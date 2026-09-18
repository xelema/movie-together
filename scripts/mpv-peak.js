// Sonde les valeurs de détection de pic que mpv expose en pause sur un
// timestamp donné : video-params entier + propriétés candidates.
// Usage : node scripts/mpv-peak.js [timePos] [film]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const t = Number(process.argv[2] ?? 23.625);
const file = process.argv[3] ?? 'C:/Users/xelem/Videos/ia-spiderman/trailer_demo_HDR.mkv';
const MPV = process.env.MPV_PATH ||
  (process.platform === 'win32' && existsSync(path.join(process.env.APPDATA, 'mpv/mpv.exe'))
    ? path.join(process.env.APPDATA, 'mpv/mpv.exe') : 'mpv');
const pipe = `mpvpeak-${process.pid}`;
const proc = spawn(MPV, ['--force-window=yes', '--idle=yes', '--pause=yes', '--osd-level=0',
  `--input-ipc-server=${pipe}`, '--autofit=1600x670',
  '--target-trc=gamma2.2', '--target-peak=75', file], { stdio: 'ignore', windowsHide: true });
process.on('exit', () => proc.kill());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let socket;
for (;;) {
  try {
    socket = await new Promise((resolve, reject) => {
      const s = net.createConnection(`\\\\.\\pipe\\${pipe}`, () => { s.off('error', reject); resolve(s); });
      s.once('error', reject);
    });
    break;
  } catch { await sleep(200); }
}
let buffer = '', next = 1; const pending = new Map();
socket.on('data', chunk => {
  buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.request_id && pending.has(m.request_id)) { pending.get(m.request_id)(m); pending.delete(m.request_id); }
  }
});
const send = (...command) => new Promise(resolve => { const id = next++; pending.set(id, resolve); socket.write(JSON.stringify({ command, request_id: id }) + '\n'); });
const get = async property => await send('get_property', property);
const until = async (property, value) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if ((await get(property)).data === value) return; await sleep(150); }
  throw new Error(`${property} reste ${JSON.stringify(await get(property))}`);
};

await until('duration', (await get('duration')).data); // attend le chargement
for (;;) { if ((await get('duration')).data) break; await sleep(250); }
await send('seek', t, 'absolute+exact');
await until('seeking', false);
await sleep(1500);
const params = await get('video-params');
console.log('video-params:', JSON.stringify(params.data ?? params, null, 1));
for (const p of ['video-params/max-pq-y', 'video-params/avg-pq-y', 'video-params/peak-saturation',
  'video-out-params/max-pq-y', 'video-out-params/avg-pq-y']) {
  const r = await get(p);
  console.log(p, '=>', JSON.stringify(r.data ?? r.error));
}
await send('quit'); socket.end();
