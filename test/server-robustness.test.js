import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
