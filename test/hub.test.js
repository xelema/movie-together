import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createRoomHub } from '../src/sync/hub.js';
import { createSettings } from '../src/settings.js';

const stubHub = (saved = {}, overrides = {}) => createRoomHub({ origin: 'http://localhost',
  settings: createSettings({ env: {}, saved }),
  sessionFor: () => null, sessionActive: () => true, canAccess: () => false,
  movieFor: () => null, moviePlayable: () => true, ...overrides });

test('tune applies thresholds to existing and future rooms', async t => {
  const hub = stubHub({ minBuffer: 20, lowBuffer: 5 });
  t.after(() => hub.close());
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'test-room' });
  assert.equal(hub.get(room.id).engine.minBuffer, 20);
  hub.tune({ minBuffer: 8, lowBuffer: 3 });
  assert.equal(hub.get(room.id).engine.minBuffer, 8);
  assert.equal(hub.get(room.id).engine.lowBuffer, 3);
  const next = hub.create({ movieId: 'movie', duration: 100, code: 'next-room' });
  assert.equal(next.engine.minBuffer, 8);
  assert.deepEqual(hub.state(room).sync, { minBuffer: 8, lowBuffer: 3 });
});

test('tune rejects invalid thresholds without touching rooms', async t => {
  const hub = stubHub({ minBuffer: 20, lowBuffer: 5 });
  t.after(() => hub.close());
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'test-room' });
  for (const bad of [{ minBuffer: 3, lowBuffer: 8 }, { minBuffer: 8, lowBuffer: 0 },
    { minBuffer: 500, lowBuffer: 3 }, { minBuffer: 'x', lowBuffer: 3 }, {}]) {
    assert.throws(() => hub.tune(bad), /Seuils invalides/);
  }
  assert.equal(hub.get(room.id).engine.minBuffer, 20);
});

test('the voice capability is frozen at creation and absent from ordinary rooms', async t => {
  const bare = stubHub();
  t.after(() => bare.close());
  const plain = bare.create({ movieId: 'movie', duration: 100, code: 'plain-room' });
  const voiced = bare.create({ movieId: 'movie', duration: 100, code: 'voix-room', voice: true });
  assert.equal('voice' in bare.state(plain), false);
  const voice = bare.state(voiced).voice;
  assert.deepEqual(voice, { enabled: true, pair: ['fr', 'ko'], available: false });
  assert.ok(Object.isFrozen(voice));
  // Availability is not a room setting: it mirrors the service wired into the hub.
  const served = stubHub({}, { voiceService: {} });
  t.after(() => served.close());
  const room = served.create({ movieId: 'movie', duration: 100, code: 'servi-room', voice: true });
  assert.equal(served.state(room).voice.available, true);
});

test('the webcam capability is frozen at creation and absent from ordinary rooms', async t => {
  const hub = stubHub();
  t.after(() => hub.close());
  const plain = hub.create({ movieId: 'movie', duration: 100, code: 'plain-room' });
  const faced = hub.create({ movieId: 'movie', duration: 100, code: 'cam-room', webcam: true });
  assert.equal('webcam' in hub.state(plain), false);
  const webcam = hub.state(faced).webcam;
  assert.deepEqual(webcam, { enabled: true });
  assert.ok(Object.isFrozen(webcam));
});

// A real hub on a real server, with sockets carrying a fake session cookie
// `s=<name>`: the transport guards and the member lifecycle run unmodified.
async function liveHub(t) {
  const sessions = new Map();
  const sessionFor = request => {
    const name = /s=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (!name) return null;
    if (!sessions.has(name)) sessions.set(name, { name, admin: false, expires: Date.now() + 3600_000 });
    return sessions.get(name);
  };
  const hub = stubHub({}, { sessionFor, canAccess: () => true, movieFor: () => ({ id: 'movie', title: 'm' }) });
  const server = http.createServer();
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'live-room' });
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await hub.close(); server.close(); });
  const open = session => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?room=${room.id}`,
      { headers: { Origin: 'http://localhost', Cookie: `s=${session}` } });
    sockets.push(ws);
    ws.states = []; ws.pongs = 0; ws.sequence = 0;
    ws.closed = new Promise(done => ws.on('close', code => done(code)));
    ws.on('message', data => {
      const message = JSON.parse(data);
      if (message.type === 'welcome') { ws.id = message.id; resolve(ws); }
      if (message.type === 'state') ws.states.push(message);
      if (message.type === 'pong') ws.pongs++;
    });
    ws.on('error', reject);
  });
  return { hub, room, open };
}
const latest = ws => ws.states.at(-1)?.state;
// Polls an observable condition; a closed socket fails the wait at once.
async function until(condition, { socket, timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (socket && socket.readyState !== WebSocket.OPEN) throw new Error(`${label}: socket closed`);
    if (Date.now() > deadline) throw new Error(`${label}: timed out`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const healthyReport = ws => {
  const state = latest(ws);
  ws.send(JSON.stringify({ type: 'report', epoch: state.epoch, sequence: ws.sequence++, position: state.position,
    bufferedUntil: 60, bufferedStart: 0, ready: true,
    ackStartsAt: state.phase === 'playing' ? state.startsAt : null }));
};

test('a burst over the message budget is dropped, not answered with a session close', async t => {
  const { open } = await liveHub(t);
  const a = await open('alice');
  await until(() => latest(a), { socket: a, label: 'first state' });
  // Reports queued while the network froze arrive in one block.
  const epoch = latest(a).epoch;
  for (let i = 0; i < 45; i++) a.send(JSON.stringify({ type: 'report', epoch, sequence: i, position: 0, bufferedUntil: 20, ready: true }));
  // The socket survives the burst and still answers once the budget allows it.
  await until(() => { if (!a.pongs) a.send(JSON.stringify({ type: 'ping', sentAt: 1 })); return a.pongs > 0; },
    { socket: a, label: 'pong after the burst' });
  assert.equal(a.readyState, WebSocket.OPEN);
});

test('a drag that floods seek commands keeps the socket and the séance', async t => {
  const { open } = await liveHub(t);
  const a = await open('alice'), b = await open('bob');
  await until(() => b.states.some(message => message.members?.length === 2), { socket: b, label: 'two members' });
  for (let i = 0; i < 60; i++) {
    a.send(JSON.stringify({ type: 'command', command: 'seek', position: 10 + i * 0.5, epoch: latest(a).epoch }));
  }
  await until(() => { if (!a.pongs) a.send(JSON.stringify({ type: 'ping', sentAt: 1 })); return a.pongs > 0; },
    { socket: a, label: 'pong after the drag' });
  assert.equal(latest(b).cause === 'leave', false);
});

test('a reconnect retires the socket it replaces without pausing the séance', async t => {
  const { room, open } = await liveHub(t);
  const a = await open('alice'), b = await open('bob');
  await until(() => a.states.at(-1)?.members?.length === 2, { socket: a, label: 'two members' });
  a.send(JSON.stringify({ type: 'command', command: 'play', epoch: latest(a).epoch }));
  await until(() => room.engine.wantsPlay, { socket: a, label: 'wantsPlay' });
  // Bob's network flipped: his browser reconnected under the same session while
  // the server never saw the old socket die. That socket stays silent.
  const b2 = await open('bob');
  const reporter = setInterval(() => { healthyReport(a); healthyReport(b2); }, 50);
  t.after(() => clearInterval(reporter));
  await until(() => latest(a)?.phase === 'playing', { socket: a, label: 'start with the ghost around' });
  // The liveness sweep finally kills the ghost: the séance keeps wanting to play.
  b.terminate();
  await until(() => room.clients.size === 2, { label: 'ghost closed' });
  assert.equal(room.engine.wantsPlay, true);
  assert.notEqual(room.engine.phase, 'paused');
});

test('the last socket of a session leaving still pauses the séance', async t => {
  const { room, open } = await liveHub(t);
  const a = await open('alice'), b = await open('bob');
  await until(() => a.states.at(-1)?.members?.length === 2, { socket: a, label: 'two members' });
  a.send(JSON.stringify({ type: 'command', command: 'play', epoch: latest(a).epoch }));
  await until(() => room.engine.wantsPlay, { socket: a, label: 'wantsPlay' });
  b.terminate();
  await until(() => room.clients.size === 1, { label: 'bob gone' });
  assert.equal(room.engine.wantsPlay, false);
  assert.equal(room.engine.phase, 'paused');
});
