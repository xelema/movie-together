// All timestamps use one server-side monotonic clock, in milliseconds.
export class Room {
  constructor({ now = () => performance.now(), minBuffer = 8, lowBuffer = 3,
    reportTimeout = 3000, startDelay = 1000 } = {}) {
    if (!(minBuffer > lowBuffer && lowBuffer > 0 && reportTimeout > startDelay && startDelay > 0)) {
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

  freeze() {
    this.position = this.positionAt();
    this.startsAt = null;
    this.phase = this.wantsPlay ? 'buffering' : 'paused';
    this.epoch++;
    // Readiness from before a pause/seek cannot authorize a new start.
    for (const member of this.members.values()) member.report = null;
  }

  join(id) {
    if (this.members.has(id)) throw new Error('Participant already joined');
    this.members.set(id, { sequence: -1, report: null });
    this.freeze();
    return this.snapshot();
  }

  leave(id) {
    this.requireMember(id);
    this.members.delete(id);
    // A disconnect always stops playback; resuming is an explicit group action.
    this.wantsPlay = false;
    this.freeze();
    return this.snapshot();
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
    return this.snapshot();
  }

  command(id, { epoch, type, position }) {
    this.requireMember(id);
    if (epoch !== this.epoch) return this.snapshot();
    if (this.duration === null) throw new Error('No movie selected');
    if (!['play', 'pause', 'seek'].includes(type)) throw new Error('Unknown command');
    if (type === 'seek' && (!Number.isFinite(position) || position < 0 || position > this.duration)) {
      throw new RangeError('Invalid seek position');
    }
    if (type === 'play') this.wantsPlay = true;
    if (type === 'pause') this.wantsPlay = false;
    this.freeze();
    if (type === 'seek') this.position = position;
    return this.snapshot();
  }

  report(id, { epoch, sequence, position, bufferedUntil, ready, ackStartsAt = null }) {
    const member = this.requireMember(id);
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence <= member.sequence) return this.snapshot();
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(bufferedUntil) || bufferedUntil < position || typeof ready !== 'boolean') {
      throw new RangeError('Invalid playback report');
    }
    member.sequence = sequence;
    member.report = { position, bufferedUntil, ready, ackStartsAt, receivedAt: this.now() };
    return this.tick();
  }

  tick() {
    const time = this.now();
    const position = this.positionAt(time);
    if (this.phase === 'playing' && this.duration !== null && position >= this.duration) {
      this.wantsPlay = false;
      this.freeze();
      return this.snapshot();
    }
    const reports = [...this.members.values()].map(member => member.report);
    const healthy = (report, reserve) => report && report.ready &&
      time - report.receivedAt < this.reportTimeout &&
      report.bufferedUntil >= Math.min(this.duration, position + reserve);
    if (this.phase === 'playing') {
      if (!reports.every(report => healthy(report, this.lowBuffer)) ||
        (time >= this.startsAt - 300 && !reports.every(report => report.ackStartsAt === this.startsAt))) this.freeze();
    } else if (this.wantsPlay && this.duration !== null && reports.length &&
      reports.every(report => healthy(report, this.minBuffer) && Math.abs(report.position - position) <= 0.1)) {
      this.phase = 'playing';
      this.startsAt = time + this.startDelay;
    }
    return this.snapshot();
  }
}
