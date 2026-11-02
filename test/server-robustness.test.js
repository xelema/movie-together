import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'test-password-long-enough';

// One application on a scratch data directory, its movies written as stored
// metadata, closed with every handle once the test ends.
async function boot(t, { movies = [], settings } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-robust-'));
  for (const movie of movies) {
    await mkdir(path.join(dataDir, 'movies', movie.id), { recursive: true });
    await writeFile(path.join(dataDir, 'movies', movie.id, 'movie.json'), JSON.stringify(movie));
  }
  if (settings) await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  const instance = createApplication({ dataDir, password: PASSWORD, origin: ORIGIN, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, { cookie, method = 'GET', body, raw, headers = {} } = {}) => fetch(base + url, {
    method, headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const login = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { instance, dataDir, base, request, cookie };
}

// A guest of a fresh room on a ready movie, connected once so the room knows
// its member id: what a viewer's page holds before it sends telemetry.
async function guestOf(t, { request, cookie, base }, movie, code) {
  const room = await (await request('/api/rooms', { cookie, method: 'POST', body: { movieId: movie, code } })).json();
  const joined = await request('/api/join', { method: 'POST', body: { code: room.code } });
  const guest = joined.headers.get('set-cookie').split(';')[0];
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`, { headers: { Cookie: guest, Origin: ORIGIN } });
  t.after(() => socket.terminate());
  const memberId = await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', data => { const message = JSON.parse(data); if (message.type === 'welcome') resolve(message.id); });
  });
  return { room, guest, memberId, socket };
}

const ready = n => ({ id: movieId(n), title: `Film ${n}`, status: 'ready', duration: 120 });
const movieId = n => `00000000-0000-4000-8000-00000000000${n}`;
const uploaded = n => ({ id: movieId(n), title: `Film ${n}`, status: 'uploaded' });

// A background job answers 202 first: wait until the movie leaves its status.
const settled = async (request, cookie, id, busy) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const movie = (await (await request('/api/movies', { cookie })).json()).find(item => item.id === id);
    if (movie.status !== busy) return movie;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${id} stayed ${busy}`);
};

test('a failing metadata save never leaks the heavy job lock', async t => {
  const { instance, request, cookie } = await boot(t, { movies: [uploaded(1), uploaded(2), uploaded(3)] });
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = error; });
  const save = instance.store.save;
  const full = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };

  // The save that opens the job fails: the request errors, nothing stays claimed
  // and the movie keeps its status.
  instance.store.save = full;
  assert.equal((await request(`/api/movies/${movieId(1)}/probe`, { cookie, method: 'POST', body: {} })).status, 500);
  instance.store.save = save;
  assert.equal((await (await request('/api/movies', { cookie })).json()).find(item => item.id === movieId(1)).status, 'uploaded');
  assert.equal((await request(`/api/movies/${movieId(2)}/probe`, { cookie, method: 'POST', body: {} })).status, 202);
  await settled(request, cookie, movieId(2), 'probing');

  // The save that closes the job fails: the job still releases its claim.
  let calls = 0;
  instance.store.save = movie => (++calls === 1 ? save(movie) : full());
  assert.equal((await request(`/api/movies/${movieId(3)}/probe`, { cookie, method: 'POST', body: {} })).status, 202);
  await settled(request, cookie, movieId(3), 'probing');
  instance.store.save = save;
  assert.ok(calls >= 2, 'the closing save ran');
  assert.ok(errors.some(line => line.includes('ENOSPC')), 'the lost save is logged');
  assert.equal((await request(`/api/movies/${movieId(1)}/probe`, { cookie, method: 'POST', body: {} })).status, 202);
  await settled(request, cookie, movieId(1), 'probing');

  // Same guard on the preparation: a failing opening save frees the pipeline.
  instance.store.save = full;
  assert.equal((await request(`/api/movies/${movieId(2)}/prepare`, { cookie, method: 'POST', body: { audio: [], subtitles: [] } })).status, 500);
  instance.store.save = save;
  assert.notEqual((await (await request('/api/movies', { cookie })).json()).find(item => item.id === movieId(2)).status, 'processing');
  assert.equal((await request(`/api/movies/${movieId(3)}/probe`, { cookie, method: 'POST', body: {} })).status, 202);
  await settled(request, cookie, movieId(3), 'probing');
});

test('the large json parser only runs on its two routes, after their guard, and never inflates', async t => {
  const app = await boot(t, { movies: [ready(1)] });
  const { request, cookie } = app;
  const malformed = { raw: '{"a":', headers: { 'Content-Type': 'application/json' } };
  // Paths that merely end like a large route keep the small limit.
  const heavy = { raw: JSON.stringify(Array(40_000).fill(0)), headers: { 'Content-Type': 'application/json' } };
  assert.equal((await request('/nope/telemetry', { method: 'POST', ...heavy })).status, 413);
  assert.equal((await request('/x/cues', { method: 'PUT', ...heavy })).status, 413);
  // The real routes reject an anonymous caller before reading its body.
  assert.equal((await request(`/api/rooms/${movieId(9)}/telemetry`, { method: 'POST', ...malformed })).status, 401);
  assert.equal((await request(`/api/movies/${movieId(1)}/subtitles/x/cues`, { method: 'PUT', ...malformed })).status, 401);
  const { room, guest, memberId } = await guestOf(t, app, movieId(1), 'parseur');
  // A guest outside the room is refused before its body is read as well.
  assert.equal((await request(`/api/rooms/${movieId(9)}/telemetry`, { cookie: guest, method: 'POST', ...malformed })).status, 404);
  // A compressed body is refused: a few KiB on the wire must not become 4 MiB to parse.
  const batch = { memberId, events: Array.from({ length: 400 }, (_, i) => ({ t: i, type: 'tick', pad: 'x'.repeat(3700) })) };
  const json = JSON.stringify(batch);
  assert.ok(json.length > 1024 ** 2, 'a batch at the client bounds weighs over a MiB');
  assert.equal((await request(`/api/rooms/${room.id}/telemetry`, { cookie: guest, method: 'POST', raw: gzipSync(json),
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })).status, 415);
  // The client contract still holds: 400 events of 3800 characters pass whole.
  assert.equal((await request(`/api/rooms/${room.id}/telemetry`, { cookie: guest, method: 'POST', raw: json,
    headers: { 'Content-Type': 'application/json' } })).status, 204);
  // Every other route keeps the small limit.
  assert.equal((await request('/api/login', { method: 'POST', raw: JSON.stringify({ password: 'x'.repeat(40_000) }),
    headers: { 'Content-Type': 'application/json' } })).status, 413);
});
