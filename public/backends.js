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

  constructor(video, url, { timelineOffset = 0, bufferSeconds = 30, minBuffer = 8, bitrate,
      backBufferSeconds = 15, maxBufferMb = 50 } = {},
    { onTracksChanged, onBuffered, onStalled, onFatal } = {}) {
    this.video = video; this.timelineOffset = timelineOffset; this.bitrate = bitrate;
    this.bufferSeconds = bufferSeconds; this.minBuffer = minBuffer;
    this.backBufferSeconds = backBufferSeconds; this.maxBufferMb = maxBufferMb;
    this.mediaRecoveries = 0; this.networkRecoveries = 0;
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
      // Append réussi : la place est revenue, on restaure le plafond que
      // reduceLengthAndFlushBuffer() avait bridé sur erreur de quota.
      this.applyBufferCap();
      onBuffered?.();
    });
    for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) {
      this.hls.on(window.Hls.Events[name], () => onTracksChanged?.());
    }
    this.hls.on(window.Hls.Events.ERROR, (event, data) => {
      // Quota SourceBuffer dépassé : hls.js évicte lui-même le back-buffer
      // (fragments entiers avant la tête de lecture) puis retente l'append.
      if (!data.fatal) return;
      onStalled?.();
      // Hls.js already retries transient requests. Bound recovery after a fatal error.
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) this.hls.recoverMediaError();
      else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && this.networkRecoveries++ < 1) this.hls.startLoad(video.currentTime);
      else onFatal?.('Chargement interrompu. Rechargez la page pour réessayer.');
    });
  }

  // Cible d'avance en secondes, plafonnée par le budget maxBufferMb au débit
  // réel du niveau (BANDWIDTH du manifest). Sur un flux lourd (peak 34 Mbps),
  // 30 s d'avance dépassent le quota SourceBuffer de Chrome et l'append du
  // prochain segment échoue en boucle ; ~12-15 s suffisent à couvrir minBuffer.
  applyBufferCap() {
    const level = this.hls.levels?.[this.hls.currentLevel];
    const bps = level?.bitrate || this.bitrate;
    const floor = Math.min(this.bufferSeconds, Math.max(12, this.minBuffer));
    let cap = this.bufferSeconds;
    if (bps) cap = 8 * this.maxBufferMb * 1024 * 1024 / bps;
    cap = Math.min(this.bufferSeconds, Math.max(floor, cap));
    Object.assign(this.hls.config, { maxBufferLength: cap, maxMaxBufferLength: cap });
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
  destroy() { this.hls.destroy(); }
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
