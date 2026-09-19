// Generates only tiny test fixtures. Production preparation never encodes video.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { chromium, firefox } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';
import { prepareMovie, run } from '../src/media.js';
import { pipeline } from '../public/color-renderer.js';

const { splineLut, gamutLut, rgb2ipt, ipt2rgb, iptRgb2lms, invert3, PRIMARIES, TARGET_NITS, TARGET_BLACK } = pipeline;

// Independent model of the intended render for the known patches: limited-range decode
// with the source matrix, transfer to linear. HDR then replays the renderer's own
// chain (spline on the source peak, perceptual gamut, gamma 2.2);
// SDR keeps the simple gamut matrix and sRGB out. Comparing the render to this
// model catches a decoder path that no browser flags.
const pqToNits = v => { const p = Math.max(v, 0) ** (1 / 78.84375);
  return 10000 * (Math.max(p - .8359375, 0) / Math.max(18.8515625 - 18.6875 * p, .000001)) ** (1 / .1593017578125); };
const nitsToPq = n => { const p = (Math.max(n, 0) / 10000) ** .1593017578125;
  return ((.8359375 + 18.8515625 * p) / (1 + 18.6875 * p)) ** 78.84375; };
const hlgToLinear = v => v <= .5 ? v * v / 3 : (Math.exp((v - .55991073) / .17883277) + .28466892) / 12;
const KRKB = { bt709: [.2126, .0722], bt2020nc: [.2627, .0593], smpte170m: [.299, .114], bt470bg: [.299, .114] };
const GAMUT = { bt709: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  bt2020: [1.660491, -.124550, -.018151, -.587641, 1.132900, -.100579, -.072850, -.008349, 1.118730],
  smpte170m: [.939542, .017772, -.001622, .050181, .965793, -.004371, .010277, .016435, 1.005993],
  bt470bg: [1.044044, 0, 0, -.044044, 1, .011793, 0, 0, .988207],
  smpte432: [1.224940, -.042057, -.019638, -.224940, 1.042057, -.078636, 0, 0, 1.098274] };

function expectedPatch(color, { code, chroma }) {
  const s = color.bitDepth === 10 ? 4 : 1;
  const y = (code - 16 * s) / (219 * s), cb = chroma / (224 * s), cr = -chroma / (224 * s);
  const [kr, kb] = KRKB[color.matrix];
  const r = y + 2 * (1 - kr) * cr, b = y + 2 * (1 - kb) * cb;
  // The RGBA8 texture clamps what the decoder produces before the shader sees it.
  let rgb = [r, (y - kr * r - kb * b) / (1 - kr - kb), b].map(v => Math.min(1, Math.max(v, 0)));
  const hdr = color.transfer === 'smpte2084' || color.transfer === 'arib-std-b67';
  if (color.transfer === 'smpte2084') rgb = rgb.map(pqToNits);
  else if (color.transfer === 'arib-std-b67') {
    rgb = rgb.map(hlgToLinear);
    rgb = rgb.map(v => v * 1000 * Math.max(rgb[0] * .2627 + rgb[1] * .678 + rgb[2] * .0593, 0) ** .2);
  }
  // SDR : pas de linearisation, les navigateurs affichent le RGB decode tel
  // quel (bt709 ~ sRGB). Le modele rend donc les codes directement.
  if (!hdr) {
    const g = GAMUT[color.primaries];
    rgb = [0, 1, 2].map(i => g[i] * rgb[0] + g[i + 3] * rgb[1] + g[i + 6] * rgb[2]);
  }
  let luminance = Math.max(rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722, 0);
  if (hdr) {
    // Chaîne HDR du shader : spline statique sur I (IPT, pic de la source),
    // rescale chroma hull, LUT gamut perceptuelle, sortie gamma 2.2 après remap
    // du noir ; le contrast recovery est sans effet sur des aplats.
    const inMin = nitsToPq(1e-6);
    let outMin = nitsToPq(TARGET_BLACK), outMax = nitsToPq(TARGET_NITS);
    const inMax = Math.max(nitsToPq(color.peakNits || (color.transfer === 'smpte2084' ? 10000 : 1000)),
      Math.min(outMax, nitsToPq(100)));
    if (Math.abs(inMin - outMin) < 1e-6) outMin = inMin;
    if (Math.abs(inMax - outMax) < 1e-6) outMax = inMax;
    outMax = Math.min(outMax, inMax);
    const lut = splineLut(inMin, inMax, 0, outMin, outMax);
    const inRange = inMax - inMin;
    const rgb2lms = iptRgb2lms(PRIMARIES[color.primaries]);
    const dstLms2rgb = invert3(iptRgb2lms(PRIMARIES.bt709));
    const gmin = nitsToPq(TARGET_BLACK), ginv = 1 / (nitsToPq(TARGET_NITS) - gmin);
    const lut3d = color.primaries === 'bt709' ? null : gamutCache[color.primaries] ??= gamutLut(
      { srcRgb2lms: rgb2lms, srcLms2rgb: invert3(rgb2lms), dstRgb2lms: iptRgb2lms(PRIMARIES.bt709), dstLms2rgb },
      gmin, nitsToPq(TARGET_NITS));
    const hull = x => ((x - 6) * x + 9) * x;
    // rgb2ipt/ipt2rgb travaillent en nits/10000, la sortie shader en 1/203 nit.
    const outScale = 10000 / (TARGET_NITS - TARGET_BLACK), outOffset = -TARGET_BLACK / (TARGET_NITS - TARGET_BLACK);
    const map = v => {
      let ipt = rgb2ipt(v.map(x => x / 10000), rgb2lms);
      const iOrig = ipt[0];
      const fi = Math.min(Math.max((iOrig - inMin) / inRange, 0), 1) * 255;
      const i0 = Math.floor(fi), f = fi - i0;
      ipt[0] = Math.min(Math.max(lut[i0] * (1 - f) + lut[Math.min(i0 + 1, 255)] * f, outMin), outMax);
      if (iOrig > 0 && ipt[0] > 0) {
        const k = Math.min(iOrig / ipt[0], hull(ipt[0]) / hull(iOrig));
        ipt[1] *= k; ipt[2] *= k;
      }
      if (lut3d) ipt = gamutSample(lut3d, [(ipt[0] - gmin) * ginv, 2 * Math.hypot(ipt[1], ipt[2]),
        Math.atan2(ipt[2], ipt[1]) * .15915494 + .5]);
      return ipt2rgb(ipt, dstLms2rgb).map(x => Math.max(x * outScale + outOffset, 0) ** (1 / 2.2));
    };
    return map(rgb).map(v => Math.round(v * 255));
  }
  const low = Math.min(...rgb), high = Math.max(...rgb);
  let saturation = 1;
  if (low < 0) saturation = Math.min(saturation, luminance / (luminance - low));
  if (high > 1) saturation = Math.min(saturation, Math.max(1 - luminance, 0) / Math.max(high - luminance, .000001));
  rgb = rgb.map(v => Math.min(1, Math.max(0, luminance + (v - luminance) * saturation)));
  return rgb.map(v => Math.round(v * 255));
}

// Port du fetch trilinéaire de la LUT 3D ICh du shader (h cyclique sur 255).
const gamutCache = {};
function gamutSample(lut3d, idx) {
  const clampN = (v, n) => Math.min(Math.max(v, 0), n);
  const fetch = (x, y, z) => {
    const h = ((z % 255) + 255) % 255;
    const o = ((h * 32 + clampN(y, 31)) * 48 + clampN(x, 47)) * 4;
    return [lut3d[o], lut3d[o + 1], lut3d[o + 2]];
  };
  const f = [clampN(idx[0], 1) * 47, clampN(idx[1], 1) * 31, idx[2] * 255];
  const i0 = f.map(Math.floor), t = f.map((v, i) => v - i0[i]);
  const mix3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const c00 = mix3(fetch(i0[0], i0[1], i0[2]), fetch(i0[0] + 1, i0[1], i0[2]), t[0]);
  const c10 = mix3(fetch(i0[0], i0[1] + 1, i0[2]), fetch(i0[0] + 1, i0[1] + 1, i0[2]), t[0]);
  const c01 = mix3(fetch(i0[0], i0[1], i0[2] + 1), fetch(i0[0] + 1, i0[1], i0[2] + 1), t[0]);
  const c11 = mix3(fetch(i0[0], i0[1] + 1, i0[2] + 1), fetch(i0[0] + 1, i0[1] + 1, i0[2] + 1), t[0]);
  return mix3(mix3(c00, c10, t[1]), mix3(c01, c11, t[1]), t[2]);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'movie-colors-'));
const store = createStore(root), fixtures = [], report = { browsers: {}, comparisons: {}, truth: {} };
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const output = path.resolve('test-results/colors'); await mkdir(output, { recursive: true });
let server;
try {
  for (const [name, codec, depth, transfer, primaries, matrix] of [
    ['HDR10', 'libx265', 10, 'smpte2084', 'bt2020', 'bt2020nc'],
    ['HLG', 'libx265', 10, 'arib-std-b67', 'bt2020', 'bt2020nc'],
    ['SDR709', 'libx264', 8, 'bt709', 'bt709', 'bt709'],
    ['SDR601', 'libx264', 8, 'smpte170m', 'smpte170m', 'smpte170m'],
  ]) {
    const width = 512, height = 128;
    // Twenty-four flat patches: grey levels plus moderate and saturated chroma, without edge interpolation.
    // Saturated chroma is what a wrong matrix decode visibly destroys.
    const codes = depth === 10 ? [64, 128, 256, 384, 448, 512, 576, 720] : [16, 32, 64, 96, 128, 160, 192, 235];
    const mild = depth === 10 ? 24 : 6, strong = depth === 10 ? 256 : 64;
    const patchChroma = column => column >= 2 && column < 4 ? mild : column >= 4 && column < 6 ? strong : 0;
    const patches = [];
    for (let column = 0; column < 8; column++) {
      patches.push({ x: column * 64 + 32, y: 32, code: codes[column], chroma: 0 });
      patches.push({ x: column * 64 + 32, y: 96, code: codes[column], chroma: patchChroma(column) });
    }
    // 10-bit planar samples occupy 16 bits in rawvideo.
    const raw = Buffer.alloc(width * height * 3 / 2 * (depth === 10 ? 2 : 1));
    const put = (index, value) => depth === 10 ? raw.writeUInt16LE(value, index * 2) : raw.writeUInt8(value, index);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(y * width + x, codes[Math.floor(x / 64)]);
    for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) {
      const center = depth === 10 ? 512 : 128, chroma = y >= 32 ? patchChroma(Math.floor(x / 32)) : 0;
      put(width * height + y * width / 2 + x, center + chroma);
      put(width * height * 5 / 4 + y * width / 2 + x, center - chroma);
    }
    const input = path.join(root, `${name}.yuv`); await writeFile(input, raw);
    const movie = { id: randomUUID(), title: name }; store.save(movie);
    const args = ['-y', '-v', 'error', '-stream_loop', '-1', '-f', 'rawvideo', '-pixel_format', depth === 10 ? 'yuv420p10le' : 'yuv420p',
      '-video_size', `${width}x${height}`, '-framerate', '10', '-i', input, '-t', '1', '-c:v', codec, '-preset', 'ultrafast', '-threads', '2'];
    // Les balises couleur doivent entrer dans le VUI x265 : sans elles ffprobe
    // ne voit que la matrice et transfer retombe a bt709 (rendu passthrough).
    if (depth === 10) args.push('-x265-params', `pools=2:lossless=1:colorprim=${primaries}:transfer=${transfer}:colormatrix=${matrix}`);
    else args.push('-crf', '1');
    args.push('-color_primaries', primaries, '-color_trc', transfer, '-colorspace', matrix, '-color_range', 'tv', '-f', 'matroska', path.join(store.directory(movie.id), 'source'));
    await run(ffmpeg, args);
    const prepared = await prepareMovie(store, movie, [], []);
    fixtures.push({ name, root: path.join(store.directory(movie.id), prepared.generation),
      rendition: prepared.renditions[0], patches });
  }
  const app = express();
  app.get('/', (_, res) => res.send('<!doctype html><style>body{margin:0;background:black}main{position:relative;width:512px}video{width:100%}canvas{position:absolute;inset:0;width:100%;height:100%}</style><main><video muted playsinline></video></main><script src="/hls.js"></script>'));
  app.get('/hls.js', (_, res) => res.sendFile(path.resolve('node_modules/hls.js/dist/hls.js')));
  app.use('/public', express.static(path.resolve('public')));
  for (const fixture of fixtures) app.use(`/${fixture.name}`, express.static(fixture.root));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, images = {};
  for (const [name, type, options] of [['Chrome', chromium, process.platform === 'win32' ? { channel: 'chrome' } : {}], ['Firefox', firefox, {}]]) {
    const browser = await type.launch({ headless: process.platform !== 'win32', ...options });
    try {
      report.browsers[name] = { version: browser.version() };
      const page = await browser.newPage({ viewport: { width: 512, height: 256 } }); await page.goto(base);
      for (const fixture of fixtures) {
        const result = await page.evaluate(async ({ name, rendition }) => {
          const { ColorRenderer } = await import('/public/color-renderer.js');
          window.renderer?.dispose(); window.hls?.destroy();
          const video = document.querySelector('video');
          let failure;
          window.renderer = new ColorRenderer(video, rendition.color, message => { failure = message; });
          window.hls = new Hls({ enableWorker: false });
          let fatal;
          hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fatal = `${data.type}/${data.details}: ${data.error?.message ?? ''}`; });
          hls.loadSource(`/${name}/${rendition.manifest}`); hls.attachMedia(video);
          await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() =>
            reject(Error(fatal || video.error?.message || `Decoder timeout (readyState ${video.readyState}, support ${MediaSource.isTypeSupported(`video/mp4; codecs="${rendition.codecs}"`)})`)), 15000))]);
          video.pause(); await new Promise(resolve => setTimeout(resolve, 100)); renderer.draw();
          if (failure) throw Error(failure);
          const { gl, canvas } = renderer, pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const snapshot = document.createElement('canvas'); snapshot.width = canvas.width; snapshot.height = canvas.height;
          snapshot.getContext('2d').drawImage(canvas, 0, 0);
          return { pixels: Array.from(pixels), width: canvas.width, height: canvas.height, png: snapshot.toDataURL(), ready: renderer.ready };
        }, fixture);
        assert.ok(result.ready, `${name}/${fixture.name}: no rendered frame`);
        assert.ok(result.pixels.some((value, i) => i % 4 !== 3 && value > 100), `${name}/${fixture.name}: black output`);
        images[`${name}/${fixture.name}`] = result.pixels;
        // Ground truth: the patch codes are known, so the render must match an independent
        // model of the intended conversion, not only the other browser.
        const expected = fixture.patches.map(patch => expectedPatch(fixture.rendition.color, patch));
        const measured = fixture.patches.map(patch => {
          const at = ((result.height - 1 - patch.y) * result.width + patch.x) * 4;
          return [result.pixels[at], result.pixels[at + 1], result.pixels[at + 2]];
        });
        const errors = measured.map((m, i) => Math.max(...m.map((v, c) => Math.abs(v - expected[i][c]))));
        const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length, max = Math.max(...errors);
        report.truth[`${name}/${fixture.name}`] = { mean, max };
        console.log(`${name} ${fixture.name}: truth mean ${mean.toFixed(2)}/255, max ${max}`);
        // The margin covers decoder YUV->RGB rounding, amplified by the transfer curves on
        // saturated patches at the texture clamp boundary. A wrong matrix or transfer shows
        // up an order of magnitude above it.
        if (!(mean <= 5 && max <= 14)) {
          fixture.patches.forEach((patch, i) => console.log(
            `  patch ${i} (code ${patch.code}, chroma ${patch.chroma}): expected ${expected[i]} measured ${measured[i]}`));
        }
        assert.ok(mean <= 5 && max <= 14, `${name}/${fixture.name}: render deviates from the expected colours`);
        await writeFile(path.join(output, `${name}-${fixture.name}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
        console.log(`${name} ${fixture.name}: rendered`);
      }
    } finally { await browser.close(); }
  }
  for (const { name } of fixtures) {
    const a = images[`Chrome/${name}`], b = images[`Firefox/${name}`], differences = [];
    for (let i = 0; i < a.length; i++) if (i % 4 !== 3) differences.push(Math.abs(a[i] - b[i]));
    differences.sort((a, b) => a - b);
    const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    const p99 = differences[Math.floor(differences.length * .99)], max = differences.at(-1);
    report.comparisons[name] = { mean, p99, max };
    console.log(`${name}: mean ${mean.toFixed(3)}/255, p99 ${p99}, maximum ${max}`);
    // Meme marge que la verite : le bruit de decodage est amplifie par les
    // courbes de transfert au voisinage du clip.
    assert.ok(mean <= 5 && p99 <= 14, `${name}: visible browser colour mismatch`);
  }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
