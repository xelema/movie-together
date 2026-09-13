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

test('rejects acknowledgements and positions the room cannot satisfy', () => {
  const { room, command, report } = setup(); command('play'); report('a');
  // A stored acknowledgement that never equals startsAt would freeze every start.
  assert.throws(() => report('a', { ackStartsAt: 'soon' }), /Invalid playback report/);
  assert.throws(() => report('a', { ackStartsAt: 12345 }), /Invalid playback report/);
  // Out-of-range positions keep a member misaligned forever, so the report is invalid input.
  assert.throws(() => report('a', { position: 999 }), /Invalid playback report/);
  assert.throws(() => report('a', { position: 0, bufferedUntil: 9999 }), /Invalid playback report/);
  // Rejected reports must not consume the sequence slot.
  report('a'); assert.equal(room.members.get('a').report.position, 0);
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

test('a pause from a slightly outdated participant still stops the group', () => {
  const { room, start } = setup(); start();
  room.command('b', { epoch: room.epoch - 1, type: 'pause' });
  assert.equal(room.phase, 'paused');
});

test('member status mirrors the phase gates: ready, fresh, aligned', () => {
  const { room, command, report, advance } = setup();
  report('a'); report('b');
  assert.equal(room.memberStatus('a').waiting, false);
  // A participant away from the shared position blocks the start and shows waiting.
  command('seek', 60); command('play');
  report('a', { position: 0, bufferedUntil: 120 });
  assert.equal(room.memberStatus('a').waiting, true);
  report('a', { position: 60, bufferedUntil: 120 });
  assert.equal(room.memberStatus('a').waiting, false);
  advance(4000);
  assert.equal(room.memberStatus('a').waiting, true);
});

test('waiting status names the gate that blocks the member', () => {
  const { room, command, report, advance } = setup();
  command('play');
  assert.equal(room.memberStatus('a').reason, 'no-report');
  report('a', { ready: false, blockers: ['activation', 'clock'] });
  assert.equal(room.memberStatus('a').reason, 'not-ready');
  assert.deepEqual(room.memberStatus('a').blockers, ['activation', 'clock']);
  report('a', { ready: false, failure: 'Lecture impossible sur cet appareil.' });
  assert.equal(room.memberStatus('a').failure, 'Lecture impossible sur cet appareil.');
  report('a', { bufferedUntil: 5 });
  assert.equal(room.memberStatus('a').reason, 'low-buffer');
  assert.equal(room.memberStatus('a').buffered, 5);
  assert.equal(room.memberStatus('a').needed, 8);
  report('a', { position: 30, bufferedUntil: 60 });
  assert.equal(room.memberStatus('a').reason, 'misaligned');
  report('a');
  assert.equal(room.memberStatus('a').waiting, false);
  assert.equal(room.memberStatus('a').reason, null);
  advance(4000);
  assert.equal(room.memberStatus('a').reason, 'stale-report');
});

test('changed marks epoch or phase moves only', () => {
  const { room, command, report } = setup();
  assert.equal(command('play').changed, true);
  assert.equal(report('a').changed, false);
  assert.equal(report('a', { epoch: -1 }).changed, false);
  // The last aligned report starts playback: a transition.
  assert.equal(report('b').changed, true);
  assert.equal(room.phase, 'playing');
  assert.equal(report('a').changed, false);
});
