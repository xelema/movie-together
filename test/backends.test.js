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
    assert.equal(config.backBufferLength, 15);
    assert.equal(config.startFragPrefetch, true);
    assert.equal(config.progressive, false);
    assert.equal(config.maxBufferSize, 80 * 1024 * 1024);
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
    assert.equal(config.maxBufferSize, 120 * 1024 * 1024);
    hls.config.backBufferLength = 30; hls.config.maxBufferSize = 120 * 1024 * 1024;
    backend.setBufferGoal(8, 30, 45, 90);
    assert.equal(hls.config.backBufferLength, 45);
    assert.equal(hls.config.maxBufferSize, 90 * 1024 * 1024);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});

test('a saturated SourceBuffer purges the back buffer then restores the target', () => {
  const { hls } = fakeHls();
  const saved = globalThis.window;
  globalThis.window = { Hls: class { constructor() { return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    new HlsJsBackend({}, 'u', { backBufferSeconds: 25 });
    for (const details of ['bufferAppendError', 'bufferFullError']) {
      hls.config.backBufferLength = 25;
      hls.emit('err', { fatal: false, details });
      assert.equal(hls.config.backBufferLength, 0, details);
      hls.emit('fb');
      assert.equal(hls.config.backBufferLength, 25, details);
    }
    // Other non-fatal errors leave the retention alone.
    hls.emit('err', { fatal: false, details: 'fragParsingError' });
    assert.equal(hls.config.backBufferLength, 25);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});
