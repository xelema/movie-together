import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, bufferEnd, SyncPlayer } from '../public/sync-player.js';

test('clock estimates offset using the shortest round trip and expires old samples', () => {
  const clock = new Clock();
  clock.sample(100, 140, 1120); clock.sample(200, 220, 1210); clock.sample(300, 380, 1340);
  assert.equal(clock.offset, 1000); assert.equal(clock.ready, true);
  clock.sample(30_000, 30_020, 32_010);
  assert.equal(clock.offset, 2000); assert.equal(clock.ready, false);
});

test('keeps audio at normal speed and pauses the group for excessive drift', t => {
  const previous = globalThis.document;
  globalThis.document = { hidden: false };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let stopped = false, reported = false;
  const player = Object.assign(Object.create(SyncPlayer.prototype), {
    state: { phase: 'playing', startsAt: 0 }, clock: { ready: true }, lastMessage: performance.now(),
    serverTime: () => 1000, target: () => 10, offset: 0,
    video: { paused: false, currentTime: 9.8, playbackRate: 1 },
    pauseLocal: () => { stopped = true; }, report: force => { reported = force === false; },
  });
  player.reconcile();
  assert.equal(player.video.playbackRate, 1); assert.equal(stopped, false);
  player.video.currentTime = 9.5; player.reconcile();
  assert.equal(stopped, true); assert.equal(reported, true);
});
test('buffer measurement never counts ranges beyond a gap', () => {
  const video = { currentTime: 2, buffered: { length: 2, start: i => [0, 20][i], end: i => [4, 60][i] } };
  assert.equal(bufferEnd(video), 4);
  video.currentTime = 10; assert.equal(bufferEnd(video), 10);
});
