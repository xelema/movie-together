import http from 'node:http';

const [base, mode, countArg, tag] = process.argv.slice(2);
const count = Number(countArg ?? 6);
const FILM_MBPS = 30;
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

const get = (path, range) => new Promise((resolve, reject) => {
  http.get(base + path, { agent, headers: range ? { range } : {} }, res => {
    let n = 0;
    res.on('data', c => { n += c.length; }).on('end', () => resolve(n)).on('error', reject);
  }).on('error', reject);
});

const size = await new Promise((resolve, reject) => http.request(base + '/seg/size', { method: 'HEAD', agent },
  res => { res.resume(); resolve(Number(res.headers['content-length'])); }).on('error', reject).end());

const fetchSeg = async (i, parts) => {
  if (parts === 1) return get(`/seg/${i}`);
  const step = Math.ceil(size / parts);
  const sizes = await Promise.all([...Array(parts).keys()].map(p =>
    get(`/seg/${i}`, `bytes=${p * step}-${Math.min(size, (p + 1) * step) - 1}`)));
  return sizes.reduce((s, x) => s + x, 0);
};

const parts = { seq: 1, par4: 4, par8: 8 }[mode] ?? 1;
const times = [];
const t0 = performance.now();
for (let i = 0; i < count; i++) {
  const t = performance.now();
  const n = await fetchSeg(`${tag ?? 'x'}-${i}`, parts);
  if (n !== size) throw new Error(`short ${n}/${size}`);
  times.push((performance.now() - t) / 1000);
}
const wall = (performance.now() - t0) / 1000;
const warm = times.slice(1);
const mbps = size * count * 8 / wall / 1e6;
const warmMbps = size * warm.length * 8 / warm.reduce((s, x) => s + x, 0) / 1e6;
console.log(JSON.stringify({ mode, mbps: +mbps.toFixed(1), warmMbps: +warmMbps.toFixed(1),
  first: +times[0].toFixed(2), worst: +Math.max(...warm).toFixed(2), realtime: +(warmMbps / FILM_MBPS).toFixed(2) }));
