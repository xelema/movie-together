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

const root = await mkdtemp(path.join(os.tmpdir(), 'movie-colors-'));
const store = createStore(root), fixtures = [], report = { browsers: {}, comparisons: {} };
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
    // Twenty-four flat patches: grey levels and moderate chroma, without edge interpolation.
    const codes = depth === 10 ? [64, 128, 256, 384, 448, 512, 576, 720] : [16, 32, 64, 96, 128, 160, 192, 235];
    // 10-bit planar samples occupy 16 bits in rawvideo.
    const raw = Buffer.alloc(width * height * 3 / 2 * (depth === 10 ? 2 : 1));
    const put = (index, value) => depth === 10 ? raw.writeUInt16LE(value, index * 2) : raw.writeUInt8(value, index);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(y * width + x, codes[Math.floor(x / 64)]);
    for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) {
      const center = depth === 10 ? 512 : 128, chroma = y >= 32 && x >= 64 && x < 192 ? (depth === 10 ? 24 : 6) : 0;
      put(width * height + y * width / 2 + x, center + chroma);
      put(width * height * 5 / 4 + y * width / 2 + x, center - chroma);
    }
    const input = path.join(root, `${name}.yuv`); await writeFile(input, raw);
    const movie = { id: randomUUID(), title: name }; store.save(movie);
    const args = ['-y', '-v', 'error', '-stream_loop', '-1', '-f', 'rawvideo', '-pixel_format', depth === 10 ? 'yuv420p10le' : 'yuv420p',
      '-video_size', `${width}x${height}`, '-framerate', '10', '-i', input, '-t', '1', '-c:v', codec, '-preset', 'ultrafast', '-threads', '2'];
    if (depth === 10) args.push('-x265-params', 'pools=2:lossless=1');
    else args.push('-crf', '1');
    args.push('-color_primaries', primaries, '-color_trc', transfer, '-colorspace', matrix, '-color_range', 'tv', '-f', 'matroska', path.join(store.directory(movie.id), 'source'));
    await run(ffmpeg, args);
    const prepared = await prepareMovie(store, movie, [], []);
    fixtures.push({ name, root: path.join(store.directory(movie.id), prepared.generation), rendition: prepared.renditions[0] });
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
          hls.loadSource(`/${name}/${rendition.manifest}`); hls.attachMedia(video);
          await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(Error(video.error?.message || 'Decoder timeout')), 15000))]);
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
    assert.ok(mean < 1.5 && p99 <= 6, `${name}: visible browser colour mismatch`);
  }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
