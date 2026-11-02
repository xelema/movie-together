import test from 'node:test';
import assert from 'node:assert/strict';
import { codecPlayable, pinSubtitleModes, releaseSubtitlePlaceholders, SUBTITLE_PLACEHOLDER, HlsJsBackend, nativeHls, supportsMime, floorForwardBuffer } from '../public/backends.js';

// The adapter watches the media element for the subtitle <track> nodes hls.js
// appends itself; node has no MutationObserver, and these stubs no DOM to watch.
const stubMutationObserver = hooks => {
  const saved = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) { hooks?.created?.(callback); }
    observe(target, options) { hooks?.observe?.(target, options); }
    disconnect() { hooks?.disconnect?.(); }
  };
  return () => { saved === undefined ? delete globalThis.MutationObserver : globalThis.MutationObserver = saved; };
};

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
    loadSource() {}, attachMedia() {}, on() {}, destroy() {},
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
  const restoreObserver = stubMutationObserver();
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
    restoreObserver();
  }
});

test('hls.js is configured for stall-free resume and deep segment reuse', () => {
  const { hls } = fakeHls();
  const restoreObserver = stubMutationObserver();
  const saved = globalThis.window;
  let config;
  globalThis.window = { Hls: class { constructor(options) { config = options; return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    new HlsJsBackend({}, 'u');
    assert.equal(config.backBufferLength, 60);
    assert.equal(config.startFragPrefetch, true);
    assert.equal(config.progressive, false);
    assert.ok(config.maxBufferSize >= 128 * 1024 ** 2);
  } finally {
    saved === undefined ? delete globalThis.window : globalThis.window = saved;
    restoreObserver();
  }
});

// hls.js hardcodes `data:,WEBVTT` as the src of every subtitle track node it
// creates (createTrackNode). The app CSP's media-src refuses data:, so leaving the
// placeholder in place costs one blocked request and one `resource-error` per
// subtitle rendition; the adapter swaps it for an empty WebVTT blob first.
test('the hls.js subtitle placeholder is swapped for a loadable empty WebVTT', () => {
  const nodes = [{ src: SUBTITLE_PLACEHOLDER }, { src: '/media/sub_fr.m3u8' }, { src: SUBTITLE_PLACEHOLDER }];
  releaseSubtitlePlaceholders(nodes, 'blob:empty-vtt');
  assert.deepEqual(nodes.map(node => node.src), ['blob:empty-vtt', '/media/sub_fr.m3u8', 'blob:empty-vtt']);
  // The watcher fires on every later childList change too; a node already adopted
  // and a real track node must both be left alone.
  releaseSubtitlePlaceholders(nodes, 'blob:other');
  assert.deepEqual(nodes.map(node => node.src), ['blob:empty-vtt', '/media/sub_fr.m3u8', 'blob:empty-vtt']);
});

test('the adapter adopts hls.js track nodes the moment they are appended', () => {
  const { hls } = fakeHls();
  const savedWindow = globalThis.window;
  const seen = [];
  let callback;
  const restoreObserver = stubMutationObserver({
    created: cb => { callback = cb; },
    observe: (target, options) => seen.push([target, options]),
    disconnect: () => seen.push('disconnect'),
  });
  globalThis.window = { Hls: class { constructor() { return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  try {
    const node = { src: SUBTITLE_PLACEHOLDER };
    const video = { querySelectorAll: () => [node] };
    const backend = new HlsJsBackend(video, 'u');
    assert.deepEqual(seen[0], [video, { childList: true }]);
    callback();
    assert.equal(node.src, backend.subtitleVtt);
    assert.match(backend.subtitleVtt, /^blob:/);
    backend.destroy();
    assert.equal(seen.at(-1), 'disconnect');
  } finally {
    savedWindow === undefined ? delete globalThis.window : globalThis.window = savedWindow;
    restoreObserver();
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
// hls.js's reduceMaxBufferLength, as it ran on fab's TV (29 October, AV1 fragments
// of 10.01 s): bufferLen 26.65, 22.65 then 10.97 at each QuotaExceededError.
const reduceMaxBufferLength = (config, threshold, fragDuration) => {
  const minLength = Math.max(Math.min(threshold - fragDuration, config.maxBufferLength), fragDuration / 2);
  const reducedLength = Math.max(threshold - fragDuration * 3, config.maxMaxBufferLength / 2, minLength);
  if (reducedLength >= minLength) config.maxMaxBufferLength = reducedLength;
};

test('three quota refusals cannot cut the forward buffer under the room reserve', () => {
  const bare = { maxBufferLength: 25, maxMaxBufferLength: 50 };
  for (const len of [26.65, 22.65, 10.97]) reduceMaxBufferLength(bare, len, 10.01);
  // What hls.js aimed for on the TV: 6.3 s, under the 8 s the room waited for.
  assert.ok(bare.maxMaxBufferLength < 8);

  const config = { maxBufferLength: 25, maxMaxBufferLength: 50 };
  floorForwardBuffer(config, () => 9);
  const cuts = [];
  for (const len of [26.65, 22.65, 10.97]) { reduceMaxBufferLength(config, len, 10.01); cuts.push(config.maxMaxBufferLength); }
  // Above the floor the cut still applies; it stops at the floor.
  assert.deepEqual(cuts.map(value => Math.round(value * 100) / 100), [25, 12.64, 9]);
  config.maxMaxBufferLength = 60;
  assert.equal(config.maxMaxBufferLength, 60);
});

test('the adapter floors hls.js just over the reserve, and follows a new reserve', () => {
  const restore = stubMutationObserver();
  const saved = globalThis.window, savedURL = globalThis.URL, savedBlob = globalThis.Blob;
  let created;
  globalThis.window = { Hls: class { constructor(config) { this.config = config; created = this; }
    loadSource() {} attachMedia() {} on() {} destroy() {} static Events = {} } };
  try {
    const backend = new HlsJsBackend({ querySelectorAll: () => [] }, '/m.m3u8', { bufferSeconds: 25, minBuffer: 8 }, {});
    assert.equal(created.config.maxMaxBufferLength, 50);
    created.config.maxMaxBufferLength = 6.32;
    assert.equal(created.config.maxMaxBufferLength, 9);
    backend.setBufferGoal(12, 30);
    assert.equal(created.config.maxMaxBufferLength, 60);
    created.config.maxMaxBufferLength = 3;
    assert.equal(created.config.maxMaxBufferLength, 13);
  } finally {
    restore(); globalThis.window = saved; globalThis.URL = savedURL; globalThis.Blob = savedBlob;
  }
});

// A first outage spends the fatal-error recovery; once the stream has played
// healthily for a while the budget is back, so a second outage later in the
// film recovers the same way instead of failing the viewer for the rest of the
// séance. A fragment buffered right after a recovery does not refill it: a
// deterministic decode error must still end in a failure, not a loop.
test('a healthy stretch restores the fatal-error recovery budget', () => {
  const restore = stubMutationObserver();
  const saved = globalThis.window;
  const handlers = {}, calls = [];
  const hls = { config: {}, loadSource() {}, attachMedia() {}, destroy() {},
    on(name, handler) { (handlers[name] ??= []).push(handler); },
    startLoad: at => calls.push(['startLoad', at]), recoverMediaError: () => calls.push(['recoverMediaError']) };
  globalThis.window = { Hls: class { constructor() { return hls; } } };
  window.Hls.Events = { FRAG_BUFFERED: 'fb', MANIFEST_PARSED: 'mp', AUDIO_TRACKS_UPDATED: 'au', SUBTITLE_TRACKS_UPDATED: 'su', ERROR: 'err' };
  window.Hls.ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  const emit = (name, data) => { for (const handler of handlers[name] ?? []) handler(name, data); };
  const fatal = [];
  let now = 0;
  try {
    const video = { currentTime: 12, querySelectorAll: () => [] };
    const backend = new HlsJsBackend(video, 'u', {}, { onFatal: message => fatal.push(message) });
    backend.clock = () => now;
    emit('err', { fatal: true, type: 'network', details: 'fragLoadError' });
    now = 120_000; emit('fb', {});
    video.currentTime = 3600;
    emit('err', { fatal: true, type: 'network', details: 'fragLoadError' });
    emit('err', { fatal: true, type: 'media', details: 'bufferStalledError' });
    assert.deepEqual(calls, [['startLoad', 12], ['startLoad', 3600], ['recoverMediaError']]);
    assert.deepEqual(fatal, []);
    // Fragments buffered just after the recovery do not refill the budget: the
    // same decode error coming back fails instead of recovering forever.
    now = 125_000; emit('fb', {});
    emit('err', { fatal: true, type: 'media', details: 'bufferStalledError' });
    assert.equal(fatal.length, 1);
    assert.equal(calls.length, 3);
    // A long healthy stretch later, the next outage recovers again.
    now = 400_000; emit('fb', {});
    emit('err', { fatal: true, type: 'media', details: 'bufferStalledError' });
    assert.deepEqual(calls.at(-1), ['recoverMediaError']);
    assert.equal(fatal.length, 1);
    backend.destroy();
  } finally {
    restore(); saved === undefined ? delete globalThis.window : globalThis.window = saved;
  }
});
