// The seam between SyncPlayer and the engine that feeds the video element.
// Two real adapters: hls.js over MSE, and the browser's native HLS (Safari).
// Each owns track enumeration, track selection, fatal-error recovery and the
// media-PTS anchor (timelineOffset) that maps séance positions onto media time.
import { HLS_EVENTS, hlsErrorPayload, hlsEventPayload } from './hls-events.js';

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

// The byte cap must hold the buffer goal of this stream: on a high-bitrate
// uncompressed film, a tight cap stalls the player far before the buffer goal.
export const bufferBytes = (bufferGoal, bitrate) =>
  Math.max(128 * 1024 ** 2, Math.ceil((bufferGoal ?? 60) * (bitrate ?? 25_000_000) / 8 * 1.5));

// hls.js attaches one `<track>` node per subtitle rendition of the manifest and
// gives it a placeholder src — `data:,WEBVTT`, hardcoded in its own createTrackNode
// (utils/texttrack-utils) — so Chrome's captions menu lists the track and WebKit
// keeps its cues. Our CSP (`media-src 'self' blob: mediastream:`) refuses data:,
// so the moment hls.js raises the node's mode out of 'disabled' the browser blocks
// the fetch: one `resource-error {tag: TRACK, src: data:,WEBVTT}` and one CSP
// violation per subtitle rendition, and the element is left in the failed state.
// Cues are unaffected either way (hls.js appends them to `track.track`, it never
// reads the file), so the swap below is about the node loading for real: an empty
// WebVTT blob is allowed by media-src and keeps the element a valid track.
export const SUBTITLE_PLACEHOLDER = 'data:,WEBVTT';

// hls.js raises the current track's mode in the same task it appends the node, so
// the adoption has to happen between the append and that first fetch attempt.
export function releaseSubtitlePlaceholders(nodes, src) {
  for (const node of nodes) if (node.src === SUBTITLE_PLACEHOLDER) node.src = src;
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

  constructor(video, url, { timelineOffset = 0, bufferSeconds = 30, minBuffer = 8, bitrate } = {},
    { onTracksChanged, onBuffered, onStalled, onFatal, onEvent } = {}) {
    this.video = video; this.timelineOffset = timelineOffset; this.bitrate = bitrate;
    this.mediaRecoveries = 0; this.networkRecoveries = 0;
    this.hls = new window.Hls({ maxBufferLength: bufferSeconds, maxMaxBufferLength: bufferSeconds * 2,
      maxBufferSize: bufferBytes(bufferSeconds, bitrate), backBufferLength: 60,
      startFragPrefetch: true, enableWorker: true,
      maxBufferHole: 0.5, highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5, nudgeOffset: 0.1,
      // progressive fetch splits each 10 s fMP4 into chunks and aborts them on
      // refill; the server logs those as HTTP/2 stream resets. Plain XHR fetches.
      progressive: false,
      fragLoadingTimeOut: 30_000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000,
      fragLoadingMaxRetryDelay: 8000, manifestLoadingTimeOut: 15_000, levelLoadingTimeOut: 15_000 });

    const trackController = this.hls.subtitleTrackController;
    if (trackController) trackController.toggleTrackModes = () => pinSubtitleModes(trackController);
    // The subtitle nodes land after the manifest is parsed, and hls.js may raise the
    // current one in the same task it appends it: adopt them as they arrive, before
    // the fetch the CSP would refuse (see releaseSubtitlePlaceholders).
    this.subtitleVtt = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
    this.trackNodes = new MutationObserver(() => releaseSubtitlePlaceholders(video.querySelectorAll('track'), this.subtitleVtt));
    this.trackNodes.observe(video, { childList: true });
    this.hls.loadSource(url); this.hls.attachMedia(video);
    this.hls.on(window.Hls.Events.FRAG_BUFFERED, () => onBuffered?.());
    for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) {
      this.hls.on(window.Hls.Events[name], () => onTracksChanged?.());
    }
    // Journal de la chaîne MSE : les événements du cycle de vie passent par le
    // traducteur pur de hls-events.js ; une erreur de lecture ne peut pas
    // remonter dans le moteur.
    const emit = (type, fields) => { try { onEvent?.(type, fields); } catch { } };
    for (const name of HLS_EVENTS) {
      this.hls.on(window.Hls.Events[name], (event, data) => {
        try { const fields = hlsEventPayload(name, data, this.hls); if (fields) emit('hls', fields); } catch { }
      });
    }
    this.hls.on(window.Hls.Events.ERROR, (event, data) => {
      try { emit('mediaError', hlsErrorPayload(data, this.hls)); } catch { }
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
      maxMaxBufferLength: bufferSeconds * 2, maxBufferSize: bufferBytes(bufferSeconds, this.bitrate) });
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
  destroy() { this.trackNodes.disconnect(); URL.revokeObjectURL(this.subtitleVtt); this.hls.destroy(); }
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
