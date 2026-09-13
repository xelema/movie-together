import { ColorRenderer } from './color-renderer.js';

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

// Native HLS lists chapters and metadata alongside subtitles in textTracks.
const subtitleTracks = video => Array.from(video.textTracks ?? []).filter(track => ['subtitles', 'captions'].includes(track.kind));

export class SyncPlayer {
  constructor({ video, roomId, name = '', onStatus, onState, onTracks, onActivation }) {
    Object.assign(this, { video, roomId, onStatus, onState, onTracks, onActivation });
    this.offset = 0; this.audioChoice = 0; this.subtitleChoice = -1;
    this.name = name;
    this.clock = new Clock(); this.sequence = 0; this.activated = false; this.disposed = false;
    this.lastMessage = 0; this.lastEpoch = -1; this.internalUntil = 0; this.listeners = [];
    this.listen(video, 'waiting', () => { if (this.state?.phase === 'playing' && this.serverTime() >= this.state.startsAt) this.report(false); });
    this.listen(video, 'canplay', () => {
      this.recovering = false;
      if (!this.activated && !this.activating && !this.autoActivationTried) {
        this.autoActivationTried = true; this.activate();
      }
    });
    this.listen(video, 'loadedmetadata', () => { this.applyTrackChoices(); this.tracks(); });
    this.listen(video, 'loadeddata', () => { this.decoded = true; });
    this.listen(video, 'emptied', () => { this.decoded = false; });
    if (video.audioTracks) this.listen(video.audioTracks, 'addtrack', () => this.tracks());
    this.listen(video.textTracks, 'addtrack', () => this.tracks());
    this.listen(video.textTracks, 'addtrack', event => {
      const raise = () => this.positionSubtitles();
      this.listen(event.track, 'cuechange', raise); raise();
    });
    for (const event of ['controlsshown', 'controlshidden']) this.listen(video, event, () => this.positionSubtitles());
    this.listen(window, 'resize', () => this.positionSubtitles());
    this.listen(video, 'error', () => { if (!this.hls) this.failPlayback('Lecture impossible sur cet appareil.'); });
    this.listen(video, 'play', () => {
      // Browsers can dispatch a queued play event after activate() already paused: internalUntil
      // keeps that stale notification from leaking a play command into a paused room.
      if (this.activating || performance.now() <= this.internalUntil) return;
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
      else if (this.activated) this.acquireWakeLock();
    });
    this.listen(window, 'offline', () => { this.command('pause'); this.report(false); });
    this.interval = setInterval(() => { this.reconcile(); this.report(); }, 200);
    this.pinger = setInterval(() => this.ping(), 2000);
    this.connect();
  }
  listen(target, event, handler) { target.addEventListener(event, handler); this.listeners.push(() => target.removeEventListener(event, handler)); }
  positionSubtitles() {
    const container = this.video.closest('.plyr'), controls = container?.querySelector('.plyr__controls');
    const visible = !container?.classList.contains('plyr--hide-controls') || this.video.closest('#screen')?.classList.contains('settings-open');
    const height = this.video.getBoundingClientRect().height;
    const line = visible && height ? Math.max(35, Math.min(84, 100 - ((controls?.getBoundingClientRect().height || 64) + 12) / height * 100)) : 84;
    for (const track of this.video.textTracks) for (const cue of track.activeCues ?? []) {
      cue.snapToLines = false; cue.line = line; cue.lineAlign = 'end';
    }
    this.colorRenderer?.updateCaptions();
  }
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
      if (this.name) this.send({ type: 'identify', name: this.name });
      this.clock = new Clock(); this.lastMessage = performance.now(); this.sequence = 0;
      this.ping();
      this.initialPings = setInterval(() => { this.ping(); if (this.clock.ready) clearInterval(this.initialPings); }, 200);
    };
    this.ws.onmessage = event => {
      if (this.disposed) return;
      const message = JSON.parse(event.data);
      this.lastMessage = performance.now();
      if (message.type === 'pong') this.clock.sample(message.sentAt, performance.now(), message.serverNow);
      if (message.type === 'welcome') this.memberId = message.id;
      if (message.type === 'error') this.onStatus(message.error);
      if (message.type === 'state') {
        this.state = message.state;
        // A paused room does not need to hold the screen awake.
        if (this.activated && message.state.phase !== 'paused') this.acquireWakeLock(); else this.releaseWakeLock();
        if (message.movie?.id !== this.movie?.id || message.movie?.generation !== this.movie?.generation) this.load(message.movie);
        if (this.lastEpoch !== this.state.epoch) { clearTimeout(this.startTimer); this.startTimer = null; this.scheduled = null; this.lastEpoch = this.state.epoch; }
        this.reconcile(); this.onState(message, this);
      }
    };
    this.ws.onclose = event => {
      if (this.disposed) return;
      clearInterval(this.initialPings); this.pauseLocal(); clearTimeout(this.startTimer); this.state = null;
      if ([1000, 1008].includes(event.code)) this.failure = 'Room fermée ou session expirée.';
      this.onStatus(event.code === 1000 || event.code === 1008 ? 'Room fermée ou session expirée.' : 'Connexion perdue. Séance en pause, reconnexion…');
      if (!this.disposed && ![1000, 1008].includes(event.code)) this.retry = setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => this.onStatus('Connexion à la room impossible. Vérifier l’invitation.');
  }
  pauseLocal() { this.internalUntil = performance.now() + 500; this.video.pause(); this.video.playbackRate = 1; }
  // Keeps a phone awake while the film runs; the OS drops the lock when the tab hides.
  async acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden || (this.wakeLock && !this.wakeLock.released)) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { }
  }
  releaseWakeLock() { this.wakeLock?.release().catch(() => {}); this.wakeLock = null; }
  failPlayback(message) {
    this.failure = message; this.activated = false; this.recovering = false;
    this.pauseLocal(); this.report(false); this.onActivation(false); this.onStatus(message);
  }
  seekLocal(position) { this.internalUntil = performance.now() + 500; this.video.currentTime = position; }
  load(movie) {
    const sameMovie = movie?.id === this.movie?.id;
    const activated = sameMovie && this.activated;
    if (!sameMovie) { this.audioChoice = 0; this.subtitleChoice = -1; }
    clearTimeout(this.startTimer); this.scheduled = null;
    this.pauseLocal(); this.colorRenderer?.dispose(); this.colorRenderer = null; this.hls?.destroy(); this.hls = null;
    this.loadToken = (this.loadToken || 0) + 1; this.activating = false; this.recovering = false;
    this.networkRecoveries = 0; this.mediaRecoveries = 0;
    this.movie = movie; this.failure = null; this.activated = activated; this.autoActivationTried = false; this.activationBlocked = false; this.onActivation(activated);
    this.video.removeAttribute('src'); this.video.load();
    if (!movie) return;
    const versions = movie.renditions?.length ? movie.renditions : [{ id: 'original', manifest: 'master.m3u8', timelineOffset: 0 }];
    this.rendition = versions[0];
    this.offset = this.rendition.timelineOffset ?? 0;
    if (this.rendition.color) {
      try { this.colorRenderer = new ColorRenderer(this.video, this.rendition.color, message => this.failPlayback(message)); }
      catch (error) { this.failPlayback(error.message); return; }
    }
    const url = `/media/${movie.id}/${this.rendition.manifest}`;
    // Prefer native HLS on Safari; its media policies and audio track API differ from MSE.
    if (this.video.canPlayType('application/vnd.apple.mpegurl') &&
      (/Apple/.test(navigator.vendor) || !window.Hls?.isSupported())) {
      // Native HLS presents a zero-based playlist timeline; MSE retains media PTS.
      this.offset = 0;
      this.video.src = url;
    } else if (window.Hls?.isSupported()) {
      this.hls = new window.Hls({ maxBufferLength: 30, maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1024 * 1024, backBufferLength: 10, enableWorker: true });
      this.hls.loadSource(url); this.hls.attachMedia(this.video);
      this.hls.on(window.Hls.Events.FRAG_BUFFERED, () => { if (this.video.readyState >= 3) this.recovering = false; });
      for (const name of ['MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'SUBTITLE_TRACKS_UPDATED']) this.hls.on(window.Hls.Events[name], () => { this.applyTrackChoices(); this.tracks(); });
      this.hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;
        this.pauseLocal(); this.report(false);
        this.recovering = true;
        // Hls.js already retries transient requests. Bound recovery after a fatal error.
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) this.hls.recoverMediaError();
        else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && this.networkRecoveries++ < 1) this.hls.startLoad(this.video.currentTime);
        else this.failPlayback('Chargement interrompu. Rechargez la page pour réessayer.');
      });
    } else this.failPlayback('Ce navigateur ne permet pas la lecture HLS.');
  }
  tracks() {
    const audio = this.hls ? this.hls.audioTracks.map((track, index) => ({ index, label: track.name || track.lang })) :
      Array.from(this.video.audioTracks ?? []).map((track, index) => ({ index, label: track.label || track.language || `Audio ${index + 1}` }));
    const subtitles = this.hls ? this.hls.subtitleTracks.map((track, index) => ({ index, label: track.name || track.lang })) :
      subtitleTracks(this.video).map((track, index) => ({ index, label: track.label || track.language || `Subtitles ${index + 1}` }));
    this.onTracks(audio, subtitles);
  }
  async activate() {
    if (!this.movie || this.activating || this.failure) return;
    this.activating = true; this.failure = null;
    const token = this.loadToken;
    const timeout = setTimeout(() => { if (token === this.loadToken) this.pauseLocal(); }, 15_000);
    this.internalUntil = performance.now() + 1500;
    try {
      // User gesture must reach play() even before metadata loads on mobile Safari.
      await this.video.play();
      if (this.disposed || token !== this.loadToken) return;
      this.pauseLocal(); this.activated = true; this.activationBlocked = false; this.onActivation(true);
      this.acquireWakeLock();
    } catch (error) {
      if (this.disposed || token !== this.loadToken) return;
      this.activated = false; this.activationBlocked = error.name === 'NotAllowedError';
      this.onActivation(false); this.onStatus('Autorisez le son pour rejoindre la séance. / 함께 시청하려면 소리를 허용하세요.');
    }
    finally {
      clearTimeout(timeout);
      if (!this.disposed && token === this.loadToken) { this.activating = false; this.reconcile(); this.report(); }
    }
  }
  command(command, position) {
    if (!this.state) return;
    if (command === 'pause' || command === 'seek') this.pauseLocal();
    this.send({ type: 'command', command, position, epoch: this.state.epoch });
  }
  async togglePlayback() {
    if (this.activated && ['playing', 'buffering'].includes(this.state?.phase)) { this.command('pause'); return; }
    if (!this.activated) await this.activate();
    if (this.activated) this.command('play');
  }
  identify(name) {
    this.name = name.trim().slice(0, 40);
    if (this.name) this.send({ type: 'identify', name: this.name });
  }
  // A switch is local to this viewer; if the new audio track stalls, the room
  // drops to buffering and resumes on its own once we are ready again.
  changeTrack(type, index) {
    if (type === 'audio') this.audioChoice = index; else this.subtitleChoice = index;
    if (this.hls) {
      if (type === 'audio') this.hls.audioTrack = index;
      else { this.hls.subtitleTrack = index; this.hls.subtitleDisplay = index >= 0; }
    } else if (type === 'audio') Array.from(this.video.audioTracks ?? []).forEach((track, i) => { track.enabled = i === index; });
    else subtitleTracks(this.video).forEach((track, i) => { track.mode = i === index ? 'showing' : 'disabled'; });
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
      subtitleTracks(this.video).forEach((track, i) => { track.mode = i === this.subtitleChoice ? 'showing' : 'disabled'; });
    }
  }
  reconcile() {
    if (this.activating) return;
    if (!this.state || !this.clock.ready || document.hidden || navigator.onLine === false || performance.now() - this.lastMessage > 1500) { this.pauseLocal(); return; }
    const target = this.target() + this.offset;
    if (this.state.phase !== 'playing' || this.serverTime() < this.state.startsAt) {
      this.pauseLocal();
      // B-frame reordering can leave a tiny initial gap after lossless remuxing.
      const start = this.video.buffered.length ? this.video.buffered.start(0) : 0;
      const seekTarget = start > target && start - target <= 0.1 ? start + 0.00001 : target;
      // A seek issued before the first decoded frame never completes on WebKit and would wedge
      // the player in seeking, blocking the whole room.
      if (this.decoded && !this.video.seeking &&
        (Math.abs(this.video.currentTime - seekTarget) > 0.1 || (Math.abs(start - seekTarget) <= 0.1 && this.video.currentTime < start))) this.seekLocal(seekTarget);
      if (this.state.phase === 'playing' && this.activated && this.scheduled !== this.state.startsAt) {
        clearTimeout(this.startTimer); this.scheduled = this.state.startsAt;
        this.startTimer = setTimeout(() => this.begin(), Math.max(0, this.state.startsAt - this.serverTime()));
      }
      return;
    }
    if (this.video.paused) return;
    const drift = target - this.video.currentTime;
    // Keep audio at its native speed: repeated time stretching can create audible artifacts.
    // Larger drift still pauses and realigns the entire room.
    if (Math.abs(drift) > 0.35) { this.pauseLocal(); this.report(false); }
    else if (this.video.playbackRate !== 1) this.video.playbackRate = 1;
  }
  async begin() {
    this.startTimer = null;
    if (!this.state || this.state.phase !== 'playing' || this.state.startsAt !== this.scheduled || !this.activated ||
      this.failure || document.hidden || performance.now() - this.lastMessage > 1500) return;
    if (this.serverTime() < this.state.startsAt) {
      this.startTimer = setTimeout(() => this.begin(), Math.ceil(this.state.startsAt - this.serverTime())); return;
    }
    try { await this.video.play(); }
    catch (error) { this.activated = false; this.activationBlocked = error.name === 'NotAllowedError'; this.onActivation(false); this.report(false); }
  }
  report(force) {
    if (!this.state) return;
    const position = this.position();
    const running = this.state.phase === 'playing' && this.serverTime() > this.state.startsAt + 200;
    const ready = force !== false && !this.failure && (!this.colorRenderer || (this.colorRenderer.ready && !this.colorRenderer.failed)) && !this.recovering && this.activated && this.clock.ready && !document.hidden && navigator.onLine !== false &&
      performance.now() - this.lastMessage < 1500 && !this.video.seeking && this.video.readyState >= 3 &&
      (!running || (!this.video.paused && Math.abs(position - this.target()) <= 0.35));
    this.send({ type: 'report', epoch: this.state.epoch, sequence: this.sequence++, position,
      bufferedUntil: Math.max(position, bufferEnd(this.video) - this.offset), ready,
      ackStartsAt: ready && this.scheduled === this.state.startsAt ? this.scheduled : null });
  }
  dispose() {
    this.disposed = true; clearInterval(this.interval); clearInterval(this.pinger); clearInterval(this.initialPings);
    clearTimeout(this.startTimer); clearTimeout(this.retry); this.listeners.forEach(remove => remove());
    this.ws?.close(1000); this.pauseLocal(); this.colorRenderer?.dispose(); this.hls?.destroy(); this.video.removeAttribute('src'); this.video.load();
    this.releaseWakeLock();
  }
}
