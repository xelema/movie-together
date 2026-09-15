import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';

test('probe rooms persist across restarts, accept telemetry and stay open', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-telemetry-'));
  const origin = 'http://localhost:3000';
  const movieId = '11111111-2222-3333-4444-555555555555';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Film test', status: 'ready', duration: 120 }));
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await rm(dataDir, { recursive: true, force: true }); });

  const boot = async () => {
    const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin });
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
    return { instance, base, request, cookie: login.headers.get('set-cookie').split(';')[0] };
  };

  const first = await boot();
  const probe = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'avant-premiere', probe: true } })).json();
  const plain = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'seance-normale' } })).json();
  const listed = await (await first.request('/api/rooms', { cookie: first.cookie })).json();
  assert.equal(listed.find(room => room.code === 'avant-premiere').probe, true);
  assert.equal(listed.find(room => room.code === 'seance-normale').probe, false);
  // Probe rooms outlive the usual twelve hours.
  assert.ok(listed.find(room => room.code === 'avant-premiere').expires > Date.now() + 400 * 86400_000);

  const joined = await first.request('/api/join', { method: 'POST', body: { code: 'avant-premiere' } });
  const guest = joined.headers.get('set-cookie').split(';')[0];
  const welcome = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${first.base.replace('http', 'ws')}/ws?room=${probe.id}`, { headers: { Cookie: guest, Origin: origin } });
    sockets.push(socket); socket.on('error', reject);
    socket.on('message', data => { const message = JSON.parse(data); if (message.type === 'welcome') resolve(message); });
  });
  assert.equal(welcome.probe, true);
  const memberId = welcome.id;

  // Telemetry is appended to one NDJSON per member, rejected elsewhere.
  const telemetry = (cookie, body) => first.request(`/api/rooms/${probe.id}/telemetry`, { cookie, method: 'POST', body });
  assert.equal((await telemetry(guest, { memberId, events: [{ t: 1, type: 'caps', ua: 'test' }, { t: 2, type: 'tick', pos: 0 }] })).status, 204);
  assert.equal((await telemetry(guest, { memberId, events: [] })).status, 400);
  assert.equal((await telemetry(guest, { memberId: '../etc', events: [{ t: 1, type: 'x' }] })).status, 400);
  assert.equal((await first.request(`/api/rooms/${plain.id}/telemetry`, { cookie: guest, method: 'POST',
    body: { memberId, events: [{ t: 1, type: 'x' }] } })).status, 404);
  assert.equal((await first.request(`/api/rooms/${probe.id}/telemetry`, { method: 'POST',
    body: { memberId, events: [{ t: 1, type: 'x' }] } })).status, 401);
  const file = path.join(dataDir, 'telemetry', `avant-premiere-${memberId}.ndjson`);
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'caps');
  assert.ok(lines[0].at >= lines[0].t);

  await first.instance.close();

  // Second boot: the probe room is recreated under the same code, the plain one is gone.
  const second = await boot();
  t.after(() => second.instance.close());
  const relisted = await (await second.request('/api/rooms', { cookie: second.cookie })).json();
  assert.deepEqual(relisted.map(room => room.code), ['avant-premiere']);
  assert.equal((await second.request('/api/join', { method: 'POST', body: { code: 'seance-normale' } })).status, 404);
  const rejoined = await second.request('/api/join', { method: 'POST', body: { code: 'avant-premiere' } });
  assert.equal(rejoined.status, 200);

  const roomId = (await rejoined.json()).id;
  assert.equal((await second.request(`/api/rooms/${roomId}`, { cookie: second.cookie, method: 'DELETE' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8')), []);
  assert.equal((await readdir(path.join(dataDir, 'telemetry'))).length, 1);
});
