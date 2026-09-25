import test from 'node:test';
import assert from 'node:assert/strict';
import { ColorRenderer, colorNeedsRenderer } from '../public/color-renderer.js';

test('only HDR transfers use the colour renderer', () => {
  const needs = color => colorNeedsRenderer({ version: 1, matrix: 'bt709', fullRange: false, bitDepth: 8, peakNits: 1000, ...color });
  // SDR plays through the native video element, whatever its gamut.
  assert.equal(needs({ transfer: 'bt709', primaries: 'bt709' }), false);
  assert.equal(needs({ transfer: 'bt709', primaries: 'bt2020', matrix: 'bt2020nc' }), false);
  assert.equal(needs({ transfer: 'smpte170m', primaries: 'smpte170m', matrix: 'smpte170m' }), false);
  assert.equal(needs({ transfer: 'iec61966-2-1', primaries: 'bt709' }), false);
  assert.equal(needs({ transfer: 'smpte2084', primaries: 'bt2020', matrix: 'bt2020nc', bitDepth: 10 }), true);
  assert.equal(needs({ transfer: 'arib-std-b67', primaries: 'bt2020', matrix: 'bt2020nc', bitDepth: 10 }), true);
  // Unknown metadata keeps the old behaviour: try the renderer, fail loudly if unmappable.
  assert.equal(colorNeedsRenderer({ version: 2 }), true);
});

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
  // Stub GL permissif : toute methode est absorbee, les constantes valent 0.
  const gl = new Proxy({ NO_ERROR: 0, getParameter: () => 8192,
    drawArrays() { draws++; }, getError() { checks++; return 0; },
    readPixels(x, y, w, h, f, t, pixel) { pixel[0] = x & 255; } },
    { get: (target, prop) => (prop in target ? target[prop] : /^[A-Z_0-9]+$/.test(String(prop)) ? 0 : () => {}) });
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    canvas: { width: 300, height: 150, dataset: {}, style: {} }, captions: { style: {} },
    displayWidth: 400, displayHeight: 300,
    video: { readyState: 4, videoWidth: 3840, videoHeight: 2160, currentTime: 1, paused: false },
    gl,
  });
  renderer.draw();
  assert.deepEqual([renderer.canvas.width, renderer.canvas.height], [800, 450]);
  assert.equal(renderer.ready, true); assert.equal(checks, 1);
  assert.equal(renderer.canvas.style.visibility, '');
  renderer.draw(false); assert.equal(draws, 1);
  for (let i = 0; i < 30; i++) { now += 30; renderer.video.currentTime += 1 / 30; renderer.draw(false); }
  assert.equal(draws, 31); assert.equal(checks, 1);
  // L'import vérifié coupe les sondes synchrones pendant la lecture active.
  now = 2000; renderer.draw(); assert.equal(checks, 1);
  renderer.displayWidth = 3840; renderer.displayHeight = 2160; renderer.draw();
  assert.equal(checks, 2);
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
  const gl = new Proxy({ NO_ERROR: 0, getParameter: () => 8192, getError: () => 0,
    readPixels(x, y, w, h, f, t, pixel) { pixel.fill(51); } },
    { get: (target, prop) => (prop in target ? target[prop] : /^[A-Z_0-9]+$/.test(String(prop)) ? 0 : () => {}) });
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    canvas: { width: 800, height: 400, dataset: {}, style: {} }, captions: { style: {} },
    video: { readyState: 4, videoWidth: 800, videoHeight: 400, currentTime: 1, paused: false },
    gl,
  });
  renderer.draw();
  assert.equal(renderer.canvas.style.visibility, '');
  now = 3000; renderer.draw();
  assert.equal(renderer.canvas.style.visibility, 'hidden');
  assert.equal(renderer.captions.style.display, 'none');
  renderer.gl.readPixels = (x, y, w, h, f, t, pixel) => { pixel[0] = x & 255; };
  now = 6000; renderer.draw();
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

test('renderer skips an already-presented frame and stays silent during resume grace', t => {
  t.mock.method(performance, 'now', () => now);
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { hidden: false }; globalThis.window = { devicePixelRatio: 1 };
  let now = 0, uploads = 0, draws = 0, errors = 0, reads = 0;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const gl = new Proxy({ NO_ERROR: 0, getParameter: () => 8192,
    texImage2D() { uploads++; }, drawArrays() { draws++; },
    getError() { errors++; return 0; },
    readPixels(x, y, w, h, f, ty, pixel) { reads++; pixel[0] = x & 255; } },
    { get: (target, prop) => (prop in target ? target[prop] : /^[A-Z_0-9]+$/.test(String(prop)) ? 0 : () => {}) });
  const renderer = Object.assign(Object.create(ColorRenderer.prototype), {
    canvas: { width: 800, height: 450, dataset: {}, style: {} }, captions: { style: {} },
    displayWidth: 800, displayHeight: 450,
    video: { readyState: 4, videoWidth: 1920, videoHeight: 1080, currentTime: 1, paused: false,
      requestVideoFrameCallback: () => 1 },
    gl,
  });
  // Première frame présentée : upload, rendu et vérification unique de l'import.
  renderer.draw(false, 1);
  assert.equal(uploads, 1); assert.equal(draws, 1);
  assert.equal(reads, 2); assert.equal(renderer.importVerified, true);
  // La même frame re-présentée ne re-uploade pas la texture ni ne re-dessine.
  renderer.draw(false, 1);
  assert.equal(uploads, 1); assert.equal(draws, 1);
  // Grace de reprise : aucune sonde synchrone alors qu'un check serait dû.
  renderer.resumeGraceUntil = now + 2500; renderer.lastErrorCheck = now - 3000;
  renderer.draw(false, 2);
  assert.equal(errors, 1); assert.equal(reads, 2); assert.equal(uploads, 2);
  // Grace passée, l'import vérifié dispense aussi le polling getError des 2 s.
  now = 5000; renderer.draw(false, 3);
  assert.equal(errors, 1); assert.equal(reads, 2);
  // La pause conserve sa sonde, inoffensive sur une image figée.
  renderer.video.paused = true; renderer.draw();
  assert.equal(errors, 2); assert.equal(reads, 2);
});

test('the WebGL context is requested on the high-performance GPU', t => {
  const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  let attributes;
  const gl = new Proxy({ NO_ERROR: 0, getParameter: () => 8192,
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderPrecisionFormat: () => ({ precision: 23 }), getExtension: () => null },
    { get: (target, prop) => (prop in target ? target[prop] : /^[A-Z_0-9]+$/.test(String(prop)) ? 0 : () => {}) });
  globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    hidden: false,
    createElement: tag => tag === 'canvas'
      ? { className: '', style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
          remove() {}, getContext: (name, options) => { attributes = options; return gl; } }
      : { className: '', style: {}, remove() {} },
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const video = {
    readyState: 0, paused: true, addEventListener() {}, removeEventListener() {},
    parentElement: { append() {} },
    textTracks: { addEventListener() {}, removeEventListener() {}, [Symbol.iterator]: function* () {} },
    requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {},
  };
  const renderer = new ColorRenderer(video, { version: 1, matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' }, () => {});
  assert.equal(attributes.powerPreference, 'high-performance');
  assert.equal(attributes.alpha, false);
  assert.equal(attributes.preserveDrawingBuffer, false);
  renderer.dispose();
});
