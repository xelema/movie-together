// PROTOTYPE: mesure le debit d'un fetch de segment dans un vrai navigateur,
// en forcant HTTP/3 puis TCP. Jetable, pas de prod.
// Usage : node scripts/proto-http3-throughput.mjs [h3|tcp]
import { chromium } from '@playwright/test';

const mode = process.argv[2] ?? 'h3';
const origin = 'https://movie-seoul.duckdns.org';
const args = mode === 'h3'
  ? ['--enable-quic', '--origin-to-force-quic-on=movie-seoul.duckdns.org:443']
  : ['--disable-quic'];

const browser = await chromium.launch({ args });
const page = await browser.newPage();
await page.goto(origin + '/');
const result = await page.evaluate(async () => {
  const join = await fetch('/api/join', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"code":"test-hevc"}' });
  if (!join.ok) return { error: 'join ' + join.status };
  const url = '/media/e1ac08df-7e7d-4a18-8e6b-27f2e0b933bd/segment_0_000003.m4s';
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  const dt = (performance.now() - t0) / 1000;
  const entry = performance.getEntriesByName(location.origin + url).at(-1);
  return { bytes: buf.byteLength, mbps: buf.byteLength * 8 / dt / 1e6,
    proto: entry?.nextHopProtocol, secs: dt };
});
console.log(mode, JSON.stringify(result));
await browser.close();
