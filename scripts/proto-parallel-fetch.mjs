// PROTOTYPE: mesure le debit aggrege en telechargeant une ressource par
// N connexions TCP paralleles (Range requests). Jetable, pas de prod.
// Usage : node scripts/proto-parallel-fetch.mjs <url> <cookie> [connexions=8]
const [url, cookie, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 8);
if (!url || !cookie) { console.error('usage: proto-parallel-fetch <url> <cookie> [n]'); process.exit(1); }

const head = await fetch(url, { method: 'HEAD', headers: { cookie } });
const size = Number(head.headers.get('content-length'));
const acceptRanges = head.headers.get('accept-ranges');
console.log(`size=${size} accept-ranges=${acceptRanges} connexions=${n}`);
if (acceptRanges !== 'bytes') throw new Error('pas de Range support');

const bounds = i => [Math.floor(size * i / n), i === n - 1 ? size - 1 : Math.floor(size * (i + 1) / n) - 1];
const t0 = performance.now();
const speeds = await Promise.all([...Array(n).keys()].map(async i => {
  const [a, b] = bounds(i);
  const t = performance.now();
  const res = await fetch(url, { headers: { cookie, range: `bytes=${a}-${b}` } });
  const buf = await res.arrayBuffer();
  const dt = (performance.now() - t) / 1000;
  if (buf.byteLength !== b - a + 1) throw new Error(`part ${i}: ${buf.byteLength} != ${b - a + 1}`);
  return { bytes: buf.byteLength, mbps: (buf.byteLength * 8 / dt / 1e6).toFixed(1) };
}));
const total = speeds.reduce((s, p) => s + p.bytes, 0);
const wall = (performance.now() - t0) / 1000;
console.log(`par-connexion Mb/s: ${speeds.map(p => p.mbps).join(' ')}`);
console.log(`AGGREGAT: ${(total * 8 / wall / 1e6).toFixed(1)} Mb/s en ${wall.toFixed(1)}s`);
