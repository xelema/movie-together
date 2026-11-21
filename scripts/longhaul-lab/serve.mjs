import http from 'node:http';
import crypto from 'node:crypto';

const [port, upstream] = [Number(process.argv[2]), process.argv[3]];
const SIZE = Number(process.env.SEG_BYTES ?? 12_000_000);
const body = crypto.randomBytes(SIZE);
const cache = new Map();
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const send = (req, res, buf) => {
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
  const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, buf.length - 1];
  res.writeHead(m ? 206 : 200, { 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
  res.end(req.method === 'HEAD' ? undefined : buf.subarray(a, b + 1));
};

const passThrough = (req, res, key) => http.get(upstream + key, { agent, headers: req.headers.range ? { range: req.headers.range } : {} }, up => {
  res.writeHead(up.statusCode, { 'content-length': up.headers['content-length'], 'accept-ranges': 'bytes' });
  const parts = [];
  up.on('data', c => { if (!req.headers.range) parts.push(c); res.write(c); });
  up.on('end', () => { if (!req.headers.range) cache.set(key, Buffer.concat(parts)); res.end(); });
});

const server = http.createServer((req, res) => {
  if (!upstream) return send(req, res, body);
  const key = req.url.split('?')[0];
  if (cache.has(key)) return send(req, res, cache.get(key));
  if (req.method === 'HEAD') return send(req, res, body);
  passThrough(req, res, key);
});
Object.assign(server, { keepAliveTimeout: 600_000, requestTimeout: 0 });
server.listen(port, () => console.log(`listening ${port} ${upstream ? 'relay->' + upstream : 'origin'}`));
