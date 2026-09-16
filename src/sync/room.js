// All timestamps use one server-side monotonic clock, in milliseconds.
export const validThresholds = ({ minBuffer, lowBuffer }) => minBuffer > lowBuffer && lowBuffer > 0;

// Control and bidi characters let a participant forge log lines. Nicknames and
// report diagnostics share this filter.
export const cleanText = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '');

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
  }

  snapshot() {
    return { epoch: this.epoch, phase: this.phase, position: this.position,
      startsAt: this.startsAt, duration: this.duration };
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
    const aligned = report && Math.abs(report.position - position) <= 0.1;
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

  freeze() {
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
    this.freeze();
    return { snapshot: this.snapshot(), changed: true };
  }

  leave(id) {
    this.requireMember(id);
    this.members.delete(id);
    // A disconnect always stops playback; resuming is an explicit group action.
    this.wantsPlay = false;
    this.freeze();
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
    this.freeze();
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
    this.freeze();
    if (type === 'seek') this.position = position;
    return { snapshot: this.snapshot(), changed: true };
  }

  report(id, { epoch, sequence, position, bufferedUntil, ready, ackStartsAt = null, blockers = null, failure = null }) {
    const member = this.requireMember(id);
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence <= member.sequence) {
      return { snapshot: this.snapshot(), changed: false };
    }
    // Positions are bounded to the film (+1 s of decode overshoot): a report the room can
    // never satisfy is invalid input, not a member to wait on. Same for an acknowledgement
    // that is not the current start: storing it would freeze every future start.
    const bound = (this.duration ?? Infinity) + 1;
    if (!Number.isFinite(position) || position < 0 || position > bound ||
      !Number.isFinite(bufferedUntil) || bufferedUntil < position || bufferedUntil > bound || typeof ready !== 'boolean' ||
      (ackStartsAt !== null && ackStartsAt !== this.startsAt) ||
      (blockers !== null && (!Array.isArray(blockers) || blockers.length > 12 || blockers.some(name => typeof name !== 'string' || name.length > 40))) ||
      (failure !== null && (typeof failure !== 'string' || failure.length > 200))) {
      throw new RangeError('Invalid playback report');
    }
    member.sequence = sequence;
    member.report = { position, bufferedUntil, ready, ackStartsAt, receivedAt: this.now(),
      blockers: blockers?.map(cleanText) ?? null, failure: failure === null ? null : cleanText(failure) };
    return this.tick();
  }

  tick() {
    const mark = { epoch: this.epoch, phase: this.phase };
    const time = this.now();
    const position = this.positionAt(time);
    if (this.phase === 'playing' && this.duration !== null && position >= this.duration) {
      this.wantsPlay = false;
      this.freeze();
      return this.outcome(mark);
    }
    const reports = [...this.members.values()].map(member => member.report);
    const healthy = (report, reserve) => this.healthy(report, reserve, position, time);
    if (this.phase === 'playing') {
      if (!reports.every(report => healthy(report, this.lowBuffer)) ||
        (time >= this.startsAt - 300 && !reports.every(report => report.ackStartsAt === this.startsAt))) this.freeze();
    } else if (this.wantsPlay && this.duration !== null && reports.length &&
      reports.every(report => healthy(report, this.minBuffer) && Math.abs(report.position - position) <= 0.1)) {
      this.phase = 'playing';
      this.startsAt = time + this.startDelay;
    }
    return this.outcome(mark);
  }
}
