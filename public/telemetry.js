// Journal de diagnostic côté navigateur. Voir docs/telemetry.md : chaque ligne
// est un événement horodaté envoyé au journal de la séance — opt-out
// (#telemetry=off ou localStorage.movieTelemetry='off'), lot de 400, purge à
// 2000, sendBeacon en sortie. Rien ici ne doit ralentir ou casser la lecture :
// chaque sonde est gardée, chaque échec est avalé et une mauvaise propriété ne
// peut pas interrompre un tick ni traverser un callback du lecteur.
import { bufferEnd } from './sync-player.js';
import { sourceBufferState } from './hls-events.js';

const FLUSH_MS = 5000;      // cadence d'envoi des lots
const BATCH = 400;          // taille maximale d'un POST
const BATCH_BYTES = 256 * 1024; // budget d'octets d'un POST
const QUEUE_MAX = 2000;     // purge FIFO hors quota côté serveur
const LONGTASK_MAX = 200;   // puis on ne garde que le compteur

// Les globaux sont lus au moment de l'appel, jamais capturés à l'import :
// la page comme un banc d'essai peuvent les fournir après coup.
const env = () => typeof window === 'object' ? window : undefined;
const doc = () => typeof document === 'object' ? document : undefined;
const nav = () => typeof navigator === 'object' ? navigator : undefined;

// Les sondes : une erreur de lecture devient "absent", jamais un plantage.
const g = fn => { try { const v = fn(); return v === null ? undefined : v; } catch { return undefined; } };
const ag = async fn => { try { const v = await fn(); return v === null ? undefined : v; } catch { return undefined; } };
const r2 = v => Number.isFinite(v) ? +v.toFixed(2) : undefined;
const now = () => g(() => performance.now()) ?? 0;
const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined;

// TimeRanges de l'élément <video> en paires [début, fin] arrondies.
const mediaRanges = ranges => g(() => {
  const out = [];
  for (let i = 0; i < (ranges?.length ?? 0); i++) out.push([r2(ranges.start(i)), r2(ranges.end(i))]);
  return out.length ? out : undefined;
});

// GPU réel via WebGL ; la chaîne GL_RENDERER est souvent masquée, d'où
// WEBGL_debug_renderer_info quand il existe. Deux essais : webgl2 puis webgl.
const gpuInfo = () => g(() => {
  const canvas = doc()?.createElement('canvas');
  let gl = g(() => canvas?.getContext('webgl2'));
  const webgl2 = !!gl;
  if (!gl) gl = g(() => canvas?.getContext('webgl'));
  if (!gl) return { webgl2: false };
  const info = g(() => gl.getExtension('WEBGL_debug_renderer_info'));
  const read = param => g(() => gl.getParameter(param));
  const found = {
    webgl2,
    vendor: read(info?.UNMASKED_VENDOR_WEBGL ?? gl?.VENDOR),
    renderer: read(info?.UNMASKED_RENDERER_WEBGL ?? gl?.RENDERER),
    version: read(gl?.VERSION),
    glsl: read(gl?.SHADING_LANGUAGE_VERSION),
    maxTexture: read(gl?.MAX_TEXTURE_SIZE),
  };
  // Le contexte est rendu tout de suite : un poste sans GPU en accorde très peu,
  // et une sonde de diagnostic ne doit pas priver le moteur de couleurs du sien
  // (sans contexte, le rendu des couleurs échoue et la séance ne joue plus).
  g(() => gl.getExtension('WEBGL_lose_context')?.loseContext());
  return found;
});

// Prise sécurisée sur un objet de capacité : support oui/non/vide.
const canPlay = (video, mime) => g(() => {
  const support = video.canPlayType(mime);
  return support || undefined;
});
const mse = mime => g(() => window.MediaSource?.isTypeSupported?.(mime)) ?? false;

// Profils testés au chargement : le serveur annonce ses segments en H.264
// mais le diagnostiqueur veut savoir ce que le poste sait faire au-delà.
// Deux cartes de booléens : lecture directe (`canPlay`) et ajout MSE (`mse`).
const codecProbes = video => {
  const formats = [
    ['h264', 'video/mp4; codecs="avc1.640029"'], ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ['hevc10', 'video/mp4; codecs="hev1.2.4.L150.B0"'], ['av1', 'video/mp4; codecs="av01.0.08M.08"'],
    ['vp9', 'video/webm; codecs="vp9"'], ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
    ['opus', 'audio/webm; codecs="opus"'], ['ec3', 'audio/mp4; codecs="ec-3"'],
    ['ac3', 'audio/mp4; codecs="ac-3"'], ['flac', 'audio/flac'], ['hls', 'application/vnd.apple.mpegurl'],
  ];
  const playable = {}, muxable = {};
  for (const [name, mime] of formats) {
    playable[name] = !!canPlay(video, mime);
    const added = mse(mime);
    if (added) muxable[name] = added;
  }
  return { canPlay: playable, mse: muxable };
};

// Sondage asynchrone de MediaCapabilities : la configuration du film d'abord
// (codec ffmpeg ramené à son paramètre codecs=), puis quatre codecs courants
// en 1080p pour confronter les listes de codecs.
const FFMPEG_TO_RFC = { h264: 'avc1.640029', avc1: 'avc1.640029', hevc: 'hvc1.1.6.L93.B0', hvc1: 'hvc1.1.6.L93.B0',
  hev1: 'hev1.2.4.L150.B0', av1: 'av01.0.08M.08', vp9: 'vp09.00.10.08', vp09: 'vp09.00.10.08' };
const mediaCaps = async (rendition, bitrate) => {
  const trim = info => info && { supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
  const probe = async video => trim(await ag(() => nav().mediaCapabilities?.decodingInfo({ type: 'file', video })));
  const out = {};
  if (rendition && FFMPEG_TO_RFC[rendition.codec]) {
    const video = { contentType: `video/mp4; codecs="${FFMPEG_TO_RFC[rendition.codec]}"`, width: rendition.width, height: rendition.height,
      bitrate: bitrate ?? 4_000_000, framerate: 24 };
    const audio = { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: 2, bitrate: 128_000, samplerate: 48_000 };
    out.film = { codec: rendition.codec, w: rendition.width, h: rendition.height, bitrate: video.bitrate,
      ...trim(await ag(() => nav().mediaCapabilities?.decodingInfo({ type: 'media-source', video, audio }))) };
  }
  for (const [name, contentType] of [
    ['h264', 'video/mp4; codecs="avc1.640029"'], ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ['av1', 'video/mp4; codecs="av01.0.08M.08"'], ['vp9', 'video/webm; codecs="vp9"'],
  ]) out[name] = await probe({ contentType, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 24 });
  return out;
};

const mediaQueries = () => {
  const mq = query => g(() => matchMedia(query)?.matches);
  return {
    color: {
      gamut: mq('(color-gamut: rec2020)') ? 'rec2020' : mq('(color-gamut: p3)') ? 'p3' : mq('(color-gamut: srgb)') ? 'srgb' : undefined,
      range: mq('(dynamic-range: high)') ? 'high' : 'standard',
      forcedColors: mq('(forced-colors: active)') || undefined,
      reducedMotion: mq('(prefers-reduced-motion: reduce)') || undefined,
    },
  };
};

const connection = () => {
  const c = g(() => nav()?.connection);
  return c ? { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData || undefined, type: c.type } : undefined;
};

const heap = () => g(() => ({
  used: performance.memory?.usedJSHeapSize, total: performance.memory?.totalJSHeapSize, limit: performance.memory?.jsHeapSizeLimit,
}));

// attaches : le producteur unique du journal côté client. `player` et `video`
// ne sont que lus ; `context` porte ce que la séance sait déjà (drapeau probe,
// langues, film, réglages de synchronisation, origine d'entrée).
export function attachTelemetry(player, video, roomId, options = {}) {
  const url = `/api/rooms/${roomId}/telemetry`;
  const sid = g(() => Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join(''));
  const startedP = now();
  const context = { ...(options.context ?? {}) };
  const queue = [];
  let dropped = 0, sending = false, disposed = false, sessionEnded = false;
  let lastPos, lastHidden, lastWakeLock, longtasks = 0, longtaskTotal = 0, tickCount = 0;
  // Profil « film » des MediaCapabilities : tant qu'il manque faute de rendition
  // connue, tick() le redemande — borné pour ne jamais boucler.
  let capsFilm = false, capsRetries = 0;
  const timers = [], removers = [], observers = [];
  const frames = { count: 0, since: now(), delays: [] };

  // Désactivation : l'opt-out URL / localStorage / option coupe l'envoi sans
  // empêcher l'attache — le handle reste rendu pour un code appelant stable.
  const stored = g(() => localStorage.getItem('movieTelemetry'));
  const hash = g(() => new URLSearchParams(location.hash.slice(1)).get('telemetry'));
  let enabled = options.enabled !== false && stored !== 'off' && hash !== 'off';
  if (stored === 'on') enabled = options.enabled !== false && hash !== 'off';

  const listen = (target, type, handler, opts) => {
    if (!target?.addEventListener) return;
    try {
      target.addEventListener(type, handler, opts);
      removers.push(() => { try { target.removeEventListener(type, handler, opts); } catch {} });
    } catch {}
  };

  // Insertion unique : enveloppe horodatée, champs non définis retirés par la
  // sérialisation, quota FIFO et comptage des lignes non sérialisables.
  const push = (type, fields) => {
    if (!enabled || disposed) return;
    try {
      const event = { ...(fields && typeof fields === 'object' ? fields : {}),
        t: Date.now(), p: Math.round(now() * 10) / 10, sid, type: String(type).slice(0, 40) };
      // Une ligne qui dépasse la limite serveur ferait refuser tout le lot :
      // elle est comptée puis sautée, jamais fatale.
      if (JSON.stringify(event).length > 3800) { dropped++; return; }
      if (queue.length >= QUEUE_MAX) { queue.shift(); dropped++; }
      queue.push(event);
    } catch { dropped++; }
  };

  // Un lot est borné en nombre et en octets : un pic d'événements (capacités,
  // segments, longtasks) ne doit pas fabriquer un corps que le serveur refuse.
  // Le premier événement part toujours, quel que soit son poids.
  const take = () => {
    const events = [];
    let bytes = 0;
    while (queue.length && events.length < BATCH) {
      let size;
      try { size = JSON.stringify(queue[0]).length + 1; } catch { dropped++; queue.shift(); continue; }
      if (events.length && bytes + size > BATCH_BYTES) break;
      bytes += size;
      events.push(queue.shift());
    }
    return events;
  };

  // Dernier envoi : sendBeacon à la place du fetch, en plusieurs appels quand
  // la file dépasse un lot ; les lots refusés remontent pour une nouvelle
  // tentative au prochain flush.
  const beacon = () => {
    const memberId = g(() => player.memberId);
    if (!queue.length || !memberId || !nav()?.sendBeacon) return;
    while (queue.length) {
      const events = take();
      let ok = false;
      try { ok = nav().sendBeacon(url, new Blob([JSON.stringify({ memberId, events })], { type: 'application/json' })) === true; } catch {}
      if (!ok) { queue.unshift(...events); break; }
    }
  };

  const flush = () => {
    if (sending || disposed) return;
    const memberId = g(() => player.memberId);
    if (!queue.length || !memberId || typeof fetch !== 'function') return;
    sending = true;
    const events = take();
    const body = g(() => JSON.stringify({ memberId, events })) ?? '{}';
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(response => {
        if (response && response.ok === false) throw new Error(`http ${response.status}`);
        if (dropped) { const n = dropped; dropped = 0; push('queue', { dropped: n, size: queue.length }); }
      })
      .catch(() => {
        queue.unshift(...events);
        const over = queue.length - QUEUE_MAX;
        if (over > 0) { queue.splice(0, over); dropped += over; }
      })
      .finally(() => { sending = false; if (queue.length) flush(); });
  };

  // Déclaration des événements du contrat.

  const sessionEnd = reason => {
    if (sessionEnded) return;
    sessionEnded = true;
    push('session-end', { reason, ms: Math.round(now() - startedP) });
  };

  const gatherCaps = async () => {
    const movie = g(() => player.movie) ?? context.movie;
    const permission = name => ag(() => nav().permissions?.query({ name }).then(p => p.state)).then(v => v ?? 'unsupported');
    const perms = { camera: await permission('camera'), microphone: await permission('microphone'), 'wake-lock': await permission('wake-lock') };
    push('perms', perms);
    const battery = await ag(async () => { const b = await nav().getBattery?.(); return b && { level: b.level, charging: b.charging }; });
    const estimate = await ag(() => nav().storage?.estimate?.());
    const gpu = gpuInfo();
    const sync = { ...(context.sync ?? {}), ...(g(() => player.sync) ?? {}) };
    const mediaCap = await mediaCaps(movie?.renditions?.[0] ?? g(() => player.rendition), movie?.bitrate);
    // Le film n'est pas toujours chargé à l'attache : sans rendition le profil
    // « film » manquerait pour toute la séance, d'où la relance depuis tick().
    if (mediaCap?.film) capsFilm = true;
    push('caps', {
      name: context.name,
      ua: g(() => nav().userAgent), uaBrands: g(() => nav().userAgentData?.brands),
      platform: g(() => nav().userAgentData?.platform) ?? g(() => nav().platform), mobile: g(() => nav().userAgentData?.mobile),
      lang: g(() => nav().language), langs: g(() => [...(nav().languages ?? [nav().language])]),
      tz: g(() => Intl.DateTimeFormat().resolvedOptions().timeZone), tzOffset: g(() => new Date().getTimezoneOffset()),
      screen: g(() => ({ w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight,
        depth: screen.colorDepth, orientation: screen.orientation?.type })),
      dpr: g(() => devicePixelRatio), viewport: g(() => ({ w: innerWidth, h: innerHeight })),
      cores: g(() => nav().hardwareConcurrency), mem: g(() => nav().deviceMemory), touch: g(() => nav().maxTouchPoints),
      battery, jsHeap: heap(), storage: estimate && { quota: estimate.quota, usage: estimate.usage },
      gpu, webgl2: gpu?.webgl2,
      ...codecProbes(video),
      mediaCap,
      nativeHls: canPlay(video, 'application/vnd.apple.mpegurl') !== undefined,
      hlsjs: g(() => env() ? { version: env().Hls?.version, supported: g(() => env().Hls.isSupported()), mse: 'MediaSource' in env() } : undefined),
      features: {
        wakeLock: g(() => 'wakeLock' in (nav() ?? {})), pip: g(() => doc()?.pictureInPictureEnabled),
        fullscreen: g(() => doc()?.fullscreenEnabled), rvfc: g(() => typeof video.requestVideoFrameCallback === 'function'),
        playbackQuality: g(() => typeof video.getVideoPlaybackQuality === 'function'),
        worklet: g(() => typeof AudioWorkletNode === 'function'), sab: g(() => typeof SharedArrayBuffer === 'function'),
        webgpu: g(() => 'gpu' in (nav() ?? {})), mediaSession: g(() => 'mediaSession' in (nav() ?? {})),
      },
      ...mediaQueries(),
      conn: connection(),
      room: { probe: context.probe, languages: context.languages,
        minBuffer: sync.minBuffer, lowBuffer: sync.lowBuffer, tickMs: sync.tickMs,
        startDelay: sync.startDelay, reportTimeout: sync.reportTimeout,
        mode: g(() => player.backend ? (player.backend.hls ? 'hlsjs' : 'native') : undefined) },
      movie: movie && { id: movie.id, title: movie.title, duration: movie.duration, bitrate: movie.bitrate,
        maxSegmentSeconds: movie.maxSegmentSeconds, maxSegmentBytes: movie.maxSegmentBytes,
        bufferRisk: movie.bufferRisk, generation: movie.generation,
        audio: movie.audio?.length, subtitles: movie.subtitles?.length,
        renditions: movie.renditions?.slice(0, 8).map(r => ({ id: r.id, codec: r.codec, w: r.width, h: r.height, videoRange: r.videoRange })) },
      session: { admin: context.admin, enter: context.enter, forceShader: context.forceShader, hdr: context.hdr },
    });
  };

  const tick = () => {
    tickCount++;
    const pos = g(() => player.position());
    const target = g(() => player.target());
    const offset = g(() => player.offset);
    const quality = g(() => video.getVideoPlaybackQuality?.());
    const clock = g(() => player.clock);
    const hls = g(() => player.backend?.hls);
    const renderer = g(() => player.colorRenderer);
    const state = g(() => player.state);
    // Le fps est celui de l'intervalle écoulé, pas une moyenne depuis l'attache :
    // une image figée doit faire tomber la valeur, pas la diluer.
    const drawn = frames.count;
    const elapsed = (now() - frames.since) / 1000;
    frames.since = now(); frames.count = 0;
    const wakeLock = g(() => player.wakeLock && !player.wakeLock.released);
    if (lastWakeLock !== undefined && wakeLock !== lastWakeLock) push('wakeLock', { on: !!wakeLock });
    lastWakeLock = wakeLock;
    const hidden = renderer && g(() => renderer.canvas.style.visibility === 'hidden');
    if (hidden !== undefined && lastHidden !== undefined && hidden !== lastHidden) push('renderer-hidden', { uniform: hidden });
    lastHidden = hidden;
    lastPos = pos ?? lastPos;
    // Un nouveau film dans la même séance : le profil de capacités est
    // renvoyé pour que le journal porte le risque du film courant.
    const currentMovie = g(() => player.movie);
    if (currentMovie && currentMovie.id !== context.movie?.id) {
      context.movie = currentMovie;
      gatherCaps();
    } else if (!capsFilm && capsRetries < 3 && currentMovie && g(() => player.rendition)) {
      // Second essai une fois le film chargé, puis on renonce : un poste sans
      // rendition ne doit pas relancer le sondage à chaque seconde.
      capsRetries++;
      gatherCaps();
    }
    push('tick', {
      pos: r2(pos), target: r2(target),
      ahead: r2(Math.max(0, (g(() => bufferEnd(video)) ?? g(() => video.currentTime) ?? 0) - (offset ?? 0) - (pos ?? 0))),
      drift: r2(Number.isFinite(target) && Number.isFinite(pos) ? target - pos : undefined),
      phase: state?.phase, epoch: state?.epoch,
      wantsPlay: state ? state.phase === 'playing' || state.phase === 'buffering' : undefined,
      rs: g(() => video.readyState), ns: g(() => video.networkState), paused: g(() => video.paused),
      rate: g(() => video.playbackRate), seeking: g(() => video.seeking) || undefined, dur: r2(g(() => video.duration)),
      vw: g(() => video.videoWidth), vh: g(() => video.videoHeight),
      ranges: mediaRanges(g(() => video.buffered)), se: mediaRanges(g(() => video.seekable)),
      buf: hls ? sourceBufferState(hls) : undefined,
      frames: quality?.totalVideoFrames, dropped: quality?.droppedVideoFrames, corrupted: quality?.corruptedVideoFrames,
      fps: elapsed > 0.5 ? Math.round(drawn / elapsed) : undefined,
      pdelay: median(frames.delays.filter(d => Number.isFinite(d)).map(d => +(d * 1000).toFixed(1))),
      rtt: clock?.best ? Math.round(clock.best.rtt) : undefined, off: clock ? Math.round(clock.offset) : undefined,
      cok: clock?.ready, samples: clock?.samples?.length,
      off2: clock?.samples?.length ? Math.round(clock.samples[clock.samples.length - 1].offset) : undefined,
      act: g(() => player.activated), blk: g(() => player.activationBlocked), rec: g(() => player.recovering), fail: g(() => player.failure),
      back: g(() => player.backend?.constructor?.name), bw: g(() => Math.round(hls?.bandwidthEstimate ?? NaN)) || undefined,
      ws: g(() => player.ws?.readyState), hid: g(() => doc()?.hidden) || undefined,
      on: g(() => nav()?.onLine) === false ? false : undefined, focused: g(() => doc()?.hasFocus?.()),
      vol: r2(g(() => video.volume)), muted: g(() => video.muted),
      track: g(() => ({ audio: player.audioChoice, subs: player.subtitleChoice })),
      ttracks: g(() => Array.from(video.textTracks ?? []).map(t => t.mode).join(',')) || undefined,
      rend: renderer && {
        ok: !!renderer.ready, bad: !!renderer.failed, uni: hidden || undefined,
        w: g(() => renderer.canvas.width), h: g(() => renderer.canvas.height),
      },
      mem: g(() => performance.memory?.usedJSHeapSize), queue: queue.length,
    });
    // Compteurs du moteur de rendu couleur, lus toutes les cinq secondes.
    if (renderer && tickCount % 5 === 0) push('renderer', {
      ready: !!renderer.ready, failed: !!renderer.failed, visible: !hidden,
      w: g(() => renderer.canvas.width), h: g(() => renderer.canvas.height),
      drawn: g(() => renderer.drawn), errors: g(() => renderer.errors), importVerified: g(() => renderer.importVerified),
      resumeGrace: g(() => Number.isFinite(renderer.resumeGraceUntil) && renderer.resumeGraceUntil > now()) || undefined,
      ctx: 'webgl2',
    });
  };

  // Les sondages document, fenêtre, réseau et erreurs.
  const onVisibility = () => { if (g(() => doc()?.hidden)) beacon(); };
  const onPageHide = () => { push('lifecycle', { ev: 'pagehide' }); sessionEnd('pagehide'); beacon(); };
  const onFreeze = ev => push('lifecycle', { ev: ev?.type ?? 'freeze' });
  const onOnline = online => push('net', { online, conn: connection() });

  let envTimer;
  const envProbe = () => {
    clearTimeout(envTimer);
    envTimer = setTimeout(() => push('env', {
      vw: g(() => innerWidth), vh: g(() => innerHeight),
      screen: g(() => ({ w: screen.width, h: screen.height, orientation: screen.orientation?.type })),
      dpr: g(() => devicePixelRatio), conn: connection(),
    }), 1000);
  };
  // Le zoom change le devicePixelRatio : un matchMedia à usage unique suit le
  // seuil courant puis se ré-arme sur la nouvelle valeur.
  const watchDpr = () => {
    const mq = g(() => matchMedia(`(resolution: ${devicePixelRatio}dppx)`));
    if (mq?.addEventListener) {
      const once = () => { envProbe(); watchDpr(); };
      try { mq.addEventListener('change', once, { once: true }); } catch {}
    }
  };

  // Charge initiale : session, capacités (asynchrones), état initial.
  push('session-start', { code: context.code ?? roomId, probe: context.probe, languages: context.languages,
    movie: g(() => player.movie?.id) ?? context.movie?.id, href: g(() => location.pathname) });
  gatherCaps();
  push('net', { online: g(() => nav()?.onLine) !== false, conn: connection() });
  push('visibility', { state: g(() => doc()?.visibilityState) });
  push('focus', { focused: g(() => doc()?.hasFocus?.()) ?? undefined });
  envProbe();
  listen(g(() => nav()?.serviceWorker), 'controllerchange', () => push('lifecycle', { ev: 'controllerchange' }));

  // Minuteurs et télémétrie périodique.
  const ticker = setInterval(tick, 1000);
  const flusher = setInterval(flush, FLUSH_MS);
  // Sous Node un minuteur oublié retiendrait le process ; unref est absent
  // des navigateurs où la page vit de toute façon jusqu'à son déchargement.
  ticker.unref?.(); flusher.unref?.();
  timers.push(ticker, flusher);

  // Rendu réel : le compteur de trames affichées donne le fps observé, pas le
  // fps nominal de la piste. Les délais de traitement sont médianisés au tick.
  if (g(() => typeof video.requestVideoFrameCallback === 'function')) {
    const loop = (t, meta) => {
      if (disposed) return;
      frames.count++;
      if (Number.isFinite(meta?.processingDuration)) {
        frames.delays.push(meta.processingDuration);
        if (frames.delays.length > 600) frames.delays.splice(0, frames.delays.length - 600);
      }
      g(() => { frames.id = video.requestVideoFrameCallback(loop); });
    };
    g(() => { frames.id = video.requestVideoFrameCallback(loop); });
  }

  // Événements de l'élément : la charge utile lit la position en temps de
  // séance et le tampon pour corréler seeking/stalled avec le journal serveur.
  const videoFields = () => ({
    pos: r2(g(() => player.position())), rs: g(() => video.readyState), ns: g(() => video.networkState),
    ranges: mediaRanges(g(() => video.buffered)), ahead: r2((g(() => bufferEnd(video)) ?? 0) - (g(() => player.offset) ?? 0) - (g(() => player.position()) ?? 0)),
    vw: g(() => video.videoWidth), vh: g(() => video.videoHeight), dur: r2(g(() => video.duration)),
  });
  for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'play', 'pause', 'waiting',
    'stalled', 'seeked', 'emptied', 'ratechange', 'durationchange', 'volumechange', 'ended'])
    listen(video, name, () => push(`video-${name}`, videoFields()));
  listen(video, 'seeking', () => {
    const to = g(() => player.position());
    push('video-seeking', { from: r2(lastPos), to: r2(to), delta: r2(Number.isFinite(to) && Number.isFinite(lastPos) ? to - lastPos : undefined), ...videoFields() });
    lastPos = to;
  });
  listen(video, 'error', () => push('video-error', {
    code: g(() => video.error?.code), name: g(() => video.error?.name), msg: g(() => video.error?.message),
    rs: g(() => video.readyState), ns: g(() => video.networkState),
  }));

  // Segments vus par le navigateur : nom, taille, temps de chargement, protocole
  // et un indice cache quand le timing le permet (transferSize nul). Les noms
  // de fichiers suivent le paquetage ffmpeg : master*.m3u8, stream_<v>.m3u8,
  // init_<v>.mp4, segment_<v>_<n>.m4s, sub_<id>.{m3u8,vtt}.
  const videoStreams = () => new Set(g(() => player.movie?.renditions?.map(r => r.streamIndex))
    ?? g(() => context.movie?.renditions?.map(r => r.streamIndex)) ?? []);
  const segFromEntry = entry => {
    const name = g(() => new URL(entry.name, location.href)) ?? { pathname: entry.name };
    const file = String(g(() => name.pathname.split('/').pop()) ?? '');
    let kind = 'media', level, sn, match;
    if ((match = file.match(/^segment_(\d+)_(\d+)\.m4s$/))) {
      level = +match[1]; sn = +match[2];
      kind = videoStreams().has(level) ? 'video' : 'audio';
    } else if ((match = file.match(/^init_(\d+)\.mp4$/))) { kind = 'init'; level = +match[1]; }
    else if ((match = file.match(/^stream_(\d+)\.m3u8$/))) { kind = 'level'; level = +match[1]; }
    else if (/^master.*\.m3u8$/.test(file)) kind = 'master';
    else if (/^sub_/.test(file)) kind = 'subtitle';
    return {
      n: file, kind, level, sn,
      d: Math.round(entry.duration ?? 0), start: Math.round(entry.startTime ?? 0),
      b: entry.transferSize || entry.decodedBodySize || entry.encodedBodySize,
      enc: entry.encodedBodySize, dec: entry.decodedBodySize,
      ttfb: Number.isFinite(entry.responseStart) ? Math.round(entry.responseStart - entry.startTime) : undefined,
      proto: entry.nextHopProtocol, status: entry.responseStatus,
      cached: entry.transferSize === 0 || undefined,
    };
  };
  try {
    const resourceObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries())
        if (/\/media\//.test(entry.name ?? '')) push('seg', segFromEntry(entry));
    });
    resourceObserver.observe({ type: 'resource', buffered: true });
    observers.push(resourceObserver);
  } catch {}

  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const longtaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          longtaskTotal++;
          if (longtasks < LONGTASK_MAX) { longtasks++; push('longtask', { ms: Math.round(entry.duration), start: Math.round(entry.startTime) }); }
          else if (longtasks === LONGTASK_MAX) { longtasks++; push('longtask', { capped: true, total: longtaskTotal }); }
        }
      });
      longtaskObserver.observe({ type: 'longtask', buffered: true });
      observers.push(longtaskObserver);
    }
  } catch {}

  // Erreurs hors cadre : erreur JS avec position, ressource non chargée.
  listen(env(), 'error', event => {
    if (event?.target && event.target !== env()) push('resource-error', { tag: g(() => event.target.tagName), src: g(() => String(event.target.src ?? event.target.href ?? '')).slice(0, 300) });
    else push('js-error', {
      msg: g(() => String(event.message ?? '')).slice(0, 300), name: g(() => event.error?.name),
      src: g(() => event.filename)?.slice(0, 300),
      line: event?.lineno, col: event?.colno, stack: g(() => String(event.error?.stack ?? '')).slice(0, 2000),
    });
  }, true);
  listen(env(), 'unhandledrejection', event => push('js-error', { msg: g(() => `unhandledrejection ${event.reason}`).slice(0, 300) }));

  // Événements document/fenêtre : visibilité, focus, plein écran, réseau, fin.
  listen(doc(), 'visibilitychange', () => { push('visibility', { state: g(() => doc()?.visibilityState) }); onVisibility(); });
  listen(env(), 'pagehide', onPageHide);
  listen(doc(), 'freeze', onFreeze);
  listen(doc(), 'resume', () => push('lifecycle', { ev: 'resume' }));
  listen(env(), 'online', () => onOnline(true));
  listen(env(), 'offline', () => onOnline(false));
  listen(env(), 'focus', () => push('focus', { focused: true }));
  listen(env(), 'blur', () => push('focus', { focused: false }));
  listen(doc(), 'fullscreenchange', () => push('fullscreen', { on: g(() => !!doc()?.fullscreenElement) }));
  listen(env(), 'resize', envProbe);
  listen(env(), 'orientationchange', envProbe);
  listen(g(() => nav()?.connection), 'change', envProbe);
  watchDpr();

  // Le lecteur de synchronisation est la source des états serveur : on observe
  // ses événements sans le toucher, et on déduplique l'état sur sa signature.
  let stateSig;
  const observer = (type, fields) => {
    if (type === 'state' && fields) {
      const sig = `${fields.phase}|${fields.epoch}|${(fields.members ?? []).map(m => `${m.id}:${m.waiting}:${m.reason}`).join(',')}`;
      if (sig === stateSig) return;
      stateSig = sig;
    }
    push(type, fields);
  };
  const unobserve = g(() => player.observe?.(observer));

  const event = (type, fields) => push(type, type === 'action'
    ? { pos: r2(g(() => player.position())), phase: g(() => player.state?.phase), epoch: g(() => player.state?.epoch), ...fields }
    : fields);

  const dispose = () => {
    if (disposed) return;
    sessionEnd('dispose');
    disposed = true;
    for (const id of timers) clearInterval(id);
    clearTimeout(envTimer);
    for (const remove of removers) remove();
    for (const obs of observers) { try { obs.disconnect(); } catch {} }
    try { unobserve?.(); } catch {}
    if (frames.id !== undefined) g(() => video.cancelVideoFrameCallback?.(frames.id));
    beacon();
  };

  return {
    event,
    dispose,
    context,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
  };
}
