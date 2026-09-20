import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleFontSize, shownSubtitleTrack } from '../public/sync-core.js';

const track = (mode, { kind = 'subtitles', cues = 0 } = {}) =>
  ({ kind, mode, activeCues: Array.from({ length: cues }, () => ({})) });

test('subtitle font size follows the rendered picture height', () => {
  // Reference: the old 2.4vw rule on a 1280x720 16:9 picture.
  assert.equal(subtitleFontSize(720), 30.72);
  assert.equal(subtitleFontSize(360), 18);
  assert.equal(subtitleFontSize(0), 18);
  assert.ok(Math.abs(subtitleFontSize(1080) - 46.08) < 1e-9);
  assert.ok(Math.abs(subtitleFontSize(540) - 23.04) < 1e-9);
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
