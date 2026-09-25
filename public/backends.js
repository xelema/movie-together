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

export function createBackend(video, url, options, handlers) {
  // Prefer native HLS on Safari; its media policies and audio track API differ from MSE.
  if (video.canPlayType('application/vnd.apple.mpegurl') &&
    (/Apple/.test(navigator.vendor) || !window.Hls?.isSupported())) {
    return new NativeHlsBackend(video, url, handlers);
  }
  if (window.Hls?.isSupported()) return new HlsJsBackend(video, url, options, handlers);
  return null;
}

// The byte cap must hold minBuffer seconds of this stream: on a high-bitrate
// film a fixed cap would stall the room before playback could ever start.
const bufferBytes = (minBuffer, bitrate) =>
  Math.max(60 * 1024 ** 2, Math.ceil(minBuffer * (bitrate ?? 20_000_000) / 8));

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

  constructor(video, url, { timelineOffset = 0, bufferSeconds = 30, minBuffer = 8, bitrate } = {},
    { onTracksChanged, onBuffered, onStalled, onFatal } = {}) {
    this.video = video; this.timelineOffset = timelineOffset; this.bitrate = bitrate;
    this.mediaRecoveries = 0; this.networkRecoveries = 0;
    this.hls = new window.Hls({ maxBufferLength: bufferSeconds, maxMaxBufferLength: bufferSeconds * 2,
      maxBufferSize: bufferBytes(minBuffer, bitrate), backBufferLength: 60,
      // Prefetch du fragment de départ et lookup fin : la reprise et le
      // re-buffer piochent dans le cache local sans attendre le réseau.
      startFragPrefetch: true, maxFragLookUpTolerance: 0.05, enableWorker: true });

    const trackController = this.hls.subtitleTrackController;
    if (trackController) trackController.toggleTrackModes = () => pinSubtitleModes(trackController);
    this.hls.loadSource(url); this.hls.attachMedia(video);
    this.hls.on(window.Hls.Events.FRAG_BUFFERED, () => onBuffered?.());
    for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) {
      this.hls.on(window.Hls.Events[name], () => onTracksChanged?.());
    }
    this.hls.on(window.Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      onStalled?.();
      // Hls.js already retries transient requests. Bound recovery after a fatal error.
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) this.hls.recoverMediaError();
      else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && this.networkRecoveries++ < 1) this.hls.startLoad(video.currentTime);
      else onFatal?.('Chargement interrompu. Rechargez la page pour réessayer.');
    });
  }

  // The room's thresholds can change at runtime; hls.js reads its config live.
  setBufferGoal(minBuffer, bufferSeconds) {
    Object.assign(this.hls.config, { maxBufferLength: bufferSeconds,
      maxMaxBufferLength: bufferSeconds * 2, maxBufferSize: bufferBytes(minBuffer, this.bitrate) });
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
