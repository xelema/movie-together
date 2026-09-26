import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/app.js';

const PW_KO = 'fr-ko-password-long-enough';
const PW_VI = 'fr-vi-password-long-enough';

async function boot(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-accounts-'));
  const origin = 'http://localhost:3000';
  const movieId = 'eeeeeeee-1111-2222-3333-444444444444';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Film', status: 'ready', duration: 120 }));
  const instance = createApplication({ dataDir, origin, env: {}, ...options });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async password => {
    const response = await request('/api/login', { method: 'POST', body: { password } });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const sessionOf = async cookie => (await request('/api/session', { cookie })).json();
  return { request, login, sessionOf, movieId, hub: instance.hub };
}

test('two accounts open two sessions, each bound to its language pair', async t => {
  const { request, login, sessionOf } = await boot(t, { passwords: { 'fr-ko': PW_KO, 'fr-vi': PW_VI } });
  assert.equal((await login('wrong-password-xxxxx')).status, 401);
  assert.equal((await request('/api/session')).status, 200);
  const ko = await login(PW_KO);
  assert.equal(ko.status, 200);
  assert.deepEqual(await sessionOf(ko.cookie),
    { authenticated: true, admin: true, adminRole: 'fr-ko', adminLanguages: ['fr', 'ko'] });
  const vi = await login(PW_VI);
  assert.equal(vi.status, 200);
  assert.deepEqual(await sessionOf(vi.cookie),
    { authenticated: true, admin: true, adminRole: 'fr-vi', adminLanguages: ['fr', 'vi'] });
  // Les deux cookies coexistent : aucun ne recouvre l'autre.
  assert.deepEqual((await sessionOf(ko.cookie)).adminRole, 'fr-ko');
});

test('a lone password string stays the single fr-ko account', async t => {
  const { login, sessionOf } = await boot(t, { password: 'test-password-long-enough' });
  const admin = await login('test-password-long-enough');
  assert.equal(admin.status, 200);
  const session = await sessionOf(admin.cookie);
  assert.equal(session.adminRole, 'fr-ko');
  assert.deepEqual(session.adminLanguages, ['fr', 'ko']);
});

test('every configured password still needs sixteen characters', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-accounts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.throws(() => createApplication({ dataDir, passwords: { 'fr-ko': PW_KO, 'fr-vi': 'short' }, env: {} }),
    /16 caractères/);
  assert.throws(() => createApplication({ dataDir, passwords: {}, env: {} }), /16 caractères/);
});

test('each admin creates and lists only rooms on its own pair', async t => {
  const { request, login, movieId } = await boot(t, { passwords: { 'fr-ko': PW_KO, 'fr-vi': PW_VI } });
  const ko = (await login(PW_KO)).cookie;
  const vi = (await login(PW_VI)).cookie;
  const create = (cookie, code) => request('/api/rooms', { cookie, method: 'POST', body: { movieId, code, voice: true } });
  const koRoom = await (await create(ko, 'frko-room')).json();
  const viRoom = await (await create(vi, 'frvi-room')).json();
  // La séance porte la paire du compte : la voix se fige dessus.
  const koState = await (await request(`/api/rooms/${koRoom.id}`, { cookie: ko })).json();
  assert.deepEqual(koState.languages, ['fr', 'ko']);
  assert.deepEqual(koState.voice.pair, ['fr', 'ko']);
  const viState = await (await request(`/api/rooms/${viRoom.id}`, { cookie: vi })).json();
  assert.deepEqual(viState.languages, ['fr', 'vi']);
  assert.deepEqual(viState.voice.pair, ['fr', 'vi']);
  // Aucune trace de coréen dans la liste du compte fr-vi, et réciproquement.
  const koList = await (await request('/api/rooms', { cookie: ko })).json();
  assert.deepEqual(koList.map(room => room.code), ['frko-room']);
  assert.deepEqual(koList[0].languages, ['fr', 'ko']);
  const viList = await (await request('/api/rooms', { cookie: vi })).json();
  assert.deepEqual(viList.map(room => room.code), ['frvi-room']);
  assert.deepEqual(viList[0].languages, ['fr', 'vi']);
});
