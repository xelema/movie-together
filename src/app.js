import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, statfs, rename, unlink, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './storage.js';
import { probeFile, prepareMovie, addSubtitle, writeMaster, decodeSubtitleText, subtitleFileFormat, SUBTITLE_EXTENSIONS } from './media.js';
import { Room } from './sync/room.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[a-f0-9-]{36}$/;
const TTL = 12 * 3600_000;
const CHUNK = 8 * 1024 * 1024;
const TICK_MS = 200;
const fail = (status, message) => Object.assign(new Error(message), { status });
const SUBTITLE_EXT = new RegExp(`\\.(${Object.keys(SUBTITLE_EXTENSIONS).join('|')})$`, 'i');
const SUBTITLE_EXT_MESSAGE = 'Choisir un fichier de sous-titres de moins de 2 Mo (SRT, VTT, SMI, ASS, SUB…).';
// Release names carry encoding jargon that has no place in the interface.
const FORMAT_TAG = /^(2160p|1440p|1080[pi]|720p|576p|480p|4k|4klight|uhd|hdr10?(\+|plus)?|hlg|dovi|10bits?|8bits?|bluray|blu|brrip|bdrip|bdremux|remux|webrip|webdl|web|hdtv|dvdrip|dvdscr|x26[45]|h26[45]|hevc|avc|av1|vp9|xvid|divx|aac\d?|ac3|eac3|ddp?\d?|dts|dtshd|truehd|atmos|flac|opus|mp3)$/i;
const EDITION_TAG = /^(multi\d?|vf[fqi2]?|vo|vost|vostfr|subfrench|french|truefrench|english|repack|proper|extended|unrated|uncut|imax|limited|integrale|amzn|nf|dsnp|hmax|atvp|itunes|dv|sdr)$/i;
const tag = word => word.replace(/^[[(<]+/, '').replace(/[\])>]+$/, '').split('-')[0];
export function cleanTitle(filename) {
  const words = filename.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').split(/\s+/).filter(Boolean);
  const cut = words.findIndex(word => FORMAT_TAG.test(tag(word)));
  const kept = cut > 0 ? words.slice(0, cut) : [...words];
  while (kept.length > 1 && EDITION_TAG.test(tag(kept.at(-1)))) kept.pop();
  return kept.join(' ').replace(/[\s\-–—[({]+$/, '').trim().slice(0, 150) || filename.slice(0, 150);
}
const trackNames = source => Object.fromEntries(Object.entries(source ?? {})
  .filter(([index]) => /^\d{1,3}$/.test(index))
  .map(([index, value]) => [index, String(value ?? '').trim().slice(0, 60)])
  .filter(([, value]) => value).slice(0, 48));
// Re-preparing a ready movie repeats its current selection. Prepared tracks keep
// their source index; subtitles prepared before they did are matched back by
// language, unambiguous only.
const previousSubtitles = movie => {
  const pool = (movie.probe?.subtitles ?? []).filter(track => track.compatible);
  return (movie.subtitles ?? []).filter(track => !track.external).map(track => {
    if (track.index !== undefined) return track.index;
    const matches = pool.filter(item => item.language === track.language);
    if (matches.length !== 1) throw fail(400, 'Sélection invalide.');
    pool.splice(pool.indexOf(matches[0]), 1);
    return matches[0].index;
  });
};
const publicMovie = movie => ({ id: movie.id, title: movie.title, status: movie.status,
  duration: movie.duration, audio: movie.audio, subtitles: movie.subtitles,
  maxSegmentSeconds: movie.maxSegmentSeconds, bitrate: movie.probe?.bitrate, renditions: movie.renditions, generation: movie.generation });

export function createApplication({ dataDir = path.join(ROOT, 'data'), password,
  origin = 'http://localhost:3000', secure = false, trustProxy = false, syncOptions = {} } = {}) {
  if (!password || password.length < 16) throw new Error('ADMIN_PASSWORD doit contenir au moins 16 caractères.');
  if (secure && !origin.startsWith('https://')) throw new Error('APP_ORIGIN doit utiliser HTTPS en production.');
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const store = createStore(dataDir);
  const sessions = new Map(), rooms = new Map(), locks = new Set(), mediaLocks = new Set();
  const salt = randomBytes(32), hash = scryptSync(password, salt, 64);
  let processing = false;
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    mediaSrc: ["'self'", 'blob:'], workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'"], upgradeInsecureRequests: secure ? [] : null,
  } }, strictTransportSecurity: secure ? undefined : false }));
  const sessionFor = request => {
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('sid='))?.slice(4);
    const session = sessions.get(token);
    return session?.expires > Date.now() ? session : null;
  };
  app.use((req, res, next) => {
    req.session = sessionFor(req);
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) {
      return res.status(403).json({ error: 'Origine refusée.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const admin = (req, res, next) => req.session?.admin ? next() : next(fail(401, 'Connexion administrateur requise.'));
  const authenticated = (req, res, next) => req.session ? next() : next(fail(401, 'Rejoindre une room ou se connecter.'));
  const access = (req, room) => room && (req.session?.admin || req.session?.rooms.has(room.id));
  const getMovie = id => {
    const movie = store.movies.get(id);
    if (!movie) throw fail(404, 'Film introuvable.');
    return movie;
  };
  const idleMovie = id => {
    const movie = getMovie(id);
    if (mediaLocks.has(id)) throw fail(409, 'Modification du film en cours.');
    if (['processing', 'probing'].includes(movie.status)) throw fail(409, 'Traitement en cours.');
    if ([...rooms.values()].some(room => room.movieId === id && room.engine.members.size)) throw fail(409, 'Film utilisé dans une room.');
    return movie;
  };
  const cookie = (res, session) => {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, session);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure, maxAge: TTL, path: '/' });
  };
  const roomState = room => ({ type: 'state', roomId: room.id, code: room.code,
    state: room.engine.snapshot(), movie: room.movieId ? publicMovie(getMovie(room.movieId)) : null,
    members: [...room.engine.members.keys()].map(id => ({ id,
      name: [...room.clients].find(client => client.memberId === id)?.displayName ?? 'Invité / 게스트',
      ...room.engine.memberStatus(id) })),
  });
  const broadcast = room => {
    const payload = JSON.stringify(roomState(room));
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > 65536) client.terminate();
        else client.send(payload);
      }
    }
  };
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  const inviteLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ authenticated: !!req.session, admin: !!req.session?.admin }));
  app.post('/api/login', loginLimiter, (req, res) => {
    if (typeof req.body.password !== 'string' || req.body.password.length > 512 ||
      !timingSafeEqual(hash, scryptSync(req.body.password, salt, 64))) throw fail(401, 'Mot de passe incorrect.');
    cookie(res, { admin: true, rooms: new Set(), expires: Date.now() + TTL });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    for (const [token, session] of sessions) if (session === req.session) sessions.delete(token);
    res.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'strict', secure }); res.json({ ok: true });
  });
  app.get('/api/movies', authenticated, (req, res) => res.json([...store.movies.values()]
    .filter(movie => req.session.admin || [...req.session.rooms].some(id => rooms.get(id)?.movieId === movie.id)).map(movie => req.session.admin ? movie : publicMovie(movie))));
  app.get('/api/storage', admin, async (req, res) => {
    const disk = await statfs(store.root);
    res.json({ free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize });
  });
  app.post('/api/rooms', admin, (req, res) => {
    if (rooms.size >= 20) throw fail(409, 'Fermer une room avant d’en créer une autre.');
    const movie = getMovie(req.body.movieId);
    if (movie.status !== 'ready' || mediaLocks.has(movie.id)) throw fail(409, 'Film non préparé.');
    if (req.body.code !== undefined && (typeof req.body.code !== 'string' || !/^[a-z0-9-]{4,32}$/i.test(req.body.code.trim()))) throw fail(400, 'Code : 4 à 32 lettres, chiffres ou tirets.');
    const id = randomUUID(), code = req.body.code?.trim().toLowerCase() || randomBytes(8).toString('hex');
    if ([...rooms.values()].some(room => room.code === code && room.expires > Date.now())) throw fail(409, 'Ce code est déjà utilisé.');
    const room = { id, code, expires: Date.now() + TTL, movieId: movie.id, engine: new Room(syncOptions), clients: new Set() };
    room.engine.load(movie.duration); rooms.set(id, room);
    res.status(201).json({ id, code, link: `${origin}/#invite=${code}` });
  });
  app.get('/api/rooms', admin, (req, res) => res.json([...rooms.values()].map(room => ({
    id: room.id, code: room.code, movieId: room.movieId, expires: room.expires, participants: room.clients.size,
    link: `${origin}/#invite=${room.code}`,
  }))));
  app.post('/api/join', inviteLimiter, (req, res) => {
    const room = [...rooms.values()].find(item => item.code === req.body.code?.trim().toLowerCase() && item.expires > Date.now());
    if (!room) throw fail(404, 'Code invalide ou expiré.');
    const session = req.session ?? { admin: false, rooms: new Set(), expires: Date.now() + TTL };
    session.rooms.add(room.id);
    if (!req.session) cookie(res, session);
    res.json({ id: room.id });
  });
  app.get('/api/rooms/:id', authenticated, (req, res) => {
    const room = rooms.get(req.params.id);
    if (!access(req, room)) throw fail(404, 'Room introuvable.');
    res.json(roomState(room));
  });
  app.delete('/api/rooms/:id', admin, (req, res) => {
    const room = rooms.get(req.params.id);
    if (room) { for (const client of room.clients) client.close(1000, 'Room fermée'); rooms.delete(room.id); }
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/movie', admin, (req, res) => {
    const room = rooms.get(req.params.id);
    if (!access(req, room)) throw fail(404, 'Room introuvable.');
    const movie = getMovie(req.body.movieId);
    if (movie.status !== 'ready' || mediaLocks.has(movie.id)) throw fail(409, 'Film non préparé.');
    room.movieId = movie.id; room.engine.load(movie.duration); broadcast(room); res.json({ ok: true });
  });
  const uploadPath = id => {
    if (!ID.test(id)) throw fail(404, 'Upload introuvable.');
    return path.join(store.root, 'uploads', id);
  };
  const uploadInfo = async id => {
    try { return JSON.parse(await readFile(path.join(uploadPath(id), 'upload.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw fail(404, 'Upload introuvable.'); throw error; }
  };
  app.post('/api/uploads', admin, async (req, res) => {
    const { size, name, fingerprint } = req.body;
    const { kind = 'movie', movieId, label = name, language = 'und' } = req.body;
    if (!['movie', 'subtitle'].includes(kind)) throw fail(400, 'Fichier invalide.');
    if (kind !== 'movie') {
      const movie = idleMovie(movieId);
      if ((movie.externalTracks?.length ?? 0) >= 24) throw fail(400, 'Trop de fichiers ajoutés.');
      if (typeof label !== 'string' || !label.trim() || label.length > 100 || !/^[a-z]{2,3}$/.test(language)) throw fail(400, 'Nom ou langue invalide.');
      if (!SUBTITLE_EXT.test(name) || size > 2 * 1024 ** 2) throw fail(400, SUBTITLE_EXT_MESSAGE);
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > 20 * 1024 ** 3 || typeof name !== 'string' || name.length > 250) throw fail(400, 'Fichier invalide (maximum 20 Go).');
    if ((await readdir(path.join(store.root, 'uploads'))).length >= 2) throw fail(409, 'Terminer ou supprimer les uploads précédents.');
    const disk = await statfs(store.root);
    if (disk.bavail * disk.bsize < size * 2.2) throw fail(409, 'Espace disque insuffisant pour l’original et sa préparation.');
    const id = randomUUID(); await mkdir(uploadPath(id));
    if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) throw fail(400, 'Empreinte invalide.');
    const info = { id, name, size, fingerprint, kind, movieId, label, language, createdAt: Date.now() };
    await writeFile(path.join(uploadPath(id), 'upload.json'), JSON.stringify(info));
    await writeFile(path.join(uploadPath(id), 'source'), '');
    res.status(201).json({ ...info, offset: 0, chunkSize: CHUNK });
  });
  app.get('/api/uploads', admin, async (req, res) => {
    const result = [];
    for (const id of await readdir(path.join(store.root, 'uploads'))) {
      try { result.push({ ...await uploadInfo(id), offset: (await stat(path.join(uploadPath(id), 'source'))).size, chunkSize: CHUNK }); }
      catch { /* An upload may have just been finalized. */ }
    }
    res.json(result);
  });
  app.get('/api/uploads/:id', admin, async (req, res) => res.json({ ...await uploadInfo(req.params.id),
    offset: (await stat(path.join(uploadPath(req.params.id), 'source'))).size, chunkSize: CHUNK }));
  app.put('/api/uploads/:id', admin, express.raw({ type: 'application/octet-stream', limit: CHUNK }), async (req, res) => {
    const id = req.params.id;
    if (locks.has(id)) throw fail(409, 'Upload occupé.');
    locks.add(id);
    try {
      const info = await uploadInfo(id), file = path.join(uploadPath(id), 'source');
      const offset = (await stat(file)).size;
      if (!Buffer.isBuffer(req.body) || !req.body.length || offset + req.body.length > info.size) throw fail(400, 'Bloc invalide.');
      if (Number(req.headers['upload-offset']) !== offset) return res.status(409).json({ error: 'Reprendre à la position courante.', offset });
      await writeFile(file, req.body, { flag: 'a' });
      res.json({ offset: offset + req.body.length });
    } finally { locks.delete(id); }
  });
  app.delete('/api/uploads/:id', admin, async (req, res) => {
    if (locks.has(req.params.id)) throw fail(409, 'Upload occupé.');
    locks.add(req.params.id);
    try { await rm(uploadPath(req.params.id), { recursive: true, force: true }); res.json({ ok: true }); }
    finally { locks.delete(req.params.id); }
  });
  app.post('/api/uploads/:id/complete', admin, async (req, res) => {
    const id = req.params.id;
    if (processing || locks.has(id)) throw fail(409, 'Un import est déjà en cours.');
    processing = true; locks.add(id);
    try {
      const info = await uploadInfo(id), source = path.join(uploadPath(id), 'source');
      if ((await stat(source)).size !== info.size) throw fail(409, 'Upload incomplet.');
      if (info.kind && info.kind !== 'movie') {
        const movie = idleMovie(info.movieId);
        // Stored files carry no extension and may use a legacy charset: normalize to UTF-8 first.
        await writeFile(source, decodeSubtitleText(await readFile(source)));
        const formats = SUBTITLE_EXTENSIONS[path.extname(info.name).slice(1).toLowerCase()] ?? [];
        const found = await subtitleFileFormat(source, formats);
        if (!found) throw fail(400, 'Ce fichier ne contient aucune piste utilisable.');
        const filename = `external_${id}`;
        await rename(source, path.join(store.directory(movie.id), filename));
        movie.externalTracks ??= [];
        movie.externalTracks.push({ id, kind: info.kind, filename, label: info.label, language: info.language,
          format: found.format ?? undefined, index: found.format ? 0 : 's:0' });
        // A file queued for the next preparation must not unserve a working one.
        if (movie.status !== 'ready') movie.status = 'uploaded';
        store.save(movie); await rm(uploadPath(id), { recursive: true, force: true });
        res.json(movie); return;
      }
      const movie = { id, title: cleanTitle(info.name), status: 'probing', originalBytes: info.size };
      store.save(movie);
      await rename(source, path.join(store.directory(id), 'source'));
      await rm(uploadPath(id), { recursive: true, force: true });
      try {
        movie.probe = await probeFile(path.join(store.directory(id), 'source'));
        movie.status = movie.probe.compatible ? 'uploaded' : 'incompatible';
      } catch (error) { movie.status = 'failed'; movie.error = error.message; }
      store.save(movie); res.json(movie);
    } finally { processing = false; locks.delete(id); }
  });
  app.post('/api/movies/:id/probe', admin, async (req, res) => {
    const movie = idleMovie(req.params.id);
    if (processing || movie.status === 'ready') throw fail(409, 'Analyse indisponible.');
    processing = true; movie.status = 'probing'; movie.error = null; store.save(movie);
    res.status(202).json({ ok: true });
    try {
      movie.probe = await probeFile(path.join(store.directory(movie.id), 'source'));
      movie.status = movie.probe.compatible ? 'uploaded' : 'incompatible';
    } catch (error) { movie.status = 'failed'; movie.error = error.message; }
    finally { store.save(movie); processing = false; }
  });
  app.post('/api/movies/:id/prepare', admin, async (req, res) => {
    const movie = idleMovie(req.params.id);
    if (processing) throw fail(409, 'Un import est déjà en cours.');
    if (req.body.names !== undefined) {
      if (typeof req.body.names !== 'object' || req.body.names === null) throw fail(400, 'Noms de pistes invalides.');
      movie.trackNames = { audio: trackNames(req.body.names.audio), subtitles: trackNames(req.body.names.subtitles) };
    }
    processing = true; movie.status = 'processing'; movie.error = null; store.save(movie);
    res.status(202).json({ ok: true });
    try {
      movie.progress = { stage: 'analysis', percent: 0 }; store.save(movie);
      let lastProgress = 0;
      const audio = req.body.audio ?? (movie.audio ?? []).map(track => track.index);
      const subtitles = req.body.subtitles ?? previousSubtitles(movie);
      Object.assign(movie, await prepareMovie(store, movie, audio, subtitles, {
        onProgress(progress) {
          movie.progress = progress;
          if (Date.now() - lastProgress > 1000) { store.save(movie); lastProgress = Date.now(); }
        },
      }));
      movie.status = 'ready';
      // No active viewer can reference previous generations while a movie is prepared.
      for (const entry of await readdir(store.directory(movie.id), { withFileTypes: true })) {
        if (entry.isDirectory() && ID.test(entry.name) && entry.name !== movie.generation) {
          await rm(path.join(store.directory(movie.id), entry.name), { recursive: true, force: true });
        }
      }
    } catch (error) {
      // A failed run never replaces a working one: a previous generation keeps playing.
      const servable = movie.generation && await stat(path.join(store.directory(movie.id), movie.generation)).then(() => true, () => false);
      movie.status = servable ? 'ready' : 'failed'; movie.error = error.message;
    }
    finally { delete movie.progress; store.save(movie); processing = false; }
  });
  app.patch('/api/movies/:id', admin, (req, res) => {
    const movie = idleMovie(req.params.id);
    if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.length > 150) throw fail(400, 'Titre invalide.');
    movie.title = req.body.title.trim(); store.save(movie); res.json(movie);
  });
  app.delete('/api/movies/:id', admin, async (req, res) => {
    const movie = idleMovie(req.params.id);
    for (const room of rooms.values()) if (room.movieId === movie.id) throw fail(409, 'Fermer les rooms de ce film avant suppression.');
    mediaLocks.add(movie.id);
    try { await rm(store.directory(movie.id), { recursive: true, force: true }); store.movies.delete(movie.id); res.json({ ok: true }); }
    finally { mediaLocks.delete(movie.id); }
  });
  app.post('/api/movies/:id/subtitles', admin, express.raw({ type: 'text/plain', limit: 2 * 1024 ** 2 }), async (req, res) => {
    const movie = idleMovie(req.params.id);
    if (processing || movie.status !== 'ready') throw fail(409, 'Film indisponible.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Sous-titre vide.');
    if (req.query.name !== undefined && (typeof req.query.name !== 'string' || !SUBTITLE_EXT.test(req.query.name))) throw fail(400, SUBTITLE_EXT_MESSAGE);
    processing = true; mediaLocks.add(movie.id);
    const directory = path.join(store.directory(movie.id), movie.generation);
    const input = path.join(directory, 'subtitle-input');
    try {
      await writeFile(input, decodeSubtitleText(req.body));
      const formats = req.query.name ? SUBTITLE_EXTENSIONS[path.extname(req.query.name).slice(1).toLowerCase()] ?? [] : [];
      let track;
      for (const format of [...formats, undefined]) {
        try {
          track = await addSubtitle(directory, input, { label: req.query.label || 'Subtitles',
            language: req.query.language || 'und', duration: movie.duration, format });
          break;
        } catch { }
      }
      if (!track) throw fail(400, 'Ce fichier ne contient aucune piste utilisable.');
      track.external = true;
      movie.subtitles.push(track); await writeMaster(directory, movie.audio, movie.subtitles, movie.renditions); store.save(movie);
      res.json(movie);
    } finally { await unlink(input).catch(() => {}); processing = false; mediaLocks.delete(movie.id); }
  });
  app.delete('/api/movies/:id/subtitles/:track', admin, async (req, res) => {
    const movie = idleMovie(req.params.id);
    if (processing) throw fail(409, 'Un import est déjà en cours.');
    const track = movie.subtitles?.find(item => item.id === req.params.track);
    if (!track) throw fail(404, 'Piste introuvable.');
    mediaLocks.add(movie.id);
    try {
      const subtitles = movie.subtitles.filter(item => item !== track);
      const directory = path.join(store.directory(movie.id), movie.generation);
      await writeMaster(directory, movie.audio, subtitles, movie.renditions);
      movie.subtitles = subtitles; store.save(movie);
      await unlink(path.join(directory, track.filename)); await unlink(path.join(directory, `sub_${track.id}.m3u8`));
      for (const rendition of movie.renditions ?? []) {
        for (const ext of ['vtt', 'm3u8']) await rm(path.join(directory, `sub_${track.id}_${rendition.id}.${ext}`), { force: true });
      }
      res.json(movie);
    } finally { mediaLocks.delete(movie.id); }
  });
  app.delete('/api/movies/:id/external/:track', admin, async (req, res) => {
    const movie = idleMovie(req.params.id);
    if (processing) throw fail(409, 'Un import est déjà en cours.');
    const track = movie.externalTracks?.find(item => item.id === req.params.track);
    if (!track) throw fail(404, 'Piste introuvable.');
    mediaLocks.add(movie.id);
    try {
      movie.externalTracks = movie.externalTracks.filter(item => item !== track);
      await unlink(path.join(store.directory(movie.id), track.filename)).catch(() => {});
      store.save(movie); res.json(movie);
    } finally { mediaLocks.delete(movie.id); }
  });
  app.get('/media/:id/:file', authenticated, (req, res, next) => {
    const movie = getMovie(req.params.id);
    if (!req.session.admin && ![...req.session.rooms].some(id => rooms.get(id)?.movieId === movie.id)) throw fail(403, 'Accès au film refusé.');
    if (movie.status !== 'ready' || !/^(master(?:_original|_compatible)?|stream_\d+|sub_[a-f0-9-]+(?:_original|_compatible)?)\.m3u8$|^(init_\d+\.mp4|segment_\d+_\d+\.m4s|sub_[a-f0-9-]+(?:_original|_compatible)?\.vtt)$/.test(req.params.file)) throw fail(404, 'Média introuvable.');
    res.set('Cache-Control', 'private, no-store');
    const ext = path.extname(req.params.file);
    if (ext === '.m4s' || ext === '.mp4') {
      // Revalidate access before reusing private bytes; generations change on preparation.
      res.set('Cache-Control', 'private, no-cache');
      res.set('ETag', `"${movie.generation}-${req.params.file}"`);
    }
    res.type(({ '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4', '.vtt': 'text/vtt', '.mp4': 'video/mp4' })[ext]);
    res.sendFile(req.params.file, { root: path.join(store.directory(movie.id), movie.generation) }, error => { if (error) next(error); });
  });
  app.get('/vendor/hls.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
  app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));
  for (const file of ['plyr.js', 'plyr.css', 'plyr.svg']) app.get(`/vendor/${file}`, (req, res) =>
    res.sendFile(path.join(ROOT, 'node_modules/plyr/dist', file)));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use((req, res) => res.status(404).json({ error: 'Page introuvable.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!error.status || error.status >= 500) console.error(error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur serveur. Consulter les journaux.' });
  });

  server.on('upgrade', (request, socket, head) => {
    const session = sessionFor(request);
    const url = new URL(request.url, origin), room = rooms.get(url.searchParams.get('room'));
    if (url.pathname !== '/ws' || request.headers.origin !== origin || !session ||
      !access({ session }, room) || room.expires <= Date.now() || room.clients.size >= 8 ||
      store.movies.get(room.movieId)?.status !== 'ready' || mediaLocks.has(room.movieId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const id = randomUUID(); let messages = 0, windowAt = Date.now();
      ws.session = session; ws.alive = true; ws.memberId = id;
      ws.displayName = session.admin ? 'Hôte / 호스트' : 'Invité / 게스트';
      room.clients.add(ws); room.engine.join(id);
      // The client derives its cadence and buffer targets from these thresholds:
      // shipping them keeps the timing contract explicit instead of hardcoded twice.
      const { minBuffer, lowBuffer, reportTimeout, startDelay } = room.engine;
      ws.send(JSON.stringify({ type: 'welcome', id,
        sync: { minBuffer, lowBuffer, reportTimeout, startDelay, tickMs: TICK_MS } })); broadcast(room);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('message', data => {
        if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); messages = 0; }
        if (++messages > 40 || session.expires <= Date.now()) return ws.close(1008, 'Session invalide');
        try {
          const message = JSON.parse(data);
          if (message.type === 'identify') {
            if (typeof message.name !== 'string' || message.name.length > 40) throw new Error('Pseudo invalide.');
            const name = message.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
            if (!name) throw new Error('Pseudo requis.');
            ws.displayName = name; broadcast(room); return;
          }
          if (message.type === 'ping' && Number.isFinite(message.sentAt)) {
            return ws.send(JSON.stringify({ type: 'pong', sentAt: message.sentAt, serverNow: performance.now() }));
          }
          if (message.type === 'report') {
            // Ordinary buffer reports share the ticker, transitions are sent immediately.
            if (!room.engine.report(id, message).changed) return;
          } else if (message.type === 'command') room.engine.command(id, { ...message, type: message.command });
          else throw new Error('Message inconnu.');
          broadcast(room);
        } catch { ws.send(JSON.stringify({ type: 'error', error: 'Commande invalide.' })); }
      });
      ws.on('close', () => { room.clients.delete(ws); room.engine.leave(id); if (rooms.has(room.id)) broadcast(room); });
    });
  });
  const ticker = setInterval(() => {
    for (const room of rooms.values()) { room.engine.tick(); broadcast(room); }
  }, TICK_MS);
  const cleaner = setInterval(() => {
    for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
    for (const room of rooms.values()) {
      if (room.expires <= Date.now()) { for (const ws of room.clients) ws.close(1000, 'Room expirée'); rooms.delete(room.id); continue; }
      for (const ws of room.clients) {
        if (!ws.alive || ws.session.expires <= Date.now() || ![...sessions.values()].includes(ws.session)) ws.terminate();
        else { ws.alive = false; ws.ping(); }
      }
    }
  }, 10_000);
  const close = async () => {
    clearInterval(ticker); clearInterval(cleaner);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  };
  return { app, server, store, close };
}
