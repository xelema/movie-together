export class Clock {
  constructor() { this.samples = []; }
  sample(sentAt, receivedAt, serverNow) {
    const rtt = receivedAt - sentAt;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 1500) return;
    this.samples.push({ rtt, offset: serverNow - (sentAt + receivedAt) / 2, at: receivedAt });
    this.samples = this.samples.filter(sample => receivedAt - sample.at < 20_000).slice(-20);
  }
  get best() { return this.samples.reduce((best, sample) => !best || sample.rtt < best.rtt ? sample : best, null); }
  get offset() { return this.best?.offset ?? 0; }
  get ready() { return this.samples.length >= 3 && this.best.rtt < 500; }
}

export function bufferEnd(video) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.05 && video.buffered.end(i) >= video.currentTime) return video.buffered.end(i);
  }
  return video.currentTime;
}

export class SyncPlayer {
  constructor({ video, roomId, onStatus, onState, onTracks, onActivation, onRendition = () => {} }) {
    Object.assign(this, { video, roomId, onStatus, onState, onTracks, onActivation, onRendition });
    this.offset = 0; this.audioChoice = 0; this.subtitleChoice = -1;
    this.clock = new Clock(); this.sequence = 0; this.activated = false; this.disposed = false;
    this.lastMessage = 0; this.lastEpoch = -1; this.internalUntil = 0; this.listeners = [];
    this.listen(video, 'waiting', () => { if (this.state?.phase === 'playing' && this.serverTime() >= this.state.startsAt) this.report(false); });
    this.listen(video, 'error', () => { this.failure = 'Lecture impossible sur cet appareil.'; this.onStatus(this.failure); this.activated = false; this.onActivation(false); this.report(false); });
    this.listen(video, 'play', () => {
      if (this.activating) return;
      if (this.state?.phase !== 'playing') { this.pauseLocal(); this.command('play'); }
      else if (this.serverTime() < this.state.startsAt) this.pauseLocal();
    });
    this.listen(video, 'pause', () => {
      if (performance.now() > this.internalUntil && this.state?.phase === 'playing' && this.serverTime() > this.state.startsAt) this.command('pause');
    });
    this.listen(video, 'seeking', () => {
      if (performance.now() > this.internalUntil && this.state) this.command('seek', this.position());
    });
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) { this.pauseLocal(); this.report(false); }
    });
    this.interval = setInterval(() => { this.reconcile(); this.report(); }, 200);
    this.pinger = setInterval(() => this.ping(), 2000);
    this.connect();
  }
  listen(target, event, handler) { target.addEventListener(event, handler); this.listeners.push(() => target.removeEventListener(event, handler)); }
  serverTime() { return performance.now() + this.clock.offset; }
  position() { return Math.max(0, this.video.currentTime - this.offset); }
  target() {
    if (!this.state) return 0;
    return Math.min(this.state.duration, this.state.position +
      (this.state.phase === 'playing' ? Math.max(0, this.serverTime() - this.state.startsAt) / 1000 : 0));
  }
  send(message) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  ping() { this.send({ type: 'ping', sentAt: performance.now() }); }
  connect() {
    if (this.disposed) return;
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?room=${this.roomId}`);
    this.ws.onopen = () => {
      this.clock = new Clock(); this.lastMessage = performance.now(); this.sequence = 0;
      this.ping();
      this.initialPings = setInterval(() => { this.ping(); if (this.clock.ready) clearInterval(this.initialPings); }, 200);
    };
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      this.lastMessage = performance.now();
      if (message.type === 'pong') this.clock.sample(message.sentAt, performance.now(), message.serverNow);
      if (message.type === 'welcome') this.memberId = message.id;
      if (message.type === 'error') this.onStatus(message.error);
      if (message.type === 'state') {
        this.state = message.state;
        if (message.movie?.id !== this.movie?.id || message.movie?.generation !== this.movie?.generation) this.load(message.movie);
        if (this.lastEpoch !== this.state.epoch) { clearTimeout(this.startTimer); this.startTimer = null; this.scheduled = null; this.lastEpoch = this.state.epoch; }
        this.reconcile(); this.onState(message, this);
      }
    };
    this.ws.onclose = event => {
      clearInterval(this.initialPings); this.pauseLocal(); clearTimeout(this.startTimer); this.state = null;
      this.onStatus(event.code === 1000 || event.code === 1008 ? 'Room fermée ou session expirée.' : 'Connexion perdue. Séance en pause, reconnexion…');
      if (!this.disposed && ![1000, 1008].includes(event.code)) this.retry = setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => this.onStatus('Connexion à la room impossible. Vérifier l’invitation.');
  }
  pauseLocal() { this.internalUntil = performance.now() + 500; this.video.pause(); this.video.playbackRate = 1; }
  seekLocal(position) { this.internalUntil = performance.now() + 500; this.video.currentTime = position; }
  load(movie, selected) {
    const sameMovie = movie?.id === this.movie?.id;
    const activated = sameMovie && this.activated;
    if (!sameMovie) { this.audioChoice = 0; this.subtitleChoice = -1; }
    clearTimeout(this.startTimer); this.scheduled = null;
    this.pauseLocal(); this.hls?.destroy(); this.hls = null;
    this.movie = movie; this.failure = null; this.activated = activated; this.onActivation(activated);
    this.video.removeAttribute('src'); this.video.load();
    if (!movie) return;
    const versions = movie.renditions?.length ? movie.renditions : [{ id: 'original', manifest: 'master.m3u8', timelineOffset: 0 }];
    this.rendition = versions.find(item => item.id === selected) ?? versions.find(item => item.id === 'compatible') ?? versions[0];
    this.offset = this.rendition.timelineOffset ?? 0;
    this.onRendition(versions, this.rendition.id);
    const url = `/media/${movie.id}/${this.rendition.manifest}`;
    // Prefer native HLS on Safari; its media policies and audio track API differ from MSE.
    if (this.video.canPlayType('application/vnd.apple.mpegurl') &&
      (/Apple/.test(navigator.vendor) || !window.Hls?.isSupported())) {
      // Native HLS presents a zero-based playlist timeline; MSE retains media PTS.
      this.offset = 0;
      this.video.src = url;
      this.listen(this.video, 'loadedmetadata', () => { this.applyTrackChoices(); this.tracks(); });
      if (this.video.audioTracks) this.listen(this.video.audioTracks, 'addtrack', () => this.tracks());
      if (this.video.textTracks) this.listen(this.video.textTracks, 'addtrack', () => this.tracks());
    } else if (window.Hls?.isSupported()) {
      this.hls = new window.Hls({ maxBufferLength: 60, maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1024 * 1024, backBufferLength: 10, enableWorker: true });
      this.hls.loadSource(url); this.hls.attachMedia(this.video);
      for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) this.hls.on(window.Hls.Events[name], () => { this.applyTrackChoices(); this.tracks(); });
      this.hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) { this.failure = 'Chargement interrompu. Rechargez la page pour réessayer.'; this.activated = false; this.onActivation(false); this.pauseLocal(); this.report(false); this.onStatus(this.failure); }
      });
    } else this.onStatus('Ce navigateur ne permet pas la lecture HLS.');
  }
  tracks() {
    const audio = this.hls ? this.hls.audioTracks.map((track, index) => ({ index, label: track.name || track.lang })) :
      Array.from(this.video.audioTracks ?? []).map((track, index) => ({ index, label: track.label || track.language || `Audio ${index + 1}` }));
    const subtitles = this.hls ? this.hls.subtitleTracks.map((track, index) => ({ index, label: track.name || track.lang })) :
      Array.from(this.video.textTracks ?? []).map((track, index) => ({ index, label: track.label || track.language || `Sous-titres ${index + 1}` }));
    this.onTracks(audio, subtitles);
  }
  async activate() {
    if (!this.movie || this.activating) return;
    this.activating = true; this.failure = null;
    const movieId = this.movie.id;
    const timeout = setTimeout(() => this.pauseLocal(), 15_000);
    this.internalUntil = performance.now() + 1500;
    try {
      // User gesture must reach play() even before metadata loads on mobile Safari.
      await this.video.play(); this.pauseLocal();
      if (!this.disposed && this.movie?.id === movieId) { this.activated = true; this.onActivation(true); }
    } catch { this.activated = false; this.onStatus('Touchez à nouveau « Activer mon lecteur » pour autoriser la lecture.'); }
    finally { clearTimeout(timeout); this.activating = false; this.reconcile(); this.report(); }
  }
  command(command, position) {
    if (!this.state) return;
    if (command === 'pause' || command === 'seek') this.pauseLocal();
    this.send({ type: 'command', command, position, epoch: this.state.epoch });
  }
  changeTrack(type, index) {
    this.command('pause');
    if (type === 'audio') this.audioChoice = index; else this.subtitleChoice = index;
    if (this.hls) {
      if (type === 'audio') this.hls.audioTrack = index;
      else { this.hls.subtitleTrack = index; this.hls.subtitleDisplay = index >= 0; }
    } else if (type === 'audio') Array.from(this.video.audioTracks ?? []).forEach((track, i) => { track.enabled = i === index; });
    else Array.from(this.video.textTracks ?? []).forEach((track, i) => { track.mode = i === index ? 'showing' : 'disabled'; });
    this.onStatus('Piste changée pour vous. Relancez la séance quand vous êtes prêt.');
  }
  applyTrackChoices() {
    if (this.hls) {
      if (this.hls.audioTracks[this.audioChoice] && this.hls.audioTrack !== this.audioChoice) this.hls.audioTrack = this.audioChoice;
      if (this.subtitleChoice < 0 || this.hls.subtitleTracks[this.subtitleChoice]) {
        if (this.hls.subtitleTrack !== this.subtitleChoice) this.hls.subtitleTrack = this.subtitleChoice;
        this.hls.subtitleDisplay = this.subtitleChoice >= 0;
      }
    } else {
      Array.from(this.video.audioTracks ?? []).forEach((track, i) => { track.enabled = i === this.audioChoice; });
      Array.from(this.video.textTracks ?? []).forEach((track, i) => { track.mode = i === this.subtitleChoice ? 'showing' : 'disabled'; });
    }
  }
  changeRendition(id) {
    if (!this.movie?.renditions?.some(item => item.id === id) || this.rendition?.id === id) return;
    this.command('pause'); this.load(this.movie, id);
  }
  reconcile() {
    if (this.activating) return;
    if (!this.state || !this.clock.ready || document.hidden || performance.now() - this.lastMessage > 1500) { this.pauseLocal(); return; }
    const target = this.target() + this.offset;
    if (this.state.phase !== 'playing' || this.serverTime() < this.state.startsAt) {
      this.pauseLocal();
      // B-frame reordering can leave a tiny initial gap after lossless remuxing.
      const start = this.video.buffered.length ? this.video.buffered.start(0) : 0;
      const seekTarget = start > target && start - target <= 0.1 ? start + 0.00001 : target;
      if (this.video.readyState >= 1 && !this.video.seeking &&
        (Math.abs(this.video.currentTime - seekTarget) > 0.1 || (Math.abs(start - seekTarget) <= 0.1 && this.video.currentTime < start))) this.seekLocal(Math.max(seekTarget, start));
      if (this.state.phase === 'playing' && this.activated && this.scheduled !== this.state.startsAt) {
        clearTimeout(this.startTimer); this.scheduled = this.state.startsAt;
        this.startTimer = setTimeout(() => this.begin(), Math.max(0, this.state.startsAt - this.serverTime()));
      }
      return;
    }
    if (this.video.paused) return;
    const drift = target - this.video.currentTime;
    // Large drift stops the group; small drift is corrected gradually without skipping frames.
    if (Math.abs(drift) > 0.35) { this.pauseLocal(); this.report(false); }
    else this.video.playbackRate = Math.abs(drift) > 0.04 ? 1 + Math.max(-0.04, Math.min(0.04, drift * 0.2)) : 1;
  }
  async begin() {
    this.startTimer = null;
    if (!this.state || this.state.phase !== 'playing' || this.state.startsAt !== this.scheduled || !this.activated ||
      document.hidden || performance.now() - this.lastMessage > 1500) return;
    if (this.serverTime() < this.state.startsAt) {
      this.startTimer = setTimeout(() => this.begin(), Math.ceil(this.state.startsAt - this.serverTime())); return;
    }
    try { await this.video.play(); }
    catch { this.activated = false; this.onActivation(false); this.report(false); }
  }
  report(force) {
    if (!this.state) return;
    const position = this.position();
    const running = this.state.phase === 'playing' && this.serverTime() > this.state.startsAt + 200;
    const ready = force !== false && this.activated && this.clock.ready && !document.hidden &&
      performance.now() - this.lastMessage < 1500 && !this.video.seeking && this.video.readyState >= 3 &&
      (!running || (!this.video.paused && Math.abs(position - this.target()) <= 0.35));
    this.send({ type: 'report', epoch: this.state.epoch, sequence: this.sequence++, position,
      bufferedUntil: Math.max(position, bufferEnd(this.video) - this.offset), ready,
      ackStartsAt: ready && this.scheduled === this.state.startsAt ? this.scheduled : null });
  }
  dispose() {
    this.disposed = true; clearInterval(this.interval); clearInterval(this.pinger); clearInterval(this.initialPings);
    clearTimeout(this.startTimer); clearTimeout(this.retry); this.listeners.forEach(remove => remove());
    this.ws?.close(1000); this.pauseLocal(); this.hls?.destroy(); this.video.removeAttribute('src'); this.video.load();
  }
}
