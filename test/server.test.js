import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../src/app.js';
import { run, inspectProbe } from '../src/media.js';

test('accepts supported video without resolution restrictions and converts audio when needed', () => {
  const video = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', profile: 'High', level: 40, width: 1920, height: 1080 };
  const audio = { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' };
  const inspect = (v, a) => inspectProbe({ streams: [v, a], format: { duration: '100' } }).compatible;
  assert.equal(inspect(video, audio), true);
  assert.equal(inspect({ ...video, codec_name: 'hevc', width: 7680, height: 4320 }, audio), true);
  assert.equal(inspect(video, { ...audio, codec_name: 'dts' }), true);
  assert.equal(inspect({ ...video, pix_fmt: 'yuv420p10le' }, audio), true);
  assert.equal(inspect({ ...video, codec_name: 'unknown' }, audio), false);
});

test('authenticated upload, real lossless packaging, private rooms and access control', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body, headers = {} } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  assert.equal((await request('/api/movies')).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'bad' } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: 'https://elsewhere.invalid' }, body: { password: 'test-password-long-enough' } })).status, 403);
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const file = path.join(dataDir, 'fixture.mp4');
  // Only this synthetic test pattern is encoded; movie import always uses stream copy.
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '20', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a', 'aac', '-ac', '2', '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng', file]);
  const bytes = await readFile(file);
  const upload = await (await request('/api/uploads', { cookie, method: 'POST', body: { name: 'Test.mp4', size: bytes.length } })).json();
  assert.ok(upload.id);
  const cut = Math.floor(bytes.length / 2);
  const put = (offset, body) => request(`/api/uploads/${upload.id}`, { cookie, method: 'PUT', body,
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) } });
  assert.equal((await put(0, bytes.subarray(0, cut))).status, 200);
  assert.equal((await put(0, bytes.subarray(0, cut))).status, 409);
  assert.equal((await (await request(`/api/uploads/${upload.id}`, { cookie })).json()).offset, cut);
  assert.equal((await put(cut, bytes.subarray(cut))).status, 200);
  const movie = await (await request(`/api/uploads/${upload.id}/complete`, { cookie, method: 'POST', body: {} })).json();
  assert.equal(movie.status, 'uploaded', movie.error);
  assert.equal((await request(`/api/movies/${movie.id}/prepare`, { cookie, method: 'POST', body: { audio: [1, 2], subtitles: [] } })).status, 202);
  let prepared;
  for (let count = 0; count < 100; count++) {
    prepared = (await (await request('/api/movies', { cookie })).json())[0];
    if (prepared.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(prepared.status, 'ready', prepared.error);
  const master = await (await request(`/media/${movie.id}/master.m3u8`, { cookie })).text();
  assert.equal((master.match(/TYPE=AUDIO/g) ?? []).length, 2);
  const media = await request(`/media/${movie.id}/init_0.mp4`, { cookie });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('cache-control'), 'private, no-cache');
  const etag = media.headers.get('etag');
  assert.ok(etag.includes(prepared.generation));
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { cookie, headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 304);
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 401);
  const range = await request(`/media/${movie.id}/init_0.mp4`, { cookie, headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const hashStream = (input, stream) => run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', input, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  const directory = path.join(instance.store.directory(movie.id), prepared.generation);
  assert.equal(await hashStream(path.join(directory, 'stream_0.m3u8'), '0:v:0'), await hashStream(file, '0:v:0'));
  assert.equal(await hashStream(path.join(directory, 'stream_1.m3u8'), '0:a:0'), await hashStream(file, '0:a:0'));
  const subtitle = await request(`/api/movies/${movie.id}/subtitles?label=English&language=en`, { cookie, method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nA subtitle.\n') });
  assert.equal(subtitle.status, 200);
  const withSubtitles = await subtitle.json();
  const vtt = await (await request(`/media/${movie.id}/${withSubtitles.subtitles[0].filename}`, { cookie })).text();
  assert.match(vtt, /WEBVTT/); assert.match(vtt, /A subtitle\./);
  assert.match(await (await request(`/media/${movie.id}/master.m3u8`, { cookie })).text(), /TYPE=SUBTITLES/);
  assert.equal((await request(`/media/${movie.id}/master.m3u8`)).status, 401);
  const room = await (await request('/api/rooms', { cookie, method: 'POST', body: { movieId: movie.id, code: 'Cinema-Soir' } })).json();
  assert.equal(room.code, 'cinema-soir');
  assert.equal((await request('/api/rooms', { cookie, method: 'POST', body: { movieId: movie.id, code: 'CINEMA-SOIR' } })).status, 409);
  assert.equal((await request('/api/rooms', { cookie, method: 'POST', body: { movieId: movie.id, code: '<script>' } })).status, 400);
  const joined = await request('/api/join', { method: 'POST', body: { code: room.code } });
  const guest = joined.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(`/api/rooms/${room.id}/movie`, { cookie: guest, method: 'POST', body: { movieId: movie.id } })).status, 401);
  assert.equal((await request(`/media/${movie.id}/master.m3u8`, { cookie: guest })).status, 200);
  assert.equal((await request(`/media/${movie.id}/source`, { cookie: guest })).status, 404);
  assert.equal((await request('/api/uploads', { cookie: guest })).status, 401);
  const connect = cookieValue => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`, { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket); socket.on('error', reject); socket.on('message', data => {
      const message = JSON.parse(data); if (message.type === 'state') resolve({ socket, message });
    });
  });
  const a = await connect(cookie), b = await connect(guest);
  assert.equal(b.message.members.length, 2);
  assert.equal((await request(`/api/movies/${movie.id}`, { cookie, method: 'DELETE' })).status, 409);
  await request(`/api/rooms/${room.id}`, { cookie, method: 'DELETE' });
  assert.equal((await request(`/media/${movie.id}/master.m3u8`, { cookie: guest })).status, 403);
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { cookie: guest, headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 403);
  assert.equal((await request('/api/join', { method: 'POST', body: { code: room.code } })).status, 404);
});
