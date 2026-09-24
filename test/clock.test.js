import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, bufferEnd, SyncPlayer } from '../public/sync-player.js';
import { decide, memberReady, readyBlockers } from '../public/sync-core.js';

test('clock estimates offset using the shortest round trip and expires old samples', () => {
  const clock = new Clock();
  clock.sample(100, 140, 1120); clock.sample(200, 220, 1210); clock.sample(300, 380, 1340);
  assert.equal(clock.offset, 1000); assert.equal(clock.ready, true);
  clock.sample(30_000, 30_020, 32_010);
  assert.equal(clock.offset, 2000); assert.equal(clock.ready, false);
});

test('keeps audio at normal speed and pauses the group for excessive drift', () => {
  const base = {
    activating: false, state: { phase: 'playing', startsAt: 0, position: 10, duration: 100 },
    clockReady: true, hidden: false, online: true, silent: false,
    decoded: true, seeking: false, paused: false, currentTime: 9.8, bufferedStart: 0,
    target: 10, serverNow: 1000, activated: true, scheduled: 0,
  };
  assert.deepEqual(decide(base), { normalizeRate: true });
  // Mid-range drift stretches the playback rate instead of freezing the room.
  assert.deepEqual(decide({ ...base, currentTime: 9.5 }), { rate: 1.08 });
  assert.deepEqual(decide({ ...base, currentTime: 10.5 }), { rate: 0.92 });
  // A correcting member keeps correcting until drift falls under the release band.
  assert.deepEqual(decide({ ...base, currentTime: 9.75, rate: 1.08 }), { rate: 1.08 });
  assert.deepEqual(decide({ ...base, currentTime: 9.85, rate: 1.08 }), { normalizeRate: true });
  assert.deepEqual(decide({ ...base, currentTime: 8.5 }), { pause: true, reportUnready: true });
  // A backward seek must reload evicted segments rather than clamp to the buffered range.
  const paused = { ...base, state: { ...base.state, phase: 'paused' }, currentTime: 44, bufferedStart: 40 };
  assert.equal(decide(paused).seekTo, 10);
  // Before the first decoded frame a seek would wedge the media element on some engines.
  assert.equal(decide({ ...paused, decoded: false }).seekTo, undefined);
});

test('a playing phase before startsAt arms the local start timer once', () => {
  const base = {
    activating: false, state: { phase: 'playing', startsAt: 5000, position: 0, duration: 100 },
    clockReady: true, hidden: false, online: true, silent: false,
    decoded: true, seeking: false, paused: true, currentTime: 0, bufferedStart: 0,
    target: 0, serverNow: 4000, activated: true, scheduled: null,
  };
  const action = decide(base);
  assert.equal(action.pause, true);
  assert.equal(action.scheduleStart, true);
  assert.equal(action.startIn, 1000);
  assert.equal(decide({ ...base, scheduled: 5000 }).scheduleStart, undefined);
});

test('readiness folds activation, decode, liveness and alignment into one bit', () => {
  const base = {
    state: { phase: 'playing', startsAt: 0 }, failure: null, rendererReady: true,
    recovering: false, activated: true, clockReady: true, hidden: false, online: true,
    silent: false, seeking: false, readyState: 4, paused: false,
    position: 10, target: 10, serverNow: 1000,
  };
  assert.ok(memberReady(base));
  assert.ok(!memberReady({ ...base, activated: false }));
  assert.ok(!memberReady({ ...base, seeking: true }));
  assert.ok(!memberReady({ ...base, readyState: 2 }));
  assert.ok(!memberReady({ ...base, recovering: true }));
  assert.ok(!memberReady({ ...base, silent: true }));
  // Once the start has run past its grace window, drift beyond tolerance reports not-ready.
  assert.ok(!memberReady({ ...base, position: 11.5 }));
  assert.ok(memberReady({ ...base, position: 10.6 }));
  assert.ok(memberReady({ ...base, position: 10.2 }));
  // Before that window, position checks do not apply.
  assert.ok(memberReady({ ...base, serverNow: 100, position: 11, paused: true }));
});
test('readiness blockers name each failing gate', () => {
  const base = {
    state: { phase: 'playing', startsAt: 0 }, failure: null, rendererReady: true,
    recovering: false, activated: true, clockReady: true, hidden: false, online: true,
    silent: false, seeking: false, readyState: 4, paused: false,
    position: 10, target: 10, serverNow: 1000,
  };
  assert.deepEqual(readyBlockers(base), []);
  assert.deepEqual(readyBlockers({ ...base, activated: false }), ['activation']);
  assert.deepEqual(readyBlockers({ ...base, clockReady: false, hidden: true }), ['clock', 'hidden']);
  assert.deepEqual(readyBlockers({ ...base, seeking: true, readyState: 2 }), ['seeking', 'data']);
  assert.deepEqual(readyBlockers({ ...base, position: 11.5 }), ['drift']);
  assert.deepEqual(readyBlockers({ ...base, failure: 'x', rendererReady: false, recovering: true }),
    ['failure', 'renderer', 'recovering']);
});

test('buffer measurement never counts ranges beyond a gap', () => {
  const video = { currentTime: 2, buffered: { length: 2, start: i => [0, 20][i], end: i => [4, 60][i] } };
  assert.equal(bufferEnd(video), 4);
  video.currentTime = 10; assert.equal(bufferEnd(video), 10);
});

test('audio authorization reports readiness without issuing a group play command', async () => {
  const blocked = Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' });
  let reject = true, commands = 0;
  const player = Object.assign(Object.create(SyncPlayer.prototype), {
    movie: { id: 'test' }, video: { play: async () => { if (reject) throw blocked; } },
    pauseLocal() {}, onStatus() {}, onActivation() {}, reconcile() {}, report() {}, command() { commands++; },
  });
  await player.activate(); assert.equal(player.activationBlocked, true); assert.equal(player.activated, false);
  reject = false; await player.activate();
  assert.equal(player.activated, true); assert.equal(player.activationBlocked, false); assert.equal(commands, 0);
});

test('an old playback promise cannot activate a new movie', async () => {
  let finish;
  const player = Object.assign(Object.create(SyncPlayer.prototype), {
    movie: { id: 'old' }, loadToken: 1, video: { play: () => new Promise(resolve => { finish = resolve; }) },
    pauseLocal() { assert.fail('Old playback must not pause the new movie'); },
    onStatus() {}, onActivation() { assert.fail('Old playback must not activate the new movie'); }, reconcile() {}, report() {},
  });
  const pending = player.activate();
  player.movie = { id: 'new' }; player.loadToken++; player.activating = false;
  finish(); await pending;
  assert.notEqual(player.activated, true);
});

test('a permanent decoder error stays visible when play is pressed again', async () => {
  const player = Object.assign(Object.create(SyncPlayer.prototype), {
    movie: { id: 'test' }, failure: 'Unsupported decoder', video: { play() { assert.fail('No working decoder'); } },
  });
  await player.activate(); assert.equal(player.failure, 'Unsupported decoder');
});

test('a pause event delivered after a stalled loop stays local', () => {
  const recorded = () => {
    const events = {};
    return { events, addEventListener: (name, handler) => (events[name] ??= []).push(handler), removeEventListener() {} };
  };
  const video = recorded(), doc = recorded(), win = recorded(), textTracks = recorded();
  Object.assign(video, { textTracks, paused: true, pause() { this.paused = true; }, load() {}, removeAttribute() {} });
  const globals = ['document', 'window', 'location', 'matchMedia', 'ResizeObserver', 'WebSocket', 'requestAnimationFrame'];
  const saved = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, {
    document: Object.assign(doc, { hidden: false }),
    window: win,
    location: { protocol: 'https:', host: 'example.test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } send() {} close() {} },
    requestAnimationFrame: () => {},
  });
  try {
    const player = new SyncPlayer({ video, roomId: 'room', onStatus() {}, onState() {}, onTracks() {}, onActivation() {} });
    const commands = [];
    player.command = (...args) => commands.push(args);
    player.state = { epoch: 3, phase: 'playing', position: 10, startsAt: 0, duration: 50 };
    // pause() only queues its event: a stalled main thread can deliver it after
    // the self-caused window expired, and it must still not reach the room.
    video.paused = false;
    player.pauseLocal();
    player.internalUntil = 0;
    video.events['pause'][0]();
    assert.deepEqual(commands, []);
    // A pause we did not cause while the room plays still reaches it.
    video.paused = false;
    video.pause();
    video.events['pause'][0]();
    assert.deepEqual(commands, [['pause']]);
    player.disposed = true;
    clearInterval(player.interval); clearInterval(player.pinger); clearInterval(player.initialPings);
  } finally {
    for (const key of globals) saved[key] === undefined ? delete globalThis[key] : globalThis[key] = saved[key];
  }
});

test('a pause counted before a source reload cannot swallow the next real pause', () => {
  const recorded = () => {
    const events = {};
    return { events, addEventListener: (name, handler) => (events[name] ??= []).push(handler), removeEventListener() {} };
  };
  const video = recorded(), doc = recorded(), win = recorded(), textTracks = recorded();
  Object.assign(video, { textTracks, paused: true, pause() { this.paused = true; }, load() {}, removeAttribute() {} });
  const globals = ['document', 'window', 'location', 'matchMedia', 'ResizeObserver', 'WebSocket', 'requestAnimationFrame'];
  const saved = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, {
    document: Object.assign(doc, { hidden: false }),
    window: win,
    location: { protocol: 'https:', host: 'example.test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } send() {} close() {} },
    requestAnimationFrame: () => {},
  });
  let player;
  try {
    player = new SyncPlayer({ video, roomId: 'room', onStatus() {}, onState() {}, onTracks() {}, onActivation() {} });
    const commands = [];
    player.command = (...args) => commands.push(args);
    player.state = { epoch: 3, phase: 'playing', position: 10, startsAt: 0, duration: 50 };
    // load() pauses a playing element, then video.load() drops the queued
    // pause event: the counted pause must not outlive the reload.
    video.paused = false;
    player.load(null);
    video.paused = false;
    video.pause();
    video.events['pause'][0]();
    assert.deepEqual(commands, [['pause']]);
    // A pause we cause after the reload is still spent by its own event.
    video.paused = false;
    player.pauseLocal();
    video.events['pause'][0]();
    assert.deepEqual(commands, [['pause']]);
  } finally {
    player?.dispose();
    for (const key of globals) saved[key] === undefined ? delete globalThis[key] : globalThis[key] = saved[key];
  }
});
