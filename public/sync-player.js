import { ColorRenderer, colorNeedsRenderer, nativeHdrPipeline } from './color-renderer.js';
import { codecPlayable, createBackend } from './backends.js';
import { INTERNAL_EVENT_MS, selfCaused, roomTarget, decide, readyBlockers, canBegin, subtitleFontSize, shownSubtitleTrack, reviveSubtitleCues } from './sync-core.js';

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
  constructor({ video, roomId, name = '', forceShader = false, onStatus, onState, onTracks, onActivation, onVoice }) {
    Object.assign(this, { video, roomId, forceShader, onStatus, onState, onTracks, onActivation, onVoice });
    this.offset = 0; this.audioChoice = 0; this.subtitleChoice = -1;
    this.name = name;
    this.clock = new Clock(); this.sequence = 0; this.activated = false; this.disposed = false;
    this.lastMessage = 0; this.lastEpoch = -1; this.internalUntil = 0; this.pendingPauses = 0;
    this.retries = 0; this.listeners = [];
    // Defaults until the room publishes its sync policy in welcome.
    this.sync = { minBuffer: 8, tickMs: 200, startDelay: 1000 };
    this.silenceMs = 1500; this.bufferSeconds = 30; this.reportEveryMs = 200;
    this.listen(video, 'waiting', () => { if (this.state?.phase === 'playing' && this.serverTime() >= this.state.startsAt) this.report(false); });
    this.listen(video, 'canplay', () => {
      this.recovering = false;
      if (!this.activated && !this.activating && !this.autoActivationTried) {
        this.autoActivationTried = true; this.activate();
      }
    });
    this.listen(video, 'loadedmetadata', () => { this.applyTrackChoices(); this.tracks(); this.positionSubtitles(); });
    this.listen(video, 'loadeddata', () => { this.decoded = true; });
    this.listen(video, 'emptied', () => { this.decoded = false; });
    this.listen(video.textTracks, 'addtrack', event => {
      const raise = () => this.positionSubtitles();
      this.listen(event.track, 'cuechange', raise); raise();
    });
    this.listen(video.textTracks, 'change', () => this.positionSubtitles());
    // Les transitions d'interface arrivent en rafale au play/pause : le mesurage
    // (getBoundingClientRect) est coalescé sur un seul rAF pour éviter un Forced
    // Synchronous Layout pendant que le décodeur démarre.
    for (const event of ['controlsshown', 'controlshidden']) this.listen(video, event, () => this.scheduleSubtitles());
    // The element box tracks window resizes, fullscreen and orientation changes:
    // observing it keeps the glyph size glued to the picture with no skipped frame.
    this.subtitleObserver = new ResizeObserver(() => this.positionSubtitles());
    this.subtitleObserver.observe(video);
    this.listen(document, 'fullscreenchange', () => this.positionSubtitles());
    this.listen(document, 'webkitfullscreenchange', () => this.positionSubtitles());
    // iOS native fullscreen moves the video into a system layer: the layout box
    // does not change and document fullscreenchange never fires, so its own
    // events drive the refresh, with a second pass once the layout settles.
    const refreshSubtitles = () => { this.positionSubtitles(); requestAnimationFrame(() => this.positionSubtitles()); };
    for (const event of ['webkitbeginfullscreen', 'webkitendfullscreen', 'webkitpresentationmodechanged']) this.listen(video, event, refreshSubtitles);
    // Rotation inside iOS native fullscreen changes the screen but never the
    // element box, so neither the observer nor the events above can see it.
    // Other resizes already reach the observer.
    this.listen(window, 'resize', () => { if (this.video.webkitDisplayingFullscreen) refreshSubtitles(); });
    this.listen(video, 'error', () => { if (!this.backend?.recoversErrors) this.failPlayback('Lecture impossible sur cet appareil.'); });
    this.listen(video, 'play', () => {
      // Browsers can dispatch a queued play event after activate() already paused: the
      // self-caused window keeps that stale notification from leaking a play command.
      if (this.activating || selfCaused(performance.now(), this.internalUntil)) return;
      if (this.state?.phase !== 'playing') { this.pauseLocal(); this.command('play'); }
      else if (this.serverTime() < this.state.startsAt) this.pauseLocal();
    });
    // pause() only queues its event: a stalled main thread can deliver it
    // past the self-caused window, so count our pauses and spend one per event.
    this.listen(video, 'pause', () => {
      if (this.pendingPauses) { this.pendingPauses--; return; }
      if (this.state?.phase === 'playing' && this.serverTime() > this.state.startsAt) this.command('pause');
    });
    this.listen(video, 'seeking', () => {
      if (!selfCaused(performance.now(), this.internalUntil) && this.state) this.command('seek', this.position());
    });
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) { this.pauseLocal(); this.report(false); }
      else if (this.activated) this.acquireWakeLock();
    });
    // A dead network leaves the socket open but silent: pause locally, report
    // once, and surface the reason now rather than waiting for a close event.
    this.listen(window, 'offline', () => { this.command('pause'); this.report(false);
      this.onStatus('Connexion perdue. Séance en pause. / 연결이 끊겨 일시정지되었습니다.'); });
    // dynamic-range follows the screen the window sits on: dragging between
    // monitors re-runs the native-HDR vs shader decision.
    this.hdrScreen = matchMedia('(dynamic-range: high)');
    this.listen(this.hdrScreen, 'change', () => this.updateColorPath());
    this.interval = setInterval(() => { this.reconcile(); this.report(); }, 200);
    this.pinger = setInterval(() => this.ping(), 2000);
    this.connect();
  }
  listen(target, event, handler) { target.addEventListener(event, handler); this.listeners.push(() => target.removeEventListener(event, handler)); }
  scheduleSubtitles() {
    // Sans boucle d'animation (tests, DOM minimal) la mesure reste synchrone.
    if (typeof requestAnimationFrame !== 'function') { this.positionSubtitles(); return; }
    if (this.subtitleFrame) return;
    this.subtitleFrame = requestAnimationFrame(() => { this.subtitleFrame = 0; if (!this.disposed) this.positionSubtitles(); });
  }
  positionSubtitles() {
    const container = this.video.closest('.plyr'), controls = container?.querySelector('.plyr__controls');
    // iOS native fullscreen paints through a system layer where the element box
    // does not change and plyr controls do not apply: measure the screen itself.
    const fullscreen = this.video.webkitDisplayingFullscreen === true;
    const rect = fullscreen ? { width: screen.width, height: screen.height } : this.video.getBoundingClientRect(), height = rect.height;
    const visible = !fullscreen && (!container?.classList.contains('plyr--hide-controls') || this.video.closest('#screen')?.classList.contains('settings-open'));
    // object-fit: contain letterboxes inside the element; the glyph size follows
    // the painted picture, which a --subtitle-size custom property carries to
    // ::cue, the colour renderer's captions and the translated supertitle.
    const aspect = this.video.videoWidth / this.video.videoHeight || 16 / 9;
    const pictureHeight = Math.min(rect.height, rect.width / aspect);
    if (pictureHeight > 0) this.video.closest('.video-stage')?.style.setProperty('--subtitle-size', `${subtitleFontSize(pictureHeight)}px`);
    const line = visible && height ? Math.max(35, Math.min(84, 100 - ((controls?.getBoundingClientRect().height || 64) + 12) / height * 100)) : 84;
    const keep = this.subtitleChoice < 0 ? null : shownSubtitleTrack(Array.from(this.video.textTracks), this.subtitleChoice);
    for (const track of this.video.textTracks) {
      if (track !== keep && track.mode === 'showing' && ['subtitles', 'captions'].includes(track.kind)) track.mode = 'hidden';
      if (track === keep) reviveSubtitleCues(track, this.video.currentTime);
      for (const cue of track.activeCues ?? []) {
        cue.snapToLines = false; cue.line = line; cue.lineAlign = 'end';
      }
    }
    this.colorRenderer?.updateCaptions();
  }
  serverTime() { return performance.now() + this.clock.offset; }
  position() { return Math.max(0, this.video.currentTime - this.offset); }
  target() { return roomTarget(this.state, this.serverTime()); }
  send(message) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  // PCM frames ride the same socket. The 64 Kio bufferedAmount bound from #39
  // aborts the prise rather than dropping audio silently or stalling the page.
  sendFrame(bytes) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.ws.bufferedAmount >= 65536) return false;
    this.ws.send(bytes);
    return true;
  }
  ping() { this.send({ type: 'ping', sentAt: performance.now() }); }
  connect() {
    if (this.disposed) return;
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?room=${this.roomId}`);
    this.ws.onopen = () => {
      this.retries = 0;
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
      if (message.type === 'voice') this.onVoice?.(message);
      if (message.type === 'welcome') {
        this.memberId = message.id;
        this.applySync(message.sync);
      }
      if (message.type === 'error') this.onStatus(message.error);
      if (message.type === 'state') {
        this.state = message.state;
        if (message.sync) this.applySync(message.sync);
        // A paused room does not need to hold the screen awake.
        if (this.activated && message.state.phase !== 'paused') this.acquireWakeLock(); else this.releaseWakeLock();
        if (message.movie?.id !== this.movie?.id || message.movie?.generation !== this.movie?.generation) this.load(message.movie);
        if (this.lastEpoch !== this.state.epoch) { clearTimeout(this.startTimer); this.startTimer = null; this.scheduled = null; this.lastEpoch = this.state.epoch; }
        this.reconcile(); this.onState(message, this);
      }
    };
    this.ws.onclose = event => {
      if (this.disposed) return;
      this.onVoice?.(null);
      clearInterval(this.initialPings); this.pauseLocal(); clearTimeout(this.startTimer); this.state = null;
      if ([1000, 1008].includes(event.code)) this.failure = 'Room fermée ou session expirée.';
      this.onStatus(event.code === 1000 || event.code === 1008 ? 'Room fermée ou session expirée.' : 'Connexion perdue. Séance en pause, reconnexion…');
      // Back off reconnects so a down server is not hammered every two seconds.
      if (!this.disposed && ![1000, 1008].includes(event.code)) this.retry = setTimeout(() => this.connect(), Math.min(2000 * 2 ** this.retries++, 30_000));
    };
    this.ws.onerror = () => this.onStatus('Connexion à la room impossible. Vérifier l’invitation.');
  }
  pauseLocal() {
    // Déjà en pause : rien à réarmer toutes les 200 ms, juste le rate à rendre.
    if (this.video.paused) { if (this.video.playbackRate !== 1) this.video.playbackRate = 1; return; }
    this.internalUntil = performance.now() + INTERNAL_EVENT_MS;
    this.pendingPauses++; this.video.pause(); this.video.playbackRate = 1;
  }
  // The room's thresholds arrive with welcome and can change mid-session via state.
  applySync(sync) {
    const retune = sync.minBuffer !== undefined && sync.minBuffer !== this.sync.minBuffer;
    this.sync = { ...this.sync, ...sync };
    // Buffer targets must exceed what the room requires to start; silence is
    // declared after several missed ticks; reports must land inside startDelay
    // for the ack-of-start handshake.
    this.bufferSeconds = Math.max(30, Math.ceil(this.sync.minBuffer * 1.5));
    this.silenceMs = Math.max(1500, this.sync.tickMs * 7.5);
    const cadence = Math.min(200, this.sync.startDelay / 5);
    if (cadence !== this.reportEveryMs) {
      this.reportEveryMs = cadence;
      clearInterval(this.interval);
      this.interval = setInterval(() => { this.reconcile(); this.report(); }, cadence);
    }
    if (retune) this.backend?.setBufferGoal?.(this.sync.minBuffer, this.bufferSeconds);
  }
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
  seekLocal(position) { this.internalUntil = performance.now() + INTERNAL_EVENT_MS; this.video.currentTime = position; }
  load(movie) {
    const sameMovie = movie?.id === this.movie?.id;
    const activated = sameMovie && this.activated;
    if (!sameMovie) { this.audioChoice = 0; this.subtitleChoice = -1; }
    clearTimeout(this.startTimer); this.scheduled = null;
    this.pauseLocal(); this.colorRenderer?.dispose(); this.colorRenderer = null; this.backend?.destroy(); this.backend = null;
    this.loadToken = (this.loadToken || 0) + 1; this.activating = false; this.recovering = false;
    this.movie = movie; this.failure = null; this.activated = activated; this.autoActivationTried = false; this.activationBlocked = false; this.onActivation(activated);
    // video.load() drops media events still queued on the element, so pauses
    // counted but never delivered must not outlive the reload.
    this.video.removeAttribute('src'); this.video.load(); this.pendingPauses = 0;
    if (!movie) return;
    const versions = movie.renditions?.length ? movie.renditions : [{ id: 'original', manifest: 'master.m3u8', timelineOffset: 0 }];
    this.rendition = versions[0];
    const playable = mime => Boolean(window.MediaSource?.isTypeSupported(mime)) || this.video.canPlayType(mime) !== '';
    if (!codecPlayable(this.rendition, playable)) {
      this.failPlayback('Ce film utilise un codec vidéo que cet appareil ne peut pas lire.');
      return;
    }
    this.hdrPipeline = undefined; this.probing = false; this.updateColorPath();
    if (this.failure) return;
    const url = `/media/${movie.id}/${this.rendition.manifest}`;
    this.backend = createBackend(this.video, url,
      { timelineOffset: this.rendition.timelineOffset ?? 0, bufferSeconds: this.bufferSeconds,
        minBuffer: this.sync.minBuffer, bitrate: movie.bitrate },
      { onTracksChanged: () => { this.applyTrackChoices(); this.tracks(); },
        onBuffered: () => { if (this.video.readyState >= 3) this.recovering = false; },
        onStalled: () => { this.pauseLocal(); this.report(false); this.recovering = true; },
        onFatal: message => this.failPlayback(message) });
    if (!this.backend) { this.failPlayback('Ce navigateur ne permet pas la lecture HLS.'); return; }
    this.offset = this.backend.timelineOffset;
  }
  // On an HDR screen the native video already presents PQ/HLG correctly (the
  // passthrough equivalent of mpv, at zero GPU cost), so the tone-map shader
  // only earns its keep on SDR. forceShader is the escape hatch if a native
  // HDR presentation ever turns out wrong.
  updateColorPath() {
    const color = this.rendition?.color;
    if (!color || !colorNeedsRenderer(color)) { this.setShader(false); return; }
    if (this.forceShader || !this.hdrScreen.matches || this.hdrPipeline === false) { this.setShader(true); return; }
    if (this.hdrPipeline === true) { this.setShader(false); return; }
    if (this.probing) return;
    this.probing = true; const token = this.loadToken;
    nativeHdrPipeline(this.rendition, this.movie?.bitrate).then(ok => {
      if (token !== this.loadToken) return;
      this.probing = false; this.hdrPipeline = ok; this.updateColorPath();
    });
  }
  setShader(on) {
    if (on === Boolean(this.colorRenderer)) return;
    this.colorRenderer?.dispose(); this.colorRenderer = null;
    if (!on) return;
    try { this.colorRenderer = new ColorRenderer(this.video, this.rendition.color, message => this.failPlayback(message)); }
    catch (error) { this.failPlayback(error.message); }
  }
  tracks() {
    this.onTracks(this.backend?.audioTracks() ?? [], this.backend?.subtitleTracks() ?? []);
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
    this.applyTrackChoices();
  }
  applyTrackChoices() { this.backend?.applyChoices(this.audioChoice, this.subtitleChoice); }
  // The policy lives in sync-core.js; this only gathers observables and applies actions.
  reconcile() {
    const action = decide({
      activating: this.activating, state: this.state, clockReady: this.clock.ready,
      hidden: document.hidden, online: navigator.onLine !== false,
      silent: performance.now() - this.lastMessage > this.silenceMs,
      decoded: this.decoded, seeking: this.video.seeking, paused: this.video.paused,
      currentTime: this.video.currentTime,
      bufferedStart: this.video.buffered.length ? this.video.buffered.start(0) : 0,
      target: this.target() + this.offset, serverNow: this.serverTime(),
      activated: this.activated, scheduled: this.scheduled, rate: this.video.playbackRate,
    });
    if (action.pause) this.pauseLocal();
    if (action.seekTo !== undefined) this.seekLocal(action.seekTo);
    if (action.scheduleStart) {
      clearTimeout(this.startTimer); this.scheduled = this.state.startsAt;
      this.startTimer = setTimeout(() => this.begin(), action.startIn);
    }
    if (action.reportUnready) this.report(false);
    const rate = action.rate ?? (action.normalizeRate ? 1 : undefined);
    if (rate !== undefined && this.video.playbackRate !== rate) this.video.playbackRate = rate;
    // A track whose cues were unscheduled stays silent forever without a
    // periodic poke: cuechange cannot fire on cues that never activate.
    const keep = this.subtitleChoice < 0 ? null : shownSubtitleTrack(Array.from(this.video.textTracks), this.subtitleChoice);
    if (keep) reviveSubtitleCues(keep, this.video.currentTime);
  }
  async begin() {
    this.startTimer = null;
    if (!canBegin({ state: this.state, scheduled: this.scheduled, activated: this.activated,
      failure: this.failure, hidden: document.hidden,
      silent: performance.now() - this.lastMessage > this.silenceMs })) return;
    if (this.serverTime() < this.state.startsAt) {
      this.startTimer = setTimeout(() => this.begin(), Math.ceil(this.state.startsAt - this.serverTime())); return;
    }
    try { await this.video.play(); }
    catch (error) { this.activated = false; this.activationBlocked = error.name === 'NotAllowedError'; this.onActivation(false); this.report(false); }
  }
  report(force) {
    if (!this.state) return;
    const position = this.position();
    let blockers = readyBlockers({
      state: this.state, failure: this.failure,
      rendererReady: !this.colorRenderer || (this.colorRenderer.ready && !this.colorRenderer.failed),
      recovering: this.recovering, activated: this.activated, clockReady: this.clock.ready,
      hidden: document.hidden, online: navigator.onLine !== false,
      silent: performance.now() - this.lastMessage >= this.silenceMs,
      seeking: this.video.seeking, readyState: this.video.readyState, paused: this.video.paused,
      position, target: this.target(), serverNow: this.serverTime(),
    });
    const ready = force !== false && !blockers.length;
    // An event-forced report with every gate green means the element itself stalled.
    if (force === false && !blockers.length) blockers = ['stalled'];
    this.send({ type: 'report', epoch: this.state.epoch, sequence: this.sequence++, position,
      bufferedUntil: Math.max(position, bufferEnd(this.video) - this.offset), ready,
      blockers: ready ? undefined : blockers, failure: this.failure ?? null,
      ackStartsAt: ready && this.scheduled === this.state.startsAt ? this.scheduled : null });
  }
  dispose() {
    this.disposed = true; if (this.subtitleFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.subtitleFrame);
    clearInterval(this.interval); clearInterval(this.pinger); clearInterval(this.initialPings);
    clearTimeout(this.startTimer); clearTimeout(this.retry); this.subtitleObserver?.disconnect(); this.listeners.forEach(remove => remove());
    this.ws?.close(1000); this.pauseLocal(); this.colorRenderer?.dispose(); this.backend?.destroy(); this.video.removeAttribute('src'); this.video.load(); this.pendingPauses = 0;
    this.releaseWakeLock();
  }
}
