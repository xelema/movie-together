import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
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
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
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
  // No env override and no saved file: the registry defaults reach the endpoint.
  const settings = await (await request('/api/settings', { cookie })).json();
  const current = Object.fromEntries(settings.fields.map(field => [field.key, field.value]));
  assert.equal(current.minBuffer, 8);
  assert.equal(current.lowBuffer, 3);
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
  // Les segments sont resservis du cache mémoire 1 h : reprise et re-buffer
  // sans RTT bloquant ; les playlists restent non cachées.
  assert.equal(media.headers.get('cache-control'), 'private, max-age=3600');
  const segment = await request(`/media/${movie.id}/segment_0_000000.m4s`, { cookie });
  assert.equal(segment.headers.get('cache-control'), 'private, max-age=3600');
  const freshPlaylist = await request(`/media/${movie.id}/master.m3u8`, { cookie });
  assert.equal(freshPlaylist.headers.get('cache-control'), 'private, no-store');
  const etag = media.headers.get('etag');
  assert.ok(etag.includes(prepared.generation));
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { cookie, headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 304);
  assert.equal((await request(`/media/${movie.id}/init_0.mp4`, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 401);
  const range = await request(`/media/${movie.id}/init_0.mp4`, { cookie, headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  // Les assets vendor et les polices sont immuables en pratique : cache long.
  for (const asset of ['hls.js', 'plyr.js', 'plyr.css', 'plyr.svg']) {
    const vendor = await request(`/vendor/${asset}`);
    assert.equal(vendor.status, 200);
    assert.equal(vendor.headers.get('cache-control'), 'public, max-age=86400');
  }
  assert.match((await request('/fonts/fonts.css')).headers.get('cache-control'), /^public, max-age=\d+$/);
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
  const vtt = await request(`/media/${movie.id}/${withSubtitles.subtitles[0].filename}`, { cookie });
  // Les fichiers WebVTT se resservent comme les segments : cache 1 h, ETag de
  // génération, 304 sur revalidation.
  assert.equal(vtt.headers.get('cache-control'), 'private, max-age=3600');
  const vttEtag = vtt.headers.get('etag');
  assert.ok(vttEtag.includes(prepared.generation));
  assert.equal((await request(`/media/${movie.id}/${withSubtitles.subtitles[0].filename}`,
    { cookie, headers: { 'If-None-Match': vttEtag, 'Cache-Control': 'max-age=0' } })).status, 304);
  const vttText = await vtt.text();
  assert.match(vttText, /WEBVTT/); assert.match(vttText, /A subtitle\./);
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

test('admin tunes operational settings at runtime and they persist', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  // A ready movie seeded on disk gives the room cap something to hold.
  const movieId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Cap Film', status: 'ready', duration: 60 }));
  const valuesOf = payload => Object.fromEntries(payload.fields.map(field => [field.key, field.value]));
  const boot = async () => {
    const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin,
      env: { MIN_BUFFER_SECONDS: '20', LOW_BUFFER_SECONDS: '5' } });
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
    return { instance, request, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  const first = await boot();
  assert.equal((await first.request('/api/settings')).status, 401);
  const initial = valuesOf(await (await first.request('/api/settings', { cookie: first.cookie })).json());
  assert.equal(initial.minBuffer, 20);
  assert.equal(initial.lowBuffer, 5);
  // Env values are defaults, not overrides: nothing is written until an admin does.
  assert.equal(await readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => null), null);
  const tuned = await first.request('/api/settings', { cookie: first.cookie, method: 'PATCH',
    body: { minBuffer: 12, lowBuffer: 4, maxRooms: 1 } });
  assert.equal(tuned.status, 200);
  // A non-dynamic setting applies to new operations immediately.
  assert.equal((await first.request('/api/rooms', { cookie: first.cookie, method: 'POST', body: { movieId } })).status, 201);
  assert.equal((await first.request('/api/rooms', { cookie: first.cookie, method: 'POST', body: { movieId } })).status, 409);
  // Invalid patches are rejected atomically: nothing above is rolled back.
  for (const bad of [{ minBuffer: 4, lowBuffer: 12 }, { maxRooms: 'x' }, { nope: 1 }, { startDelay: 4 }]) {
    assert.equal((await first.request('/api/settings', { cookie: first.cookie, method: 'PATCH', body: bad })).status, 400, JSON.stringify(bad));
  }
  // Malformed bodies are client errors too: JSON null used to crash with a 500.
  for (const bad of ['null', '[1]', '"x"']) {
    assert.equal((await first.request('/api/settings', { cookie: first.cookie, method: 'PATCH', body: Buffer.from(bad) })).status, 400, bad);
  }
  const after = valuesOf(await (await first.request('/api/settings', { cookie: first.cookie })).json());
  assert.equal(after.minBuffer, 12);
  assert.equal(after.lowBuffer, 4);
  assert.equal(after.maxRooms, 1);
  // Only admin-written keys land in the file.
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')),
    { minBuffer: 12, lowBuffer: 4, maxRooms: 1 });
  await first.instance.close();
  const second = await boot();
  t.after(() => second.instance.close());
  const reloaded = valuesOf(await (await second.request('/api/settings', { cookie: second.cookie })).json());
  assert.equal(reloaded.minBuffer, 12);
  assert.equal(reloaded.maxRooms, 1);
  // Restoring defaults reverts to env values and clears the saved overrides.
  const reset = await second.request('/api/settings/reset', { cookie: second.cookie, method: 'POST', body: {} });
  assert.equal(reset.status, 200);
  const restored = valuesOf(await reset.json());
  assert.equal(restored.minBuffer, 20);
  assert.equal(restored.maxRooms, 20);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')), {});
});

test('a tickMs patch does not retime live rooms: welcome keeps the startup cadence', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const movieId = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Cadence Film', status: 'ready', duration: 60 }));
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const room = await (await request('/api/rooms', { cookie, method: 'POST', body: { movieId } })).json();
  const join = async () => (await request('/api/join', { method: 'POST', body: { code: room.code } }))
    .headers.get('set-cookie').split(';')[0];
  const welcome = cookieValue => new Promise(resolve => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`,
      { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket);
    socket.on('message', data => { const message = JSON.parse(data); if (message.type === 'welcome') resolve(message); });
  });
  assert.equal((await welcome(await join())).sync.tickMs, 200);
  // tickMs applies at restart: a patch must not change the cadence a client is told.
  assert.equal((await request('/api/settings', { cookie, method: 'PATCH', body: { tickMs: 2000 } })).status, 200);
  assert.equal((await welcome(await join())).sync.tickMs, 200);
});

test('a pending upload reports the chunk size captured at creation', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const upload = await (await request('/api/uploads', { cookie, method: 'POST', body: { name: 'film.mkv', size: 1024 } })).json();
  assert.equal(upload.chunkSize, 8 * 1024 ** 2);
  assert.equal((await request('/api/settings', { cookie, method: 'PATCH', body: { chunkMb: 4 } })).status, 200);
  assert.equal((await (await request(`/api/uploads/${upload.id}`, { cookie })).json()).chunkSize, 8 * 1024 ** 2);
  assert.equal((await (await request('/api/uploads', { cookie })).json())[0].chunkSize, 8 * 1024 ** 2);
});

test('a rejected upload creation does not count against the pending upload cap', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const create = body => request('/api/uploads', { cookie, method: 'POST', body });
  for (let count = 0; count < 3; count++)
    assert.equal((await create({ name: 'film.mkv', size: 1024, fingerprint: 'not-hex' })).status, 400);
  // Without cleanup at creation, each rejection above would have left a directory
  // counted by the cap and this valid upload would now be refused.
  assert.equal((await create({ name: 'film.mkv', size: 1024 })).status, 201);
  const pending = await (await request('/api/uploads', { cookie })).json();
  assert.deepEqual(await readdir(path.join(dataDir, 'uploads')), [pending[0].id]);
});

test('room capacity counts distinct sessions and a session holds at most two sockets', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  // A ready movie seeded on disk avoids a real ffmpeg preparation.
  const movieId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Cap Film', status: 'ready', duration: 120 }));
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const room = await (await request('/api/rooms', { cookie, method: 'POST', body: { movieId, code: 'cap-room' } })).json();
  const join = async () => (await request('/api/join', { method: 'POST', body: { code: room.code } }))
    .headers.get('set-cookie').split(';')[0];
  // A refused upgrade surfaces as unexpected-response, an accepted one sends welcome.
  const open = cookieValue => new Promise(resolve => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`,
      { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket);
    socket.on('unexpected-response', () => resolve(null));
    socket.on('error', () => resolve(null));
    socket.on('message', data => { if (JSON.parse(data).type === 'welcome') resolve(socket); });
  });
  const guestA = await join();
  const first = await open(guestA);
  assert.ok(first);
  assert.ok(await open(guestA));
  assert.equal(await open(guestA), null);
  first.close(); await new Promise(resolve => first.on('close', resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await open(guestA));
  const guestB = await join();
  assert.ok(await open(guestB));
  // Sessions in the room: A (two sockets) + B = 2 of 8. Six more fill it.
  for (let count = 0; count < 6; count++) assert.ok(await open(await join()), `guest ${count}`);
  assert.equal(await open(await join()), null);
});

test('webcam room limits capacity to 2 participants and refuses a 3rd participant', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const movieId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Webcam Cap Film', status: 'ready', duration: 120 }));
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const room = await (await request('/api/rooms', { cookie, method: 'POST', body: { movieId, code: 'webcam-room', webcam: true } })).json();

  const join = async () => request('/api/join', { method: 'POST', body: { code: room.code } });
  const open = cookieValue => new Promise(resolve => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room.id}`,
      { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket);
    socket.on('unexpected-response', () => resolve(null));
    socket.on('error', () => resolve(null));
    socket.on('message', data => { if (JSON.parse(data).type === 'welcome') resolve(socket); });
  });

  const resA = await join();
  assert.equal(resA.status, 200);
  const cookieA = resA.headers.get('set-cookie').split(';')[0];
  const wsA = await open(cookieA);
  assert.ok(wsA);

  const resB = await join();
  assert.equal(resB.status, 200);
  const cookieB = resB.headers.get('set-cookie').split(';')[0];
  const wsB = await open(cookieB);
  assert.ok(wsB);

  // 3rd participant is rejected at HTTP join level
  const resC = await join();
  assert.equal(resC.status, 409);
  const errC = await resC.json();
  assert.equal(errC.error, 'Séance complète (2 personnes maximum avec caméra).');
});

test('joining a room with a malformed code is a client error, not a crash', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const join = body => fetch(base + '/api/join', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const code of [123, { code: 'abc' }, ['abc'], true, null])
    assert.equal((await join({ code })).status, 404, String(code));
});

test('voice translation is an opt-in capability published in room state', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const movieId = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Voice Film', status: 'ready', duration: 90 }));
  const instances = [], sockets = [];
  const boot = async () => {
    const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
    instances.push(instance);
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
    return { base, request, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    for (const instance of instances) await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = await boot();
  const voiced = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'voix-room', voice: true } })).json();
  const plain = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'plain-room' } })).json();
  assert.deepEqual((await (await first.request(`/api/rooms/${voiced.id}`, { cookie: first.cookie })).json()).voice,
    { enabled: true, pair: ['fr', 'ko'], available: false });
  const plainState = await (await first.request(`/api/rooms/${plain.id}`, { cookie: first.cookie })).json();
  assert.equal('voice' in plainState, false);
  // The capability rides the websocket welcome and the first state frame alike,
  // for a guest session as for the host.
  const frames = room => {
    const guest = first.request('/api/join', { method: 'POST', body: { code: room.code } })
      .then(response => response.headers.get('set-cookie').split(';')[0]);
    return guest.then(cookie => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${first.base.replace('http', 'ws')}/ws?room=${room.id}`,
        { headers: { Cookie: cookie, Origin: origin } });
      sockets.push(socket);
      const seen = [];
      socket.on('error', reject);
      socket.on('message', data => {
        seen.push(JSON.parse(data));
        if (seen.some(message => message.type === 'state')) resolve(seen);
      });
    }));
  };
  const voicedFrames = await frames(voiced);
  assert.equal(voicedFrames.find(message => message.type === 'welcome')?.voice?.enabled, true);
  assert.deepEqual(voicedFrames.find(message => message.type === 'state')?.voice,
    { enabled: true, pair: ['fr', 'ko'], available: false });
  // An ordinary room publishes no voice key at all.
  const plainFrames = await frames(plain);
  assert.equal('voice' in (plainFrames.find(message => message.type === 'welcome') ?? {}), false);
  assert.equal('voice' in (plainFrames.find(message => message.type === 'state') ?? {}), false);
  // A probe room keeps its capability across a restart.
  await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'probe-voix', probe: true, voice: true } });
  const second = await boot();
  const rooms = await (await second.request('/api/rooms', { cookie: second.cookie })).json();
  const revived = rooms.find(room => room.code === 'probe-voix');
  assert.ok(revived);
  assert.equal((await (await second.request(`/api/rooms/${revived.id}`, { cookie: second.cookie })).json()).voice?.enabled, true);
});

test('webcam is an opt-in capability and its signaling relays between two participants', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'movie-night-test-'));
  const origin = 'http://localhost:3000';
  const movieId = 'eeeeeeee-aaaa-bbbb-cccc-dddddddddddd';
  await mkdir(path.join(dataDir, 'movies', movieId), { recursive: true });
  await writeFile(path.join(dataDir, 'movies', movieId, 'movie.json'),
    JSON.stringify({ id: movieId, title: 'Cam Film', status: 'ready', duration: 90 }));
  const instances = [], sockets = [];
  const boot = async () => {
    const instance = createApplication({ dataDir, password: 'test-password-long-enough', origin, env: {} });
    instances.push(instance);
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    const request = (url, { cookie, method = 'GET', body } = {}) => fetch(base + url, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const login = await request('/api/login', { method: 'POST', body: { password: 'test-password-long-enough' } });
    return { base, request, cookie: login.headers.get('set-cookie').split(';')[0] };
  };
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    for (const instance of instances) await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const first = await boot();
  const cam = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'cam-room', webcam: true } })).json();
  const plain = await (await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'plain-room' } })).json();
  assert.deepEqual((await (await first.request(`/api/rooms/${cam.id}`, { cookie: first.cookie })).json()).webcam,
    { enabled: true });
  assert.equal('webcam' in await (await first.request(`/api/rooms/${plain.id}`, { cookie: first.cookie })).json(), false);
  const join = code => first.request('/api/join', { method: 'POST', body: { code } })
    .then(response => response.headers.get('set-cookie').split(';')[0]);
  // Each socket collects every frame; the welcome exposes its member id.
  const connect = async (room, cookieValue) => {
    const socket = new WebSocket(`${first.base.replace('http', 'ws')}/ws?room=${room.id}`,
      { headers: { Cookie: cookieValue, Origin: origin } });
    sockets.push(socket);
    const frames = [];
    socket.on('message', data => frames.push(JSON.parse(data)));
    const self = await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', data => { const m = JSON.parse(data); if (m.type === 'welcome') resolve(m); });
    });
    return { socket, frames, id: self.id };
  };
  const until = (frames, predicate, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = frames.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > ms) return reject(new Error('message never arrived'));
      setTimeout(poll, 20);
    };
    poll();
  });
  const cookieA = await join('cam-room');
  const a = await connect(cam, cookieA);
  const b = await connect(cam, await join('cam-room'));
  assert.equal(a.frames[0].webcam?.enabled, true);
  assert.equal(a.frames.find(m => m.type === 'state')?.webcam?.enabled, true);
  // The late joiner is announced to the already-connected peer.
  const joined = await until(a.frames, m => m.type === 'webcam' && m.action === 'peer-joined');
  assert.equal(joined.from, b.id);
  // A signal reaches the peer stamped with the sender's server-side identity.
  a.socket.send(JSON.stringify({ type: 'webcam', action: 'signal', signal: { description: { type: 'offer', sdp: 'v=0' } } }));
  const signal = await until(b.frames, m => m.type === 'webcam' && m.action === 'signal');
  assert.equal(signal.from, a.id);
  assert.equal(signal.signal.description.type, 'offer');
  assert.equal(a.frames.some(m => m.type === 'webcam' && m.action === 'signal'), false);
  // `to` narrows the relay to the named member.
  a.socket.send(JSON.stringify({ type: 'webcam', action: 'signal', to: b.id, signal: { candidate: { candidate: 'x' } } }));
  const targeted = await until(b.frames, m => m.type === 'webcam' && m.action === 'signal' && m.signal.candidate);
  assert.equal(targeted.from, a.id);
  // Status broadcasts carry a boolean, nothing else.
  a.socket.send(JSON.stringify({ type: 'webcam', action: 'status', active: 1 }));
  const status = await until(b.frames, m => m.type === 'webcam' && m.action === 'status');
  assert.equal(status.active, true);
  // A second socket on the same session joining late learns at once that the
  // peer's camera is live, and the peer is told to renegotiate.
  const late = await connect(cam, cookieA);
  const replay = await until(late.frames, m => m.type === 'webcam' && m.action === 'status' && m.from === a.id);
  assert.equal(replay.active, true);
  assert.ok(await until(a.frames, m => m.type === 'webcam' && m.action === 'peer-joined' && m.from === late.id));
  late.socket.close();
  // A malformed signal is refused to the sender and never relayed. Anything
  // larger than the websocket frame cap is already killed by the transport.
  a.socket.send(JSON.stringify({ type: 'webcam', action: 'signal', signal: 'nope' }));
  await until(a.frames, m => m.type === 'error');
  assert.equal(b.frames.filter(m => m.type === 'webcam' && m.action === 'signal').length, 2);
  // A disconnect tells the remaining peer to hang up.
  a.socket.close();
  const left = await until(b.frames, m => m.type === 'webcam' && m.action === 'peer-left' && m.from === a.id);
  assert.equal(left.from, a.id);
  // A room without the capability drops webcam traffic silently.
  const c = await connect(plain, await join('plain-room'));
  const d = await connect(plain, await join('plain-room'));
  c.socket.send(JSON.stringify({ type: 'webcam', action: 'status', active: true }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(d.frames.some(m => m.type === 'webcam'), false);
  // A probe room keeps the capability across a restart.
  await first.request('/api/rooms', { cookie: first.cookie, method: 'POST',
    body: { movieId, code: 'probe-cam', probe: true, webcam: true } });
  const second = await boot();
  const rooms = await (await second.request('/api/rooms', { cookie: second.cookie })).json();
  const revived = rooms.find(room => room.code === 'probe-cam');
  assert.ok(revived);
  assert.equal((await (await second.request(`/api/rooms/${revived.id}`, { cookie: second.cookie })).json()).webcam?.enabled, true);
});
