// Compare frame par frame le rendu affiché de mpv (référence) et celui du
// navigateur : HLS préparé + ColorRenderer en HDR, video native en SDR.
// Recette mpv : docs/research/mpv-capture.md (seek absolute+exact en pause,
// screenshot « scaled », --target-* seulement en HDR : ils reproduisent la
// transformée d'écran mesurée, en SDR ils fausseraient le passthrough).
// Usage : node --env-file-if-exists=.env scripts/mpv-compare.js [--times 8,20,35] [--size 1600x670] [--film hdr|sdr]
// --perf : pas de mpv, mesure la lecture réelle (dropped frames, temps de draw CPU/GPU) à la définition source.
// --session : vraie app + vraie room (src/server.js sur DATA_DIR) ; la capture lit le canvas que
// l'app produit, mpv est capturé à la taille réelle de ce canvas. Corpus par défaut : 8,20,65,100,120.
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
import { colorNeedsRenderer } from '../public/color-renderer.js';

const { values: args } = parseArgs({ options: {
  times: { type: 'string' }, size: { type: 'string', default: '1600x670' },
  film: { type: 'string', default: 'both' }, out: { type: 'string', default: 'test-results/mpv-compare' },
  perf: { type: 'boolean' }, seconds: { type: 'string', default: '12' },
  gate: { type: 'boolean' }, session: { type: 'boolean' },
}});
// Gate « pareil que mpv » (#13) : barre uniforme par plan, diff max-3-canaux
// en LSB 8 bits. `max` reste informatif (bruit de décodage, hors gate).
const GATE_MEAN = 3, GATE_P99 = 10, GATE_REGION_MEAN = 6;
const gateCheck = (film, t, diff, failures) => {
  const badRegion = diff.regions.filter(r => r.mean > GATE_REGION_MEAN).map(r => `${r.region}=${r.mean.toFixed(1)}`);
  const ok = diff.mean <= GATE_MEAN && diff.p99 <= GATE_P99 && !badRegion.length;
  console.log(`   gate: ${ok ? 'PASS' : 'FAIL'} (mean ${diff.mean.toFixed(2)}/${GATE_MEAN}, p99 ${diff.p99}/${GATE_P99}` +
    (badRegion.length ? `, régions ${badRegion.join(' ')}>${GATE_REGION_MEAN}` : '') + ')');
  if (!ok) failures.push(`${film} t=${t}`);
};
const [W, H] = args.size.split('x').map(Number);
const FILMS = {
  hdr: process.env.MPV_HDR || 'data/sample/hdr10.mkv',
  sdr: process.env.MPV_SDR || 'data/sample/sdr-bt709.mkv',
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
  const mpq = await ipc.get('video-out-params/max-pq-y'), apq = await ipc.get('video-out-params/avg-pq-y');
  await ipc.send('screenshot-to-file', png, 'scaled');
  const deadline = Date.now() + 10_000;
  while (!existsSync(png) && Date.now() < deadline) await sleep(100);
  if (!existsSync(png)) throw new Error(`mpv: capture absente ${png}`);
  return { timePos, frame, mpq, apq };
}
async function mpvCapture(film, file, times, outDir, w = W, h = H, tag = '') {
  const pipe = `mpvcap-${process.pid}`;
  const flags = ['--force-window=yes', '--idle=yes', '--pause=yes', '--osd-level=0',
    `--input-ipc-server=${pipe}`, `--autofit=${w}x${h}`,
    '--screenshot-format=png', '--screenshot-high-bit-depth=yes', '--screenshot-tag-colorspace=yes',
    `--log-file=${path.join(outDir, 'mpv.log')}`];
  // La cible calibrée reproduit l'écran SDR de référence ; en SDR mpv ne convertit
  // déjà rien, une cible explicite activerait au contraire une conversion BT.1886->G22.
  // hdr-compute-peak=no : le renderer a abandonne la detection dynamique (sauts
  // de luminosite en lecture), la reference mpv doit suivre le meme pic statique.
  if (film === 'hdr') flags.push('--target-trc=gamma2.2', '--target-peak=75', '--hdr-compute-peak=no');
  flags.push(file);
  const proc = spawn(MPV, flags, { stdio: 'ignore', windowsHide: true }); children.add(proc);
  const socket = await mpvConnect(pipe); const ipc = mpvIpc(socket);
  const deadline = Date.now() + 60_000;
  while (!(await ipc.get('duration')) && Date.now() < deadline) await sleep(250);
  const shots = [];
  for (const t of times) {
    const png = path.join(outDir, `t${t}-${tag}mpv.png`);
    shots.push({ t, png, ...await mpvShot(ipc, t, png) });
    console.log(`mpv ${film} t=${t}s : frame ${shots.at(-1).frame} @ ${shots.at(-1).timePos}s` +
      (shots.at(-1).mpq != null ? `, max-pq-y ${shots.at(-1).mpq} avg-pq-y ${shots.at(-1).apq}` : ''));
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
    window.hls?.destroy(); window.renderer?.dispose();
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
        renderer.displayWidth = w; renderer.displayHeight = h;
        renderer.draw();
        if (failure) throw new Error(failure);
        if (canvas.width !== w || canvas.height !== h) throw new Error(`canvas ${canvas.width}x${canvas.height} != ${w}x${h}`);
        const raw = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        pixels = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) pixels.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      } else {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, w, h);
        pixels = context.getImageData(0, 0, w, h).data;
      }
      let probe = null;
      if (renderer) {
        // Diagnostic : decode texture values via the copy pass into a small FBO.
        const { gl } = renderer, pw = 160, ph = Math.round(160 * video.videoHeight / video.videoWidth);
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.useProgram(renderer.programs.copy); gl.viewport(0, 0, pw, ph);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const buf = new Uint8Array(pw * ph * 4);
        gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
        probe = { w: pw, h: ph, pixels: b64(buf) };
      }
      results.push({ t, currentTime: video.currentTime, pixels: b64(pixels),
        tone: renderer?.tone ?? null, probe });
    }
    window.hls = hls; window.renderer = renderer;
    return results;
  }, { film, rendition, shots, w, h });
}

// --perf : deux passes de lecture au timepos donné. La passe « clean » compte les
// dropped frames sans instrumentation ; la passe « timed » ajoute gl.finish()
// après chaque draw pour borner le temps GPU frame (le finish fausse les drops,
// d'où deux passes). Le canvas est forcé à la définition source : texImage2D
// envoie toujours la frame 4K entière, seule la rasterisation dépend du canvas.
async function perfRun(page, film, rendition, seconds) {
  return page.evaluate(async ({ film, rendition, seconds }) => {
    const { ColorRenderer, colorNeedsRenderer } = await import('/public/color-renderer.js');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const video = document.querySelector('video');
    window.hls?.destroy(); window.renderer?.dispose();
    let fatal; const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fatal = `${data.type}/${data.details}`; });
    hls.loadSource(`/${film}/${rendition.manifest}`); hls.attachMedia(video);
    await video.play().catch(error => { throw new Error(fatal || error.message); });
    video.pause();
    if (!video.videoWidth) await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
    video.style.width = `${video.videoWidth}px`; video.style.height = `${video.videoHeight}px`;
    let renderer;
    if (colorNeedsRenderer(rendition.color)) {
      renderer = new ColorRenderer(video, rendition.color, message => { throw new Error(message); });
      renderer.displayWidth = video.videoWidth; renderer.displayHeight = video.videoHeight;
    }
    let presented = 0;
    if (video.requestVideoFrameCallback) {
      const loop = (_, meta) => { presented = meta.presentedFrames; video.requestVideoFrameCallback(loop); };
      video.requestVideoFrameCallback(loop);
    }
    let active = null, timed = false;
    if (renderer) {
      const original = renderer.draw.bind(renderer);
      renderer.draw = (...drawArgs) => {
        const t0 = performance.now(); original(...drawArgs);
        const submit = performance.now() - t0;
        if (!active || video.seeking || video.paused || video.readyState < 2) return;
        active.draws++; active.submit.push(submit);
        if (timed) { const t1 = performance.now(); renderer.gl.finish(); active.finish.push(performance.now() - t1); }
      };
    }
    const stats = values => values.length ? {
      mean: values.reduce((sum, v) => sum + v, 0) / values.length,
      p95: [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)],
      max: Math.max(...values) } : null;
    const pass = async (withFinish) => {
      const quality = video.getVideoPlaybackQuality?.() ?? {};
      const presented0 = presented, t0 = performance.now();
      const samples = { draws: 0, submit: [], finish: [] };
      video.currentTime = 20;
      await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      active = samples; timed = withFinish;
      await video.play(); await sleep(seconds * 1000); video.pause();
      active = null;
      const after = video.getVideoPlaybackQuality?.() ?? {};
      return { seconds: (performance.now() - t0) / 1000,
        frames: (after.totalVideoFrames ?? 0) - (quality.totalVideoFrames ?? 0),
        dropped: (after.droppedVideoFrames ?? 0) - (quality.droppedVideoFrames ?? 0),
        presented: presented - presented0, draws: samples.draws,
        submit: stats(samples.submit), finish: stats(samples.finish) };
    };
    const clean = await pass(false);
    const timedPass = renderer ? await pass(true) : null;
    let fenceProbe = null;
    if (renderer) {
      const gl = renderer.gl, wrapped = renderer.draw;
      video.currentTime = 40;
      await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      await video.play(); await sleep(500);
      let issued = -1, signaled = -1, draws0 = 0;
      renderer.draw = (...a) => { wrapped(...a); draws0++;
        if (issued < 0) issued = draws0;
        else if (signaled < 0 && gl.clientWaitSync(fenceProbe.sync, 0, 0) === gl.ALREADY_SIGNALED) signaled = draws0; };
      fenceProbe = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) };
      await sleep(4000); video.pause();
      const stillPending = gl.clientWaitSync(fenceProbe.sync, 0, 0) !== gl.ALREADY_SIGNALED;
      gl.deleteSync(fenceProbe.sync); renderer.draw = wrapped;
      fenceProbe = { signaledAfterDraws: signaled < 0 ? null : signaled - issued, draws: draws0, stillPending };
    }
    window.hls = hls; window.renderer = renderer;
    const debug = renderer?.gl.getExtension('WEBGL_debug_renderer_info');
    return { video: [video.videoWidth, video.videoHeight],
      canvas: renderer ? [renderer.canvas.width, renderer.canvas.height] : null,
      gpu: debug ? renderer.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      floatExt: renderer ? !!renderer.floatExt : null,
      fenceProbe, clean, timed: timedPass };
  }, { film, rendition, seconds });
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

// --session : la vraie app (src/server.js sur DATA_DIR), une vraie room et le
// canvas que le renderer de l'app dessine lui-meme. Les films sont re-prepares
// pour que la generation servie vienne du code teste ; mpv est capture a la
// taille reelle du canvas. Le corpus reste celui du gate (#13).
// Le seek passe par la room (commande 'seek' du player) : une position posée
// directement sur la video serait recalée par reconcile au bout de 200 ms.
// La commande porte l'epoch du dernier etat recu ; si la room l'a deja avance
// (transition post-pause en vol) elle ignore le seek en silence, donc on
// renvoie jusqu'a ce que la video atteigne la cible.
async function roomSeek(page, t) {
  const send = () => page.evaluate(t => { const p = window.player; p.command('seek', t); return t + p.offset; }, t);
  const target = await send();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await page.waitForFunction(target => { const v = document.querySelector('video');
        return !v.seeking && Math.abs(v.currentTime - target) < 0.1; }, target, { timeout: 3_000 });
      return;
    } catch { await send(); }
  }
  throw new Error(`seek navigateur trop long @${t}`);
}
// La capture relance un draw dans la meme tache que le readPixels : sans
// preserveDrawingBuffer la frame deja compositee n'est plus lisible.
async function sessionShot(page, t) {
  await roomSeek(page, t);
  return page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const video = document.querySelector('video');
    await sleep(600);
    video.dispatchEvent(new Event('seeked'));
    const b64 = buffer => { let s = ''; for (let i = 0; i < buffer.length; i += 32768) s += String.fromCharCode(...buffer.subarray(i, i + 32768)); return btoa(s); };
    const canvas = document.querySelector('.color-canvas');
    let w, h, pixels;
    if (canvas) {
      w = canvas.width; h = canvas.height;
      const gl = canvas.getContext('webgl2'), raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      pixels = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) pixels.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    } else {
      const rect = video.getBoundingClientRect(), ratio = devicePixelRatio || 1;
      const s = Math.min(1, rect.width * ratio / video.videoWidth, rect.height * ratio / video.videoHeight);
      w = Math.round(video.videoWidth * s); h = Math.round(video.videoHeight * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const context = c.getContext('2d'); context.drawImage(video, 0, 0, w, h);
      pixels = context.getImageData(0, 0, w, h).data;
    }
    return { w, h, pixels: b64(pixels), currentTime: video.currentTime };
  });
}
// Un vrai clic de lecture : la room part et se synchronise par le protocole
// normal (rapports -> playing -> begin), puis pause par le meme bouton.
async function sessionPlayback(page, seconds) {
  const toggle = async () => {
    await page.locator('#screen').hover();
    await page.locator('.plyr__controls [data-plyr="play"]').first().click({ timeout: 10_000 });
  };
  const sample = () => page.evaluate(() => {
    const v = document.querySelector('video'), q = v.getVideoPlaybackQuality?.() ?? {};
    return { t: v.currentTime, frames: q.totalVideoFrames ?? 0, dropped: q.droppedVideoFrames ?? 0 };
  });
  await toggle();
  await page.waitForFunction(() => !document.querySelector('video').paused, null, { timeout: 90_000 });
  await sleep(1500);
  const a = await sample();
  await page.waitForTimeout(seconds * 1000);
  const b = await sample();
  await toggle();
  await page.waitForFunction(() => document.querySelector('video').paused, null, { timeout: 15_000 });
  return { seconds: b.t - a.t, frames: b.frames - a.frames, dropped: b.dropped - a.dropped };
}
async function sessionRun(films, times, report, failures) {
  const port = Number(process.env.SESSION_PORT || 3939), origin = `http://localhost:${port}`;
  if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD manquant (lancer via npm run compare:mpv)');
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'],
    { env: { ...process.env, PORT: String(port), APP_ORIGIN: origin }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.add(server);
  const browser = await chromium.launch({ headless: process.platform !== 'win32',
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const deadline = Date.now() + 30_000;;) {
      try { if ((await (await fetch(`${origin}/healthz`)).json()).ok) break; } catch { }
      if (Date.now() > deadline) throw new Error('app : démarrage trop long');
      await sleep(250);
    }
    const jar = { cookie: '' };
    const api = async (route, options = {}) => {
      const res = await fetch(`${origin}${route}`, { method: options.method ?? 'GET',
        headers: { 'content-type': 'application/json', origin, cookie: jar.cookie },
        body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const setCookie = res.headers.get('set-cookie'); if (setCookie) jar.cookie = setCookie.split(';')[0];
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${route} : ${data.error ?? res.status}`);
      return data;
    };
    await api('/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
    const picked = {};
    for (const film of films) {
      const id = process.env[`SESSION_FILM_${film.toUpperCase()}`];
      const movie = (await api('/api/movies')).find(m => id ? m.id === id : new RegExp(film, 'i').test(m.title));
      if (!movie) throw new Error(`${film} : aucun film de ce nom dans la bibliothèque`);
      if (movie.status === 'ready') await api(`/api/movies/${movie.id}/prepare`, { method: 'POST', body: {} });
      for (const deadline = Date.now() + 300_000;;) {
        const refreshed = (await api('/api/movies')).find(m => m.id === movie.id);
        if (refreshed.status === 'ready') { picked[film] = refreshed; break; }
        if (refreshed.status === 'failed' || Date.now() > deadline) {
          throw new Error(`${film} : préparation échouée (${refreshed.error ?? refreshed.status})`);
        }
        await sleep(2000);
      }
      console.log(`${film} : « ${picked[film].title} » prêt (${picked[film].generation.slice(0, 8)})`);
    }
    const room = await api('/api/rooms', { method: 'POST', body: { movieId: picked[films[0]].id } });
    const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
    await page.goto(`${origin}/#invite=${room.code}`);
    await page.waitForFunction(() => document.querySelector('#join-form input[name=code]')?.value);
    await page.locator('#join-form button').click();
    await page.locator('#room-name').fill('Agent');
    await page.locator('#name-dialog button').click();
    for (const film of films) {
      const movie = picked[film];
      if (film !== films[0]) await api(`/api/rooms/${room.id}/movie`, { method: 'POST', body: { movieId: movie.id } });
      await page.waitForFunction(title => document.querySelector('#movie-title')?.textContent === title,
        movie.title, { timeout: 60_000 });
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v?.readyState >= 2 && v.videoWidth > 0; },
        null, { timeout: 90_000 });
      if (colorNeedsRenderer(movie.renditions[0].color))
        await page.waitForSelector('.color-canvas[data-ready="true"]', { timeout: 45_000 });
      else await page.waitForSelector('.color-canvas', { state: 'detached', timeout: 15_000 }).catch(() => {});
      const session = (report.films[film] = { ...report.films[film],
        session: { size: null, mode: null, shots: [] } }).session;
      session.playback = await sessionPlayback(page, Number(args.seconds));
      console.log(`${film} session lecture : ${session.playback.seconds.toFixed(1)}s, ` +
        `${session.playback.frames} frames, ${session.playback.dropped} dropped`);
      const outDir = path.join(out, film); await mkdir(outDir, { recursive: true });
      // Le dpr peut dériver en début de séance (fenêtre replacée sur un autre
      // écran virtuel) : on mesure la taille réelle après la lecture et on
      // recale mpv une fois si elle bouge encore.
      for (let attempt = 0; attempt < 2; attempt++) {
        await roomSeek(page, times[0]);
        const dims = await page.evaluate(async () => {
          const video = document.querySelector('video');
          await new Promise(resolve => setTimeout(resolve, 600));
          video.dispatchEvent(new Event('seeked'));
          const canvas = document.querySelector('.color-canvas');
          if (canvas) return { w: canvas.width, h: canvas.height, mode: 'shader' };
          const rect = video.getBoundingClientRect(), ratio = devicePixelRatio || 1;
          const s = Math.min(1, rect.width * ratio / video.videoWidth, rect.height * ratio / video.videoHeight);
          return { w: Math.round(video.videoWidth * s), h: Math.round(video.videoHeight * s), mode: 'natif' };
        });
        const [w, h] = [dims.w, dims.h];
        console.log(`${film} : sortie app ${dims.mode} ${w}x${h}`);
        session.size = [w, h]; session.mode = dims.mode; session.shots = [];
        // autofit arrondit la fenetre : recalibrer la boite jusqu'a la taille exacte.
        let shots, first;
        for (const [dw, dh] of [[0, 0], [1, 0], [0, 1], [1, 1], [0, -1], [1, -1], [-1, 1]]) {
          shots = await mpvCapture(film, FILMS[film], times, outDir, w + dw, h + dh, 'session-');
          first = await pngToRaw(shots[0].png);
          if (first.width === w && first.height === h) break;
        }
        if (first.width !== w || first.height !== h)
          throw new Error(`${film} : captures mpv ${first.width}x${first.height} != app ${w}x${h}`);
        let drift = false;
        for (const [index, shot] of shots.entries()) {
          const cap = await sessionShot(page, shot.timePos ?? shot.t);
          if (cap.w !== w || cap.h !== h) {
            console.log(`${film} : taille app ${cap.w}x${cap.h} != ${w}x${h}, recalage`);
            drift = true; session.shots = []; break;
          }
          const browserPixels = Buffer.from(cap.pixels, 'base64');
          if (browserPixels.length !== w * h * 4)
            throw new Error(`${film} t=${shot.t} : buffer app inattendu`);
          await rawToPng(browserPixels, w, h, path.join(outDir, `t${shot.t}-session-browser.png`));
          const raw = index === 0 ? first : await pngToRaw(shot.png);
          const diff = await diffShot(raw.buffer, browserPixels, w, h, `t${shot.t}-session`, outDir);
          session.shots.push({ t: shot.t, mpvTime: shot.timePos, mpvFrame: shot.frame,
            videoTime: cap.currentTime, mean: diff.mean, p99: diff.p99, max: diff.max, regions: diff.regions });
          console.log(`${film} session t=${shot.t}s (mpv ${shot.timePos}s f${shot.frame} / video ${cap.currentTime}s) : ` +
            `mean ${diff.mean.toFixed(2)} p99 ${diff.p99} max ${diff.max}`);
          if (args.gate) gateCheck(film, shot.t, diff, failures);
        }
        if (!drift) break;
        if (attempt === 1) throw new Error(`${film} : taille de sortie instable`);
      }
    }
    await api(`/api/rooms/${room.id}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await browser.close();
    server.kill();
  }
}

const films = (args.film === 'both' ? Object.keys(FILMS) : [args.film]).filter(name => FILMS[name]);
await mkdir(out, { recursive: true });
// Un run --perf et un run de diff accumulent dans le meme rapport.
const reportPath = path.join(out, 'report.json');
const prepared = {}, report = { size: [W, H], date: new Date().toISOString(), films: {} }, failures = [];
if (existsSync(reportPath)) Object.assign(report.films, JSON.parse(await readFile(reportPath, 'utf8')).films);
if (args.session) {
  await sessionRun(films, args.times?.split(',').map(Number) ?? [8, 20, 65, 100, 120], report, failures);
  process.exit(failures.length ? 1 : 0);
}
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
    if (args.perf) {
      const perf = await perfRun(page, film, prepared[film].rendition, Number(args.seconds));
      report.films[film] = { ...report.films[film], perf };
      const { clean, timed } = perf;
      console.log(`${film} perf ${perf.video.join('x')} -> canvas ${perf.canvas?.join('x') ?? 'natif'} : ` +
        `${clean.frames} frames, ${clean.dropped} dropped, ${clean.draws} draws en ${clean.seconds.toFixed(1)}s` +
        (timed ? ` ; submit moy ${timed.submit?.mean.toFixed(2)}ms p95 ${timed.submit?.p95.toFixed(2)}ms, ` +
        `gpu moy ${timed.finish?.mean.toFixed(2)}ms p95 ${timed.finish?.p95.toFixed(2)}ms max ${timed.finish?.max.toFixed(1)}ms` : '') +
        (perf.fenceProbe ? ` ; fence signal après ${perf.fenceProbe.signaledAfterDraws ?? '>' + String(perf.fenceProbe.draws)} draws` : ''));
      continue;
    }
    const times = requested ?? [0.15, 0.45, 0.75].map(f => Math.round(prepared[film].duration * f * 10) / 10);
    const shots = await mpvCapture(film, FILMS[film], times, outDir);
    const first = await pngToRaw(shots[0].png);
    const [w, h] = [first.width, first.height];
    console.log(`${film} : captures mpv ${w}x${h}`);
    const browsers = await browserShots(page, film, prepared[film].rendition, shots, w, h);
    report.films[film] = { ...report.films[film], shots: [] };
    for (const [index, shot] of shots.entries()) {
      const raw = index === 0 ? first : await pngToRaw(shot.png);
      if (raw.width !== w || raw.height !== h) throw new Error(`${film} t=${shot.t} : taille mpv ${raw.width}x${raw.height} != ${w}x${h}`);
      const browserPixels = Buffer.from(browsers[index].pixels, 'base64');
      if (browserPixels.length !== w * h * 4) throw new Error(`${film} t=${shot.t} : buffer navigateur inattendu`);
      await rawToPng(browserPixels, w, h, path.join(outDir, `t${shot.t}-browser.png`));
      const diff = await diffShot(raw.buffer, browserPixels, w, h, `t${shot.t}`, outDir);
      const entry = { t: shot.t, mpvTime: shot.timePos, mpvFrame: shot.frame, videoTime: browsers[index].currentTime,
        mean: diff.mean, p99: diff.p99, max: diff.max, regions: diff.regions, tone: browsers[index].tone };
      if (browsers[index].probe) await writeFile(path.join(outDir, `t${shot.t}-probe.b64`), JSON.stringify(browsers[index].probe));
      report.films[film].shots.push(entry);
      console.log(`${film} t=${shot.t}s (mpv ${shot.timePos}s f${shot.frame} / video ${browsers[index].currentTime}s) : mean ${diff.mean.toFixed(2)} p99 ${diff.p99} max ${diff.max}`);
      if (args.gate) gateCheck(film, shot.t, diff, failures);
    }
  }
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
if (args.gate && failures.length) {
  console.log(`gate: ${failures.length} plan(s) au-dessus du seuil : ${failures.join(', ')}`);
  process.exit(1);
}
