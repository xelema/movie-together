// The seam between SyncPlayer and the engine that feeds the video element.
// Two real adapters: hls.js over MSE, and the browser's native HLS (Safari).
// Each owns track enumeration, track selection, fatal-error recovery and the
// media-PTS anchor (timelineOffset) that maps séance positions onto media time.

// Native HLS lists chapters and metadata alongside subtitles in textTracks.
const subtitleTracks = video => Array.from(video.textTracks ?? []).filter(track => ['subtitles', 'captions'].includes(track.kind));

// Preflight so an undecodable codec fails with a clear message instead of
// hls.js burning its recovery attempts on a stream MSE could never accept.
// The probe strings use the most permissive profile each codec offers.
const CODEC_PROBES = { h264: 'avc1.42E01E', hevc: 'hvc1.1.6.L93.B0', av1: 'av01.0.08M.08', vp9: 'vp09.00.10.08' };
export function codecPlayable(rendition, supports) {
  const codecs = rendition.codecs || CODEC_PROBES[rendition.codec];
  return !codecs || supports(`video/mp4; codecs="${codecs}"`);
}

// Prefer native HLS on Safari; its media policies and audio track API differ from MSE.
export function nativeHls(video) {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '' &&
    (/Apple/.test(navigator.vendor) || !window.Hls?.isSupported());
}

// Codec probes must ask the engine that will decode: MediaSource for hls.js,
// canPlayType for native HLS. Chrome's canPlayType accepts codecs MSE refuses
// on the first segment.
// Admin-side rendering of the risk measured at segmentation: a badge, its
// tone and the numbers behind it — honest about the cause and the only fix
// (a short GOP, which means re-encoding). Unmeasured movies get no badge.
export function bufferRiskBadge(risk, t) {
  if (!risk || risk.level === 'ok') return null;
  const title = t(
    `Segments vidéo jusqu'à ${risk.maxSegmentMb} Mo — deux d'affilée dépassent le quota mémoire de Chrome (~40 Mo) et la lecture se fige vers 20 s. Firefox ou un GPU plus généreux peuvent passer ; sinon il faut ré-encoder le film avec un GOP court.`,
    `비디오 세그먼트가 최대 ${risk.maxSegmentMb}MB — 연속 두 개가 Chrome 메모리 한도(~40MB)를 넘어 재생이 약 20초에서 멈춥니다. Firefox나 더 강한 GPU에서는 될 수도 있고, 아니면 짧은 GOP로 재인코딩해야 합니다.`);
  return { tone: risk.level === 'risk' ? 'danger' : 'pending', title,
    text: risk.level === 'risk' ? t('⚠ Lecture à risque', '⚠ 재생 위험') : t('⚠ Lecture limite', '⚠ 재생 한계') };
}

export function supportsMime(video) {
  return nativeHls(video)
    ? mime => video.canPlayType(mime) !== ''
    : mime => Boolean(window.MediaSource?.isTypeSupported(mime));
}

export function createBackend(video, url, options, handlers) {
  if (nativeHls(video)) return new NativeHlsBackend(video, url, handlers);
  if (window.Hls?.isSupported()) return new HlsJsBackend(video, url, options, handlers);
  return null;
}

// hls.js parks unselected subtitle tracks in 'disabled', and a WebVTT fragment
// that finishes parsing there loses its cues for good: _appendCues bails on
// 'disabled' and the cached fragment is never fetched again, so a fast
// re-selection can leave the track showing with an empty cue list. Same dance
// as the stock toggleTrackModes, but 'hidden' is the floor: it renders
// identically and late cues still land.
export function pinSubtitleModes(controller) {
  if (!controller.media || !controller.hls.config.renderTextTracksNatively) return;
  const current = controller.currentTrack;
  for (const track of controller.tracksInGroup) {
    const textTrack = track.trackNode?.track;
    const mode = track === current && controller.subtitleDisplay ? 'showing' : 'hidden';
    if (textTrack && textTrack.mode !== mode) textTrack.mode = mode;
  }
}

export class HlsJsBackend {
  // Bounded recovery happens inside the adapter; the media element's own error
  // event must not short-circuit it.
  recoversErrors = true;

  constructor(video, url, { timelineOffset = 0, bufferSeconds = 30, minBuffer = 4, bitrate,
      backBufferSeconds = 5, maxBufferMb = 50 } = {},
    { onTracksChanged, onBuffered, onStalled, onFatal } = {}) {
    this.video = video; this.timelineOffset = timelineOffset; this.bitrate = bitrate;
    this.bufferSeconds = bufferSeconds; this.minBuffer = minBuffer;
    this.backBufferSeconds = backBufferSeconds; this.maxBufferMb = maxBufferMb;
    this.mediaRecoveries = 0; this.networkRecoveries = 0;
    this.onTick = () => this.evictBehind();
    video.addEventListener?.('timeupdate', this.onTick);
    this.hls = new window.Hls({ maxBufferSize: 0, backBufferLength: backBufferSeconds,
      startFragPrefetch: true, enableWorker: true,
      maxBufferHole: 0.5, highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5, nudgeOffset: 0.1,
      // progressive fetch splits each 10 s fMP4 into chunks and aborts them on
      // refill; the server logs those as HTTP/2 stream resets. Plain XHR fetches.
      progressive: false,
      fragLoadingTimeOut: 30_000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000,
      fragLoadingMaxRetryDelay: 8000, manifestLoadingTimeOut: 15_000, levelLoadingTimeOut: 15_000 });
    this.applyBufferCap();

    const trackController = this.hls.subtitleTrackController;
    if (trackController) trackController.toggleTrackModes = () => pinSubtitleModes(trackController);
    this.hls.loadSource(url); this.hls.attachMedia(video);
    // Le débit de pointe du niveau n'est connu qu'après le manifest.
    this.hls.on(window.Hls.Events.LEVEL_SWITCHED, () => this.applyBufferCap());
    this.hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
      // Chaque segment peut peser 20-34 Mo : la place doit être rendue dès
      // que la tête entre dans le suivant.
      this.evictBehind();
      // Append réussi : la place est revenue, on restaure le plafond que
      // reduceLengthAndFlushBuffer() avait bridé sur erreur de quota.
      this.applyBufferCap();
      onBuffered?.();
    });
    for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) {
      this.hls.on(window.Hls.Events[name], () => onTracksChanged?.());
    }
    this.hls.on(window.Hls.Events.ERROR, (event, data) => {
      // Quota SourceBuffer dépassé : l'éviction native de hls.js garde encore
      // un targetDuration entier derrière la tête. Purge d'urgence qui peut
      // mordre dans le GOP lu — avec des segments de 20-34 Mo, la place ne se
      // libère jamais sinon sous le quota réel de Chrome. Le plafond bridé par
      // reduceLengthAndFlushBuffer() est restauré aussitôt pour que le segment
      // soit retenté dès que la tête de lecture rend la place.
      if (!data.fatal && (data.details === window.Hls.ErrorDetails?.BUFFER_FULL_ERROR ||
          data.error?.name === 'QuotaExceededError')) {
        this.evictBehind(true);
        this.applyBufferCap();
        return;
      }
      if (!data.fatal) return;
      onStalled?.();
      // Hls.js already retries transient requests. Bound recovery after a fatal error.
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) this.hls.recoverMediaError();
      else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && this.networkRecoveries++ < 1) this.hls.startLoad(video.currentTime);
      else onFatal?.('Chargement interrompu. Rechargez la page pour réessayer.');
    });
  }

  // Cible d'avance en secondes, plafonnée par le budget maxBufferMb au débit
  // réel du niveau (BANDWIDTH du manifest). Le quota MSE de Chrome (~40 Mo
  // sous Direct3D11) ne laisse pas la place à deux segments lourds : quand le
  // budget en octets ne couvre pas 2×targetDuration, l'avance retombe à un
  // seul segment — jamais sous minBuffer, sans quoi la salle ne démarre pas.
  applyBufferCap() {
    const level = this.hls.levels?.[this.hls.currentLevel];
    const bps = level?.bitrate || this.bitrate;
    const target = level?.details?.targetduration;
    const floor = Math.min(this.bufferSeconds, Math.max(target >= 8 ? target : 12, this.minBuffer));
    let cap = this.bufferSeconds, budget;
    if (bps) budget = cap = 8 * this.maxBufferMb * 1024 * 1024 / bps;
    cap = Math.min(this.bufferSeconds, Math.max(floor, cap));
    // Sans cette borne, le budget en octets laisse le cap dépasser un segment
    // (12,3 s > 10,01 s) et hls.js garde deux segments résidents : 41,5 Mo >
    // quota, le second append échoue en bufferAppendNoProgress.
    const single = Boolean(target && budget !== undefined && budget < 2 * target);
    if (single) cap = Math.max(this.minBuffer, Math.min(cap, target));
    // Exposé à la télémétrie : le cap rabattu à un segment est l'événement
    // rare qui dira au prochain test si la contention du quota a disparu.
    this.capLimited = single ? { cap: +cap.toFixed(2), target, mbps: +(bps / 1e6).toFixed(1) } : null;
    // Back-buffer : 5 s à 34 Mbps gardent ~21 Mo derrière la tête et mangent
    // la marge du quota ; sous ~8 Mbps ils ne coûtent rien et évitent un
    // re-buffering sur retour arrière.
    const back = bps > 8_000_000 ? Math.min(this.backBufferSeconds, 0.5) : this.backBufferSeconds;
    Object.assign(this.hls.config, { maxBufferLength: cap, maxMaxBufferLength: cap, backBufferLength: back });
  }

  // Purge le back-buffer vidéo jusqu'au début du fragment lu (-0,5 s de
  // marge, jamais dans son GOP : retirer la keyframe en cours de décodage fige
  // le décodeur). hls.js n'évicte de lui-même qu'au-delà de ~2×targetDuration,
  // délai que le quota SourceBuffer ne permet pas avec des segments de 20-34 Mo.
  evictBehind(deep = false) {
    const buffered = this.video.buffered;
    const ctl = this.hls.streamController;
    const frag = ctl?.getAppendedFrag?.(this.video.currentTime) ?? ctl?.fragPlaying;
    // deep : le quota est plein, on taille jusqu'à 1 s derrière la tête, même
    // dans le GOP en cours — ses images avant la tête sont déjà décodées.
    const end = Math.max((frag?.start ?? 0) - 0.5, deep ? this.video.currentTime - 1 : -Infinity);
    if (end > 0 && buffered?.length && buffered.start(0) < end - 0.5) {
      this.hls.trigger(window.Hls.Events.BUFFER_FLUSHING,
        { startOffset: 0, endOffset: end, type: 'video' });
    }
  }

  // The room's thresholds can change at runtime; hls.js reads its config live.
  setBufferGoal(minBuffer, bufferSeconds, backBufferSeconds, maxBufferMb) {
    this.minBuffer = minBuffer; this.bufferSeconds = bufferSeconds;
    if (backBufferSeconds !== undefined) {
      this.backBufferSeconds = backBufferSeconds;
      this.hls.config.backBufferLength = backBufferSeconds;
    }
    if (maxBufferMb !== undefined) this.maxBufferMb = maxBufferMb;
    this.applyBufferCap();
  }

  audioTracks() {
    return this.hls.audioTracks.map((track, index) => ({ index, label: track.name || track.lang }));
  }
  subtitleTracks() {
    return this.hls.subtitleTracks.map((track, index) => ({ index, label: track.name || track.lang }));
  }
  applyChoices(audio, subtitles) {
    if (this.hls.audioTracks[audio] && this.hls.audioTrack !== audio) this.hls.audioTrack = audio;
    if (subtitles < 0 || this.hls.subtitleTracks[subtitles]) {
      if (this.hls.subtitleTrack !== subtitles) this.hls.subtitleTrack = subtitles;
      this.hls.subtitleDisplay = subtitles >= 0;
    }
  }
  destroy() {
    this.video.removeEventListener?.('timeupdate', this.onTick);
    this.hls.destroy();
  }
}

export class NativeHlsBackend {
  constructor(video, url, { onTracksChanged } = {}) {
    this.video = video;
    // Native HLS presents a zero-based playlist timeline; MSE retains media PTS.
    this.timelineOffset = 0;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    video.src = url;
    if (video.audioTracks) video.audioTracks.addEventListener('addtrack', () => onTracksChanged?.(), { signal });
    video.textTracks.addEventListener('addtrack', () => onTracksChanged?.(), { signal });
  }

  audioTracks() {
    return Array.from(this.video.audioTracks ?? [])
      .map((track, index) => ({ index, label: track.label || track.language || `Audio ${index + 1}` }));
  }
  subtitleTracks() {
    return subtitleTracks(this.video)
      .map((track, index) => ({ index, label: track.label || track.language || `Subtitles ${index + 1}` }));
  }
  applyChoices(audio, subtitles) {
    Array.from(this.video.audioTracks ?? []).forEach((track, i) => { track.enabled = i === audio; });
    // 'hidden' rather than 'disabled': WebKit can shed a disabled track's cues.
    subtitleTracks(this.video).forEach((track, i) => { track.mode = i === subtitles ? 'showing' : 'hidden'; });
  }
  destroy() { this.abort.abort(); }
}
