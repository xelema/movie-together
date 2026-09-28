// All timestamps use one server-side monotonic clock, in milliseconds.
export const validThresholds = ({ minBuffer, lowBuffer }) => minBuffer > lowBuffer && lowBuffer > 0;

// Control and bidi characters let a participant forge log lines. Nicknames and
// report diagnostics share this filter.
export const cleanText = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '');

// Whether a member is in step with the room's own position, or parked on a head
// it cannot get behind: a remuxed film's first decodable frame can sit a few
// frames after zero, and no seek puts a viewer before it. Without that exception
// the start gate waits for an alignment the file cannot produce and the séance
// stays in buffering forever. The gap is capped at a few frames, so a member that
// is genuinely elsewhere is still reported as misaligned.
const ALIGNMENT = 0.1;
const HEAD_GAP = 0.25;

export class Room {
  constructor({ now = () => performance.now(), minBuffer = 8, lowBuffer = 3,
    reportTimeout = 3000, startDelay = 1000 } = {}) {
    if (!(validThresholds({ minBuffer, lowBuffer }) && reportTimeout > startDelay && startDelay > 0)) {
      throw new RangeError('Invalid synchronization thresholds');
    }
    Object.assign(this, { now, minBuffer, lowBuffer, reportTimeout, startDelay });
    this.members = new Map();
    this.epoch = 0;
    this.phase = 'paused';
    this.position = 0;
    this.duration = null;
    this.startsAt = null;
    this.wantsPlay = false;
    // Why the last freeze happened — carried into snapshots and the journal.
    this.cause = 'unknown';
  }

  snapshot() {
    return { epoch: this.epoch, phase: this.phase, position: this.position,
      startsAt: this.startsAt, duration: this.duration, cause: this.cause };
  }

  positionAt(time = this.now()) {
    const elapsed = this.phase === 'playing' ? Math.max(0, time - this.startsAt) / 1000 : 0;
    return Math.min(this.duration ?? Infinity, this.position + elapsed);
  }

  // A report is healthy when it is fresh, self-declared ready, and buffered past
  // the reserve the current phase requires. One definition, shared by tick() and memberStatus().
  healthy(report, reserve, position, time) {
    return report && report.ready &&
      time - report.receivedAt < this.reportTimeout &&
      report.bufferedUntil >= Math.min(this.duration ?? Infinity, position + reserve);
  }

  // Shared by the start gate in tick() and by the display in memberStatus(): one
  // definition of "in step", so a stuck séance never blames an alignment it
  // already accepts.
  aligned(report, position) {
    if (!report) return false;
    if (Math.abs(report.position - position) <= ALIGNMENT) return true;
    const head = report.bufferedStart;
    return Number.isFinite(head) && head > position && head - position <= HEAD_GAP &&
      Math.abs(report.position - head) <= ALIGNMENT;
  }

  // What the séance knows of a participant, for display. `waiting` mirrors the
  // phase gates: a member out of alignment blocks a start while wantsPlay is set.
  // `reason` names the first failing gate so a stuck séance explains itself, and
  // `blockers` carries the member's own readiness detail when it is not ready.
  memberStatus(id) {
    const member = this.requireMember(id);
    const time = this.now();
    const position = this.positionAt(time);
    const report = member.report;
    const reserve = this.phase === 'playing' ? this.lowBuffer : this.minBuffer;
    const aligned = this.aligned(report, position);
    const waiting = !this.healthy(report, reserve, position, time) ||
      (this.wantsPlay && this.phase !== 'playing' && !aligned);
    const fresh = report && time - report.receivedAt < this.reportTimeout;
    const buffered = report && report.bufferedUntil >= Math.min(this.duration ?? Infinity, position + reserve);
    const reason = !waiting ? null : !report ? 'no-report' : !fresh ? 'stale-report'
      : !report.ready ? 'not-ready' : !buffered ? 'low-buffer' : 'misaligned';
    // Seconds of buffer ahead of the shared position vs what the room requires.
    return { waiting, reason, blockers: report?.blockers ?? [], failure: report?.failure ?? null,
      buffered: report ? report.bufferedUntil - position : 0,
      needed: Math.min(this.duration ?? Infinity, position + reserve) - position };
  }

  freeze(cause = 'unknown') {
    this.cause = cause;
    this.position = this.positionAt();
    this.startsAt = null;
    this.phase = this.wantsPlay ? 'buffering' : 'paused';
    this.epoch++;
    // Readiness from before a pause/seek cannot authorize a new start.
    for (const member of this.members.values()) member.report = null;
  }

  // `changed` marks an epoch or phase move: worth broadcasting right away
  // rather than waiting for the next tick.
  outcome(mark) {
    return { snapshot: this.snapshot(), changed: this.epoch !== mark.epoch || this.phase !== mark.phase };
  }

  join(id) {
    if (this.members.has(id)) throw new Error('Participant already joined');
    this.members.set(id, { sequence: -1, report: null });
    this.freeze('join');
    return { snapshot: this.snapshot(), changed: true };
  }

  leave(id) {
    this.requireMember(id);
    this.members.delete(id);
    // A disconnect always stops playback; resuming is an explicit group action.
    this.wantsPlay = false;
    this.freeze('leave');
    return { snapshot: this.snapshot(), changed: true };
  }

  requireMember(id) {
    const member = this.members.get(id);
    if (!member) throw new Error('Unknown participant');
    return member;
  }

  load(duration) {
    if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Invalid duration');
    this.wantsPlay = false;
    this.freeze('load');
    this.duration = duration;
    this.position = 0;
    return { snapshot: this.snapshot(), changed: true };
  }

  command(id, { epoch, type, position }) {
    this.requireMember(id);
    // Pause remains effective even if the sender has not received the latest epoch.
    if (epoch !== this.epoch && type !== 'pause') return { snapshot: this.snapshot(), changed: false };
    if (this.duration === null) throw new Error('No movie selected');
    if (!['play', 'pause', 'seek'].includes(type)) throw new Error('Unknown command');
    if (type === 'seek' && (!Number.isFinite(position) || position < 0 || position > this.duration)) {
      throw new RangeError('Invalid seek position');
    }
    if (type === 'play') this.wantsPlay = true;
    if (type === 'pause') this.wantsPlay = false;
    this.freeze(type);
    if (type === 'seek') this.position = position;
    return { snapshot: this.snapshot(), changed: true };
  }

  report(id, { epoch, sequence, position, bufferedUntil, bufferedStart = null, ready, ackStartsAt = null, blockers = null, failure = null }) {
    const member = this.requireMember(id);
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence <= member.sequence) {
      return { snapshot: this.snapshot(), changed: false,
        rejected: epoch !== this.epoch ? 'stale-epoch' : 'stale-sequence' };
    }
    // Positions are bounded to the film (+1 s of decode overshoot): a report the room can
    // never satisfy is invalid input, not a member to wait on. The head of the buffered
    // range rides along so a start position it precedes is read as unreachable rather
    // than as misalignment. Same for an acknowledgement that is not the current start:
    // storing it would freeze every future start.
    const bound = (this.duration ?? Infinity) + 1;
    if (!Number.isFinite(position) || position < 0 || position > bound ||
      (bufferedStart !== null && (!Number.isFinite(bufferedStart) || bufferedStart < 0 || bufferedStart > bound)) ||
      !Number.isFinite(bufferedUntil) || bufferedUntil < position || bufferedUntil > bound || typeof ready !== 'boolean' ||
      (ackStartsAt !== null && ackStartsAt !== this.startsAt) ||
      (blockers !== null && (!Array.isArray(blockers) || blockers.length > 12 || blockers.some(name => typeof name !== 'string' || name.length > 40))) ||
      (failure !== null && (typeof failure !== 'string' || failure.length > 200))) {
      throw new RangeError('Invalid playback report');
    }
    member.sequence = sequence;
    member.report = { position, bufferedUntil, bufferedStart, ready, ackStartsAt, receivedAt: this.now(),
      blockers: blockers?.map(cleanText) ?? null, failure: failure === null ? null : cleanText(failure) };
    return this.tick();
  }

  // `cause` overrides the health-derived reason only when a caller (a retune)
  // is itself the reason reports no longer hold.
  tick(cause = null) {
    const mark = { epoch: this.epoch, phase: this.phase };
    const time = this.now();
    const position = this.positionAt(time);
    if (this.phase === 'playing' && this.duration !== null && position >= this.duration) {
      this.wantsPlay = false;
      this.freeze('end');
      return this.outcome(mark);
    }
    const reports = [...this.members.values()].map(member => member.report);
    const healthy = (report, reserve) => this.healthy(report, reserve, position, time);
    if (this.phase === 'playing') {
      const stuck = [...this.members.keys()].find(id => !healthy(this.members.get(id).report, this.lowBuffer));
      if (stuck) this.freeze(cause ?? this.memberStatus(stuck).reason ?? 'unknown');
      else if (time >= this.startsAt - 300 && !reports.every(report => report.ackStartsAt === this.startsAt)) {
        this.freeze('no-ack');
      }
    } else if (this.wantsPlay && this.duration !== null && reports.length &&
      reports.every(report => healthy(report, this.minBuffer) && this.aligned(report, position))) {
      this.phase = 'playing';
      this.startsAt = time + this.startDelay;
    }
    return this.outcome(mark);
  }
}
