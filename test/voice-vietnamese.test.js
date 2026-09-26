import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';
import { createVoiceService } from '../src/voice.js';

// Same fake provider as voice.test.js: openSession returns a controllable
// session; nextResult steers what flush() emits.
const fakeService = () => {
  const service = { sessions: [] };
  service.openSession = options => {
    const session = { options, sent: [], flushed: 0, closed: false,
      onText: null, onSource: null, onEnd: null,
      send(pcm) { this.sent.push(pcm); },
      flush() {
        this.flushed++;
        const result = service.nextResult;
        if (result) queueMicrotask(() => { session.onSource?.(result.heard); session.onText?.(result.text); });
      },
      close() { this.closed = true; } };
    service.sessions.push(session);
    return session;
  };
  return service;
};

const tone = (frequency = 300, frames = 4) => {
  const pcm = Buffer.alloc(960 * frames);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / 16000) * 0.3 * 32767), i * 2);
  }
  return pcm;
};

async function boot(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-voice-vi-'));
  const origin = 'http://localhost:3000';
  const movieId = 'eeeeeeee-1111-2222-3333-444444444444';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Voice Film', status: 'ready', duration: 120 }));
  const service = fakeService();
  const instance = createApplication({ dataDir,
    passwords: { 'fr-vi': 'fr-vi-password-long-enough' },
    origin, env: {}, voiceService: service, voiceTiming: { idleMs: 80 } });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'fr-vi-password-long-enough' } });
  const admin = login.headers.get('set-cookie').split(';')[0];
  const createRoom = async body => (await request('/api/rooms', { cookie: admin, method: 'POST', body: { movieId, ...body } })).json();
  const join = async code => (await request('/api/join', { method: 'POST', body: { code } }))
    .headers.get('set-cookie').split(';')[0];
  const open = (roomId, cookieValue) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${roomId}`,
      { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket);
    const client = { socket, messages: [], waiters: [] };
    client.waitFor = (pred, since = 0) => new Promise((done, fail) => {
      const hit = client.messages.find((message, index) => index >= since && pred(message));
      if (hit) return done(hit);
      const timer = setTimeout(() => fail(new Error('waitFor timeout')), 9000);
      client.waiters.push({ pred, done, timer, since });
    });
    client.settle = async () => {
      const sentAt = Math.random();
      const pong = client.waitFor(m => m.type === 'pong' && m.sentAt === sentAt);
      socket.send(JSON.stringify({ type: 'ping', sentAt }));
      await pong;
    };
    socket.on('message', data => {
      const message = JSON.parse(data);
      const index = client.messages.length;
      client.messages.push(message);
      client.waiters = client.waiters.filter(waiter => {
        if (index < waiter.since || !waiter.pred(message)) return true;
        clearTimeout(waiter.timer); waiter.done(message); return false;
      });
      if (message.type === 'welcome') resolve(client);
    });
    socket.on('error', reject);
  });
  const send = (client, action, lang) => client.socket.send(JSON.stringify({ type: 'voice', action, ...(lang === undefined ? {} : { lang }) }));
  return { request, admin, createRoom, join, open, send, service };
}

test('a fr-vi room carries its pair everywhere and names participants in Vietnamese', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t);
  const room = await createRoom({ code: 'vi-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin);
  const b = await open(room.id, guest);
  const welcome = a.messages.find(m => m.type === 'welcome');
  assert.deepEqual(welcome.languages, ['fr', 'vi']);
  assert.deepEqual(welcome.voice.pair, ['fr', 'vi']);
  const state = await a.waitFor(m => m.type === 'state' && m.members.length === 2);
  assert.deepEqual(state.languages, ['fr', 'vi']);
  assert.deepEqual(state.members.map(m => m.name).sort(), ['Hôte / Chủ nhà', 'Invité / Khách']);
  // Une prise française part vers le vietnamien ; la console en dit autant.
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  await a.settle();
  assert.equal(service.sessions.length, 1);
  assert.deepEqual(service.sessions[0].options, { source: 'fr', target: 'vi' });
  // Le coréen n'a pas droit de cité : une sortie en hangul est incohérente.
  service.nextResult = { heard: 'Xin chào bạn.', text: '안녕하세요.' };
  send(a, 'stop');
  const failed = await a.waitFor(m => m.state === 'failed');
  assert.equal(failed.error, 'inconsistent');
});

test('hangul anywhere in a fr-vi utterance fails, a clean translation lands', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t);
  const room = await createRoom({ code: 'vi-clean', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin);
  const b = await open(room.id, guest);
  // Coréen détecté dans la transcription source : rejet aussi.
  service.nextResult = { heard: '안녕', text: 'Bonjour.' };
  send(b, 'start', 'vi');
  await b.waitFor(m => m.state === 'started');
  b.socket.send(tone());
  await b.settle();
  assert.deepEqual(service.sessions[0].options, { source: 'vi', target: 'fr' });
  send(b, 'stop');
  const failed = await b.waitFor(m => m.state === 'failed');
  assert.equal(failed.error, 'inconsistent');
  // Une vraie traduction française passe et est partagée.
  service.nextResult = { heard: 'Chào nhé.', text: 'Salut toi.' };
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  await a.settle();
  send(a, 'stop');
  const result = await b.waitFor(m => m.state === 'result');
  assert.equal(result.text, 'Salut toi.');
  assert.equal(result.speaker, 'Hôte / Chủ nhà');
});

// Le fournisseur reçoit la consigne vietnamienne quand la cible est 'vi'.
test('a session targeting vi ships the Vietnamese system prompt', () => {
  const sockets = [];
  const service = createVoiceService({ env: { GEMINI_API_KEY: 'k' }, connect: () => {
    const socket = new EventEmitter();
    socket.sent = [];
    socket.send = data => socket.sent.push(JSON.parse(data));
    socket.terminate = () => {};
    sockets.push(socket);
    return socket;
  } });
  const session = service.openSession({ source: 'fr', target: 'vi' });
  sockets[0].emit('open');
  const setup = sockets[0].sent[0].setup;
  assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, 'vi');
  assert.match(setup.systemInstruction.parts[0].text, /Vietnamese/);
  session.close();
});
