import test from 'node:test';
import assert from 'node:assert/strict';
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
