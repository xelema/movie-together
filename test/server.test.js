import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApplication, cleanTitle } from '../src/app.js';
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

test('strips release tags from uploaded file names without eating real titles', () => {
  assert.equal(cleanTitle('The Social Network (2010) MULTi VFF 2160p 10bit 4KLight DOLBY VISION BluRay AC3 5.1 x265-QTZ.mkv'), 'The Social Network (2010)');
  assert.equal(cleanTitle('Backrooms.2026.MULTI.VFQ.2160p.WEB.DV.HDR10PLUS.EAC3.5.1.H265-SUPPLY.mkv'), 'Backrooms 2026');
  assert.equal(cleanTitle('Avatar.de.Feu.et.de.Cendres.2025.MULTI.VF2.1080p.WEB.EAC3.7.1.H265-Slay3R.mkv'), 'Avatar de Feu et de Cendres 2025');
  assert.equal(cleanTitle('The French Connection 1971 1080p BluRay x264.mkv'), 'The French Connection 1971');
  assert.equal(cleanTitle('Les Quatre Cents Coups.mp4'), 'Les Quatre Cents Coups');
  assert.equal(cleanTitle('1080p.mkv'), '1080p');
});

test('authenticated upload, original video and audio, private rooms and access control', { timeout: 60_000 }, async t => {
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
  assert.equal((await request('/api/storage')).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'bad' } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: 'https://elsewhere.invalid' }, body: { password: 'test-password-long-enough' } })).status, 403);
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const storage = await (await request('/api/storage', { cookie })).json();
  assert.ok(storage.free > 0 && storage.total >= storage.free);
  // No syncOptions and no saved file: the defaults must still reach the endpoint.
  assert.deepEqual(await (await request('/api/settings', { cookie })).json(), { minBuffer: 8, lowBuffer: 3 });
  const file = path.join(dataDir, 'fixture.mp4');
  // Use a small synthetic source for a real preparation and access-control check.
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
  const sub = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nA pending subtitle.\n');
  const subUpload = await (await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'pending.srt', size: sub.length, kind: 'subtitle', movieId: movie.id, label: 'French', language: 'fr' } })).json();
  assert.equal((await request(`/api/uploads/${subUpload.id}`, { cookie, method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: sub })).status, 200);
  const withTrack = await (await request(`/api/uploads/${subUpload.id}/complete`, { cookie, method: 'POST', body: {} })).json();
  assert.equal(withTrack.externalTracks.length, 1);
  const afterDelete = await (await request(`/api/movies/${movie.id}/external/${withTrack.externalTracks[0].id}`, { cookie, method: 'DELETE' })).json();
  assert.equal(afterDelete.externalTracks.length, 0);
  // EUC-KR bytes for « 안녕하세요. 반갑습니다 » : SMI uploads arrive in legacy Korean charsets.
  const smi = Buffer.concat([Buffer.from('<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=KRCC>'),
    Buffer.from([0xBE, 0xC8, 0xB3, 0xE7, 0xC7, 0xCF, 0xBC, 0xBC, 0xBF, 0xE4, 0x2E, 0x20,
      0xB9, 0xDD, 0xB0, 0xA9, 0xBD, 0xC0, 0xB4, 0xCF, 0xB4, 0xD9]), Buffer.from('\n</BODY>\n</SAMI>\n')]);
  const smiUpload = await (await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'korean.smi', size: smi.length, kind: 'subtitle', movieId: movie.id, label: 'Korean', language: 'ko' } })).json();
  assert.equal((await request(`/api/uploads/${smiUpload.id}`, { cookie, method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: smi })).status, 200);
  const withSmi = await (await request(`/api/uploads/${smiUpload.id}/complete`, { cookie, method: 'POST', body: {} })).json();
  assert.equal(withSmi.externalTracks[0].format, 'sami');
  const stored = await readFile(path.join(instance.store.directory(movie.id), withSmi.externalTracks[0].filename), 'utf8');
  assert.match(stored, /안녕하세요/);
  const afterSmiDelete = await (await request(`/api/movies/${movie.id}/external/${withSmi.externalTracks[0].id}`, { cookie, method: 'DELETE' })).json();
  assert.equal(afterSmiDelete.externalTracks.length, 0);
  const junk = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const junkUpload = await (await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'junk.sub', size: junk.length, kind: 'subtitle', movieId: movie.id, label: 'x', language: 'fr' } })).json();
  assert.equal((await request(`/api/uploads/${junkUpload.id}`, { cookie, method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: junk })).status, 200);
  assert.equal((await request(`/api/uploads/${junkUpload.id}/complete`, { cookie, method: 'POST', body: {} })).status, 400);
  await request(`/api/uploads/${junkUpload.id}`, { cookie, method: 'DELETE' });
  assert.equal((await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'notes.txt', size: 10, kind: 'subtitle', movieId: movie.id, label: 'x', language: 'fr' } })).status, 400);
  assert.equal((await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'voice.mka', size: 10, kind: 'audio', movieId: movie.id, label: 'x', language: 'fr' } })).status, 400);
  assert.equal((await request(`/api/movies/${movie.id}/prepare`, { cookie, method: 'POST', body: { audio: [1, 2], subtitles: [] } })).status, 202);
  let prepared;
  for (let count = 0; count < 100; count++) {
    prepared = (await (await request('/api/movies', { cookie })).json())[0];
    if (prepared.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(prepared.status, 'ready', prepared.error);
  const workingGeneration = prepared.generation;
  // A failed re-preparation keeps the working generation servable.
  assert.equal((await request(`/api/movies/${movie.id}/prepare`, { cookie, method: 'POST', body: { audio: [99], subtitles: [] } })).status, 202);
  for (let count = 0; count < 100; count++) {
    prepared = (await (await request('/api/movies', { cookie })).json())[0];
    if (prepared.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(prepared.status, 'ready');
  assert.match(prepared.error, /incompatible/);
  assert.equal(prepared.generation, workingGeneration);
  assert.equal((await request(`/media/${movie.id}/master.m3u8`, { cookie })).status, 200);
  // A subtitle file queued on a ready movie waits for the next preparation.
  const lateUpload = await (await request('/api/uploads', { cookie, method: 'POST',
    body: { name: 'late.srt', size: sub.length, kind: 'subtitle', movieId: movie.id, label: 'Late', language: 'en' } })).json();
  assert.equal((await request(`/api/uploads/${lateUpload.id}`, { cookie, method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: sub })).status, 200);
  const withLate = await (await request(`/api/uploads/${lateUpload.id}/complete`, { cookie, method: 'POST', body: {} })).json();
  assert.equal(withLate.status, 'ready');
  assert.equal(withLate.externalTracks.length, 1);
  await request(`/api/movies/${movie.id}/external/${withLate.externalTracks[0].id}`, { cookie, method: 'DELETE' });
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
  assert.deepEqual(await readFile(path.join(instance.store.directory(movie.id), 'source')), bytes);
  assert.equal(prepared.renditions.length, 1);
  assert.equal(prepared.renditions[0].codec, 'h264');
  const hashStream = (input, stream) => run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v', 'error', '-i', input, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  for (const [index, stream] of ['0:v:0', '0:a:0', '0:a:1'].entries()) {
    assert.equal(await hashStream(file, stream), await hashStream(path.join(instance.store.directory(movie.id), prepared.generation, `stream_${index}.m3u8`), '0:0'));
  }
  assert.ok(prepared.audio.every(track => !track.converted));
  const subtitle = await request(`/api/movies/${movie.id}/subtitles?label=English&language=en`, { cookie, method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nA subtitle.\n') });
  assert.equal(subtitle.status, 200);
  const withSubtitles = await subtitle.json();
  const vtt = await (await request(`/media/${movie.id}/${withSubtitles.subtitles[0].filename}`, { cookie })).text();
  assert.match(vtt, /WEBVTT/); assert.match(vtt, /A subtitle\./);
  const smiSub = await request(`/api/movies/${movie.id}/subtitles?label=Korean&language=ko&name=korean.smi`, { cookie, method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: smi });
  assert.equal(smiSub.status, 200);
  const smiTrack = (await smiSub.json()).subtitles.at(-1);
  assert.match(await (await request(`/media/${movie.id}/${smiTrack.filename}`, { cookie })).text(), /안녕하세요/);
  assert.equal((await request(`/api/movies/${movie.id}/subtitles?label=x&name=evil.exe`, { cookie, method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: smi })).status, 400);
  assert.match(await (await request(`/media/${movie.id}/master.m3u8`, { cookie })).text(), /TYPE=SUBTITLES/);
  // Re-preparing without a selection repeats the current one and keeps added subtitles.
  assert.equal((await request(`/api/movies/${movie.id}/prepare`, { cookie, method: 'POST', body: {} })).status, 202);
  for (let count = 0; count < 100; count++) {
    prepared = (await (await request('/api/movies', { cookie })).json())[0];
    if (prepared.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(prepared.status, 'ready', prepared.error);
  assert.notEqual(prepared.generation, workingGeneration);
  assert.equal(prepared.audio.length, 2);
  assert.equal(prepared.subtitles.length, 2);
  assert.ok(prepared.subtitles.every(track => track.external));
  assert.match(await (await request(`/media/${movie.id}/master.m3u8`, { cookie })).text(), /NAME="French"/);
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
  assert.equal((await request('/api/storage', { cookie: guest })).status, 401);
  const connect = cookieValue => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`, { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket); socket.on('error', reject); socket.on('message', data => {
      const message = JSON.parse(data); if (message.type === 'state') resolve({ socket, message });
    });
  });
  const a = await connect(cookie), b = await connect(guest);
  assert.equal(b.message.members.length, 2);
  // Drain the join broadcast before checking a burst of unchanged reports.
  const ping = sentAt => new Promise(resolve => {
    const listener = data => {
      const message = JSON.parse(data);
      if (message.type === 'pong' && message.sentAt === sentAt) { a.socket.off('message', listener); resolve(); }
    };
    a.socket.on('message', listener); a.socket.send(JSON.stringify({ type: 'ping', sentAt }));
  });
  await ping(1);
  let broadcasts = 0;
  const count = data => { if (JSON.parse(data).type === 'state') broadcasts++; };
  a.socket.on('message', count);
  for (let sequence = 0; sequence < 10; sequence++) a.socket.send(JSON.stringify({
    type: 'report', epoch: b.message.state.epoch, sequence, position: 0, bufferedUntil: 0, ready: false,
  }));
  await ping(2); a.socket.off('message', count);
  assert.ok(broadcasts <= 2, `Unchanged reports caused ${broadcasts} broadcasts`);
  // Waiting diagnostics ride only on the admin channel, over ws and REST alike.
  const nextState = socket => new Promise(resolve => {
    const listener = data => {
      const message = JSON.parse(data);
      if (message.type === 'state') { socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
  const aNext = nextState(a.socket), bNext = nextState(b.socket);
  a.socket.send(JSON.stringify({ type: 'report', epoch: b.message.state.epoch, sequence: 10,
    position: 0, bufferedUntil: 0, ready: false, blockers: ['activation'] }));
  const [aState, bState] = await Promise.all([aNext, bNext]);
  assert.ok(aState.members.some(member => member.reason === 'not-ready' && member.blockers?.includes('activation')));
  assert.ok(bState.members.every(member => member.waiting !== undefined && member.reason === undefined && member.blockers === undefined));
  const guestRoom = await (await request(`/api/rooms/${room.id}`, { cookie: guest })).json();
  assert.ok(guestRoom.members.every(member => member.reason === undefined));
  const adminRoom = await (await request(`/api/rooms/${room.id}`, { cookie })).json();
  assert.ok(adminRoom.members.some(member => member.reason));
  assert.equal((await request(`/api/movies/${movie.id}`, { cookie, method: 'DELETE' })).status, 409);
  await request(`/api/rooms/${room.id}`, { cookie, method: 'DELETE' });
  assert.equal((await request(`/media/${movie.id}/master.m3u8`, { cookie: guest })).status, 403);
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { cookie: guest, headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 403);
  assert.equal((await request('/api/join', { method: 'POST', body: { code: room.code } })).status, 404);
});

test('admin tunes buffer thresholds at runtime and they persist', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const boot = async () => {
    const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin,
      syncOptions: { minBuffer: 20, lowBuffer: 5 } });
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
    return { instance, request, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  const first = await boot();
  assert.equal((await first.request('/api/settings')).status, 401);
  assert.deepEqual(await (await first.request('/api/settings', { cookie: first.cookie })).json(), { minBuffer: 20, lowBuffer: 5 });
  assert.equal((await first.request('/api/settings', { cookie: first.cookie, method: 'PATCH', body: { minBuffer: 12, lowBuffer: 4 } })).status, 200);
  assert.equal((await first.request('/api/settings', { cookie: first.cookie, method: 'PATCH', body: { minBuffer: 4, lowBuffer: 12 } })).status, 400);
  assert.deepEqual(await (await first.request('/api/settings', { cookie: first.cookie })).json(), { minBuffer: 12, lowBuffer: 4 });
  await first.instance.close();
  const second = await boot();
  t.after(() => second.instance.close());
  assert.deepEqual(await (await second.request('/api/settings', { cookie: second.cookie })).json(), { minBuffer: 12, lowBuffer: 4 });
});
