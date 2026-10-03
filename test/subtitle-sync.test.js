import test from 'node:test';
import assert from 'node:assert/strict';
import { findOffset } from '../src/subtitle-sync.js';

// Signaux de synthèse déterministes, sans E/S : des prises de parole
// régulières avec un jitter fixe (jamais d'aléatoire, jamais de période
// exacte — un motif pur rendrait plusieurs décalages équivalents).
const speechTrack = (count = 60, step = 4) => Array.from({ length: count }, (_, index) => {
  const start = 2 + index * step + (index * 7919 % 100) / 100;
  return { start, end: start + 1.2 + (index * 104729 % 100) / 200 };
});
const shifted = (intervals, delta) => intervals.map(({ start, end }) => ({ start: start + delta, end: end + delta }));

test('findOffset finds ~0 when cues already sit on speech', () => {
  const speech = speechTrack();
  const result = findOffset({ cues: shifted(speech, 0), speech, duration: 300 });
  assert.ok(Math.abs(result.offset) <= 0.02, `offset=${result.offset}`);
  assert.equal(result.confidence, 'high');
});

test('findOffset recovers a known shift of +5.5 s and -5.5 s', () => {
  const speech = speechTrack();
  for (const delta of [5.5, -5.5]) {
    const result = findOffset({ cues: shifted(speech, -delta), speech, duration: 320 });
    assert.ok(Math.abs(result.offset - delta) <= 0.02, `delta=${delta} → ${result.offset}`);
  }
});

test('findOffset answers no-speech when the mask is silent', () => {
  const speech = [{ start: 10, end: 12 }];
  const result = findOffset({ cues: speechTrack(30), speech, duration: 300 });
  assert.equal(result.offset, null);
  assert.equal(result.reason, 'no-speech');
  assert.equal(result.confidence, 'low');
});

test('findOffset answers too-few-cues below ten cues', () => {
  const speech = speechTrack();
  const result = findOffset({ cues: shifted(speech, 0).slice(0, 5), speech, duration: 300 });
  assert.equal(result.offset, null);
  assert.equal(result.reason, 'too-few-cues');
});

test('findOffset calls an ambiguous match low confidence', () => {
  // Motif strictement périodique : décaler d'une période colle aussi bien.
  const speech = Array.from({ length: 14 }, (_, index) => ({ start: 10 + index * 30, end: 12 + index * 30 }));
  const result = findOffset({ cues: speech.slice(0, 13), speech, duration: 440 });
  assert.equal(result.confidence, 'low');
});

test('findOffset agreement collapses when only half the film is shifted', () => {
  const speech = speechTrack(80, 4);
  const half = Math.floor(speech.length / 2);
  const cues = [...shifted(speech.slice(0, half), -5), ...speech.slice(half)];
  const result = findOffset({ cues, speech, duration: 340 });
  assert.ok(result.agreement !== null && result.agreement < 0.75, `agreement=${result.agreement}`);
  assert.notEqual(result.confidence, 'high');
});
