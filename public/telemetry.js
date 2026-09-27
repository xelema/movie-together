// Télémétrie des séances instrumentées : observe le vrai chemin de lecture
// (vidéo, synchro, renderer couleur, réseau) et envoie les mesures au serveur,
// qui les appende sous data/telemetry. Lectrice seule : elle ne touche jamais
// la lecture ni l'interface.
import { bufferEnd } from './sync-player.js';

export function attachTelemetry(player, video, roomId) {
  const url = `/api/rooms/${roomId}/telemetry`;
  const queue = [];
  const listeners = [];
  const listen = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const push = (type, fields = {}) => {
    if (queue.length < 2000) queue.push({ t: Date.now(), type, ...fields });
  };

  const support = mime => { try { return video.canPlayType(mime) || 'no'; } catch { return 'no'; } };
  const mse = mime => { try { return Boolean(window.MediaSource?.isTypeSupported(mime)); } catch { return false; } };
  const mq = query => matchMedia(query).matches;
  let gpu;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : undefined;
  } catch { }
  const rendition = player.rendition;
  push('caps', {
    name: player.name, ua: navigator.userAgent, lang: navigator.language, langs: navigator.languages,
    platform: navigator.platform, screen: [screen.width, screen.height], dpr: window.devicePixelRatio,
    touch: navigator.maxTouchPoints, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    gamut: mq('(color-gamut: rec2020)') ? 'rec2020' : mq('(color-gamut: p3)') ? 'p3' : 'srgb',
    range: mq('(dynamic-range: high)') ? 'high' : 'standard',
    codecs: {
      h264: support('video/mp4; codecs="avc1.640029"'), hevc: support('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      h264mse: mse('video/mp4; codecs="avc1.640029"'), hevcmse: mse('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      hls: support('application/vnd.apple.mpegurl'),
    },
    gpu, rvfc: 'requestVideoFrameCallback' in video, vq: 'getVideoPlaybackQuality' in video,
    conn: navigator.connection && { type: navigator.connection.effectiveType, down: navigator.connection.downlink, rtt: navigator.connection.rtt },
    rendition: rendition && { codec: rendition.codec, w: rendition.width, h: rendition.height, color: rendition.color },
  });

  // Transitions repérées entre deux ticks et renvoyées comme événements.
  const seen = { ws: undefined, act: undefined, blk: undefined, uni: undefined, phase: undefined, hls: undefined };
  const tick = () => {
    // Erreurs hls.js : aucune ne doit rester invisible — le bridage de
    // maxBufferLength après QuotaExceededError était muet dans les journaux.
    const hls = player.backend?.hls;
    if (hls && seen.hls !== hls) {
      seen.hls = hls;
      const details = window.Hls?.ErrorDetails ?? {};
      const kind = d => d.details === (details.BUFFER_FULL_ERROR ?? 'bufferFullError') ? 'buffer-full'
        : d.details === (details.BUFFER_APPEND_ERROR ?? 'bufferAppendError') ? 'append-error' : 'hls-error';
      hls.on(window.Hls?.Events?.ERROR, (event, data) => push(kind(data), {
        pos: +player.position().toFixed(2), details: data.details, type: data.type,
        fatal: !!data.fatal, err: data.error?.name, msg: String(data.error?.message ?? '').slice(0, 200) }));
    }
    const ranges = [];
    for (let i = 0; i < video.buffered.length; i++) ranges.push([+video.buffered.start(i).toFixed(2), +video.buffered.end(i).toFixed(2)]);
    const quality = video.getVideoPlaybackQuality?.();
    const renderer = player.colorRenderer;
    const uniform = renderer ? renderer.canvas.style.visibility === 'hidden' : undefined;
    const wsState = player.ws?.readyState;
    if (seen.ws !== undefined && seen.ws !== wsState) push('ws', { from: seen.ws, to: wsState, retry: player.retries });
    if (seen.act !== undefined && seen.act !== player.activated) push('activation', { ok: player.activated });
    if (seen.blk !== undefined && seen.blk !== player.activationBlocked) push('activation-blocked', { blocked: player.activationBlocked });
    if (seen.uni !== undefined && seen.uni !== uniform) push('renderer-hidden', { uniform });
    if (seen.phase !== undefined && seen.phase !== player.state?.phase) push('phase', { from: seen.phase, to: player.state?.phase });
    Object.assign(seen, { ws: wsState, act: player.activated, blk: player.activationBlocked, uni: uniform, phase: player.state?.phase });
    push('tick', {
      pos: +player.position().toFixed(2), target: +player.target().toFixed(2),
      ahead: +Math.max(0, bufferEnd(video) - player.offset - player.position()).toFixed(2), ranges,
      rs: video.readyState, ns: video.networkState, paused: video.paused, rate: video.playbackRate, phase: player.state?.phase,
      dropped: quality?.droppedVideoFrames, frames: quality?.totalVideoFrames,
      rtt: player.clock.best ? Math.round(player.clock.best.rtt) : undefined, off: Math.round(player.clock.offset), cok: player.clock.ready,
      act: player.activated || undefined, blk: player.activationBlocked || undefined, rec: player.recovering || undefined,
      fail: player.failure || undefined,
      rend: renderer ? { ok: !!renderer.ready, bad: !!renderer.failed, uni: uniform || undefined, w: renderer.canvas.width, h: renderer.canvas.height } : undefined,
      back: player.backend?.constructor.name,
      bw: player.backend?.hls?.bandwidthEstimate ? Math.round(player.backend.hls.bandwidthEstimate) : undefined,
      ws: wsState, hid: document.hidden || undefined, on: navigator.onLine === false ? false : undefined,
    });
  };

  for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'play', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'emptied', 'ratechange', 'durationchange', 'volumechange']) {
    listen(video, event, () => push(`video-${event}`, { pos: +player.position().toFixed(2), vw: video.videoWidth, vh: video.videoHeight, dur: video.duration }));
  }
  listen(video, 'error', () => push('video-error', { code: video.error?.code, msg: video.error?.message }));
  listen(document, 'visibilitychange', () => push('visibility', { hidden: document.hidden }));
  listen(document, 'fullscreenchange', () => push('fullscreen', { on: !!document.fullscreenElement }));
  listen(window, 'online', () => push('net', { on: true }));
  listen(window, 'offline', () => push('net', { on: false }));
  listen(window, 'error', event => push('js-error', { msg: String(event.message).slice(0, 300) }));
  listen(window, 'unhandledrejection', event => push('js-error', { msg: String(event.reason?.message ?? event.reason).slice(0, 300) }));

  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.name.includes('/media/')) continue;
        push('seg', { n: entry.name.split('/').pop(), d: Math.round(entry.duration), b: entry.transferSize || entry.encodedBodySize || 0 });
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    listeners.push(() => observer.disconnect());
  } catch { }

  const flush = beacon => {
    if (!queue.length || !player.memberId) return;
    const events = queue.splice(0, queue.length);
    const body = JSON.stringify({ memberId: player.memberId, events });
    if (beacon) {
      navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .catch(() => { queue.unshift(...events); if (queue.length > 2000) queue.length = 2000; });
  };
  const flusher = setInterval(flush, 5000);
  listen(document, 'visibilitychange', () => { if (document.hidden) flush(true); });
  listen(window, 'pagehide', () => flush(true));

  tick();
  const ticker = setInterval(tick, 1000);
  return {
    event: push,
    dispose() {
      clearInterval(ticker); clearInterval(flusher);
      listeners.forEach(remove => remove());
      flush(true);
    },
  };
}
