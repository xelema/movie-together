// Compare frame par frame le rendu affiché de mpv (référence) et celui du
// navigateur : HLS préparé + ColorRenderer en HDR, video native en SDR.
// Recette mpv : docs/research/mpv-capture.md (seek absolute+exact en pause,
// screenshot « scaled », --target-* seulement en HDR : ils reproduisent la
// transformée d'écran mesurée, en SDR ils fausseraient le passthrough).
// Usage : node --env-file-if-exists=.env scripts/mpv-compare.js [--times 8,20,35] [--size 1600x670] [--film hdr|sdr]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import express from 'express';
import { chromium } from '@playwright/test';
import { createStore } from '../src/storage.js';
import { prepareMovie, probeFile, run } from '../src/media.js';

const { values: args } = parseArgs({ options: {
  times: { type: 'string' }, size: { type: 'string', default: '1600x670' },
  film: { type: 'string', default: 'both' }, out: { type: 'string', default: 'test-results/mpv-compare' },
}});
const [W, H] = args.size.split('x').map(Number);
const FILMS = {
  hdr: process.env.MPV_HDR || 'C:/Users/xelem/Videos/ia-spiderman/trailer_demo_HDR.mkv',
  sdr: process.env.MPV_SDR || 'C:/Users/xelem/Videos/ia-spiderman/trailer_demo_SDR_BT709_h264.mkv',
};
// mpv.com relance mpv.exe en processus détaché : viser mpv.exe garde le kill à portée.
const MPV = process.env.MPV_PATH ||
  (process.platform === 'win32' && existsSync(path.join(process.env.APPDATA, 'mpv/mpv.exe'))
    ? path.join(process.env.APPDATA, 'mpv/mpv.exe') : 'mpv');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const out = path.resolve(args.out);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
process.on('exit', () => { for (const child of children) child.kill(); });

// mpv expose un JSON-RPC par lignes sur un named pipe (--input-ipc-server).
async function mpvConnect(pipe, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`, () => { socket.off('error', reject); resolve(socket); });
        socket.once('error', reject);
      });
    } catch (error) { if (Date.now() > deadline) throw error; await sleep(250); }
  }
}
function mpvIpc(socket) {
  let buffer = '', next = 1; const pending = new Map();
  socket.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.request_id && pending.has(message.request_id)) { pending.get(message.request_id)(message); pending.delete(message.request_id); }
    }
  });
  const send = (...command) => new Promise(resolve => { const id = next++; pending.set(id, resolve); socket.write(JSON.stringify({ command, request_id: id }) + '\n'); });
  const get = async property => (await send('get_property', property)).data;
  const until = async (property, value, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await get(property) === value) return; await sleep(150); }
    throw new Error(`mpv: ${property} reste ${await get(property)}`);
  };
  return { send, get, until };
}

// Cherche un timestamp donné, attend la frame puis la capture en PNG 16 bits.
// Retourne le time-pos réel : Chrome cherchera cette valeur pour tomber sur la même frame.
async function mpvShot(ipc, t, png) {
  await ipc.send('seek', t, 'absolute+exact');
  await ipc.until('seeking', false);
  await sleep(1000);
  const timePos = await ipc.get('time-pos'), frame = await ipc.get('estimated-frame-number');
  await ipc.send('screenshot-to-file', png, 'scaled');
  const deadline = Date.now() + 10_000;
  while (!existsSync(png) && Date.now() < deadline) await sleep(100);
  if (!existsSync(png)) throw new Error(`mpv: capture absente ${png}`);
  return { timePos, frame };
}
async function mpvCapture(film, file, times, outDir) {
  const pipe = `mpvcap-${process.pid}`;
  const flags = ['--force-window=yes', '--idle=yes', '--pause=yes', '--osd-level=0',
    `--input-ipc-server=${pipe}`, `--autofit=${W}x${H}`,
    '--screenshot-format=png', '--screenshot-high-bit-depth=yes', '--screenshot-tag-colorspace=yes',
    `--log-file=${path.join(outDir, 'mpv.log')}`];
  // La cible calibrée reproduit l'écran SDR de référence ; en SDR mpv ne convertit
  // déjà rien, une cible explicite activerait au contraire une conversion BT.1886->G22.
  if (film === 'hdr') flags.push('--target-trc=gamma2.2', '--target-peak=75');
  flags.push(file);
  const proc = spawn(MPV, flags, { stdio: 'ignore', windowsHide: true }); children.add(proc);
  const socket = await mpvConnect(pipe); const ipc = mpvIpc(socket);
  const deadline = Date.now() + 60_000;
  while (!(await ipc.get('duration')) && Date.now() < deadline) await sleep(250);
  const shots = [];
  for (const t of times) {
    const png = path.join(outDir, `t${t}-mpv.png`);
    shots.push({ t, png, ...await mpvShot(ipc, t, png) });
    console.log(`mpv ${film} t=${t}s : frame ${shots.at(-1).frame} @ ${shots.at(-1).timePos}s`);
  }
  await ipc.send('quit'); socket.end();
  await Promise.race([new Promise(resolve => proc.once('exit', resolve)), sleep(10_000).then(() => proc.kill())]);
  children.delete(proc);
  return shots;
}

// Prépare (ou réutilise) la version HLS du film : même pipeline que l'app.
async function prepare(film, file) {
  const store = createStore(path.join(out, 'store'));
  const id = `mpv-compare-${film}`, marker = path.join(out, `${film}.prepared.json`);
  if (existsSync(marker)) {
    const cached = JSON.parse(await readFile(marker, 'utf8'));
    if (existsSync(path.join(store.directory(cached.id), cached.generation, 'master_original.m3u8')))
      return { ...cached, directory: path.join(store.directory(cached.id), cached.generation) };
  }
  const directory = store.directory(id); await mkdir(directory, { recursive: true });
  const source = path.join(directory, 'source');
  if (!existsSync(source)) await link(file, source).catch(() => copyFile(file, source));
  const movie = { id, title: film }; store.save(movie);
  const probe = await probeFile(source);
  const audio = probe.audio.filter(track => track.compatible).slice(0, 1).map(track => track.index);
  const prepared = await prepareMovie(store, movie, audio, []);
  movie.status = 'ready'; store.save(movie);
  const rendition = prepared.renditions[0];
  await writeFile(marker, JSON.stringify({ id, generation: prepared.generation, rendition, duration: prepared.duration }));
  console.log(`${film} : préparé (${prepared.generation.slice(0, 8)}, ${prepared.duration.toFixed(1)}s, ${rendition.codec} ${rendition.width}x${rendition.height})`);
  return { id, generation: prepared.generation, rendition, duration: prepared.duration, directory: path.join(directory, prepared.generation) };
}

// Chrome joue le HLS ; en HDR le renderer dessine dans un canvas forcé à la taille
// exacte de la capture mpv, en SDR la video native est copiée par drawImage.
async function browserShots(page, film, rendition, shots, w, h) {
  return page.evaluate(async ({ film, rendition, shots, w, h }) => {
    const { ColorRenderer, colorNeedsRenderer } = await import('/public/color-renderer.js');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const video = document.querySelector('video');
    video.style.width = `${w}px`; video.style.height = `${h}px`;
    let fatal; const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fatal = `${data.type}/${data.details}`; });
    hls.loadSource(`/${film}/${rendition.manifest}`); hls.attachMedia(video);
    await video.play().catch(error => { throw new Error(fatal || error.message); });
    video.pause();
    let renderer, failure;
    if (colorNeedsRenderer(rendition.color)) renderer = new ColorRenderer(video, rendition.color, message => { failure = message; });
    const seek = t => Promise.race([new Promise(resolve => video.addEventListener('seeked', resolve, { once: true })),
      sleep(20_000).then(() => { throw new Error(`seek navigateur trop long @${t}`); })]);
    const b64 = buffer => { let s = ''; for (let i = 0; i < buffer.length; i += 32768) s += String.fromCharCode(...buffer.subarray(i, i + 32768)); return btoa(s); };
    const results = [];
    for (const t of shots.map(shot => shot.timePos ?? shot.t)) {
      video.currentTime = t; await seek(t); await sleep(400);
      let pixels;
      if (renderer) {
        const { gl, canvas } = renderer;
        canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.flush();
        if (failure) throw new Error(failure);
        const raw = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        pixels = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) pixels.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      } else {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, w, h);
        pixels = context.getImageData(0, 0, w, h).data;
      }
      results.push({ t, currentTime: video.currentTime, pixels: b64(pixels) });
    }
    window.hls?.destroy(); window.hls = hls; window.renderer = renderer;
    return results;
  }, { film, rendition, shots, w, h });
}

async function pngToRaw(png) {
  const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', png]));
  const { width, height } = probe.streams[0];
  const raw = `${png}.raw`;
  await run(ffmpeg, ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const buffer = await readFile(raw); await rm(raw);
  return { buffer, width, height };
}
async function rawToPng(buffer, w, h, png) {
  const raw = `${png}.raw`;
  await writeFile(raw, buffer);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', raw, png]);
  await rm(raw);
}
// Diff par pixel (max des 3 canaux), stats globales et par région 4x2,
// PNG amplifié x4 pour repérer visuellement les zones qui divergent.
async function diffShot(mpv, browser, w, h, base, outDir) {
  const n = w * h, px = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    px[i] = Math.max(Math.abs(mpv[o] - browser[o]), Math.abs(mpv[o + 1] - browser[o + 1]), Math.abs(mpv[o + 2] - browser[o + 2]));
  }
  const sorted = Float32Array.from(px).sort(), mean = px.reduce((s, v) => s + v, 0) / n;
  const image = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const o = i * 4, v = Math.min(255, Math.round(px[i] * 4)); image[o] = image[o + 1] = image[o + 2] = v; image[o + 3] = 255; }
  await rawToPng(image, w, h, path.join(outDir, `${base}-diff.png`));
  const regions = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
    const x0 = Math.floor(w * c / 4), x1 = Math.floor(w * (c + 1) / 4);
    const y0 = Math.floor(h * r / 2), y1 = Math.floor(h * (r + 1) / 2);
    const cell = new Float32Array((x1 - x0) * (y1 - y0)); const crop = Buffer.alloc(cell.length * 4);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y - y0) * (x1 - x0) + (x - x0);
      cell[i] = px[y * w + x]; const o = i * 4, v = Math.min(255, Math.round(px[y * w + x] * 4));
      crop[o] = crop[o + 1] = crop[o + 2] = v; crop[o + 3] = 255;
    }
    const ordered = Float32Array.from(cell).sort();
    regions.push({ region: `r${r}c${c}`, mean: cell.reduce((s, v) => s + v, 0) / cell.length,
      p99: ordered[Math.floor(cell.length * .99)], max: ordered[cell.length - 1] });
    await rawToPng(crop, x1 - x0, y1 - y0, path.join(outDir, `${base}-diff-${r}${c}.png`));
  }
  return { mean, p99: sorted[Math.floor(n * .99)], max: sorted[n - 1], regions };
}

const films = (args.film === 'both' ? Object.keys(FILMS) : [args.film]).filter(name => FILMS[name]);
await mkdir(out, { recursive: true });
const prepared = {}, report = { size: [W, H], date: new Date().toISOString(), films: {} };
for (const film of films) prepared[film] = await prepare(film, FILMS[film]);
const requested = args.times?.split(',').map(Number);
const app = express();
app.get('/', (_, res) => res.send('<!doctype html><style>body{margin:0;background:#000}video{display:block}</style><main><video muted playsinline></video></main><script src="/hls.js"></script>'));
app.get('/hls.js', (_, res) => res.sendFile(path.resolve('node_modules/hls.js/dist/hls.js')));
app.use('/public', express.static(path.resolve('public')));
for (const film of films) app.use(`/${film}`, express.static(prepared[film].directory));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ headless: process.platform !== 'win32', ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: W + 40, height: H + 60 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const film of films) {
    const outDir = path.join(out, film); await mkdir(outDir, { recursive: true });
    const times = requested ?? [0.15, 0.45, 0.75].map(f => Math.round(prepared[film].duration * f * 10) / 10);
    const shots = await mpvCapture(film, FILMS[film], times, outDir);
    const first = await pngToRaw(shots[0].png);
    const [w, h] = [first.width, first.height];
    console.log(`${film} : captures mpv ${w}x${h}`);
    const browsers = await browserShots(page, film, prepared[film].rendition, shots, w, h);
    report.films[film] = { shots: [] };
    for (const [index, shot] of shots.entries()) {
      const raw = index === 0 ? first : await pngToRaw(shot.png);
      if (raw.width !== w || raw.height !== h) throw new Error(`${film} t=${shot.t} : taille mpv ${raw.width}x${raw.height} != ${w}x${h}`);
      const browserPixels = Buffer.from(browsers[index].pixels, 'base64');
      if (browserPixels.length !== w * h * 4) throw new Error(`${film} t=${shot.t} : buffer navigateur inattendu`);
      await rawToPng(browserPixels, w, h, path.join(outDir, `t${shot.t}-browser.png`));
      const diff = await diffShot(raw.buffer, browserPixels, w, h, `t${shot.t}`, outDir);
      const entry = { t: shot.t, mpvTime: shot.timePos, mpvFrame: shot.frame, videoTime: browsers[index].currentTime,
        mean: diff.mean, p99: diff.p99, max: diff.max, regions: diff.regions };
      report.films[film].shots.push(entry);
      console.log(`${film} t=${shot.t}s (mpv ${shot.timePos}s f${shot.frame} / video ${browsers[index].currentTime}s) : mean ${diff.mean.toFixed(2)} p99 ${diff.p99} max ${diff.max}`);
    }
  }
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
