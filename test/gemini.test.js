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
    return ok({ language: 'fr', text: 'Bonjour le film.', translation: '영화 안녕하세요.' });
  };
  const service = createVoiceService({ env: { GEMINI_API_KEY: 'secret-key' }, fetchImpl });
  const pcm = Buffer.from([7, 1, 2, 3]);
  const result = await service.translate(pcm, { pair: ['fr', 'ko'] });
  assert.deepEqual(result, { language: 'fr', text: 'Bonjour le film.', translation: '영화 안녕하세요.' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], 'secret-key');
  const body = JSON.parse(init.body);
  assert.equal(body.contents.length, 1);
  const audio = body.contents[0].parts.find(part => part.inlineData);
  assert.equal(audio.inlineData.mimeType, 'audio/L16;codec=pcm;rate=16000');
  assert.ok(Buffer.from(audio.inlineData.data, 'base64').equals(pcm));
  assert.ok(body.contents[0].parts.some(part => typeof part.text === 'string' && part.text.length));
  const config = body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseSchema.required, ['language', 'text', 'translation']);
});

test('the model choice stays server-side and overridable by env', async () => {
  const calls = [];
  const service = createVoiceService({
    env: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-test-model' },
    fetchImpl: async url => { calls.push(url); return ok({ language: 'ko', text: '안녕.', translation: 'Salut.' }); },
  });
  await service.translate(Buffer.alloc(4), { pair: ['fr', 'ko'] });
  assert.equal(calls[0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
});

test('provider errors and malformed payloads reject', async () => {
  const pair = { pair: ['fr', 'ko'] };
  const down = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(() => down.translate(Buffer.alloc(4), pair));
  const weird = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(() => weird.translate(Buffer.alloc(4), pair));
  const broken = createVoiceService({ env: { GEMINI_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }) });
  await assert.rejects(() => broken.translate(Buffer.alloc(4), pair));
});
