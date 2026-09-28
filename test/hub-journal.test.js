import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { createRoomHub } from '../src/sync/hub.js';
import { createSettings } from '../src/settings.js';

const ORIGIN = 'http://localhost';

// A hub over a real websocket server, with a journal sink capturing every
// record() call as flat { file, ...entry } lines.
const boot = (t, { session = null, voiceService = null, voiceTiming = {} } = {}) => {
  const lines = [];
  const journal = { write: (name, entries) => lines.push(...entries.map(entry => ({ file: name, ...entry }))) };
  const hub = createRoomHub({ origin: ORIGIN, settings: createSettings({ env: {} }),
    sessionFor: () => session, sessionActive: () => true,
    canAccess: (s, room) => !!room && !!s?.rooms.has(room.id),
    movieFor: () => null, moviePlayable: () => true, voiceService, voiceTiming, journal });
  const server = createServer();
  hub.attach(server);
  t.after(async () => { await hub.close(); server.close(); });
  return { hub, server, lines };
};

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', function () { resolve(`ws://127.0.0.1:${this.address().port}`); }));

const connect = (base, roomId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${base}/ws?room=${roomId}`, { headers: { Origin: ORIGIN } });
  const client = { socket, messages: [] };
  socket.on('error', reject);
  socket.on('close', (code, reason) => reject(Object.assign(new Error('closed'), { code, reason: String(reason) })));
  socket.on('message', data => {
    const message = JSON.parse(data);
    client.messages.push(message);
    if (message.type === 'welcome') resolve(client);
  });
});

// The pong answers after every earlier message was processed by the room.
const settle = client => new Promise(resolve => {
  const sentAt = Math.random();
  const onMessage = data => {
    const message = JSON.parse(data);
    if (message.type === 'pong' && message.sentAt === sentAt) { client.socket.off('message', onMessage); resolve(); }
  };
  client.socket.on('message', onMessage);
  client.socket.send(JSON.stringify({ type: 'ping', sentAt }));
});

test('a rejected upgrade records the failing condition', async t => {
  const session = { admin: false, rooms: new Set(), expires: Date.now() + 3600_000 };
  const { hub, server, lines } = boot(t, { session });
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'refuse-room' });
  const base = await listen(server);
  // No access to the room: the refusal must be named, not silent.
  await assert.rejects(connect(base, room.id), /403/);
  const refused = lines.find(line => line.type === 'refused');
  assert.equal(refused.reason, 'access');
  assert.equal(refused.file, 'refuse-room-server');
  assert.equal(refused.path, `/ws?room=${room.id}`);
});

test('connect, commands and phase moves are journaled with their cause', async t => {
  const session = { admin: true, rooms: new Set(), expires: Date.now() + 3600_000 };
  const { hub, server, lines } = boot(t, { session });
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'causal-room' });
  session.rooms.add(room.id);
  const base = await listen(server);
  const client = await connect(base, room.id);
  const memberId = client.messages.find(message => message.type === 'welcome').id;

  const connected = lines.find(line => line.type === 'connect');
  assert.equal(connected.file, 'causal-room-server');
  assert.equal(connected.member, memberId);
  assert.equal(connected.admin, true);
  assert.ok(hub.memberSeen(room.id, memberId));
  assert.equal(hub.memberSeen(room.id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), false);

  const epoch = client.messages.find(message => message.type === 'state').state.epoch;
  client.socket.send(JSON.stringify({ type: 'command', command: 'play', epoch }));
  await settle(client);
  assert.equal(lines.find(line => line.type === 'command' && line.result === 'applied')?.cmd, 'play');
  assert.equal(lines.find(line => line.type === 'phase' && line.to === 'buffering')?.cause, 'play');

  client.socket.send(JSON.stringify({ type: 'command', command: 'seek', position: 5, epoch: epoch + 99 }));
  await settle(client);
  assert.equal(lines.find(line => line.type === 'command' && line.result === 'stale-epoch')?.cmd, 'seek');

  client.socket.close();
  await new Promise(resolve => client.socket.on('close', resolve));
  const disconnect = lines.find(line => line.type === 'disconnect');
  assert.equal(disconnect.member, memberId);
  assert.equal(disconnect.reason, 'client');
});

test('voice events never carry transcript or translation text', async t => {
  const session = { admin: true, rooms: new Set(), expires: Date.now() + 3600_000 };
  const live = { sent: [], onText: null, onSource: null, onEnd: null,
    send(chunk) { this.sent.push(chunk); },
    flush() { queueMicrotask(() => { this.onSource?.('transcription secrète'); this.onText?.('비밀 번역'); }); },
    close() {} };
  const { hub, server, lines } = boot(t, {
    session, voiceService: { openSession: () => live }, voiceTiming: { idleMs: 40 } });
  const room = hub.create({ movieId: 'movie', duration: 100, code: 'voix-log', voice: true });
  session.rooms.add(room.id);
  const base = await listen(server);
  const client = await connect(base, room.id);
  client.socket.send(JSON.stringify({ type: 'voice', action: 'start', lang: 'fr' }));
  // A 300 Hz tone trips the speech gate and opens the upstream session.
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 300 * i / 16000) * 0.3 * 32767), i * 2);
  client.socket.send(pcm);
  await settle(client);
  client.socket.send(JSON.stringify({ type: 'voice', action: 'stop' }));
  await new Promise(resolve => {
    const onMessage = data => {
      const message = JSON.parse(data);
      if (message.type === 'voice' && message.state === 'result') { client.socket.off('message', onMessage); resolve(); }
    };
    client.socket.on('message', onMessage);
  });
  const voice = lines.filter(line => line.type === 'voice');
  assert.ok(voice.some(line => line.kind === 'started') && voice.some(line => line.kind === 'session'));
  assert.ok(voice.some(line => line.kind === 'completed'));
  for (const line of voice) {
    assert.ok(!JSON.stringify(line).includes('secrète') && !JSON.stringify(line).includes('비밀'));
  }
});
