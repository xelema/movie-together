import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTelemetry } from '../public/telemetry.js';
import { hlsEventPayload, hlsErrorPayload, sourceBufferState } from '../public/hls-events.js';

// Les doublures tiennent dans la page : globals navigateur minimaux, <video>
// factice avec TimeRanges maison, joueur de synchronisation lu en seul.
const ranges = pairs => ({ length: pairs.length, start: i => pairs[i][0], end: i => pairs[i][1] });

const fakeVideo = () => {
  const listeners = {};
  return {
    listeners,
    buffered: ranges([[0, 40]]), seekable: ranges([[0, 300]]),
    readyState: 4, networkState: 1, paused: false, currentTime: 12.5, duration: 300,
    playbackRate: 1, seeking: false, videoWidth: 1920, videoHeight: 1080,
    volume: 0.8, muted: false, textTracks: [],
    canPlayType: mime => /avc1|mp4a|mpegurl/.test(mime) ? 'probably' : '',
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 600, droppedVideoFrames: 3, corruptedVideoFrames: 0 }),
    rvfcs: [],
    requestVideoFrameCallback(cb) { this.rvfcs.push(cb); return this.rvfcs.length; },
    cancelVideoFrameCallback() { },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter(other => other !== fn); },
  };
};

const fakePlayer = (overrides = {}) => ({
  memberId: 'member-1',
  position: () => 10.5, target: () => 11, offset: 0,
  state: { phase: 'playing', epoch: 2 },
  clock: { best: { rtt: 64, offset: -9 }, offset: -9, ready: true,
    samples: [{ rtt: 64, offset: -9 }, { rtt: 80, offset: -8 }, { rtt: 70, offset: -9 }] },
  ws: { readyState: 1 },
  sync: { minBuffer: 8, lowBuffer: 2, tickMs: 200, startDelay: 1000, reportTimeout: 45000 },
  movie: { id: 'm1', title: 'Film', duration: 300, bitrate: 4_000_000,
    maxSegmentSeconds: 4, maxSegmentBytes: 900_000, bufferRisk: 'ok', generation: 2,
    audio: [{}], subtitles: [{}],
    renditions: [{ id: 'original', codec: 'h264', width: 1920, height: 1080, streamIndex: 0 }] },
  audioChoice: 0, subtitleChoice: -1, activated: true,
  observe: () => () => { },
  ...overrides,
});

// Les globaux lus par telemetry.js sont posés pour le test puis restitués.
const stubBrowser = t => {
  const names = ['navigator', 'document', 'localStorage', 'matchMedia', 'location',
    'window', 'fetch', 'screen', 'innerWidth', 'innerHeight', 'devicePixelRatio'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const posts = [], beacons = [];
  const storage = {};
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const gl = {
    getExtension: () => ({ UNMASKED_VENDOR_WEBGL: 0, UNMASKED_RENDERER_WEBGL: 1 }),
    getParameter: param => param === 1 ? 'stub-gpu' : `gl-${param}`,
  };
  define('navigator', {
    userAgent: 'stub-agent', language: 'fr-FR', languages: ['fr-FR', 'en'], platform: 'stub',
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, onLine: true,
    permissions: { query: async () => ({ state: 'granted' }) },
    mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: false }) },
    storage: { estimate: async () => ({ quota: 1e9, usage: 1e6 }) },
    getBattery: async () => ({ level: 0.9, charging: true }),
    sendBeacon: (url, body) => { beacons.push({ url, body }); return true; },
  });
  define('document', {
    hidden: false, visibilityState: 'visible', hasFocus: () => true,
    pictureInPictureEnabled: true, fullscreenEnabled: true, fullscreenElement: null,
    createElement: () => ({ getContext: kind => kind === 'webgl2' ? gl : null }),
    addEventListener() { }, removeEventListener() { },
  });
  define('localStorage', { getItem: key => storage[key] ?? null, setItem: (key, v) => { storage[key] = v; } });
  define('matchMedia', query => ({ matches: /srgb/.test(query), addEventListener() { }, removeEventListener() { } }));
  define('location', { pathname: '/', href: 'http://localhost/', hash: '' });
  define('window', {
    Hls: { version: '9.9.9', isSupported: () => true },
    MediaSource: { isTypeSupported: mime => /avc1|mp4a/.test(mime) },
    addEventListener() { }, removeEventListener() { },
  });
  define('screen', { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 });
  define('innerWidth', 1600); define('innerHeight', 900); define('devicePixelRatio', 2);
  define('fetch', async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; });
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { posts, beacons, storage };
};

// Les promesses de fetch et de sondes asynchrones se vident hors des
// minuteurs simulés : quelques tours de boucle suffisent.
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const allEvents = posts => posts.flatMap(post => post.body.events);
const attach = (t, overrides = {}, options = {}) => {
  const video = fakeVideo();
  const player = fakePlayer(overrides);
  const telemetry = attachTelemetry(player, video, 'room-1', { context: {
    code: 'ABCD', probe: false, languages: ['fr', 'ko'], movie: player.movie,
    sync: player.sync, admin: false, name: 'Testeur', enter: 'join' }, ...options });
  return { video, player, telemetry };
};

test('caps porte identité, GPU, codecs et profil de risque du film', async t => {
  const { posts } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { telemetry } = attach(t);
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  const caps = allEvents(posts).find(event => event.type === 'caps');
  assert.ok(caps);
  assert.equal(caps.ua, 'stub-agent');
  assert.equal(caps.gpu.renderer, 'stub-gpu');
  assert.equal(caps.webgl2, true);
  assert.equal(caps.canPlay.h264, true);
  assert.equal(caps.mse.h264, true);
  assert.equal(caps.mse.vp9, undefined);
  assert.equal(caps.mediaCap.h264.supported, true);
  assert.equal(caps.mediaCap.film.codec, 'h264');
  assert.equal(caps.movie.bufferRisk, 'ok');
  assert.equal(caps.movie.maxSegmentBytes, 900_000);
  assert.equal(caps.room.minBuffer, 8);
  assert.equal(caps.session.enter, 'join');
  assert.ok(allEvents(posts).some(event => event.type === 'perms' && event.camera === 'granted'));
  const start = allEvents(posts).find(event => event.type === 'session-start');
  assert.equal(start.code, 'ABCD');
  assert.equal(start.probe, false);
  telemetry.dispose();
});

test('tick porte position, avance, plages, fps et compteurs d\'horloge', async t => {
  const { posts } = stubBrowser(t);
  // performance.now n'est pas moquable par mock.timers sous ce Node : on
  // remplace l'horloge par une valeur pilotée pour mesurer le fps réel.
  let fakeNow = 0;
  const savedPerf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true,
    value: { now: () => fakeNow } });
  t.after(() => Object.defineProperty(globalThis, 'performance', savedPerf));
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { video, telemetry } = attach(t);
  video.rvfcs.at(-1)?.(0, {});
  video.rvfcs.at(-1)?.(0, {});
  fakeNow = 1000;
  t.mock.timers.tick(1000);
  video.rvfcs.at(-1)?.(0, {});
  video.rvfcs.at(-1)?.(0, {});
  fakeNow = 5000;
  t.mock.timers.tick(4000);
  await settle();
  const tick = allEvents(posts).find(event => event.type === 'tick');
  assert.ok(tick);
  assert.equal(tick.pos, 10.5);
  assert.equal(tick.ahead, 29.5);
  assert.deepEqual(tick.ranges, [[0, 40]]);
  assert.deepEqual(tick.se, [[0, 300]]);
  assert.equal(tick.frames, 600);
  assert.equal(tick.dropped, 3);
  assert.equal(typeof tick.fps, 'number');
  assert.ok(tick.fps > 0);
  assert.equal(tick.rtt, 64);
  assert.equal(tick.off, -9);
  assert.equal(tick.cok, true);
  assert.equal(tick.samples, 3);
  assert.equal(tick.phase, 'playing');
  telemetry.dispose();
});

test('hlsEventPayload traduit BUFFER_FLUSHING avec les plages par piste', () => {
  const hls = { bufferController: { sourceBuffers: [
    ['audiovideo', { buffered: ranges([[0, 8], [8, 16]]), updating: false, mode: 'segments', appendWindowStart: 0, appendWindowEnd: 100, timestampOffset: 1.5 }],
    ['audio', { buffered: ranges([[0, 16]]), updating: true, mode: 'segments' }],
  ] } };
  const payload = hlsEventPayload('BUFFER_FLUSHING', { startOffset: 4, endOffset: 12, type: 'video' }, hls);
  assert.equal(payload.ev, 'buffer-flushing');
  assert.equal(payload.start, 4);
  assert.equal(payload.end, 12);
  assert.equal(payload.track, 'video');
  assert.deepEqual(payload.tracks.video, [[0, 8], [8, 16]]);
  assert.deepEqual(payload.tracks.audio, [[0, 16]]);
  const state = sourceBufferState(hls);
  assert.equal(state.sb.length, 2);
  assert.equal(state.sb[0].n, 'audiovideo');
  assert.equal(state.sb[0].to, 1.5);
});

test('hlsErrorPayload porte type, détails, fragment et longueur de tampon', () => {
  const media = { currentTime: 26, buffered: ranges([[0, 30]]) };
  const hls = { media, bufferController: { sourceBuffers: [] } };
  const payload = hlsErrorPayload({
    type: 'networkError', details: 'fragLoadError', fatal: true,
    frag: { level: 0, sn: 7, start: 24, end: 32, stats: { loaded: { total: 999 } } },
    error: { name: 'TypeError', message: 'boom' },
  }, hls);
  assert.equal(payload.type, 'networkError');
  assert.equal(payload.details, 'fragLoadError');
  assert.equal(payload.fatal, true);
  assert.equal(payload.errmsg, 'boom');
  assert.equal(payload.level, 0);
  assert.equal(payload.sn, 7);
  assert.equal(payload.start, 24);
  assert.equal(payload.end, 32);
  assert.equal(payload.bytes, 999);
  assert.equal(payload.bufferLen, 4);
  assert.deepEqual(payload.ranges, [[0, 30]]);
});

test('1000 événements partent en lots de 400 au plus', async t => {
  const { posts } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { telemetry } = attach(t);
  await settle();
  for (let i = 0; i < 1000; i++) telemetry.event('probe', { i });
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(posts.length >= 3);
  for (const post of posts) assert.ok(post.body.events.length <= 400);
  assert.equal(allEvents(posts).filter(event => event.type === 'probe').length, 1000);
  assert.equal(posts[0].body.memberId, 'member-1');
  telemetry.dispose();
});

test('un lot reste sous le budget d’octets d’un POST', async t => {
  const { posts } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { telemetry } = attach(t);
  await settle();
  // 400 événements de 2 Ko : sans budget d'octets le corps ferait 840 Ko et le
  // serveur répondrait 413, rejetant la séance entière.
  for (let i = 0; i < 400; i++) telemetry.event('probe', { blob: 'x'.repeat(2000) });
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(posts.length > 1);
  for (const post of posts) assert.ok(JSON.stringify(post.body).length <= 260 * 1024);
  assert.equal(allEvents(posts).filter(event => event.type === 'probe').length, 400);
  telemetry.dispose();
});

test('la purge à 2000 événements se signale par un événement queue', async t => {
  const { posts } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  // Sans memberId aucun flush ne part : la file grossit jusqu'à la purge.
  const { telemetry, player } = attach(t, { memberId: null });
  await settle();
  for (let i = 0; i < 2100; i++) telemetry.event('probe', { i });
  player.memberId = 'member-1';
  t.mock.timers.tick(5000);
  await settle();
  const queue = allEvents(posts).find(event => event.type === 'queue');
  assert.ok(queue);
  assert.ok(queue.dropped >= 100);
  assert.ok(allEvents(posts).filter(event => event.type === 'probe').length <= 2000);
  telemetry.dispose();
});

test('un getter de joueur qui jette ne casse ni le tick ni l\'attache', async t => {
  const { posts } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const video = fakeVideo();
  const player = fakePlayer({
    memberId: 'member-1',
    position: () => { throw new Error('boom'); },
    target: () => { throw new Error('boom'); },
  });
  let telemetry;
  assert.doesNotThrow(() => { telemetry = attachTelemetry(player, video, 'room-1', {}); });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(5000);
  await settle();
  const tick = allEvents(posts).find(event => event.type === 'tick');
  assert.ok(tick);
  assert.equal(tick.pos, undefined);
  assert.ok('phase' in tick);
  telemetry.dispose();
});

test('dispose vide la file par sendBeacon et arrête les minuteurs', async t => {
  const { posts, beacons } = stubBrowser(t);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { telemetry } = attach(t);
  await settle();
  telemetry.event('probe', { i: 1 });
  telemetry.dispose();
  assert.ok(beacons.length >= 1);
  const beaconed = [];
  for (const beacon of beacons) beaconed.push(...JSON.parse(await beacon.body.text()).events);
  assert.ok(beaconed.some(event => event.type === 'session-end'));
  const before = posts.length;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(posts.length, before);
});

test('l\'opt-out localStorage empêche tout envoi mais rend le handle', async t => {
  const { posts, storage } = stubBrowser(t);
  storage.movieTelemetry = 'off';
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { telemetry } = attach(t);
  assert.equal(telemetry.enabled, false);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(posts.length, 0);
  telemetry.enabled = true;
  telemetry.event('probe', {});
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(allEvents(posts).some(event => event.type === 'probe'));
  telemetry.dispose();
});
