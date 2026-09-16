import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorRenderer } from '../public/color-renderer.js';

test('renderer sizes to display pixels, limits GPU checks and skips idle frames', t => {
  t.mock.method(performance, 'now', () => now);
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { hidden: false }; globalThis.window = { devicePixelRatio: 2 };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  let now = 0, draws = 0, checks = 0;
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    canvas: { width: 300, height: 150, dataset: {}, style: {} }, captions: { style: {} },
    displayWidth: 400, displayHeight: 300,
    video: { readyState: 4, videoWidth: 3840, videoHeight: 2160, currentTime: 1, paused: false },
    gl: { NO_ERROR: 0, getParameter: () => 8192, viewport() {}, texImage2D() {}, flush() {},
      drawArrays() { draws++; }, getError() { checks++; return 0; },
      readPixels(x, y, w, h, f, t, pixel) { pixel[0] = x & 255; } },
  });
  renderer.draw();
  assert.deepEqual([renderer.canvas.width, renderer.canvas.height], [800, 450]);
  assert.equal(renderer.ready, true); assert.equal(checks, 1);
  assert.equal(renderer.canvas.style.visibility, '');
  renderer.draw(false); assert.equal(draws, 1);
  for (let i = 0; i < 30; i++) { now += 30; renderer.video.currentTime += 1 / 30; renderer.draw(false); }
  assert.equal(draws, 31); assert.equal(checks, 1);
  now = 2000; renderer.draw(); assert.equal(checks, 2);
  renderer.displayWidth = 3840; renderer.displayHeight = 2160; renderer.draw();
  assert.deepEqual([renderer.canvas.width, renderer.canvas.height], [3840, 2160]);
  renderer.displayWidth = 400; renderer.displayHeight = 100; renderer.draw();
  assert.deepEqual([renderer.canvas.width, renderer.canvas.height], [356, 200]);
  const before = draws;
  document.hidden = true; renderer.draw(); assert.equal(draws, before);
  document.hidden = false; renderer.video.seeking = true; renderer.draw(); assert.equal(draws, before);
  renderer.video.seeking = false; renderer.drawErrors = 7; now = 4000;
  renderer.gl.getError = () => 1285;
  let failure;
  renderer.onFailure = message => { failure = message; };
  renderer.draw();
  assert.equal(renderer.failed, true); assert.match(failure, /rendu des couleurs/);
  renderer.draw(); assert.equal(draws, before + 1);
});

test('renderer falls back to the native video while the texture import is dead', t => {
  t.mock.method(performance, 'now', () => now);
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { hidden: false }; globalThis.window = { devicePixelRatio: 1 };
  let now = 0;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    canvas: { width: 800, height: 400, dataset: {}, style: {} }, captions: { style: {} },
    video: { readyState: 4, videoWidth: 800, videoHeight: 400, currentTime: 1, paused: false },
    gl: { NO_ERROR: 0, getParameter: () => 8192, viewport() {}, texImage2D() {}, flush() {},
      drawArrays() {}, getError() { return 0; },
      readPixels(x, y, w, h, f, t, pixel) { pixel.fill(51); } },
  });
  renderer.draw();
  assert.equal(renderer.canvas.style.visibility, 'hidden');
  assert.equal(renderer.captions.style.display, 'none');
  renderer.gl.readPixels = (x, y, w, h, f, t, pixel) => { pixel[0] = x & 255; };
  now = 3000; renderer.draw();
  assert.equal(renderer.canvas.style.visibility, '');
  assert.equal(renderer.captions.style.display, '');
});

test('captions deduplicate cues shared by several showing tracks', t => {
  const previous = { document: globalThis.document };
  globalThis.document = { hidden: false, createElement: () => ({ append() {} }) };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const cue = { startTime: 68.9, endTime: 71.1, text: 'ligne', line: 84, snapToLines: false, getCueAsHTML: () => 'ligne' };
  const track = mode => ({ kind: 'subtitles', mode, activeCues: [cue] });
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    captions: { style: {}, nodes: null, replaceChildren(...nodes) { this.nodes = nodes; } },
    video: { textTracks: [track('showing'), track('showing'), track('disabled'), { kind: 'metadata', mode: 'showing', activeCues: [cue] }] },
  });
  renderer.updateCaptions();
  assert.equal(renderer.captions.nodes.length, 1);
  assert.equal(renderer.captions.style.bottom, '16%');
});
