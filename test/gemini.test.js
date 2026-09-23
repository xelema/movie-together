import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceService } from '../src/voice.js';

// Contract seam: the injected fetchImpl stands for the network, so the test
// observes the one request the service sends and its decoding, never a wire.
const ok = result => ({ ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }) });

test('a missing server key means no service: unavailable, never simulated', () => {
  assert.equal(createVoiceService({ env: {} }), null);
  assert.equal(createVoiceService({ env: { UNRELATED: 'x' } }), null);
  assert.ok(createVoiceService({ env: { GEMINI_API_KEY: 'k' }, fetchImpl: async () => ok({}) }));
  assert.ok(createVoiceService({ env: { GOOGLE_API_KEY: 'k' }, fetchImpl: async () => ok({}) }));
});

test('one generateContent request carries the audio and the output contract', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return ok({ text: 'Bonjour le film.', translation: '영화 안녕하세요.' });
  };
  const service = createVoiceService({ env: { GEMINI_API_KEY: 'secret-key' }, fetchImpl });
  const pcm = Buffer.from([7, 1, 2, 3]);
  const result = await service.translate(pcm, { source: 'fr', target: 'ko' });
  assert.deepEqual(result, { text: 'Bonjour le film.', translation: '영화 안녕하세요.' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], 'secret-key');
  const body = JSON.parse(init.body);
  assert.equal(body.contents.length, 1);
  const audio = body.contents[0].parts.find(part => part.inlineData);
  assert.equal(audio.inlineData.mimeType, 'audio/wav');
  // Le conteneur WAV déclare le PCM s16 mono 16 kHz et conserve la charge
  // utile identique, octet pour octet.
  const wav = Buffer.from(audio.inlineData.data, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.ok(wav.subarray(44).equals(pcm));
  // Le prompt porte le sens figé : source française, cible coréenne, sans
  // demande de détection ni de certitude au modèle.
  const prompt = body.contents[0].parts.find(part => typeof part.text === 'string')?.text ?? '';
  assert.match(prompt, /French/);
  assert.match(prompt, /Korean/);
  assert.doesNotMatch(prompt, /[Dd]etect/);
  const config = body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseSchema.required, ['text', 'translation']);
  assert.deepEqual(Object.keys(config.responseSchema.properties).sort(), ['text', 'translation']);
});

test('the model choice stays server-side and overridable by env', async () => {
  const calls = [];
  const service = createVoiceService({
    env: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-test-model' },
    fetchImpl: async url => { calls.push(url); return ok({ text: '안녕.', translation: 'Salut.' }); },
  });
  await service.translate(Buffer.alloc(4), { source: 'ko', target: 'fr' });
  assert.equal(calls[0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
});

test('provider errors and malformed payloads reject', async () => {
  const direction = { source: 'fr', target: 'ko' };
  const down = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(() => down.translate(Buffer.alloc(4), direction));
  const weird = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(() => weird.translate(Buffer.alloc(4), direction));
  const broken = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }) });
  await assert.rejects(() => broken.translate(Buffer.alloc(4), direction));
});
