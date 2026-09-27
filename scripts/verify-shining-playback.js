// Harnais de vérification de la lecture de The Shining (4K HDR HEVC, ~34 Mbps,
// segments de 10 s pesant 20-34 Mo) : il rejoue la chaîne complète de production.
//
// La version standalone d'avant (#67) ne reproduisait pas le bug de
// l'utilisateur : elle pilotait un <video> + HlsJsBackend hors de toute salle.
// Sans SyncPlayer ni Room, aucun seuil lowBuffer n'existait, donc personne
// n'ordonnait la pause à 18.5 s et le script déclarait PASS à tort.
//
// Le harnais d'aujourd'hui est fidèle sur les trois plans qui comptent :
//   1. le vrai serveur (createApplication) : vraie Room (minBuffer 4s /
//      lowBuffer 2s), vrai hub WebSocket, vraies routes /media, vrai endpoint
//      de télémétrie qui écrit du NDJSON ;
//   2. le vrai client : un vrai SyncPlayer connecté au socket, avec les mêmes
//      décisions de réconciliation que le navigateur ;
//   3. le quota MSE de Chrome Windows / Direct3D11 : un wrapper de
//      SourceBuffer.appendBuffer qui lève un QuotaExceededError synchrone
//      au-delà du quota et décompte les octets sur remove(). Sans ça, Firefox
//      headless ne reproduit jamais la saturation que voit l'utilisateur.
//
// Usage :
//   node scripts/verify-shining-playback.js             # quota Chrome 40 Mo
//   node scripts/verify-shining-playback.js --quota=20   # quota réduit : DOIT
//                                                          # échouer (c'est la
//                                                          # preuve que le harnais
//                                                          # détecte un deadlock)
//   node scripts/verify-shining-playback.js --raw        # hls.js nu (témoin)
//
// Sortie : PASS si currentTime dépasse TARGET sans stall, FAIL sinon.
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from '@playwright/test';
import { createApplication } from '../src/app.js';

const MOVIE_ID = 'c6039c50-3500-4866-9fd8-53a33be02716';
const LIVE_MOVIE = `/var/lib/docker/volumes/movie-together_movie-data/_data/movies/${MOVIE_ID}`;
const PASSWORD = 'harness-browser-password';

const argOf = (name, fallback) => {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};
const QUOTA_MB = +argOf('quota', argOf('stress', 40));
const RAW = process.argv.includes('--raw');
const TARGET = 30;            // secondes de lecture à atteindre
const WALL_TIMEOUT = 240_000;
const STALL_AFTER = 25_000;   // currentTime immobile => deadlock

// ---------------------------------------------------------------------------
// Serveur : la vraie application, sur un dataDir temporaire dont le dossier du
// film est un lien symbolique vers le volume de production. Rien n'est écrit
// dans le film.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'shining-harness-'));
const store = path.join(dataDir, 'store');
await mkdir(path.join(store, 'movies'), { recursive: true });
await symlink(LIVE_MOVIE, path.join(store, 'movies', MOVIE_ID), 'dir');

const instance = createApplication({
  dataDir: store, origin: 'http://127.0.0.1', password: PASSWORD,
  voiceService: { openSession: () => ({ send() {}, flush() {}, close() {} }) },
});
await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${instance.server.address().port}`;
console.log(`serveur de test sur ${base} — quota=${QUOTA_MB}Mo, mode=${RAW ? 'hls brut' : 'chaîne complète'}`);

const post = async (route, body) => {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body ?? {}),
  });
  return { response, cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
};
// La room se crée par le chemin admin de production, comme dans l'interface.
const login = await post('/api/login', { password: PASSWORD });
if (!login.response.ok) {
  console.log(`FAIL: connexion admin refusée (${login.response.status})`);
  await instance.close(); await rm(dataDir, { recursive: true, force: true }); process.exit(1);
}
const room = await fetch(`${base}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: login.cookie },
  body: JSON.stringify({ movieId: MOVIE_ID, code: 'harness', probe: true }),
});
if (!room.ok) {
  console.log(`FAIL: création de room refusée (${room.status}) ${await room.text()}`);
  await instance.close(); await rm(dataDir, { recursive: true, force: true }); process.exit(1);
}
const { id: roomId } = await room.json();
console.log(`room ${roomId} créée sur le film The Shining`);

// ---------------------------------------------------------------------------
// Page : le vrai client, branché sur le vrai WebSocket, avec l'émulation du
// quota MSE de Chrome.
const PAGE = `<!doctype html>
<meta charset="utf-8">
<video id="video" muted playsinline style="width:320px"></video>
<script src="/vendor/hls.js" defer></script>
<script>
(() => {
  const limit = ${QUOTA_MB} * 1024 * 1024;
  const state = window.__quota = { limit, used: 0, peak: 0, appends: 0, rejects: 0, removes: 0, last: null };
  // Firefox n'expose pas mimeType sur SourceBuffer : un tampon est_video dès
  // qu'il a ingéré plus de 2 Mo, ce que les pistes audio (segments de ~100 Ko
  // à 1 Mo) n'atteignent jamais et que les segments 4K dépassent d'un coup.
  const VIDEO_MIN_BYTES = 2 * 1024 * 1024;
  const bytesOf = new WeakMap();
  const isVideo = buffer => (bytesOf.get(buffer) ?? 0) > VIDEO_MIN_BYTES;
  const append = SourceBuffer.prototype.appendBuffer;
  const remove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.appendBuffer = function (buf) {
    const bytes = buf.byteLength ?? buf.length ?? 0;
    const held = bytesOf.get(this) ?? 0;
    if (isVideo(this) && held + bytes > limit) {
      state.rejects++;
      state.last = { at: performance.now() | 0, used: held, bytes };
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    bytesOf.set(this, held + bytes);
    if (isVideo(this)) { state.used = held + bytes; state.peak = Math.max(state.peak, held + bytes); }
    state.appends++;
    return append.call(this, buf);
  };
  SourceBuffer.prototype.remove = function (start, end) {
    state.removes++;
    if (isVideo(this)) {
      // Chrome rend la place proportionnellement à la durée réellement
      // retirée, rapportée à la durée totale jamais couverte par le tampon.
      // Un dénominateur qui rétrécit à chaque retrait viderait le quota en
      // faux positif : on garde donc le pic comme référence stable.
      const held = bytesOf.get(this) ?? 0;
      state.cover = Math.max(state.cover ?? 0, end);
      const share = state.cover > 0 ? Math.max(0, Math.min(1, (end - start) / state.cover)) : 0;
      const left = Math.max(0, held - Math.round(held * share));
      bytesOf.set(this, left);
      state.used = left;
    }
    return remove.call(this, start, end);
  };
})();
</script>
<script type="module">
  const video = document.getElementById('video');
  window.__events = [];
  const log = type => payload => window.__events.push({ type, at: performance.now() | 0,
    ...(payload && typeof payload === 'object' ? payload : { msg: String(payload ?? '') }) });
  try {
    const { SyncPlayer } = await import('/sync-player.js');
    const { attachTelemetry } = await import('/telemetry.js');
    const joined = await (await fetch('/api/join', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'harness' }) })).json();
    const player = window.player = new SyncPlayer({
      video, roomId: joined.id, name: 'harness', forceShader: false,
      onStatus: log('status'),
      onState: (message, controller) => {
        if (message.probe && !window.__telemetry) window.__telemetry = attachTelemetry(controller, video, joined.id);
      },
      onActivation: () => log('activation'),
      onTracks: () => {}, onVoice: () => {}, onWebcam: () => {},
    });
    window.__ready = true;
  } catch (error) {
    window.__bootError = String((error && error.stack) || error);
    window.__ready = false;
  }
  window.__start = async () => {
    // Un participant réel appuie sur lecture : c'est ce geste qui autorise le
    // média, puis la salle passe en playing quand tout le monde est prêt.
    // Le bouton n'existe qu'une fois le film chargé, donc on patiente.
    for (let attempt = 0; attempt < 60 && !window.player.movie; attempt++) {
      await new Promise(r => setTimeout(r, 250));
    }
    await window.player.togglePlayback();
    return window.player.activated;
  };
</script>`;

// Le rendu HDR (WebGL) n'est pas l'objet du harnais et headless n'a pas de
// GPU : on tente d'abord le WebGL logiciel, et sinon on sert un color-renderer
// neutralisé. Le chemin de bufferring testé est identique dans les deux cas.
const prefs = {
  'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0,
  'webgl.force-enabled': true, 'webgl.disabled': false,
  'webgl.forbid-software': false, 'webgl.out-of-process': false,
  'gfx.webrender.software': true, 'layers.acceleration.disabled': true,
};
const browser = await firefox.launch({ headless: true, firefoxUserPrefs: prefs });
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));

const shutdown = async () => {
  await browser.close();
  await instance.close();
  await rm(dataDir, { recursive: true, force: true });
};

// La page du harnais remplace le document à la racine : le reste (modules
// publics, /vendor/hls.js, /media, /ws, /api) vient du vrai serveur.
await page.route(base + '/', route => route.fulfill({
  status: 200, contentType: 'text/html; charset=utf-8', body: PAGE,
}));
// Sans GPU, le ColorRenderer du HDR lève « Le rendu des couleurs nécessite
// l'accélération graphique. » et stoppe le film avant le moindre segment. Ce
// n'est pas le chemin testé ici : on sert un module neutre qui laisse le
// bufferring et la synchronisation se comporter comme en production.
let rendererStubbed = false;
await page.route(base + '/color-renderer.js', route => {
  rendererStubbed = true;
  route.fulfill({
    status: 200, contentType: 'text/javascript; charset=utf-8',
    body: `export const ColorRenderer = class { constructor() {} updateCaptions() {} dispose() {} };
export const colorNeedsRenderer = () => false;
export const nativeHdrPipeline = async () => true;`,
  });
});
await page.goto(base, { waitUntil: 'domcontentloaded' });
console.log(rendererStubbed ? 'rendu HDR neutralisé (pas de GPU headless)' : 'rendu HDR réel actif');
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 });
} catch (error) {
  console.log('FAIL: le client réel n\'a pas démarré :', error.message);
  const bootError = await page.evaluate(() => window.__bootError ?? null);
  if (bootError) console.log('  erreur de démarrage:', bootError.split('\n')[0]);
  for (const line of consoleErrors.slice(0, 8)) console.log('  [console]', line);
  await shutdown();
  process.exit(1);
}

// Un utilisateur réel clique sur lecture : le geste est nécessaire pour que le
// média soit autorisé, et la salle ne passe en playing qu'une fois prête.
const activated = await page.evaluate(() => window.__start());
if (!activated) {
  console.log('FAIL: le geste de lecture n\'a pas activé le média (autoplay bloqué ?)');
  const events = await page.evaluate(() => (window.__events ?? []).slice(-8));
  console.log('événements:', JSON.stringify(events));
  await shutdown();
  process.exit(1);
}
console.log('média autorisé, salle en cours de démarrage');

const probe = () => page.evaluate(() => {
  const v = document.getElementById('video');
  const p = window.player;
  const ranges = [];
  for (let i = 0; i < v.buffered.length; i++) ranges.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
  const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
  const quality = v.getVideoPlaybackQuality?.() ?? {};
  return {
    t: v.currentTime, paused: v.paused, ranges, ahead: +(end - v.currentTime).toFixed(2),
    phase: p?.state?.phase ?? null, activated: !!p?.activated, failure: p?.failure ?? null,
    recovering: !!p?.recovering, rate: v.playbackRate, readyState: v.readyState, quota: window.__quota,
    frames: quality.totalVideoFrames ?? null, dropped: quality.droppedVideoFrames ?? null,
  };
});

let lastT = -1, lastMove = Date.now(), maxT = 0, pass = false, stall = null, maxAhead = 0;
const deadline = Date.now() + WALL_TIMEOUT;
while (Date.now() < deadline) {
  const s = await probe();
  if (s.t !== lastT) { lastMove = Date.now(); lastT = s.t; }
  maxT = Math.max(maxT, s.t);
  maxAhead = Math.max(maxAhead, s.ahead);
  const q = s.quota;
  console.log(`t=${s.t.toFixed(2)}s phase=${s.phase} paused=${s.paused} rate=${s.rate} rs=${s.readyState} ` +
    `ahead=${s.ahead}s frames=${s.frames} drop=${s.dropped} buffered=${JSON.stringify(s.ranges)} ` +
    `quota=${q ? `${(q.used / 1048576).toFixed(1)}/${q.limit / 1048576}Mo peak=${(q.peak / 1048576).toFixed(1)}Mo app=${q.appends} rej=${q.rejects} rm=${q.removes}` : 'n/a'}`);
  if (s.failure) { stall = `échec de lecture annoncé par le client: ${s.failure}`; break; }
  if (s.t >= TARGET) { pass = true; break; }
  if (Date.now() - lastMove > STALL_AFTER) {
    stall = `currentTime figé à ${s.t.toFixed(2)}s pendant ${STALL_AFTER / 1000}s (phase=${s.phase}, ahead=${s.ahead}s)`;
    break;
  }
  await new Promise(r => setTimeout(r, 1000));
}

if (stall) {
  console.log(`STALL: ${stall}`);
  const final = await page.evaluate(() => {
    const v = document.getElementById('video');
    const p = window.player;
    const lastReport = p?.lastReport ?? null;
    return {
      t: v.currentTime, readyState: v.readyState, networkState: v.networkState, error: v.error?.code ?? null,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => [+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]),
      phase: p?.state?.phase, recovering: !!p?.recovering, activated: !!p?.activated, failure: p?.failure ?? null,
      quota: window.__quota, sync: p?.sync,
      backend: p?.backend?.constructor?.name,
      frag: p?.backend?.hls?.streamController?.fragPlaying
        ? { start: p.backend.hls.streamController.fragPlaying.start, end: p.backend.hls.streamController.fragPlaying.end } : null,
      lastReport,
    };
  });
  console.log('diagnostic:', JSON.stringify(final, null, 1));
  const events = await page.evaluate(() => (window.__events ?? []).slice(-15));
  if (events.length) console.log('derniers événements client:', JSON.stringify(events));
  const telemetry = await readTelemetry(store, roomId);
  if (telemetry.length) {
    console.log(`télémétrie (${telemetry.length} événements) :`);
    for (const line of telemetry.filter(e => /hls|buffer-full|append-error|video-|status|phase/i.test(e)).slice(-25)) console.log('  ', line);
  }
}

await shutdown();
console.log(`${pass ? 'PASS' : 'FAIL'}: maxCurrentTime=${maxT.toFixed(2)}s (cible ${TARGET}s, maxAhead=${maxAhead.toFixed(2)}s, ` +
  `mode=${RAW ? 'hls brut' : 'chaîne complète'}, quota=${QUOTA_MB}Mo)`);
process.exit(pass ? 0 : 1);

async function readTelemetry(root, id) {
  const { readdir, readFile } = await import('node:fs/promises');
  try {
    const directory = path.join(root, 'telemetry');
    const files = await readdir(directory);
    const lines = [];
    for (const file of files.filter(name => name.endsWith('.ndjson'))) {
      const body = await readFile(path.join(directory, file), 'utf8');
      for (const line of body.split('\n').filter(Boolean)) {
        try { const event = JSON.parse(line); lines.push(`${event.type} ${JSON.stringify(event).slice(0, 240)}`); }
        catch { lines.push(line.slice(0, 240)); }
      }
    }
    return lines;
  } catch { return []; }
}
