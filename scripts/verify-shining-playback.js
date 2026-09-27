// Vérifie en conditions réelles que la lecture de The Shining (4K HDR HEVC,
// ~34 Mbps, targetDuration 10 s) dépasse le deadlock historique à ~19.5 s :
// hls.js n'évicte le back-buffer qu'au-delà de 2×targetDuration, ce qui
// figeait le SourceBuffer plein avant ce seuil. Firefox headless décode HEVC
// via ffmpeg système.
//
// Usage :
//   node scripts/verify-shining-playback.js             # HlsJsBackend (fix actif)
//   node scripts/verify-shining-playback.js --raw       # hls.js nu, même config (témoin)
//   node scripts/verify-shining-playback.js --stress=N  # quota vidéo SourceBuffer à
//                                                       # N Mo : force QuotaExceededError
//                                                       # comme en prod (--raw cale ~19.5 s)
//
// Sortie : PASS si currentTime dépasse TARGET sans rester figé, FAIL sinon.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { firefox } from '@playwright/test';

const MOVIE_DIR = '/var/lib/docker/volumes/movie-together_movie-data/_data/movies/c6039c50-3500-4866-9fd8-53a33be02716/871b14fc-5635-467e-9719-20778b08e15c';
const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = process.argv.includes('--raw');
const STRESS = process.argv.find(a => a.startsWith('--stress='));
const QUOTA_MB = STRESS ? +STRESS.split('=')[1] : null;
const TARGET = 30;          // secondes de lecture à atteindre
const WALL_TIMEOUT = 240_000;
const STALL_AFTER = 30_000; // currentTime immobile => deadlock

const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4',
  '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.js': 'text/javascript', '.html': 'text/html' };

const PAGE = `<!doctype html><video id=v muted style="width:320px"></video>
<script src="/hls.js"></script>
<script type="module">
  const video = document.getElementById('v');
  window.__frags = 0; window.__fatal = null; window.__errors = [];
  window.__flush = 0;
  const config = { maxBufferLength: 30, maxMaxBufferLength: 60,
    maxBufferSize: 80 * 1024 * 1024, backBufferLength: 15,
    startFragPrefetch: true, enableWorker: true,
    maxBufferHole: 0.5, highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5,
    nudgeOffset: 0.1, progressive: false,
    fragLoadingTimeOut: 30000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryDelay: 8000, manifestLoadingTimeOut: 15000,
    levelLoadingTimeOut: 15000 };
  ${RAW ? `window.__hls = new Hls(config);
  __hls.loadSource('/master.m3u8'); __hls.attachMedia(video);` : `
  const { HlsJsBackend } = await import('/backends.js');
  window.__backend = new HlsJsBackend(video, '/master.m3u8', {},
    { onFatal: m => window.__fatal = m });
  window.__hls = window.__backend.hls;`}
  __hls.on(Hls.Events.FRAG_BUFFERED, () => window.__frags++);
  __hls.on(Hls.Events.BUFFER_FLUSHING, () => window.__flush++);
  __hls.on(Hls.Events.ERROR, (e, d) => window.__errors.push(d.details));
  video.play().catch(e => window.__errors.push('play: ' + e.message));
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  try {
    if (url === '/') return res.end(PAGE);
    if (url === '/hls.js') {
      res.setHeader('content-type', MIME['.js']);
      return res.end(await readFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.js')));
    }
    if (url === '/backends.js') {
      res.setHeader('content-type', MIME['.js']);
      return res.end(await readFile(path.join(ROOT, 'public/backends.js')));
    }
    const file = path.join(MOVIE_DIR, path.normalize(url));
    if (!file.startsWith(MOVIE_DIR)) return res.writeHead(403).end();
    const body = await readFile(file);
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const prefs = {
  'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 };
// Quota MSE vidéo : Firefox évicte puis jette QuotaExceededError au-delà.
if (QUOTA_MB) prefs['media.mediasource.eviction_threshold.video'] = QUOTA_MB * 1024 * 1024;
const browser = await firefox.launch({ headless: true, firefoxUserPrefs: prefs });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);

const probe = () => page.evaluate(() => {
  const v = document.getElementById('v');
  const ranges = [];
  for (let i = 0; i < v.buffered.length; i++) ranges.push([+v.buffered.start(i).toFixed(1), +v.buffered.end(i).toFixed(1)]);
  return { t: v.currentTime, ranges, paused: v.paused, frags: window.__frags,
    flush: window.__flush, fatal: window.__fatal, errors: window.__errors.slice(-8) };
});

let lastT = -1, lastMove = Date.now(), maxT = 0, pass = false;
const deadline = Date.now() + WALL_TIMEOUT;
while (Date.now() < deadline) {
  const s = await probe();
  if (s.t !== lastT) { lastMove = Date.now(); lastT = s.t; }
  maxT = Math.max(maxT, s.t);
  console.log(`t=${s.t.toFixed(2)}s buffered=${JSON.stringify(s.ranges)} frags=${s.frags} flush=${s.flush} paused=${s.paused}` +
    (s.errors.length ? ` errors=${s.errors.join(',')}` : ''));
  if (s.fatal) { console.log('FATAL:', s.fatal); break; }
  if (s.t >= TARGET) { pass = true; break; }
  if (Date.now() - lastMove > STALL_AFTER) {
    console.log(`STALL: currentTime figé à ${s.t.toFixed(2)}s pendant ${STALL_AFTER / 1000}s`);
    break;
  }
  await new Promise(r => setTimeout(r, 1000));
}

await browser.close();
server.close();
console.log(`${pass ? 'PASS' : 'FAIL'}: maxCurrentTime=${maxT.toFixed(2)}s (cible ${TARGET}s, mode=${RAW ? 'hls brut' : 'HlsJsBackend'}${QUOTA_MB ? `, quota=${QUOTA_MB}Mo` : ''})`);
process.exit(pass ? 0 : 1);
