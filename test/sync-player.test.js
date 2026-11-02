import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncPlayer } from '../public/sync-player.js';
import { Room } from '../src/sync/room.js';

// Minimal DOM for a real SyncPlayer: recorded listeners, a scriptable media
// element and a socket whose sent messages the test reads back.
function fakeDom(t) {
  const recorded = () => {
    const events = {};
    return { events, addEventListener: (name, handler) => (events[name] ??= []).push(handler), removeEventListener() {},
      fire(name, event = {}) { for (const handler of events[name] ?? []) handler(event); } };
  };
  const video = recorded(), doc = recorded(), win = recorded(), textTracks = recorded();
  textTracks[Symbol.iterator] = function* () {};
  Object.assign(video, { textTracks, paused: true, seeking: false, readyState: 4, currentTime: 0, playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 100 },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    load() {}, removeAttribute() {}, closest() { return null; }, getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  const globals = ['document', 'window', 'location', 'matchMedia', 'ResizeObserver', 'WebSocket', 'requestAnimationFrame', 'navigator'];
  const saved = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('document', Object.assign(doc, { hidden: false }));
  define('window', win);
  define('location', { protocol: 'https:', host: 'example.test' });
  define('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  define('ResizeObserver', class { observe() {} disconnect() {} });
  define('WebSocket', class { static OPEN = 1; constructor() { this.readyState = 0; this.bufferedAmount = 0; } send() {} close() {} });
  define('requestAnimationFrame', () => {});
  define('navigator', { onLine: true });
  let player;
  const activations = [];
  const create = () => {
    player = new SyncPlayer({ video, roomId: 'room', onStatus() {}, onState() {}, onTracks() {},
      onActivation: on => activations.push(on) });
    const sent = [];
    Object.assign(player.ws, { readyState: 1, send: message => sent.push(JSON.parse(message)) });
    for (let i = 0; i < 3; i++) player.clock.sample(performance.now() - 10, performance.now(), performance.now());
    player.lastMessage = performance.now();
    return { player, sent };
  };
  t.after(() => {
    if (player) { player.disposed = true; for (const timer of [player.interval, player.pinger, player.clocker, player.initialPings]) clearInterval(timer);
      clearTimeout(player.seekTimer); clearTimeout(player.startTimer); }
    for (const key of globals) saved[key] ? Object.defineProperty(globalThis, key, saved[key]) : delete globalThis[key];
  });
  return { video, create, activations };
}
// A state message through the socket handler, the way the room broadcasts it.
const deliver = (player, state) => player.ws.onmessage({ data: JSON.stringify({ type: 'state', state, members: [] }) });
const commands = sent => sent.filter(message => message.type === 'command');

test('reports are not stacked behind a socket that is not draining', t => {
  const { create } = fakeDom(t);
  const { player, sent } = create();
  player.state = { epoch: 1, phase: 'paused', position: 0, startsAt: null, duration: 100 };
  player.ws.bufferedAmount = 2048;
  player.report(); player.report(false);
  assert.equal(sent.filter(message => message.type === 'report').length, 0);
  player.ws.bufferedAmount = 0;
  player.report();
  assert.deepEqual(sent.filter(message => message.type === 'report').map(message => message.sequence), [0]);
});

test('a progress-bar drag sends one seek per gesture and one per epoch', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { create } = fakeDom(t);
  const { player, sent } = create();
  deliver(player, { epoch: 3, phase: 'paused', position: 10, startsAt: null, duration: 100 });
  // A drag fires one input per pointer move, about 60 per second.
  for (let i = 0; i < 60; i++) { player.seek(10 + i); t.mock.timers.tick(16); }
  assert.deepEqual(commands(sent), []);
  t.mock.timers.tick(150);
  assert.deepEqual(commands(sent).map(({ command, position, epoch }) => [command, position, epoch]), [['seek', 69, 3]]);
  // The gesture goes on before the room answered: nothing more is sent at this epoch.
  player.seek(80); t.mock.timers.tick(150);
  assert.equal(commands(sent).length, 1);
  // The answer opens a new epoch: the position the gesture settled on follows.
  deliver(player, { epoch: 4, phase: 'paused', position: 69, startsAt: null, duration: 100 });
  assert.deepEqual(commands(sent).map(({ command, position, epoch }) => [command, position, epoch]),
    [['seek', 69, 3], ['seek', 80, 4]]);
});

test('a click on the progress bar while the séance plays seeks without pausing it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { video, create } = fakeDom(t);
  const { player, sent } = create();
  const room = new Room({ now: () => performance.now() });
  room.join('me'); room.load(100);
  room.command('me', { epoch: room.epoch, type: 'play' });
  Object.assign(room, { phase: 'playing', startsAt: performance.now() - 1000, position: 19 });
  player.ws.send = message => {
    const parsed = JSON.parse(message); sent.push(parsed);
    if (parsed.type === 'command') room.command('me', { ...parsed, type: parsed.command });
  };
  player.activated = true;
  deliver(player, room.snapshot());
  video.paused = false; video.currentTime = 20;
  // Plyr's press handler pauses the media element; app.js brackets it.
  player.beginLocalToggle(); video.pause(); player.endLocalToggle();
  // The range input reports the clicked position.
  player.seek(60);
  t.mock.timers.tick(150);
  video.fire('pause');
  deliver(player, room.snapshot());
  // Release: Plyr plays the element again, its event lands after the self-caused window.
  player.beginLocalToggle(); video.play(); player.endLocalToggle();
  player.internalUntil = 0;
  video.fire('play');
  // Obeying the room, the player paused the element again: its own pause event follows.
  video.fire('pause');
  assert.deepEqual(commands(sent).map(message => message.command), ['seek']);
  assert.equal(room.wantsPlay, true);
  assert.notEqual(room.phase, 'paused');
  assert.equal(room.position, 60);
  // The room is preparing the new position: the element waits for the shared start.
  assert.equal(video.paused, true);
  // A real pause afterwards still reaches the room.
  deliver(player, { ...room.snapshot(), phase: 'playing', startsAt: performance.now() - 1000 });
  video.paused = false; video.pause(); video.fire('pause');
  assert.deepEqual(commands(sent).map(message => message.command), ['seek', 'pause']);
});

test('a start interrupted by our own pause keeps the activation', async t => {
  const { video, create } = fakeDom(t);
  const { player } = create();
  let rejectPending = null;
  video.play = function () { this.paused = false; return new Promise((resolve, reject) => { rejectPending = reject; }); };
  video.pause = function () {
    this.paused = true;
    rejectPending?.(Object.assign(new Error('The play() request was interrupted by a call to pause()'), { name: 'AbortError' }));
    rejectPending = null;
  };
  player.activated = true; player.autoActivationTried = true; player.movie = { id: 'm' };
  const startsAt = player.serverTime() - 1;
  player.state = { epoch: 4, phase: 'playing', position: 10, startsAt, duration: 100 };
  player.scheduled = startsAt;
  const started = player.begin();
  // Another member stalls at the start: the room freezes and reconcile pauses.
  player.state = { epoch: 5, phase: 'buffering', position: 10, startsAt: null, duration: 100 };
  player.pauseLocal();
  await started;
  assert.equal(player.activated, true);
  assert.ok(!player.activationBlocked);
});

test('a refused start still asks for a gesture', async t => {
  const { video, create, activations } = fakeDom(t);
  const { player } = create();
  video.play = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  player.activated = true; player.movie = { id: 'm' };
  const startsAt = player.serverTime() - 1;
  player.state = { epoch: 4, phase: 'playing', position: 10, startsAt, duration: 100 };
  player.scheduled = startsAt;
  await player.begin();
  assert.equal(player.activated, false);
  assert.equal(player.activationBlocked, true);
  assert.equal(activations.at(-1), false);
});
