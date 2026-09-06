import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/sync/room.js';

function setup() {
  let time = 0;
  const room = new Room({ now: () => time });
  room.join('a'); room.join('b'); room.load(120);
  const command = (type, position) => room.command('a', { epoch: room.epoch, type, position });
  const report = (id, options = {}) => room.report(id, {
    epoch: room.epoch, sequence: (room.members.get(id).sequence ?? -1) + 1,
    position: room.positionAt(), bufferedUntil: 60, ready: true, ackStartsAt: room.startsAt, ...options,
  });
  const start = () => { command('play'); report('a'); report('b'); report('a'); report('b'); };
  return { room, command, report, start, advance: ms => { time += ms; } };
}

test('waits for every participant and schedules a shared future start', () => {
  const { room, command, report, advance } = setup();
  command('play'); report('a');
  assert.equal(room.phase, 'buffering');
  report('b');
  assert.equal(room.startsAt, 1000);
  report('a'); report('b');
  advance(500); assert.equal(room.positionAt(), 0);
  advance(1000); assert.equal(room.positionAt(), 0.5);
});

test('low buffer pauses everyone and invalidates old readiness', () => {
  const { room, report, start, advance } = setup();
  start(); advance(2000);
  report('b', { bufferedUntil: 2 });
  assert.equal(room.phase, 'buffering');
  assert.equal(room.position, 1);
  report('b'); assert.equal(room.phase, 'buffering');
  report('a'); assert.equal(room.phase, 'playing');
  assert.equal(room.startsAt, 3000);
});

test('either participant can pause and readiness does not undo an explicit pause', () => {
  const { room, report, start } = setup(); start();
  room.command('b', { epoch: room.epoch, type: 'pause' });
  report('a'); report('b'); assert.equal(room.phase, 'paused');
});

test('seek rejects stale reports and commands, and waits for both seeks to complete', () => {
  const { room, command, report, start } = setup(); start();
  const epoch = room.epoch;
  command('seek', 40);
  report('a', { epoch }); report('b', { position: 0 });
  assert.equal(room.phase, 'buffering');
  room.command('a', { epoch, type: 'seek', position: 10 });
  assert.equal(room.position, 40);
  report('a'); report('b'); assert.equal(room.phase, 'playing');
});

test('missing heartbeats pause playback even without new network messages', () => {
  const { room, start, advance } = setup(); start();
  advance(3000); room.tick(); assert.equal(room.phase, 'buffering');
});

test('joining cancels a pending start, leaving requires explicit resumption', () => {
  const { room, start } = setup(); start();
  room.join('c'); assert.equal(room.phase, 'buffering');
  room.leave('c'); assert.equal(room.phase, 'paused');
});

test('rejects duplicate reports and invalid input', () => {
  const { room, command, report } = setup(); command('play'); report('a');
  report('a', { sequence: 0, ready: false }); report('b');
  assert.equal(room.phase, 'playing');
  assert.throws(() => command('seek', NaN));
  assert.throws(() => report('a', { bufferedUntil: Infinity }));
  assert.throws(() => room.command('unknown', { epoch: room.epoch, type: 'pause' }));
});

test('near the end, readiness only requires the remaining movie', () => {
  const { room, command, report, advance } = setup();
  command('seek', 118); command('play');
  report('a', { bufferedUntil: 120 }); report('b', { bufferedUntil: 120 });
  assert.equal(room.phase, 'playing');
  report('a', { bufferedUntil: 120 }); report('b', { bufferedUntil: 120 });
  advance(3000); room.tick();
  assert.equal(room.position, 120); assert.equal(room.phase, 'paused');
});

test('cancels a scheduled start if a participant has not acknowledged it', () => {
  const { room, command, report, advance } = setup();
  command('play'); report('a'); report('b'); report('a');
  advance(700); room.tick();
  assert.equal(room.phase, 'buffering');
});
