import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, bufferEnd } from '../public/sync-player.js';

test('clock estimates offset using the shortest round trip and expires old samples', () => {
  const clock = new Clock();
  clock.sample(100, 140, 1120); clock.sample(200, 220, 1210); clock.sample(300, 380, 1340);
  assert.equal(clock.offset, 1000); assert.equal(clock.ready, true);
  clock.sample(30_000, 30_020, 32_010);
  assert.equal(clock.offset, 2000); assert.equal(clock.ready, false);
});
test('buffer measurement never counts ranges beyond a gap', () => {
  const video = { currentTime: 2, buffered: { length: 2, start: i => [0, 20][i], end: i => [4, 60][i] } };
  assert.equal(bufferEnd(video), 4);
  video.currentTime = 10; assert.equal(bufferEnd(video), 10);
});
