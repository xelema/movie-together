import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';

// Fake translation provider: one call per prise returns the source transcript
// and the final translation together (#44). `nextTranslate` steers the answer,
// calls are counted in `translated` with the frozen direction they received.
const fakeService = () => {
  const service = { translated: [] };
  service.translate = async (pcm, options) => {
    service.translated.push({ bytes: pcm.length, pcm, ...options });
    if (service.nextTranslate) return service.nextTranslate();
    return options.source === 'ko'
      ? { text: '엔딩에서 만나요.', translation: 'On se retrouve au générique.' }
      : { text: 'Bonjour le film.', translation: '영화 안녕하세요.' };
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
    origin, env: {}, voiceService: service, voiceTiming: timing });
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
  // réel ; le serveur la fige en sens source -> cible (#44).
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
  // The second participant only learns the phrase exists at the final result.
  send(b, 'start', 'ko');
  const refused = await b.waitFor(m => m.type === 'voice' && m.state === 'failed');
  assert.equal(refused.error, 'busy');
  a.socket.send(tone());
  send(a, 'stop');
  const understood = await a.waitFor(m => m.type === 'voice' && m.state === 'understood');
  assert.equal(understood.text, 'Bonjour le film.');
  assert.equal(understood.utterance, started.utterance);
  // Le fournisseur a reçu le sens figé par la langue d'interface d'Alex.
  assert.equal(service.translated[0].source, 'fr');
  assert.equal(service.translated[0].target, 'ko');
  const [aResult, bResult] = await Promise.all([
    a.waitFor(m => m.type === 'voice' && m.state === 'result'),
    b.waitFor(m => m.type === 'voice' && m.state === 'result'),
  ]);
  assert.equal(bResult.text, '영화 안녕하세요.');
  assert.equal(bResult.speaker, 'Alex');
  assert.equal(bResult.utterance, started.utterance);
  assert.equal(bResult.seq, started.seq);
  // Guests receive no intermediate state and no transcript.
  assert.equal(voice(b).filter(m => ['started', 'understood', 'failed'].includes(m.state)).length, 1);
  assert.equal(voice(b)[0].state, 'failed');
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
  send(b, 'stop');
  const understoodKo = await b.waitFor(m => m.state === 'understood');
  assert.equal(understoodKo.text, '엔딩에서 만나요.');
  const koResult = await a.waitFor(m => m.type === 'voice' && m.state === 'result' && m.speaker === 'Minji');
  assert.equal(koResult.text, 'On se retrouve au générique.');
  assert.equal(service.translated.at(-1).source, 'ko');
  assert.equal(service.translated.at(-1).target, 'fr');
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
  assert.equal(service.translated.length, 1);
  send(b, 'start', 'fr');
  const again = await b.waitFor(m => m.type === 'voice' && m.state === 'started');
  assert.ok(again);
});

test('a cancelled prise frees the lock and never reaches the room', async t => {
  const { admin, createRoom, join, open, voice, send, service } = await boot(t, { patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'cancel-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  send(a, 'start', 'fr');
  const started = await a.waitFor(m => m.state === 'started');
  a.socket.send(tone());
  send(a, 'cancel');
  // The pong settles after the cancel on the same socket: the lock is free.
  await a.settle();
  send(b, 'start', 'fr');
  const granted = await b.waitFor(m => m.state === 'started');
  assert.notEqual(granted.utterance, started.utterance);
  // The aborted phrase produced nothing: no result, no failure echo, and the
  // provider never saw its audio.
  assert.deepEqual(voice(a).map(m => m.state), ['started']);
  assert.deepEqual(voice(b).map(m => m.state), ['started']);
  assert.equal(service.translated.length, 0);
});

test('silence and noise are refused locally before any provider call', async t => {
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
  // Neither prise reached the provider nor leaked to the room, so the quota
  // is intact for real phrases.
  assert.equal(service.translated.length, 0);
  assert.equal(b.messages.filter(m => m.type === 'voice').length, 0);
  // Une phrase courte n'est pas bloquée par le garde-fou (#45) : deux trames
  // de 30 ms suffisent à déclencher l'appel.
  await prise(tone(300, 2), 'result');
  assert.equal(service.translated.length, 1);
  await prise(tone(), 'result');
  assert.equal(service.translated.length, 2);
});

test('malformed or direction-inconsistent answers fail locally after the call', async t => {
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
    return a.waitFor(m => m.state === 'failed' || m.state === 'understood', since);
  };
  // Champ absent, vide, non textuel ou hors borne : faute fournisseur, jamais
  // de langue, de cible ni de certitude déclarées à valider.
  for (const result of [
    null,
    { text: 'Bonjour.' },
    { translation: '안녕.' },
    { text: '', translation: '안녕.' },
    { text: 'Bonjour.', translation: '' },
    { text: 'x'.repeat(2001), translation: '안녕.' },
    { text: 42, translation: '안녕.' },
  ]) {
    service.nextTranslate = () => result;
    const failed = await prise();
    assert.equal(failed.state, 'failed', JSON.stringify(result));
    assert.equal(failed.error, 'invalid-response', JSON.stringify(result));
  }
  // Sens figé fr -> ko : une traduction sans Hangul ou une transcription en
  // Hangul contredit le sens choisi (#45), sans prétendre lire le français.
  for (const result of [
    { text: 'Bonjour.', translation: 'Bonjour.' },
    { text: '안녕하세요.', translation: '안녕.' },
  ]) {
    service.nextTranslate = () => result;
    const failed = await prise();
    assert.equal(failed.state, 'failed', JSON.stringify(result));
    assert.equal(failed.error, 'inconsistent', JSON.stringify(result));
  }
  // Sens inverse ko -> fr : le même contrôle de script dans l'autre sens.
  for (const result of [
    { text: 'Bonjour.', translation: 'On se retrouve.' },
    { text: '안녕.', translation: '안녕하세요.' },
  ]) {
    service.nextTranslate = () => result;
    const failed = await prise('ko');
    assert.equal(failed.state, 'failed', JSON.stringify(result));
    assert.equal(failed.error, 'inconsistent', JSON.stringify(result));
  }
  // Every call actually sent consumed quota (#45); nothing reached the room.
  assert.equal(service.translated.length, 11);
  assert.equal(b.messages.filter(m => m.type === 'voice').length, 0);
  // Une réponse cohérente dans le sens figé passe : transcription coréenne à
  // l'orateur, traduction française à tous.
  delete service.nextTranslate;
  const last = a.messages.length;
  send(a, 'start', 'ko');
  await a.waitFor(m => m.state === 'started', last);
  a.socket.send(tone());
  send(a, 'stop');
  const understood = await a.waitFor(m => m.state === 'understood', last);
  assert.equal(understood.text, '엔딩에서 만나요.');
  await b.waitFor(m => m.type === 'voice' && m.state === 'result' && m.text === 'On se retrouve au générique.');
});

test('provider failures are local and release the lock for the next prise', async t => {
  const { admin, createRoom, join, open, send, service } = await boot(t, {
    timing: { processMs: 120 }, patch: { voiceCooldown: 0, voiceQuota: 10 } });
  const room = await createRoom({ code: 'fail-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  const prise = async () => {
    send(a, 'start', 'fr');
    await a.waitFor(m => m.state === 'started');
    a.socket.send(tone());
    send(a, 'stop');
  };
  service.nextTranslate = () => { throw new Error('provider down'); };
  await prise();
  const down = await a.waitFor(m => m.state === 'failed');
  assert.equal(down.error, 'provider');
  service.nextTranslate = () => ({ text: 42 });
  await prise();
  const malformed = await a.waitFor(m => m.state === 'failed' && m.error === 'invalid-response');
  assert.ok(malformed);
  service.nextTranslate = () => new Promise(resolve => setTimeout(() => resolve({ text: 'tard', translation: 'tard' }), 500));
  await prise();
  const late = await a.waitFor(m => m.state === 'failed' && m.error === 'timeout');
  assert.ok(late);
  // A late provider answer is dropped: the lock is free and the room sees no result.
  delete service.nextTranslate;
  await prise();
  const [fresh, shared] = await Promise.all([
    a.waitFor(m => m.state === 'result'),
    b.waitFor(m => m.type === 'voice' && m.state === 'result'),
  ]);
  assert.equal(shared.text, '영화 안녕하세요.');
  assert.equal(b.messages.filter(m => m.type === 'voice' && m.state === 'result').length, 1);
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
  assert.equal(service.translated.length, 1);
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
  // Frames without an active prise are dropped; a wrong-size frame aborts.
  a.socket.send(tone());
  send(a, 'start', 'fr');
  await a.waitFor(m => m.state === 'started', since);
  a.socket.send(Buffer.alloc(500));
  const invalid = await a.waitFor(m => m.state === 'failed', since);
  assert.equal(invalid.error, 'invalid');
  send(a, 'stop');
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

test('audio buffers are zeroed on terminal states, including late results', async t => {
  const { admin, createRoom, join, open, send, service, hub } = await boot(t, {
    timing: { processMs: 120 }, patch: { voiceCooldown: 0 } });
  const room = await createRoom({ code: 'wipe-room', voice: true });
  const guest = await join(room.code);
  const a = await open(room.id, admin, 'Alex');
  const b = await open(room.id, guest, 'Minji');
  // Le pong confirme la trame rangée : les buffers d'origine sont observables
  // par référence avant que la prise ne passe en traitement.
  const prise = async () => {
    send(a, 'start', 'fr');
    await a.waitFor(m => m.state === 'started');
    a.socket.send(tone());
    await a.settle();
    const chunks = [...(hub.get(room.id).utterance?.chunks ?? [])];
    send(a, 'stop');
    return chunks;
  };
  const first = await prise();
  await a.waitFor(m => m.state === 'result');
  assert.ok(service.translated[0].pcm.every(byte => byte === 0));
  // Les trames reçues sont elles-mêmes réduites à zéro dès la concaténation.
  assert.ok(first.length > 0);
  assert.ok(first.every(chunk => chunk.every(byte => byte === 0)));
  // A provider answer past the processing cap finds an already-zeroed buffer
  // and its result is dropped, never broadcast.
  service.nextTranslate = () => new Promise(resolve => setTimeout(() => resolve({ text: 'tard', translation: 'tard' }), 400));
  const late = await prise();
  await a.waitFor(m => m.state === 'failed' && m.error === 'timeout');
  assert.ok(service.translated[1].pcm.every(byte => byte === 0));
  assert.ok(late.every(chunk => chunk.every(byte => byte === 0)));
  // Une prise libérée pendant le traitement perd aussi sa copie concaténée.
  const third = await prise();
  const since = b.messages.length;
  a.socket.close();
  await b.waitFor(m => m.type === 'state' && m.members.length === 1, since);
  assert.ok(service.translated[2].pcm.every(byte => byte === 0));
  assert.ok(third.every(chunk => chunk.every(byte => byte === 0)));
});
