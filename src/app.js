import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, stat, statfs, rename, unlink, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './storage.js';
import { createSettings, FIELDS } from './settings.js';
import { reprobeMovie, prepareMovie, addSubtitle, writeMaster, decodeSubtitleText, subtitleFileFormat } from './media.js';
import { SUBTITLE_FORMATS, SUBTITLE_EXT } from '../public/subtitle-formats.js';
import { createRoomHub } from './sync/hub.js';
import { createJobs } from './jobs.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[a-f0-9-]{36}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const SUBTITLE_EXT_MESSAGE = size => `Choisir un fichier de sous-titres de moins de ${size} Mo (SRT, VTT, SMI, ASS, SUB…).`;
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
  origin = 'http://localhost:3000', secure = false, trustProxy = false, env = process.env,
  voiceService = null, voiceTiming } = {}) {
  if (!password || password.length < 16) throw new Error('ADMIN_PASSWORD doit contenir au moins 16 caractères.');
  if (secure && !origin.startsWith('https://')) throw new Error('APP_ORIGIN doit utiliser HTTPS en production.');
  const app = express();
  const server = createServer(app);
  const store = createStore(dataDir);
  const sessions = new Map();
  const salt = randomBytes(32), hash = scryptSync(password, salt, 64);
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    mediaSrc: ["'self'", 'blob:', 'mediastream:'], workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", 'stun:'], upgradeInsecureRequests: secure ? [] : null,
  } }, strictTransportSecurity: secure ? undefined : false }));
  const sessionFor = request => {
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('sid='))?.slice(4);
    const session = sessions.get(token);
    return session?.expires > Date.now() ? session : null;
  };
  app.use((req, res, next) => {
    req.session = sessionFor(req);
    // A non-JSON content type leaves req.body undefined; routes read it freely.
    req.body ??= {};
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
  const jobs = createJobs({ getMovie, movieInUse: id => hub.movieInUse(id) });
  // Réglages opérationnels : les défauts viennent du registre (ou de l'env),
  // puis data/settings.json pose les valeurs sauvegardées par l'admin.
  const settings = createSettings({ env, saved: store.settings() });
  const ttlMs = () => settings.get('ttlHours') * 3600_000;
  const chunkBytes = () => settings.get('chunkMb') * 1024 ** 2;
  const subtitleBytes = () => settings.get('maxSubtitleMb') * 1024 ** 2;
  const applySettings = () => {
    hub.tune({ minBuffer: settings.get('minBuffer'), lowBuffer: settings.get('lowBuffer') });
  };
  const hub = createRoomHub({ origin, settings, sessionFor,
    sessionActive: session => session.expires > Date.now() && [...sessions.values()].includes(session),
    canAccess: (session, room) => access({ session }, room),
    movieFor: id => publicMovie(getMovie(id)),
    moviePlayable: id => jobs.playable(store.movies.get(id)), voiceService, voiceTiming });
  // Probe sessions are kept in rooms.json so they survive restarts; they are
  // recreated as long as their film is still playable.
  const persistRoom = room => {
    store.saveRooms([...store.rooms().filter(saved => saved.code !== room.code),
      { code: room.code, movieId: room.movieId, probe: true, ...(room.voice ? { voice: true } : {}) }]);
  };
  const forgetRoom = room => {
    if (room?.probe) store.saveRooms(store.rooms().filter(saved => saved.code !== room.code));
  };
  for (const saved of store.rooms()) {
    const movie = store.movies.get(saved?.movieId);
    try {
      if (saved?.probe && movie && jobs.playable(movie)) hub.create({ movieId: movie.id, duration: movie.duration, code: saved.code, probe: true, voice: saved.voice === true });
    } catch { }
  }
  const cookie = (res, session) => {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, session);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure, maxAge: ttlMs(), path: '/' });
  };
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: () => settings.get('loginLimit'), standardHeaders: 'draft-8', legacyHeaders: false });
  const inviteLimiter = rateLimit({ windowMs: 60_000, limit: () => settings.get('inviteLimit'), standardHeaders: 'draft-8', legacyHeaders: false });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ authenticated: !!req.session, admin: !!req.session?.admin }));
  app.post('/api/login', loginLimiter, (req, res) => {
    if (typeof req.body.password !== 'string' || req.body.password.length > 512 ||
      !timingSafeEqual(hash, scryptSync(req.body.password, salt, 64))) throw fail(401, 'Mot de passe incorrect.');
    cookie(res, { admin: true, rooms: new Set(), expires: Date.now() + ttlMs() });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    for (const [token, session] of sessions) if (session === req.session) sessions.delete(token);
    res.clearCookie('sid', { path: '/', httpOnly: true, sameSite: 'strict', secure }); res.json({ ok: true });
  });
  app.get('/api/movies', authenticated, (req, res) => res.json([...store.movies.values()]
    .filter(movie => req.session.admin || [...req.session.rooms].some(id => hub.get(id)?.movieId === movie.id)).map(movie => req.session.admin ? movie : publicMovie(movie))));
  app.get('/api/storage', admin, async (req, res) => {
    const disk = await statfs(store.root);
    res.json({ free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize });
  });
  app.post('/api/rooms', admin, (req, res) => {
    const movie = getMovie(req.body.movieId);
    if (!jobs.playable(movie)) throw fail(409, 'Film non préparé.');
    const room = hub.create({ movieId: movie.id, duration: movie.duration, code: req.body.code, probe: req.body.probe === true, voice: req.body.voice === true });
    if (room.probe) persistRoom(room);
    res.status(201).json({ id: room.id, code: room.code, link: `${origin}/#invite=${room.code}` });
  });
  app.get('/api/rooms', admin, (req, res) => res.json(hub.list()));
  app.get('/api/settings', admin, (req, res) => res.json({ fields: settings.describe() }));
  app.patch('/api/settings', admin, (req, res) => {
    settings.update(req.body);
    applySettings();
    store.saveSettings(settings.overrides());
    res.json({ fields: settings.describe() });
  });
  app.post('/api/settings/reset', admin, (req, res) => {
    settings.reset();
    applySettings();
    store.saveSettings(settings.overrides());
    res.json({ fields: settings.describe() });
  });
  app.post('/api/join', inviteLimiter, (req, res) => {
    const room = hub.findByCode(req.body.code);
    if (!room) throw fail(404, 'Code invalide ou expiré.');
    const session = req.session ?? { admin: false, rooms: new Set(), expires: Date.now() + ttlMs() };
    session.rooms.add(room.id);
    if (!req.session) cookie(res, session);
    res.json({ id: room.id });
  });
  app.get('/api/rooms/:id', authenticated, (req, res) => {
    const room = hub.get(req.params.id);
    if (!access(req, room)) throw fail(404, 'Room introuvable.');
    res.json(hub.state(room, { details: !!req.session?.admin }));
  });
  app.delete('/api/rooms/:id', admin, (req, res) => {
    forgetRoom(hub.get(req.params.id));
    hub.remove(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/movie', admin, (req, res) => {
    const room = hub.get(req.params.id);
    if (!access(req, room)) throw fail(404, 'Room introuvable.');
    const movie = getMovie(req.body.movieId);
    if (!jobs.playable(movie)) throw fail(409, 'Film non préparé.');
    hub.setMovie(room, movie); if (room.probe) persistRoom(room); res.json({ ok: true });
  });
  // Séances instrumentées : chaque participant y envoie sa télémétrie, appendée
  // en NDJSON sous data/telemetry/<code>-<membre>.ndjson pour analyse a posteriori.
  const telemetryFiles = new Set();
  app.post('/api/rooms/:id/telemetry', authenticated, async (req, res) => {
    const room = hub.get(req.params.id);
    if (!access(req, room) || !room.probe) throw fail(404, 'Room introuvable.');
    const { memberId, events } = req.body;
    if (typeof memberId !== 'string' || !/^[a-f0-9-]{1,40}$/.test(memberId) ||
      !Array.isArray(events) || !events.length || events.length > 600 ||
      events.some(event => !event || typeof event !== 'object' || !Number.isFinite(event.t) ||
        typeof event.type !== 'string' || event.type.length > 40 || JSON.stringify(event).length > 4000)) {
      throw fail(400, 'Commande invalide.');
    }
    const directory = path.join(store.root, 'telemetry');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${room.code}-${memberId}.ndjson`);
    if (!telemetryFiles.has(file)) { telemetryFiles.add(file); console.log(`[room ${room.code}] télémétrie -> data/telemetry/${path.basename(file)}`); }
    const at = Date.now();
    await appendFile(file, events.map(event => JSON.stringify({ at, member: memberId, ...event })).join('\n') + '\n');
    res.status(204).end();
  });
  const uploadPath = id => {
    if (!ID.test(id)) throw fail(404, 'Upload introuvable.');
    return path.join(store.root, 'uploads', id);
  };
  const uploadInfo = async id => {
    try {
      const info = JSON.parse(await readFile(path.join(uploadPath(id), 'upload.json'), 'utf8'));
      // Les envois ouverts avant le cliché de création gardent la taille courante.
      info.chunkSize ??= chunkBytes();
      return info;
    } catch (error) { if (error.code === 'ENOENT') throw fail(404, 'Upload introuvable.'); throw error; }
  };
  // Only directories are pending uploads; a stray file must not count toward the cap.
  const listUploads = async () => {
    try { return (await readdir(path.join(store.root, 'uploads'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  app.post('/api/uploads', admin, async (req, res) => {
    const { size, name, fingerprint } = req.body;
    const { kind = 'movie', movieId, label = name, language = 'und' } = req.body;
    if (!['movie', 'subtitle'].includes(kind)) throw fail(400, 'Fichier invalide.');
    if (kind !== 'movie') {
      const movie = jobs.idle(movieId);
      if ((movie.externalTracks?.length ?? 0) >= settings.get('maxExternalTracks')) throw fail(400, 'Trop de fichiers ajoutés.');
      if (typeof label !== 'string' || !label.trim() || label.length > 100 || !/^[a-z]{2,3}$/.test(language)) throw fail(400, 'Nom ou langue invalide.');
      if (!SUBTITLE_EXT.test(name) || size > subtitleBytes()) throw fail(400, SUBTITLE_EXT_MESSAGE(settings.get('maxSubtitleMb')));
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > settings.get('maxMovieGb') * 1024 ** 3 || typeof name !== 'string' || name.length > 250) throw fail(400, `Fichier invalide (maximum ${settings.get('maxMovieGb')} Go).`);
    if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))) throw fail(400, 'Empreinte invalide.');
    if ((await listUploads()).length >= settings.get('maxPending')) throw fail(409, 'Terminer ou supprimer les uploads précédents.');
    const disk = await statfs(store.root);
    if (disk.bavail * disk.bsize < size * 2.2) throw fail(409, 'Espace disque insuffisant pour l’original et sa préparation.');
    const id = randomUUID(); await mkdir(uploadPath(id));
    const info = { id, name, size, fingerprint, kind, movieId, label, language, chunkSize: chunkBytes(), createdAt: Date.now() };
    // An interrupted creation must not leave a directory the cap would count forever.
    try {
      await writeFile(path.join(uploadPath(id), 'upload.json'), JSON.stringify(info));
      await writeFile(path.join(uploadPath(id), 'source'), '');
    } catch (error) { await rm(uploadPath(id), { recursive: true, force: true }); throw error; }
    res.status(201).json({ ...info, offset: 0 });
  });
  app.get('/api/uploads', admin, async (req, res) => {
    const result = [];
    for (const id of await listUploads()) {
      try { result.push({ ...await uploadInfo(id), offset: (await stat(path.join(uploadPath(id), 'source'))).size }); }
      catch (error) {
        // An upload may have just been finalized; anything else is a real corruption.
        if (error.status !== 404 && error.code !== 'ENOENT') throw error;
      }
    }
    res.json(result);
  });
  app.get('/api/uploads/:id', admin, async (req, res) => res.json({ ...await uploadInfo(req.params.id),
    offset: (await stat(path.join(uploadPath(req.params.id), 'source'))).size }));
  app.put('/api/uploads/:id', admin, express.raw({ type: 'application/octet-stream', limit: FIELDS.chunkMb.max * 1024 ** 2 }), async (req, res) => {
    const id = req.params.id;
    const release = jobs.claimUpload(id);
    try {
      const info = await uploadInfo(id), file = path.join(uploadPath(id), 'source');
      const offset = (await stat(file)).size;
      if (!Buffer.isBuffer(req.body) || !req.body.length || offset + req.body.length > info.size) throw fail(400, 'Bloc invalide.');
      if (Number(req.headers['upload-offset']) !== offset) return res.status(409).json({ error: 'Reprendre à la position courante.', offset });
      await writeFile(file, req.body, { flag: 'a' });
      res.json({ offset: offset + req.body.length });
    } finally { release(); }
  });
  app.delete('/api/uploads/:id', admin, async (req, res) => {
    const release = jobs.claimUpload(req.params.id);
    try { await rm(uploadPath(req.params.id), { recursive: true, force: true }); res.json({ ok: true }); }
    finally { release(); }
  });
  app.post('/api/uploads/:id/complete', admin, async (req, res) => {
    const id = req.params.id;
    const release = jobs.claimImport(id);
    try {
      const info = await uploadInfo(id), source = path.join(uploadPath(id), 'source');
      if ((await stat(source)).size !== info.size) throw fail(409, 'Upload incomplet.');
      if (info.kind && info.kind !== 'movie') {
        const movie = jobs.idle(info.movieId);
        // Stored files carry no extension and may use a legacy charset: normalize to UTF-8 first.
        await writeFile(source, decodeSubtitleText(await readFile(source)));
        const formats = SUBTITLE_FORMATS[path.extname(info.name).slice(1).toLowerCase()] ?? [];
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
      await reprobeMovie(store, movie);
      store.save(movie); res.json(movie);
    } finally { release(); }
  });
  app.post('/api/movies/:id/probe', admin, async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (movie.status === 'ready') throw fail(409, 'Analyse indisponible.');
    const done = jobs.claimHeavy('Analyse indisponible.');
    movie.status = 'probing'; movie.error = null; store.save(movie);
    res.status(202).json({ ok: true });
    try { await reprobeMovie(store, movie); }
    finally { store.save(movie); done(); }
  });
  app.post('/api/movies/:id/prepare', admin, async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (jobs.heavyBusy()) throw fail(409, 'Un import est déjà en cours.');
    if (req.body.names !== undefined) {
      if (typeof req.body.names !== 'object' || req.body.names === null) throw fail(400, 'Noms de pistes invalides.');
      movie.trackNames = { audio: trackNames(req.body.names.audio), subtitles: trackNames(req.body.names.subtitles) };
    }
    const done = jobs.claimHeavy();
    movie.status = 'processing'; movie.error = null; store.save(movie);
    res.status(202).json({ ok: true });
    try {
      movie.progress = { stage: 'analysis', percent: 0 }; store.save(movie);
      let lastProgress = 0;
      const audio = req.body.audio ?? (movie.audio ?? []).map(track => track.index);
      const subtitles = req.body.subtitles ?? previousSubtitles(movie);
      Object.assign(movie, await prepareMovie(store, movie, audio, subtitles, {
        threads: settings.get('encodeThreads'), segmentSeconds: settings.get('segmentSeconds'),
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
    finally { delete movie.progress; store.save(movie); done(); }
  });
  app.patch('/api/movies/:id', admin, (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.length > 150) throw fail(400, 'Titre invalide.');
    movie.title = req.body.title.trim(); store.save(movie); res.json(movie);
  });
  app.delete('/api/movies/:id', admin, async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (hub.movieAssigned(movie.id)) throw fail(409, 'Fermer les rooms de ce film avant suppression.');
    const release = jobs.claimMovie(movie.id);
    try { await rm(store.directory(movie.id), { recursive: true, force: true }); store.movies.delete(movie.id); res.json({ ok: true }); }
    finally { release(); }
  });
  app.post('/api/movies/:id/subtitles', admin, express.raw({ type: 'text/plain', limit: FIELDS.maxSubtitleMb.max * 1024 ** 2 }), async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (movie.status !== 'ready' || jobs.heavyBusy()) throw fail(409, 'Film indisponible.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Sous-titre vide.');
    if (req.body.length > subtitleBytes()) throw fail(400, SUBTITLE_EXT_MESSAGE(settings.get('maxSubtitleMb')));
    if (req.query.name !== undefined && (typeof req.query.name !== 'string' || !SUBTITLE_EXT.test(req.query.name))) throw fail(400, SUBTITLE_EXT_MESSAGE(settings.get('maxSubtitleMb')));
    const release = jobs.claimEdit(movie);
    const directory = path.join(store.directory(movie.id), movie.generation);
    const input = path.join(directory, 'subtitle-input');
    try {
      await writeFile(input, decodeSubtitleText(req.body));
      const formats = req.query.name ? SUBTITLE_FORMATS[path.extname(req.query.name).slice(1).toLowerCase()] ?? [] : [];
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
    } finally { await unlink(input).catch(() => {}); release(); }
  });
  app.delete('/api/movies/:id/subtitles/:track', admin, async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (jobs.heavyBusy()) throw fail(409, 'Un import est déjà en cours.');
    const track = movie.subtitles?.find(item => item.id === req.params.track);
    if (!track) throw fail(404, 'Piste introuvable.');
    const release = jobs.claimMovie(movie.id);
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
    } finally { release(); }
  });
  app.delete('/api/movies/:id/external/:track', admin, async (req, res) => {
    const movie = jobs.idle(req.params.id);
    if (jobs.heavyBusy()) throw fail(409, 'Un import est déjà en cours.');
    const track = movie.externalTracks?.find(item => item.id === req.params.track);
    if (!track) throw fail(404, 'Piste introuvable.');
    const release = jobs.claimMovie(movie.id);
    try {
      movie.externalTracks = movie.externalTracks.filter(item => item !== track);
      await unlink(path.join(store.directory(movie.id), track.filename)).catch(() => {});
      store.save(movie); res.json(movie);
    } finally { release(); }
  });
  app.get('/media/:id/:file', authenticated, (req, res, next) => {
    // TCP_NODELAY : pas de latence Nagle sur le flux des segments vidéo.
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true, 1000);
    const movie = getMovie(req.params.id);
    if (!req.session.admin && ![...req.session.rooms].some(id => hub.get(id)?.movieId === movie.id)) throw fail(403, 'Accès au film refusé.');
    if (movie.status !== 'ready' || !/^(master(?:_original|_compatible)?|stream_\d+|sub_[a-f0-9-]+(?:_original|_compatible)?)\.m3u8$|^(init_\d+\.mp4|segment_\d+_\d+\.m4s|sub_[a-f0-9-]+(?:_original|_compatible)?\.vtt)$/.test(req.params.file)) throw fail(404, 'Média introuvable.');
    res.set('Cache-Control', 'private, no-store');
    const ext = path.extname(req.params.file);
    if (ext === '.m4s' || ext === '.mp4' || ext === '.vtt') {
      // Les bytes peuvent être resservis du cache mémoire pendant 1 h sans RTT
      // bloquant (reprise, re-buffer) ; l'ETag porte la génération pour
      // invalider toute préparation ultérieure.
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('ETag', `"${movie.generation}-${req.params.file}"`);
    }
    res.type(({ '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4', '.vtt': 'text/vtt', '.mp4': 'video/mp4' })[ext]);
    res.sendFile(req.params.file, { root: path.join(store.directory(movie.id), movie.generation) }, error => { if (error) next(error); });
  });
  app.get('/vendor/hls.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js'), { maxAge: '1d' }));
  app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));
  for (const file of ['plyr.js', 'plyr.css', 'plyr.svg']) app.get(`/vendor/${file}`, (req, res) =>
    res.sendFile(path.join(ROOT, 'node_modules/plyr/dist', file), { maxAge: '1d' }));
  app.use('/fonts', express.static(path.join(ROOT, 'public/fonts'), { maxAge: '30d' }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use((req, res) => res.status(404).json({ error: 'Page introuvable.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!error.status || error.status >= 500) console.error(error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur serveur. Consulter les journaux.' });
  });

  hub.attach(server);
  const cleaner = setInterval(() => {
    for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
  }, 10_000);
  const close = async () => {
    clearInterval(cleaner);
    await hub.close();
    await new Promise(resolve => server.close(resolve));
  };
  return { app, server, store, hub, close };
}
