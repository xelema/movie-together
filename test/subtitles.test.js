import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleFontSize, shownSubtitleTrack, reviveSubtitleCues } from '../public/sync-core.js';
import { SyncPlayer } from '../public/sync-player.js';

const track = (mode, { kind = 'subtitles', cues = 0 } = {}) =>
  ({ kind, mode, activeCues: Array.from({ length: cues }, () => ({})) });

test('subtitle font size follows the rendered picture height', () => {
  // Reference: the old 2.4vw rule on a 1280x720 16:9 picture, raised 25%.
  assert.equal(subtitleFontSize(720), 38.4);
  assert.equal(subtitleFontSize(360), 19.2);
  assert.equal(subtitleFontSize(0), 18);
  assert.ok(Math.abs(subtitleFontSize(1080) - 57.6) < 1e-9);
  assert.ok(Math.abs(subtitleFontSize(540) - 28.8) < 1e-9);
});

test('the single showing text track is the one with live cues', () => {
  const tracks = [track('hidden'), track('showing'), track('showing', { cues: 1 }), track('disabled')];
  assert.equal(shownSubtitleTrack(tracks), tracks[2]);
});

test('a lone showing track keeps its place and other kinds are ignored', () => {
  const tracks = [track('showing'), track('showing', { kind: 'metadata', cues: 1 }), track('hidden')];
  assert.equal(shownSubtitleTrack(tracks), tracks[0]);
  assert.equal(shownSubtitleTrack([track('hidden'), track('disabled')]), null);
});

test('the selected subtitle track survives a showing duplicate with cues', () => {
  const tracks = [track('showing'), track('showing', { cues: 2 }), track('hidden')];
  assert.equal(shownSubtitleTrack(tracks, 0), tracks[0]);
  assert.equal(shownSubtitleTrack(tracks, 1), tracks[1]);
});

test('an unavailable selection falls back to live cues then first showing', () => {
  const tracks = [track('hidden'), track('showing', { cues: 1 }), track('showing')];
  assert.equal(shownSubtitleTrack(tracks, 0), tracks[1]);
  assert.equal(shownSubtitleTrack(tracks, 9), tracks[1]);
  assert.equal(shownSubtitleTrack(tracks, -1), tracks[1]);
  assert.equal(shownSubtitleTrack([track('hidden'), track('disabled')], 0), null);
});

// positionSubtitles is exercised on a bare fake: no DOM needed.
const fakePlayer = (tracks, subtitleChoice, video = {}) => {
  const styles = {};
  return {
    subtitleChoice,
    styles,
    video: {
      textTracks: tracks,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
      videoWidth: 1920, videoHeight: 1080, currentTime: 0,
      webkitDisplayingFullscreen: false,
      parentElement: { style: { setProperty: (name, value) => { styles[name] = value; } } },
      ...video,
    },
  };
};
const positionSubtitles = player => SyncPlayer.prototype.positionSubtitles.call(player);

test('positionSubtitles keeps the selected track and demotes showing duplicates', () => {
  const tracks = [track('showing'), track('showing', { cues: 1 })];
  positionSubtitles(fakePlayer(tracks, 0));
  assert.equal(tracks[0].mode, 'showing');
  assert.equal(tracks[1].mode, 'hidden');
});

test('positionSubtitles hides every text track when none is selected', () => {
  const tracks = [track('showing', { cues: 1 }), track('showing')];
  positionSubtitles(fakePlayer(tracks, -1));
  assert.deepEqual(tracks.map(t => t.mode), ['hidden', 'hidden']);
});

test('webkit native fullscreen sizes subtitles from the screen', () => {
  const player = fakePlayer([track('showing', { cues: 1 })], 0,
    { getBoundingClientRect: () => ({ width: 1280, height: 720 }), videoWidth: 1280, videoHeight: 720 });
  positionSubtitles(player);
  assert.equal(player.styles['--subtitle-size'], '38.4px');
  const saved = globalThis.screen;
  globalThis.screen = { width: 640, height: 300 };
  player.video.webkitDisplayingFullscreen = true;
  try {
    positionSubtitles(player);
    // Landscape 640x300 paints a 300 px tall picture, floored at 18 px.
    assert.equal(player.styles['--subtitle-size'], '18px');
    assert.equal(player.video.textTracks[0].activeCues[0].line, 84);
  } finally {
    if (saved === undefined) delete globalThis.screen; else globalThis.screen = saved;
  }
});

test('webkit video fullscreen events refresh subtitle layout', () => {
  const recorded = () => {
    const events = {};
    return { events, addEventListener: (name, handler) => (events[name] ??= []).push(handler), removeEventListener() {} };
  };
  const video = recorded(), doc = recorded(), win = recorded(), textTracks = recorded();
  Object.assign(video, { textTracks, pause() {}, load() {}, removeAttribute() {} });
  const globals = ['document', 'window', 'location', 'matchMedia', 'ResizeObserver', 'WebSocket', 'requestAnimationFrame'];
  const saved = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
  let frames = 0;
  Object.assign(globalThis, {
    document: Object.assign(doc, { hidden: false }),
    window: win,
    location: { protocol: 'https:', host: 'example.test' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 0; } send() {} close() {} },
    requestAnimationFrame: () => frames++,
  });
  try {
    const player = new SyncPlayer({ video, roomId: 'room', onStatus() {}, onState() {}, onTracks() {}, onActivation() {} });
    assert.equal(video.events['webkitbeginfullscreen']?.length, 1);
    assert.equal(video.events['webkitendfullscreen']?.length, 1);
    assert.equal(video.events['webkitpresentationmodechanged']?.length, 1);
    assert.equal(doc.events['fullscreenchange']?.length, 1);
    assert.equal(doc.events['webkitfullscreenchange']?.length, 1);
    // Rotation inside native fullscreen only reaches the window.
    assert.equal(win.events['resize']?.length, 1);
    // Each lifecycle event repositions now and again once layout settles.
    let calls = 0;
    player.positionSubtitles = () => calls++;
    video.events['webkitbeginfullscreen'][0]();
    video.events['webkitendfullscreen'][0]();
    video.events['webkitpresentationmodechanged'][0]();
    // A window resize outside native fullscreen is already covered by the
    // element observer; the window listener only matters in the system layer.
    win.events['resize'][0]();
    assert.equal(calls, 3);
    video.webkitDisplayingFullscreen = true;
    win.events['resize'][0]();
    assert.equal(calls, 4);
    assert.equal(frames, 4);
    player.disposed = true;
    clearInterval(player.interval); clearInterval(player.pinger); clearInterval(player.initialPings);
  } finally {
    for (const key of globals) saved[key] === undefined ? delete globalThis[key] : globalThis[key] = saved[key];
  }
});

test('a track whose cues went stale is re-registered once, whole list', () => {
  // Model the browser stranding a whole cue list: present in cues, absent from
  // activeCues even inside the cue window.
  const cue = { startTime: 0, endTime: 10 }, other = { startTime: 20, endTime: 30 };
  const track = {
    cues: [cue, other], activeCues: [], readded: [],
    removeCue() {}, addCue(item) { this.readded.push(item); },
  };
  reviveSubtitleCues(track, 5);
  assert.deepEqual(track.readded, [cue, other]);
  track.readded = [];
  reviveSubtitleCues(track, 6);
  assert.deepEqual(track.readded, []);
});

test('no cues to revive while the active cue is tracked', () => {
  const cue = { startTime: 0, endTime: 10 };
  const track = { cues: [cue], activeCues: [cue], addCue() { throw new Error('unexpected'); }, removeCue() {} };
  reviveSubtitleCues(track, 5);
  assert.equal(track.revived, false);
});

test('a healed track can be revived again after a new stranding', () => {
  const cue = { startTime: 0, endTime: 10 };
  const track = {
    cues: [cue], activeCues: [], readded: [],
    removeCue() {}, addCue(item) { this.readded.push(item); },
  };
  reviveSubtitleCues(track, 5);
  assert.equal(track.readded.length, 1);
  // The browser rescheduled the cue: the flag clears on the next healthy read.
  track.activeCues = [cue]; track.readded = [];
  reviveSubtitleCues(track, 6);
  assert.equal(track.revived, false);
  track.activeCues = [];
  reviveSubtitleCues(track, 7);
  assert.equal(track.readded.length, 1);
});

test('positionSubtitles revives the kept track when its cues went stale', () => {
  const cue = { startTime: 0, endTime: 50 };
  const kept = {
    kind: 'subtitles', mode: 'showing', cues: [cue], activeCues: [],
    removeCue() {}, addCue(item) { (this.added ??= []).push(item); },
  };
  positionSubtitles(fakePlayer([kept, track('disabled')], 0, { currentTime: 10 }));
  assert.deepEqual(kept.added, [cue]);
});
