import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';

// Fake Live Translate provider: openSession returns a controllable session.
// `nextResult` steers what flush() emits (heard = source transcription, text =
// translation); `nextOpen` steers the session itself. Sessions record sent
// frames, flushes and closes so tests see the real upstream lifecycle.
// Une session qui continue d'émettre après le flush : le repos idleMs ne
// vient jamais, c'est le plafond de traitement qui referme.
const dripSession = options => ({ options, sent: [], flushed: 0, closed: false,
  onText: null, onSource: null, onEnd: null, drip: null,
  send(pcm) { this.sent.push(pcm); },
  flush() { this.flushed++; this.drip = setInterval(() => this.onText?.('…'), 20); },
  close() { this.closed = true; clearInterval(this.drip); } });

const fakeService = () => {
  const service = { sessions: [] };
  service.openSession = options => {
    if (service.nextOpen) return service.nextOpen(options);
    const session = { options, sent: [], flushed: 0, closed: false,
      onText: null, onSource: null, onEnd: null,
      send(pcm) { this.sent.push(pcm); },
      flush() {
        this.flushed++;
        const result = service.nextResult === undefined ? (options.source === 'ko'
          ? { heard: '엔딩에서 만나요.', text: 'On se retrouve au générique.' }
          : { heard: 'Bonjour le film.', text: '영화 안녕하세요.' }) : service.nextResult;
        if (result) queueMicrotask(() => { session.onSource?.(result.heard); session.onText?.(result.text); });
      },
      close() { this.closed = true; } };
    service.sessions.push(session);
    return session;
  };
  return service;
};

// Entrées déterministes (#45) : une sinusoïde tient lieu de parole, des
// échantillons nuls de silence et un signal alterné pleine échelle de bruit
// large bande pour le garde-fou local.
const tone = (frequency = 300, frames = 4) => {
  const pcm = Buffer.alloc(960 * frames);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / 16000) * 0.3 * 32767), i * 2);
  }
  return pcm;
};
const silence = (frames = 4) => Buffer.alloc(960 * frames);
const noise = (frames = 4) => {
  const pcm = Buffer.alloc(960 * frames);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? 20000 : -20000, i * 2);
  return pcm;
};

async function boot(t, { service = fakeService(), timing, patch } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-voice-'));
  const origin = 'http://localhost:3000';
  const movieId = 'eeeeeeee-1111-2222-3333-444444444444';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Voice Film', status: 'ready', duration: 120 }));
  const instance = createApplication({ dataDir, password: 'test-password-long-enough',
    origin, env: {}, voiceService: service, voiceTiming: { idleMs: 80, ...timing } });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const admin = login.headers.get('set-cookie').split(';')[0];
  if (patch) assert.equal((await request('/api/settings', { cookie: admin, method: 'PATCH', body: patch })).status, 200);
  const createRoom = async body => (await request('/api/rooms', { cookie: admin, method: 'POST', body: { movieId, ...body } })).json();
  const join = async code => (await request('/api/join', { method: 'POST', body: { code } }))
    .headers.get('set-cookie').split(';')[0];
  const open = (roomId, cookieValue, name) => new Promise((resolve, reject) => {
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
    // A ping on the same socket is answered only after every earlier message
    // was processed: it proves cancel/close reached the room before we act.
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
    socket.on('open', () => { if (name) socket.send(JSON.stringify({ type: 'identify', name })); });
  });
  const voice = client => client.messages.filter(message => message.type === 'voice');
  // La langue d'interface accompagne chaque demande de prise, comme le client
  // réel. Le serveur la fige en sens source -> cible (#44).
  const send = (client, action, lang) => client.socket.send(JSON.stringify({ type: 'voice', action, ...(lang === undefined ? {} : { lang }) }));
  return { request, admin, createRoom, join, open, voice, send, service, dataDir, hub: instance.hub };
}

test('a prise is private to the speaker, exclusive and server-ordered', async t => {
  const { admin, createRoom, join, open, voice, send, service } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'prise-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  const started = await a.waitFor(m => m.type === 'voice' && m.state === 'started');
  assert.ok(started.utterance);
  assert.equal(started.seq, 1);
  send(b, 'start', 'ko');
  const refused = await b.waitFor(m => m.type === 'voice' && m.state === 'failed');
  assert.equal(refused.error, 'busy');
  a.socket.send(tone());
  await a.settle();
  // La parole attestée a ouvert la session amont avec le sens figé.
  assert.equal(service.sessions.length, 1);
  assert.deepEqual(service.sessions[0].options, { source: 'fr', target: 'ko' });
  // Les partiels de traduction sont partagés à tous, attribués et révisés ;
  // la transcription source ne quitte que le socket de l'orateur.
  service.sessions[0].onSource('Bonjour ');
  service.sessions[0].onText('영화 ');
  service.nextResult = { heard: 'le film.', text: '안녕하세요.' };
  const [aPartial, bPartial] = await Promise.all([
    a.waitFor(m => m.state === 'partial'),
    b.waitFor(m => m.state === 'partial'),
  ]);
  for (const partial of [aPartial, bPartial]) {
    assert.equal(partial.utterance, started.utterance);
    assert.equal(partial.seq, 1);
    assert.equal(partial.rev, 1);
    assert.equal(partial.speaker, 'Alex');
    assert.equal(partial.text, '영화 ');
  }
  const heard = await a.waitFor(m => m.state === 'heard');
  assert.equal(heard.text, 'Bonjour ');
  assert.equal(voice(b).filter(m => ['heard', 'understood'].includes(m.state)).length, 0);
  send(a, 'stop');
  const understood = await a.waitFor(m => m.type === 'voice' && m.state === 'understood');
  assert.equal(understood.text, 'Bonjour le film.');
  assert.equal(understood.utterance, started.utterance);
  const [aResult, bResult] = await Promise.all([
    a.waitFor(m => m.type === 'voice' && m.state === 'result'),
    b.waitFor(m => m.type === 'voice' && m.state === 'result'),
  ]);
  assert.equal(bResult.text, '영화 안녕하세요.');
  assert.equal(bResult.speaker, 'Alex');
  assert.equal(bResult.utterance, started.utterance);
  assert.equal(bResult.seq, started.seq);
  // L'invité ne voit jamais les états privés : started, failed, heard,
  // understood. Le seul 'failed' de b est son refus 'busy'.
  assert.deepEqual(voice(b).filter(m => ['started', 'failed', 'heard', 'understood'].includes(m.state))
    .map(m => m.error), ['busy']);
  assert.equal(service.sessions[0].flushed, 1);
  // A second prise gets a fresh identifier and a higher sequence.
  send(a, 'start', 'fr');
  const second = await a.waitFor(m => m.type === 'voice' && m.state === 'started' && m.utterance !== started.utterance);
  assert.ok(second.seq > started.seq);
  send(a, 'stop');
  await a.waitFor(m => m.state === 'failed');
  // Sens inverse : Minji a l'interface coréenne, sa prise va du coréen vers le
  // français. Transcription locale coréenne, surtitre français pour tous.
  send(b, 'start', 'ko');
  await b.waitFor(m => m.state === 'started');
  b.socket.send(tone());
  await b.settle();
  delete service.nextResult;
  assert.deepEqual(service.sessions[1].options, { source: 'ko', target: 'fr' });
  send(b, 'stop');
  const understoodKo = await b.waitFor(m => m.state === 'understood');
  assert.equal(understoodKo.text, '엔딩에서 만나요.');
  const koResult = await a.waitFor(m => m.type === 'voice' && m.state === 'result' && m.speaker === 'Minji');
  assert.equal(koResult.text, 'On se retrouve au générique.');
});

test('cancel, disconnect and the listening limit always release the room lock', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    timing: { listenMs: 350 }, patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'lock-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  send(a, 'cancel');
  await a.settle();
  send(b, 'start', 'fr');
  await b.waitFor(m => m.state === 'started');
  // A disconnected speaker frees the séance for everyone else.
  const at = b.messages.length - 1 >= 0 ? a.messages.length : 0;
  b.socket.close();
  await new Promise(resolve => b.socket.on('close', resolve));
  await a.waitFor(m => m.type === 'state' && m.members.length === 1, at);
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  // No stop: the 350 ms cap ends the prise by itself and still produces a result.
  const result = await a.waitFor(m => m.type === 'voice' && m.state === 'result');
  assert.equal(result.text, '영화 안녕하세요.');
  assert.equal(service.sessions.length, 1);
  send(b, 'start', 'fr');
  const again = await b.waitFor(m => m.type === 'voice' && m.state === 'started');
  assert.ok(again);
});

test('a cancelled prise frees the lock, closes upstream and withdraws partials', async t => {
  const { admin, createRoom, join, open, voice, send, service } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'cancel-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  const started = await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  await a.settle();
  service.sessions[0].onText('영화 ');
  await b.waitFor(m => m.state === 'partial');
  send(a, 'cancel');
  // The pong settles after the cancel on the same socket: the lock is free,
  // the upstream session is closed and the shared partial is withdrawn.
  await a.settle();
  const withdrawn = await b.waitFor(m => m.state === 'withdrawn');
  assert.equal(withdrawn.utterance, started.utterance);
  assert.equal(service.sessions[0].closed, true);
  send(b, 'start', 'fr');
  const granted = await b.waitFor(m => m.state === 'started');
  assert.notEqual(granted.utterance, started.utterance);
  // The aborted phrase produced nothing: no result, no failure echo.
  assert.deepEqual(voice(a).map(m => m.state), ['started', 'partial', 'withdrawn']);
  assert.equal(voice(b).filter(m => m.state === 'result').length, 0);
});

test('silence and noise are refused locally before any provider session', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    patch: { voiceCooldown: 0, voiceQuota: 2 } });
  const room = await createRoom({ code: 'guard-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  const prise = async (pcm, terminal = 'failed') => {
    const since = a.messages.length;
    send(a, 'start', 'fr');
    await a.waitFor(m => m.state === 'started', since);
    a.socket.send(pcm);
    send(a, 'stop');
    return a.waitFor(m => m.state === terminal, since);
  };
  assert.equal((await prise(silence())).error, 'no-speech');
  assert.equal((await prise(noise())).error, 'no-speech');
  // Ni session ni quota consommés, rien n'a fuité vers la séance.
  assert.equal(service.sessions.length, 0);
  assert.equal(b.messages.filter(m => m.type === 'voice').length, 0);
  // Une phrase courte n'est pas bloquée par le garde-fou (#45) : deux trames
  // de 30 ms suffisent à ouvrir la session.
  await prise(tone(300, 2), 'result');
  assert.equal(service.sessions.length, 1);
  await prise(tone(), 'result');
  assert.equal(service.sessions.length, 2);
});

test('empty or direction-inconsistent output fails locally after the call', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    patch: { voiceCooldown: 0, voiceQuota: 20 } });
  const room = await createRoom({ code: 'reject-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  const prise = async (lang = 'fr') => {
    const since = a.messages.length;
    send(a, 'start', lang);
    await a.waitFor(m => m.state === 'started', since);
    a.socket.send(tone());
    send(a, 'stop');
    return a.waitFor(m => m.state === 'failed' || m.state === 'result', since);
  };
  // Aucune traduction produite : faute fournisseur, rien n'est diffusé.
  service.nextResult = null;
  const empty = await prise();
  assert.equal(empty.error, 'invalid-response');
  // Sens figé fr -> ko : une traduction sans Hangul ou une transcription en
  // Hangul contredit le sens choisi (#45), sans prétendre lire le français.
  for (const result of [
    { heard: 'Bonjour.', text: 'Bonjour.' },
    { heard: '안녕하세요.', text: '안녕.' },
  ]) {
    service.nextResult = result;
    const failed = await prise();
    assert.equal(failed.error, 'inconsistent', JSON.stringify(result));
  }
  // Sens inverse ko -> fr : le même contrôle de script dans l'autre sens.
  for (const result of [
    { heard: 'Bonjour.', text: 'On se retrouve.' },
    { heard: '안녕.', text: '안녕하세요.' },
  ]) {
    service.nextResult = result;
    const failed = await prise('ko');
    assert.equal(failed.error, 'inconsistent', JSON.stringify(result));
  }
  // Chaque session ouverte a consommé le quota (#45). L'invité n'a vu que
  // les partiels retirés ensuite : jamais d'état privé ni de résultat.
  assert.equal(service.sessions.length, 5);
  assert.equal(b.messages.filter(m => m.type === 'voice' && !['partial', 'withdrawn'].includes(m.state)).length, 0);
  // Une réponse cohérente dans le sens figé passe.
  delete service.nextResult;
  const ok = await prise();
  assert.equal(ok.state, 'result');
});

test('provider failures are local, close upstream and release the lock', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    timing: { processMs: 150 }, patch: { voiceCooldown: 0, voiceQuota: 10 } });
  const room = await createRoom({ code: 'fail-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  const prise = async () => {
    send(a, 'start', 'fr');
    await a.waitFor(m => m.state === 'started');
    a.socket.send(tone());
    await a.settle();
    send(a, 'stop');
  };
  // Panne amont pendant l'écoute : échec local, session refermée.
  await prise();
  service.sessions[0].onEnd(new Error('provider down'));
  const down = await a.waitFor(m => m.state === 'failed');
  assert.equal(down.error, 'provider');
  assert.equal(service.sessions[0].closed, true);
  // Panne pendant le traitement, après des partiels : retirés chez tous.
  await prise();
  service.sessions[1].onText('영화 ');
  await b.waitFor(m => m.state === 'partial');
  service.sessions[1].onEnd(new Error('provider down'));
  const downAgain = await a.waitFor(m => m.state === 'failed' && m.seq === 2);
  assert.equal(downAgain.error, 'provider');
  await b.waitFor(m => m.state === 'withdrawn' && m.seq === 2);
  // Le plafond de traitement referme la session amont elle-même (#46) : le
  // fournisseur continue d'émettre, le repos idle ne vient jamais.
  service.nextOpen = options => { const s = dripSession(options); service.sessions.push(s); return s; };
  await prise();
  const late = await a.waitFor(m => m.state === 'failed' && m.error === 'timeout');
  assert.ok(late);
  assert.equal(service.sessions[2].closed, true);
  // La séance repart : une prise saine produit son résultat partagé.
  delete service.nextOpen;
  await prise();
  const shared = await b.waitFor(m => m.type === 'voice' && m.state === 'result');
  assert.equal(shared.text, '영화 안녕하세요.');
});

test('quota and cooldown gate new prises per participant', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    patch: { voiceQuota: 1, voiceWindow: 60, voiceCooldown: 1 } });
  const room = await createRoom({ code: 'quota-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  send(a, 'stop');
  await a.waitFor(m => m.state === 'result');
  assert.equal(service.sessions.length, 1);
  // The cooldown follows every release, before quota is even checked.
  send(a, 'start', 'fr');
  const cooled = await a.waitFor(m => m.state === 'failed');
  assert.equal(cooled.error, 'cooldown');
  assert.ok(cooled.retryAfter > 0 && cooled.retryAfter <= 1);
  await new Promise(resolve => setTimeout(resolve, cooled.retryAfter * 1000 + 60));
  send(a, 'start', 'fr');
  const exhausted = await a.waitFor(m => m.state === 'failed' && m.error === 'quota');
  assert.ok(exhausted.retryAfter > 0 && exhausted.retryAfter <= 60);
  // The quota belongs to the participant: the other member can still speak.
  send(b, 'start', 'ko');
  await b.waitFor(m => m.state === 'started');
  // Une prise sans parole ne consomme pas le quota restant.
  b.socket.send(silence());
  send(b, 'stop');
  await b.waitFor(m => m.state === 'failed' && m.error === 'no-speech');
  assert.equal(service.sessions.length, 1);
});

test('malformed voice input is refused at the boundary', async t => {
  const { request, admin, createRoom, join, open, send } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'edge-room', voice: true });
  const plain = await createRoom({ code: 'plain-room' });
  const guest = await join(room.code);
  await request('/api/join', { cookie: guest, method: 'POST', body: { code: plain.code } });
  const a = await open(room.id, admin, 'Alex');
  const c = await open(plain.id, guest);
  // Audio on a room without the capability is dropped, not played back anywhere.
  c.socket.send(tone());
  send(c, 'start', 'fr');
  const unavailable = await c.waitFor(m => m.type === 'voice' && m.state === 'failed');
  assert.equal(unavailable.error, 'unavailable');
  // A direction outside the pair, or none, is refused before any lock or call.
  let since = a.messages.length;
  send(a, 'start', 'en');
  assert.equal((await a.waitFor(m => m.state === 'failed', since)).error, 'invalid');
  since = a.messages.length;
  send(a, 'start');
  assert.equal((await a.waitFor(m => m.state === 'failed', since)).error, 'invalid');
  // Frames without an active prise are dropped. A wrong-size frame aborts.
  a.socket.send(tone());
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started', since);
  a.socket.send(Buffer.alloc(500));
  const invalid = await a.waitFor(m => m.state === 'failed', since);
  assert.equal(invalid.error, 'invalid');
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started' && m.utterance !== undefined, a.messages.length);
  assert.ok(true);
});

test('a voice room without a configured service reports unavailable', async t => {
  const { admin, createRoom, open, send } = await boot(t, { service: null });
  const room = await createRoom({ code: 'noserv-room', voice: true });
  const a = await open(room.id, admin, 'Alex');
  // La capacité existe mais annonce le service absent plutôt que simulé.
  assert.equal(a.messages.find(m => m.type === 'welcome').voice.available, false);
  send(a, 'start');
  const failed = await a.waitFor(m => m.state === 'failed');
  assert.equal(failed.error, 'unavailable');
});

test('an active prise stays out of room state and nothing is persisted', async t => {
  const { request, admin, createRoom, open, send, dataDir } = await boot(t);
  const room = await createRoom({ code: 'state-room', voice: true });
  const a = await open(room.id, admin, 'Alex');
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  const during = await (await request(`/api/rooms/${room.id}`, { cookie: admin })).json();
  assert.deepEqual(during.voice, { enabled: true, pair: ['fr', 'ko'], available: true });
  assert.equal(JSON.stringify(during).includes('utterance'), false);
  a.socket.send(tone());
  send(a, 'stop');
  await a.waitFor(m => m.state === 'result');
  const after = await (await request(`/api/rooms/${room.id}`, { cookie: admin })).json();
  assert.equal(JSON.stringify(after).includes('utterance'), false);
  // The movie seed is the only file the séance ever wrote.
  assert.deepEqual(await readdir(path.join(dataDir, 'movies', 'eeeeeeee-1111-2222-3333-444444444444')), ['movie.json']);
  const extra = (await readdir(dataDir)).filter(name => name !== 'movies');
  assert.deepEqual(extra, ['uploads']);
});

test('voice logs stay metadata-only: pseudonymized room, no code or names', async t => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  t.after(() => { console.log = original; });
  const { admin, createRoom, join, open, send } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'log-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  send(b, 'start', 'ko');
  await b.waitFor(m => m.state === 'failed' && m.error === 'busy');
  a.socket.send(tone());
  send(a, 'stop');
  await a.waitFor(m => m.state === 'result');
  const voice = lines.filter(line => line.includes('voix'));
  assert.ok(voice.length >= 3);
  for (const line of voice) assert.match(line, /\[room [a-f0-9]{8}\] voix /, line);
  // Aucune ligne de la séance ne porte le code d'invitation ni un nom de
  // participant : signatures d'attente comprises.
  for (const line of lines) {
    assert.equal(line.includes('log-room'), false, line);
    assert.equal(line.includes('Alex'), false, line);
    assert.equal(line.includes('Minji'), false, line);
  }
});

test('audio buffers are zeroed and upstream closed on terminal states', async t => {
  const { admin, createRoom, join, open, send, service, hub } = await boot(t, {
    timing: { processMs: 150 }, patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'wipe-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  // Le pong confirme la trame rangée : les buffers d'origine sont observables
  // par référence avant que la session ne s'ouvre.
  const prise = async () => {
    send(a, 'start', 'fr');
    await a.waitFor(m => m.state === 'started');
    a.socket.send(tone());
    await a.settle();
    send(a, 'stop');
  };
  await prise();
  await a.waitFor(m => m.state === 'result');
  // Les trames envoyées au fournisseur sont elles-mêmes réduites à zéro.
  assert.ok(service.sessions[0].sent.length > 0);
  assert.ok(service.sessions[0].sent.every(chunk => chunk.every(byte => byte === 0)));
  assert.equal(service.sessions[0].closed, true);
  // Une prise refusée localement garde ses trames côté serveur : elles sont
  // observables par référence puis effacées à la libération.
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(silence());
  await a.settle();
  const buffered = [...(hub.get(room.id).utterance?.chunks ?? [])];
  send(a, 'stop');
  await a.waitFor(m => m.state === 'failed' && m.error === 'no-speech');
  assert.ok(buffered.length > 0);
  assert.ok(buffered.every(chunk => chunk.every(byte => byte === 0)));
  // Le plafond de traitement referme la session amont et efface l'audio.
  service.nextOpen = options => { const s = dripSession(options); service.sessions.push(s); return s; };
  await prise();
  delete service.nextOpen;
  await a.waitFor(m => m.state === 'failed' && m.error === 'timeout');
  assert.equal(service.sessions[1].closed, true);
  assert.ok(service.sessions[1].sent.every(chunk => chunk.every(byte => byte === 0)));
  // Une déconnexion pendant l'écoute referme la session encore ouverte (#46).
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  await a.settle();
  const since = b.messages.length;
  a.socket.close();
  await b.waitFor(m => m.type === 'state' && m.members.length === 1, since);
  assert.equal(service.sessions[2].closed, true);
});

test('binary traffic is bounded per socket while healthy frames and JSON flow', async t => {
  const { admin, createRoom, join, open, send, service, hub } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'flood-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  // Un flux sain : une rafale de 60 trames de 30 ms bien formées reste sous
  // le budget de 100/s et la prise produit son résultat.
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started');
  for (let i = 0; i < 60; i++) a.socket.send(tone(300, 1));
  send(a, 'stop');
  await a.waitFor(m => m.state === 'result');
  assert.equal(service.sessions.length, 1);
  // Un JSON invalide reste une erreur locale sans fermer le socket.
  a.socket.send('not json');
  await a.waitFor(m => m.type === 'error');
  await a.settle();
  // Une rafale binaire hors écoute dépasse le budget : fermeture propre 1008.
  const flooded = new Promise(resolve => b.socket.on('close', code => resolve(code)));
  for (let i = 0; i < 120; i++) b.socket.send(tone(300, 1));
  assert.equal(await flooded, 1008);
  // Le socket de l'autre participant et la séance ne bougent pas.
  await a.settle();
  // Une trame au-delà du maxPayload (8 Kio) est refermée par le transport.
  const oversized = new Promise(resolve => a.socket.on('close', code => resolve(code)));
  a.socket.send(Buffer.alloc(8193));
  assert.equal(await oversized, 1009);
  // La séance est intacte : un nouveau socket la rejoint normalement.
  const c = await open(room.id, guest);
  assert.ok(c.messages.find(m => m.type === 'welcome'));
  assert.ok(hub.get(room.id));
});
