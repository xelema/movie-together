import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceService } from '../src/voice.js';

// Contract seam: the injected connect() stands for the network and returns a
// fake socket that records outgoing frames and lets the test play the server.
// The key never leaves the signed URL: errors stay generic by construction.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.terminated = false; }
  send(data) { this.sent.push(JSON.parse(data)); }
  terminate() { this.terminated = true; }
  serve(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
}

const fakeService = env => {
  const sockets = [], urls = [];
  const service = createVoiceService({ env, connect: url => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  return { service, sockets, urls };
};

const ready = socket => { socket.emit('open'); socket.serve({ setupComplete: {} }); };

test('a missing server key means no service: unavailable, never simulated', () => {
  assert.equal(createVoiceService({ env: {} }), null);
  assert.equal(createVoiceService({ env: { UNRELATED: 'x' } }), null);
  assert.ok(fakeService({ GEMINI_API_KEY: 'k' }).service);
  assert.ok(fakeService({ GOOGLE_API_KEY: 'k' }).service);
});

test('opening a session sends the Live Translate setup once connected', () => {
  const { service, sockets, urls } = fakeService({ GEMINI_API_KEY: 'secret-key' });
  service.openSession({ source: 'fr', target: 'ko' });
  assert.equal(urls.length, 1);
  // La clé signe l'URL du BidiGenerateContent v1beta, point unique d'appel.
  assert.match(urls[0], /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/.*BidiGenerateContent\?key=secret-key$/);
  const socket = sockets[0];
  assert.equal(socket.sent.length, 0);
  socket.emit('open');
  assert.equal(socket.sent.length, 1);
  const setup = socket.sent[0].setup;
  assert.equal(setup.model, 'models/gemini-3.5-live-translate-preview');
  // Forme mesurée sur la vraie poignée de main (sans audio) : la traduction
  // niche dans generationConfig, les transcriptions au niveau setup. Les
  // deux autres placements sont refusés en 1007 champ inconnu.
  assert.deepEqual(setup.generationConfig, {
    responseModalities: ['AUDIO'],
    translationConfig: { targetLanguageCode: 'ko', echoTargetLanguage: false },
  });
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.equal(setup.translationConfig, undefined);
  // La poignée de main acceptée n'a que ces cinq clés : toute clé en plus
  // au niveau setup est une régression (cf. translationConfig refusé).
  assert.deepEqual(Object.keys(setup).sort(),
    ['generationConfig', 'inputAudioTranscription', 'model', 'outputAudioTranscription', 'systemInstruction']);
  // Consigne sobre : registre familier et fidélité, jamais le contexte du film.
  const prompt = setup.systemInstruction.parts[0].text;
  assert.match(prompt, /banmal/);
  assert.doesNotMatch(prompt, /movie|film/i);
});

test('the direction and the model stay server-side and overridable by env', () => {
  const { service, sockets, urls } = fakeService({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-test-model' });
  service.openSession({ source: 'ko', target: 'fr' });
  sockets[0].emit('open');
  const setup = sockets[0].sent[0].setup;
  assert.equal(setup.model, 'models/gemini-test-model');
  assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, 'fr');
  assert.match(setup.systemInstruction.parts[0].text, /French/);
  assert.equal(urls.length, 1);
});

test('audio captured during the handshake bursts out once setup completes', () => {
  const { service, sockets } = fakeService({ GEMINI_API_KEY: 'k' });
  const session = service.openSession({ source: 'fr', target: 'ko' });
  const socket = sockets[0];
  const pcm = Buffer.from([7, 1, 2, 3]);
  session.send(pcm);
  socket.emit('open');
  session.send(Buffer.from([9, 9]));
  // Rien ne part avant setupComplete : la file se vide ensuite d'un coup.
  assert.equal(socket.sent.length, 1);
  socket.serve({ setupComplete: {} });
  assert.equal(socket.sent.length, 3);
  const [first, second] = socket.sent.slice(1);
  assert.equal(first.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(Buffer.from(first.realtimeInput.audio.data, 'base64'), pcm);
  assert.deepEqual(Buffer.from(second.realtimeInput.audio.data, 'base64'), Buffer.from([9, 9]));
  // La copie de la file est indépendante : effacer la trame d'origine n'y
  // touche pas (déjà vérifié ci-dessus, pcm intact après envoi).
  assert.deepEqual(pcm, Buffer.from([7, 1, 2, 3]));
});

test('flush pushes two seconds of silence at once to close the phrase', () => {
  const { service, sockets } = fakeService({ GEMINI_API_KEY: 'k' });
  const session = service.openSession({ source: 'fr', target: 'ko' });
  const socket = sockets[0];
  ready(socket);
  session.flush();
  const frames = socket.sent.slice(1).map(frame => frame.realtimeInput.audio);
  const bytes = frames.reduce((total, frame) => total + Buffer.from(frame.data, 'base64').length, 0);
  // 2 s de silence s16 mono 16 kHz, en morceaux de 50 ms, sans attendre.
  assert.equal(bytes, 16000 * 2 * 2);
  assert.equal(frames.length, 40);
  for (const frame of frames) assert.ok(Buffer.from(frame.data, 'base64').every(byte => byte === 0));
});

test('server content routes transcription and translation to their callbacks', () => {
  const { service, sockets } = fakeService({ GEMINI_API_KEY: 'k' });
  const session = service.openSession({ source: 'fr', target: 'ko' });
  const texts = [], sources = [];
  session.onText = chunk => texts.push(chunk);
  session.onSource = chunk => sources.push(chunk);
  const socket = sockets[0];
  ready(socket);
  socket.serve({ serverContent: { outputTranscription: { text: '안녕 ' } } });
  socket.serve({ serverContent: { inputTranscription: { text: 'Salut ' } } });
  socket.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'xx' } }] } } });
  socket.serve({ serverContent: { outputTranscription: { text: '씨.' } } });
  socket.serve({ serverContent: { turnComplete: true } });
  assert.deepEqual(texts, ['안녕 ', '씨.']);
  assert.deepEqual(sources, ['Salut ']);
});

test('provider errors and closes reach onEnd, always without the key', () => {
  const { service, sockets } = fakeService({ GEMINI_API_KEY: 'very-secret' });
  const ends = [];
  const session = service.openSession({ source: 'fr', target: 'ko' });
  session.onEnd = error => ends.push(error);
  const socket = sockets[0];
  socket.emit('error', new Error('socket failed'));
  assert.equal(ends.length, 1);
  assert.equal(ends[0].message, 'provider error');
  assert.equal(JSON.stringify(ends).includes('very-secret'), false);
  // Une fois terminée la session n'émet plus rien.
  socket.emit('close');
  assert.equal(ends.length, 1);
  // Erreur applicative : même traitement générique.
  const again = [];
  const second = service.openSession({ source: 'fr', target: 'ko' });
  second.onEnd = error => again.push(error);
  sockets[1].serve({ error: { code: 1007, message: 'quota near very-secret' } });
  assert.equal(again[0].message, 'provider error');
  // Fermeture distante propre : fin sans erreur.
  const clean = [];
  const third = service.openSession({ source: 'fr', target: 'ko' });
  third.onEnd = error => clean.push(error);
  sockets[2].emit('close');
  assert.deepEqual(clean, [null]);
});

test('close() terminates the upstream socket and idempotent sends stop', () => {
  const { service, sockets } = fakeService({ GEMINI_API_KEY: 'k' });
  const session = service.openSession({ source: 'fr', target: 'ko' });
  const socket = sockets[0];
  ready(socket);
  session.close();
  assert.equal(socket.terminated, true);
  session.send(Buffer.alloc(4));
  session.flush();
  assert.equal(socket.sent.length, 1); // le setup seul est parti
});
