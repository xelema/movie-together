import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, FIELDS } from '../src/settings.js';

test('defaults come from the registry, env can raise them', () => {
  const plain = createSettings({ env: {} });
  assert.equal(plain.get('minBuffer'), 8);
  assert.equal(plain.get('maxMovieGb'), 20);
  const tuned = createSettings({ env: { MIN_BUFFER_SECONDS: '20', ENCODE_THREADS: '6' } });
  assert.equal(tuned.get('minBuffer'), 20);
  assert.equal(tuned.get('encodeThreads'), 6);
  // Out-of-bounds or malformed env falls back to the built-in default.
  const bad = createSettings({ env: { MIN_BUFFER_SECONDS: '9999', ENCODE_THREADS: 'x' } });
  assert.equal(bad.get('minBuffer'), 8);
  assert.equal(bad.get('encodeThreads'), 2);
  // An env pair that breaks a cross-field rule reverts both keys.
  const skewed = createSettings({ env: { MIN_BUFFER_SECONDS: '4', LOW_BUFFER_SECONDS: '9' } });
  assert.equal(skewed.get('minBuffer'), 8);
  assert.equal(skewed.get('lowBuffer'), 3);
});

test('saved overrides win over env defaults until reset', () => {
  const s = createSettings({ env: { MIN_BUFFER_SECONDS: '20' }, saved: { minBuffer: 12, junk: 1, lowBuffer: 'x' } });
  assert.equal(s.get('minBuffer'), 12);
  assert.equal(s.get('lowBuffer'), 3);
  assert.equal(s.get('maxRooms'), 20);
  assert.deepEqual(s.overrides(), { minBuffer: 12 });
  s.reset();
  assert.equal(s.get('minBuffer'), 20);
  assert.deepEqual(s.overrides(), {});
});

test('a saved file from the flat thresholds era still loads', () => {
  const s = createSettings({ env: {}, saved: { minBuffer: 30, lowBuffer: 10 } });
  assert.equal(s.get('minBuffer'), 30);
  assert.equal(s.get('lowBuffer'), 10);
});

test('update validates strictly and rejects atomically', () => {
  const s = createSettings({ env: {} });
  // A non-object body is a malformed patch, not a crash or a silent no-op.
  for (const bad of [null, 'x', 5, [1]]) {
    assert.throws(() => s.update(bad), /Réglages invalides/, JSON.stringify(bad));
  }
  assert.throws(() => s.update({ nope: 1 }), /Réglage inconnu/);
  for (const bad of [{ minBuffer: 500 }, { minBuffer: 8.5 }, { minBuffer: 'x' },
    { startDelay: 40 }, { maxSubtitleMb: 2.3 }, { tickMs: 10 }]) {
    assert.throws(() => s.update(bad), /invalide/i, JSON.stringify(bad));
  }
  assert.equal(s.get('minBuffer'), 8);
  // Cross-field rules check the merged result, not only the patch.
  s.update({ lowBuffer: 6 });
  assert.throws(() => s.update({ minBuffer: 6 }), /Seuils invalides/);
  assert.equal(s.get('minBuffer'), 8);
  s.update({ minBuffer: 30 });
  assert.equal(s.get('minBuffer'), 30);
  assert.equal(s.get('lowBuffer'), 6);
  // reportTimeout is the ceiling for startDelay.
  assert.throws(() => s.update({ reportTimeout: 1 }), /délai de départ/);
  assert.equal(s.get('reportTimeout'), 3);
});

test('describe exposes bounds, defaults and override flags for the admin UI', () => {
  const s = createSettings({ env: { MIN_BUFFER_SECONDS: '20' }, saved: { lowBuffer: 4 } });
  const fields = Object.fromEntries(s.describe().map(field => [field.key, field]));
  assert.equal(fields.minBuffer.default, 20);
  assert.equal(fields.minBuffer.dynamic, true);
  assert.equal(fields.minBuffer.overridden, false);
  assert.equal(fields.lowBuffer.overridden, true);
  assert.equal(fields.lowBuffer.value, 4);
  assert.equal(s.describe().length, Object.keys(FIELDS).length);
});
