import test from 'node:test';
import assert from 'node:assert/strict';
import { codecPlayable, pinSubtitleModes, HlsJsBackend, nativeHls, supportsMime } from '../public/backends.js';

test('codecPlayable blocks a video codec the device rejects', () => {
  assert.equal(codecPlayable({ codec: 'hevc' }, () => false), false);
});

test('codecPlayable prefers the manifest codecs string', () => {
  let seen;
  codecPlayable({ codec: 'hevc', codecs: 'hvc1.2.4.L153.B0,mp4a.40.2' }, mime => { seen = mime; return true; });
  assert.equal(seen, 'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"');
});

test('codecPlayable maps codec names to a probe string', () => {
  let seen;
  codecPlayable({ codec: 'hevc' }, mime => { seen = mime; return true; });
  assert.equal(seen, 'video/mp4; codecs="hvc1.1.6.L93.B0"');
});

test('codecPlayable lets unknown codecs through to the engine', () => {
  assert.equal(codecPlayable({}, () => false), true);
});

// A minimal hls.js stand-in: the stock controller parks every unselected
// subtitle track in 'disabled', and hls.js drops a WebVTT fragment whose parse
// finishes in that state (_appendCues bails, the cached fragment is never
// fetched again).
const fakeHls = () => {
  const nodes = ['French', 'English'].map(() => ({ trackNode: { track: {
    kind: 'subtitles', mode: 'disabled', cues: [], addCue(cue) { this.cues.push(cue); } } } }));
  const controller = {
    media: {}, subtitleDisplay: true, currentTrack: null, tracksInGroup: nodes,
    toggleTrackModes() {
      for (const track of this.tracksInGroup) {
        const node = track.trackNode.track;
        node.mode = track === this.currentTrack && this.subtitleDisplay ? 'showing' : 'disabled';
      }
    },
  };
  const hls = {
    config: { renderTextTracksNatively: true }, audioTracks: [{}], subtitleTracks: nodes.map(() => ({})),
    audioTrack: 0, subtitleTrackController: controller,
    handlers: {},
    loadSource() {}, attachMedia() {},
    on(name, fn) { (this.handlers[name] ??= []).push(fn); },
    emit(name, data) { for (const fn of this.handlers[name] ?? []) fn(name, data); },
    triggers: [],
    trigger(name, data) { this.triggers.push({ name, data }); },
  };
  controller.hls = hls;
  let selected = -1;
  Object.defineProperty(hls, 'subtitleTrack', {
    get: () => selected,
    set: id => { selected = id; controller.currentTrack = nodes[id] ?? null; controller.toggleTrackModes(); },
  });
  Object.defineProperty(hls, 'subtitleDisplay', {
    get: () => controller.subtitleDisplay,
    set: value => { controller.subtitleDisplay = value; if (selected > -1) controller.toggleTrackModes(); },
  });
  return { hls, nodes };
};

test('pinSubtitleModes keeps unselected tracks hidden rather than disabled', () => {
  const controller = {
    media: {}, hls: { config: { renderTextTracksNatively: true } }, subtitleDisplay: true, currentTrack: null,
    tracksInGroup: [{ trackNode: { track: { mode: 'disabled' } } }, { trackNode: { track: { mode: 'disabled' } } }],
  };
  controller.currentTrack = controller.tracksInGroup[0];
  pinSubtitleModes(controller);
  assert.equal(controller.tracksInGroup[0].trackNode.track.mode, 'showing');
  assert.equal(controller.tracksInGroup[1].trackNode.track.mode, 'hidden');
  controller.subtitleDisplay = false;
  pinSubtitleModes(controller);
  assert.equal(controller.tracksInGroup[0].trackNode.track.mode, 'hidden');
});

test('a fast subtitle re-selection never strands a track without cues', () => {
  const { hls, nodes } = fakeHls();
  const saved = globalThis.window;
  globalThis.window = { Hls: class { constructor() { return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    const backend = new HlsJsBackend({}, 'u');
    backend.applyChoices(0, 0);
    assert.equal(nodes[0].trackNode.track.mode, 'showing');
    // The viewer switches away while track 0's segment is still parsing.
    backend.applyChoices(0, 1);
    if (nodes[0].trackNode.track.mode !== 'disabled') nodes[0].trackNode.track.addCue({ id: 'late' });
    backend.applyChoices(0, 0);
    assert.equal(nodes[0].trackNode.track.mode, 'showing');
    assert.equal(nodes[1].trackNode.track.mode, 'hidden');
    assert.deepEqual(nodes[0].trackNode.track.cues, [{ id: 'late' }]);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});

test('hls.js is configured for stall-free resume and deep segment reuse', () => {
  const { hls } = fakeHls();
  const saved = globalThis.window;
  let config;
  globalThis.window = { Hls: class { constructor(options) { config = options; return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    new HlsJsBackend({}, 'u');
    assert.equal(config.backBufferLength, 5);
    assert.equal(config.startFragPrefetch, true);
    assert.equal(config.progressive, false);
    // maxBufferSize est un plancher en octets chez hls.js, pas un plafond : 0
    // le désactive pour que la cible d'avance reste celle d'applyBufferCap.
    assert.equal(config.maxBufferSize, 0);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});

// Chrome's canPlayType accepts codecs its MediaSource refuses; probing must ask
// the engine that will actually decode the stream.
test('codec probes ask MSE unless native HLS will decode', () => {
  const savedWindow = globalThis.window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    globalThis.window = { Hls: { isSupported: () => true }, MediaSource: { isTypeSupported: () => false } };
    const video = { canPlayType: mime => mime === 'application/vnd.apple.mpegurl' ? 'maybe' : 'probably' };
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Google Inc.' }, configurable: true });
    assert.equal(nativeHls(video), false);
    assert.equal(supportsMime(video)('video/mp4; codecs="hvc1.1.6.L63.90"'), false);
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Apple' }, configurable: true });
    assert.equal(nativeHls(video), true);
    assert.equal(supportsMime(video)('video/mp4; codecs="hvc1.1.6.L63.90"'), true);
    window.Hls.isSupported = () => false;
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Google Inc.' }, configurable: true });
    assert.equal(nativeHls(video), true);
    assert.equal(supportsMime(video)('video/mp4; codecs="x"'), true);
  } finally {
    savedWindow === undefined ? delete globalThis.window : globalThis.window = savedWindow;
    Object.defineProperty(globalThis, 'navigator', savedNavigator);
  }
});

test('admin buffer settings reach the hls.js config and retune live', () => {
  const { hls } = fakeHls();
  const saved = globalThis.window;
  let config;
  globalThis.window = { Hls: class { constructor(options) { config = options; return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    const backend = new HlsJsBackend({}, 'u', { backBufferSeconds: 30, maxBufferMb: 120 });
    assert.equal(config.backBufferLength, 30);
    backend.setBufferGoal(8, 30, 45, 90);
    assert.equal(hls.config.backBufferLength, 45);
    // Sans débit connu, la cible d'avance reste le plafond nominal.
    assert.equal(hls.config.maxBufferLength, 30);
    assert.equal(hls.config.maxMaxBufferLength, 30);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});

const withFakeHls = (fn) => {
  const { hls } = fakeHls();
  const saved = globalThis.window;
  // Le vrai Hls fusionne les options du constructeur dans hls.config.
  globalThis.window = { Hls: class { constructor(options) { Object.assign(hls.config, options); return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au',
    SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err', LEVEL_SWITCHED: 'ls', BUFFER_FLUSHING: 'flushing' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  window.Hls.ErrorDetails = { BUFFER_FULL_ERROR: 'bufferFullError' };
  try { fn(hls); } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
};

// À fort débit, l'avance est bornée par le budget d'octets : 50 Mo à
// 34 Mbps (peak du manifest) ≈ 12,3 s et non 30 s, sinon le quota
// SourceBuffer de Chrome sature avant l'append du segment suivant.
test('the forward buffer cap adapts to the level bitrate', () => {
  withFakeHls(hls => {
    new HlsJsBackend({}, 'u', { bufferSeconds: 30 });
    assert.equal(hls.config.maxBufferLength, 30);
    hls.levels = [{ bitrate: 34_000_000 }];
    hls.currentLevel = 0;
    hls.emit('ls');
    const cap = 8 * 50 * 1024 * 1024 / 34_000_000;
    assert.equal(hls.config.maxBufferLength, cap);
    assert.equal(hls.config.maxMaxBufferLength, cap);
    // Un niveau léger retrouve la cible nominale.
    hls.levels = [{ bitrate: 1_000_000 }];
    hls.emit('ls');
    assert.equal(hls.config.maxBufferLength, 30);
  });
});

// Le plancher garantit que la cible reste au-dessus du seuil minBuffer de la
// room même si le budget d'octets imposerait moins.
test('the buffer cap never drops below the sync floor', () => {
  withFakeHls(hls => {
    new HlsJsBackend({}, 'u', { bufferSeconds: 30, minBuffer: 8, maxBufferMb: 20 });
    hls.levels = [{ bitrate: 34_000_000 }];
    hls.currentLevel = 0;
    hls.emit('ls');
    assert.equal(hls.config.maxBufferLength, 12);
    // Avec des segments de 10 s, le plancher suit targetDuration : un seul
    // segment d'avance suffit quand deux ne tiennent pas dans le quota.
    hls.levels = [{ bitrate: 34_000_000, details: { targetduration: 10 } }];
    hls.emit('ls');
    assert.equal(hls.config.maxBufferLength, 10);
  });
});

// Sur erreur de quota, on purge d'urgence les segments terminés derrière la
// tête pour rendre la place au segment en append ; le plafond bridé par
// reduceLengthAndFlushBuffer() est restauré au prochain fragment bufferisé.
test('a quota error flushes finished segments and the cap is restored on append', () => {
  withFakeHls(hls => {
    const video = { currentTime: 0, buffered: { length: 1, start: () => 0 },
      addEventListener() {}, removeEventListener() {} };
    new HlsJsBackend(video, 'u', { bufferSeconds: 30, backBufferSeconds: 10 });
    for (const details of ['bufferAppendError', 'bufferFullError']) {
      hls.config.maxBufferLength = 5; hls.config.maxMaxBufferLength = 5;
      hls.emit('err', { fatal: false, details });
      assert.deepEqual(hls.triggers, [], details);
      assert.equal(hls.config.maxBufferLength, 5, details);
      hls.emit('fb');
      assert.equal(hls.config.maxBufferLength, 30, details);
      assert.equal(hls.config.maxMaxBufferLength, 30, details);
      assert.equal(hls.config.backBufferLength, 10, details);
    }
    // La tête lit le fragment commençant à 20 s : tout ce qui précède est
    // purgé sur l'erreur de quota, sans toucher au GOP en cours de décodage.
    hls.streamController = { getAppendedFrag: () => ({ start: 20 }) };
    video.currentTime = 21;
    hls.emit('err', { fatal: false, details: 'bufferFullError' });
    assert.deepEqual(hls.triggers, [{ name: 'flushing', data: { startOffset: 0, endOffset: 19.5, type: 'video' } }]);
    hls.emit('err', { fatal: false, details: 'fragParsingError' });
    assert.equal(hls.config.maxBufferLength, 30);
  });
});

// Un segment de 10 s pèse 20-34 Mo : dès que la tête entre dans le suivant,
// tout le back-buffer vidéo antérieur est purgé au lieu d'attendre l'éviction
// native de hls.js, qui conserve encore un targetDuration entier. Jamais dans
// le fragment lu : sa keyframe est nécessaire au décodeur.
test('a finished video fragment is flushed once the head leaves it', () => {
  withFakeHls(hls => {
    const video = { currentTime: 21, buffered: { length: 1, start: () => 0 },
      addEventListener() {}, removeEventListener() {} };
    new HlsJsBackend(video, 'u', { backBufferSeconds: 5 });
    hls.streamController = { getAppendedFrag: () => ({ start: 20 }) };
    hls.emit('fb');
    assert.deepEqual(hls.triggers, [{ name: 'flushing', data: { startOffset: 0, endOffset: 19.5, type: 'video' } }]);
    // Tête toujours dans le premier fragment : rien derrière elle à purger.
    hls.streamController = { getAppendedFrag: () => ({ start: 0 }) };
    hls.emit('fb');
    assert.equal(hls.triggers.length, 1);
  });
});
