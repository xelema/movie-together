import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { Room, validThresholds, cleanText } from './room.js';
import { createSettings } from '../settings.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
// Bornes du protocole voix décidées dans #39 : trames PCM s16 mono 16 kHz de
// 30 ms (960 octets), 20 s d'écoute, 10 s de traitement et 2 000 caractères par
// texte produit. Les durées restent injectables pour les tests.
const VOICE_FRAME = 960, VOICE_TEXT_MAX = 2000;
const VOICE_MESSAGES = {
  'no-speech': 'Aucune parole détectée.',
  'unclear': 'Langue incertaine, réessayez.',
  'provider': 'Traduction indisponible.',
  'invalid-response': 'Réponse de traduction invalide.',
  'timeout': 'La traduction a expiré.',
};

// The séance protocol: room registry, websocket dispatch, broadcast, ticker and
// liveness sweep. app.js keeps HTTP and auth; it reaches séances only through
// this interface. Sessions and media stay outside: sessionFor/sessionActive,
// canAccess, movieFor and moviePlayable are injected at the seam.
export function createRoomHub({ origin, settings = createSettings(), sessionFor, sessionActive, canAccess, movieFor, moviePlayable, voiceService = null, voiceTiming = {} } = {}) {
  // Les seuils vivent ici pour les nouvelles séances comme pour tune() ; les
  // autres réglages sont relus dans settings au moment de chaque opération.
  const thresholds = { minBuffer: settings.get('minBuffer'), lowBuffer: settings.get('lowBuffer') };
  // Les boucles globales gardent leur cadence de démarrage : un client connecté
  // cale son seuil de silence sur le tickMs du welcome, le retimer à chaud
  // désynchroniserait les séances ouvertes. Un nouveau tickMs vaut au relancement.
  const cadence = { tickMs: settings.get('tickMs'), sweepMs: settings.get('sweepMs') };
  const timing = { listenMs: 20_000, processMs: 10_000, ...voiceTiming };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const rooms = new Map();
  const countSessions = room => new Set([...room.clients].map(client => client.session)).size;

  // Waiting diagnostics are for the host: guests only need the shared bit.
  const state = (room, { details = true } = {}) => ({ type: 'state', roomId: room.id, code: room.code,
    probe: !!room.probe, ...(room.voice ? { voice: room.voice } : {}),
    state: room.engine.snapshot(), movie: room.movieId ? movieFor(room.movieId) : null,
    sync: { minBuffer: room.engine.minBuffer, lowBuffer: room.engine.lowBuffer },
    members: [...room.engine.members.keys()].map(id => {
      const status = room.engine.memberStatus(id);
      return { id,
        name: [...room.clients].find(client => client.memberId === id)?.displayName ?? 'Invité / 게스트',
        ...(details ? status : { waiting: status.waiting }) };
    }),
  });

  // Phase moves and per-member waiting signatures are logged on change only:
  // a stuck séance leaves one line naming the gate that blocks it.
  const logChanges = (room, current) => {
    if (current.state.phase !== room.loggedPhase) {
      console.log(`[room ${room.code}] phase ${room.loggedPhase ?? 'new'} -> ${current.state.phase}`);
      room.loggedPhase = current.state.phase;
    }
    for (const member of current.members) {
      const signature = member.waiting
        ? `waiting ${member.reason}${member.blockers?.length ? ` (${member.blockers.join(', ')})` : ''}${member.failure ? ` [${member.failure}]` : ''}`
        : 'ready';
      if (room.logged.get(member.id) !== signature) {
        room.logged.set(member.id, signature);
        console.log(`[room ${room.code}] ${member.name}: ${signature}`);
      }
    }
  };

  const broadcast = room => {
    const current = state(room);
    logChanges(room, current);
    const full = JSON.stringify(current);
    let guest;
    for (const client of room.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 65536) { client.terminate(); continue; }
      client.send(client.session?.admin ? full : (guest ??= JSON.stringify(state(room, { details: false }))));
    }
  };

  // Prise de parole : une seule par séance, identifiée et ordonnée par le
  // serveur. Les états intermédiaires ne quittent jamais le socket de l'orateur
  // et toute libération arme le délai de reprise décidé dans #39.
  const voiceSend = (ws, payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice', ...payload }));
  };
  const refuse = (room, ws, error, message, extra = {}) => {
    console.log(`[room ${room.code}] voix refused:${error}`);
    voiceSend(ws, { state: 'failed', error, message, ...extra });
  };
  // Toute sortie détruit l'audio en mémoire : rien n'est persisté ni journalisé.
  const releaseUtterance = (room, utterance, category) => {
    clearTimeout(utterance.timer);
    utterance.chunks = null;
    if (room.utterance === utterance) room.utterance = null;
    room.voiceReleased?.set(utterance.session, Date.now());
    console.log(`[room ${room.code}] voix ${category}`);
  };
  const voiceStart = (room, ws) => {
    if (!room.voice?.enabled || typeof voiceService?.detect !== 'function' || typeof voiceService?.translate !== 'function') {
      return refuse(room, ws, 'unavailable', 'Traduction vocale indisponible.');
    }
    if (room.utterance) return refuse(room, ws, 'busy', 'Un participant parle déjà.');
    const limits = room.voiceLimits;
    const cooled = (room.voiceReleased.get(ws.session) ?? 0) + limits.cooldownMs - Date.now();
    if (cooled > 0) return refuse(room, ws, 'cooldown', 'Attendre avant de reprendre la parole.', { retryAfter: Math.ceil(cooled / 100) / 10 });
    const calls = (room.voiceCalls.get(ws.session) ?? []).filter(at => Date.now() - at < limits.windowMs);
    room.voiceCalls.set(ws.session, calls);
    if (calls.length >= limits.quota) {
      const retryAfter = Math.max(1, Math.ceil((calls[0] + limits.windowMs - Date.now()) / 1000));
      return refuse(room, ws, 'quota', 'Quota de traductions atteint.', { retryAfter });
    }
    const utterance = { id: randomUUID(), seq: ++room.voiceSeq, ws, session: ws.session,
      speaker: ws.displayName, chunks: [], bytes: 0, state: 'listening', timer: null };
    utterance.timer = setTimeout(() => finishUtterance(room, utterance), timing.listenMs);
    room.utterance = utterance;
    console.log(`[room ${room.code}] voix started`);
    voiceSend(ws, { state: 'started', utterance: utterance.id, seq: utterance.seq });
  };
  const voiceFrame = (room, ws, data) => {
    const utterance = room.utterance;
    if (!utterance || utterance.ws !== ws || utterance.state !== 'listening') return;
    // Le transport est une suite de trames de 30 ms ; toute autre taille est rejetée.
    if (!data.length || data.length % VOICE_FRAME ||
      utterance.bytes + data.length > Math.ceil(timing.listenMs / 30 + 10) * VOICE_FRAME) {
      releaseUtterance(room, utterance, 'aborted:invalid');
      return voiceSend(ws, { state: 'failed', utterance: utterance.id, seq: utterance.seq,
        error: 'invalid', message: 'Trame vocale invalide.' });
    }
    utterance.chunks.push(data);
    utterance.bytes += data.length;
  };
  const voiceStop = (room, ws) => {
    const utterance = room.utterance;
    if (utterance && utterance.ws === ws && utterance.state === 'listening') finishUtterance(room, utterance);
  };
  const voiceCancel = (room, ws) => {
    const utterance = room.utterance;
    if (utterance && utterance.ws === ws) releaseUtterance(room, utterance, 'cancelled');
  };
  const voiceControl = (room, ws, message) => {
    if (message.action === 'start') return voiceStart(room, ws);
    if (message.action === 'stop') return voiceStop(room, ws);
    if (message.action === 'cancel') return voiceCancel(room, ws);
    throw new Error('Message inconnu.');
  };
  // La phrase complète passe le garde-fou de parole et la détection de langue
  // avant tout appel facturé ; chaque sortie d'erreur libère le verrou.
  const finishUtterance = (room, utterance) => {
    if (room.utterance !== utterance || utterance.state !== 'listening') return;
    utterance.state = 'processing';
    clearTimeout(utterance.timer);
    const pcm = Buffer.concat(utterance.chunks);
    utterance.chunks = null;
    const audioMs = Math.round(pcm.length / 32);
    const fail = (error, message) => {
      releaseUtterance(room, utterance, `failed:${error}`);
      voiceSend(utterance.ws, { state: 'failed', utterance: utterance.id, seq: utterance.seq, error, message });
    };
    const pipeline = (async () => {
      const detected = await voiceService.detect(pcm);
      if (!detected?.speech) throw Object.assign(new Error('no speech'), { code: 'no-speech' });
      if (!room.voice.pair.includes(detected.language)) throw Object.assign(new Error('unclear'), { code: 'unclear' });
      // Seul l'appel réellement envoyé au fournisseur consomme le quota (#39).
      const calls = room.voiceCalls.get(utterance.session) ?? [];
      calls.push(Date.now());
      room.voiceCalls.set(utterance.session, calls);
      const result = await voiceService.translate(pcm, { language: detected.language, pair: room.voice.pair });
      if (!result || typeof result.text !== 'string' || typeof result.translation !== 'string' ||
        !result.text.length || !result.translation.length ||
        result.text.length > VOICE_TEXT_MAX || result.translation.length > VOICE_TEXT_MAX) {
        throw Object.assign(new Error('invalid'), { code: 'invalid-response' });
      }
      return { language: detected.language, result };
    })();
    const expired = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timing.processMs));
    Promise.race([pipeline, expired]).then(({ language, result }) => {
      // Une réponse arrivée après la libération de la prise est ignorée.
      if (room.utterance !== utterance) return;
      releaseUtterance(room, utterance, `completed ${audioMs}ms`);
      voiceSend(utterance.ws, { state: 'understood', utterance: utterance.id, seq: utterance.seq,
        text: result.text, language });
      const resultMessage = JSON.stringify({ type: 'voice', state: 'result',
        utterance: utterance.id, seq: utterance.seq, speaker: utterance.speaker, text: result.translation });
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(resultMessage);
      }
    }, error => {
      if (room.utterance !== utterance) return;
      fail(error.code ?? 'provider', VOICE_MESSAGES[error.code] ?? 'Traduction indisponible.');
    });
  };

  const create = ({ movieId, duration, code, probe, voice }) => {
    if (rooms.size >= settings.get('maxRooms')) throw fail(409, 'Fermer une room avant d’en créer une autre.');
    if (code !== undefined && (typeof code !== 'string' || !/^[a-z0-9-]{4,32}$/i.test(code.trim()))) throw fail(400, 'Code : 4 à 32 lettres, chiffres ou tirets.');
    code = code?.trim().toLowerCase() || randomBytes(8).toString('hex');
    if ([...rooms.values()].some(room => room.code === code && room.expires > Date.now())) throw fail(409, 'Ce code est déjà utilisé.');
    // Séance instrumentée : dix ans au lieu de douze heures, télémétrie activée.
    const room = { id: randomUUID(), code, expires: Date.now() + (probe ? 10 * 365 * 86400_000 : settings.get('ttlHours') * 3600_000), movieId,
      engine: new Room({ ...thresholds, reportTimeout: settings.get('reportTimeout') * 1000,
        startDelay: settings.get('startDelay') * 1000 }), clients: new Set(),
      probe: !!probe, logged: new Map(), loggedPhase: null };
    // Traduction vocale : capacité figée à la création. La disponibilité reflète
    // le service injecté, absent tant qu'aucun fournisseur n'est câblé.
    if (voice) {
      room.voice = Object.freeze({ enabled: true, pair: Object.freeze(['fr', 'ko']), available: !!voiceService });
      // Quotas et délais copiés à la création (#39) : immuables pendant la séance.
      room.voiceLimits = { quota: settings.get('voiceQuota'), windowMs: settings.get('voiceWindow') * 1000,
        cooldownMs: settings.get('voiceCooldown') * 1000 };
      room.voiceSeq = 0; room.utterance = null;
      room.voiceCalls = new Map(); room.voiceReleased = new Map();
    }
    room.engine.load(duration); rooms.set(room.id, room);
    return room;
  };

  // Buffer thresholds are runtime-tunable: live rooms and future ones follow,
  // and the next state broadcast carries them to connected clients.
  const tune = ({ minBuffer, lowBuffer } = {}) => {
    if (!Number.isFinite(minBuffer) || !Number.isFinite(lowBuffer) ||
      lowBuffer < 1 || minBuffer > 300 || !validThresholds({ minBuffer, lowBuffer })) {
      throw fail(400, 'Seuils invalides : 1 ≤ réserve < démarrage ≤ 300 s.');
    }
    Object.assign(thresholds, { minBuffer, lowBuffer });
    for (const room of rooms.values()) {
      room.engine.minBuffer = minBuffer; room.engine.lowBuffer = lowBuffer;
      broadcast(room);
    }
    return { minBuffer, lowBuffer };
  };

  const attach = server => server.on('upgrade', (request, socket, head) => {
    const session = sessionFor(request);
    const url = new URL(request.url, origin), room = rooms.get(url.searchParams.get('room'));
    // Capacity is per participant: sessions, not sockets. A session may hold a
    // spare socket so a reconnect is not locked out by its dying predecessor.
    const held = room ? [...room.clients].filter(client => client.session === session).length : 0;
    const sessions = room ? countSessions(room) : 0;
    if (url.pathname !== '/ws' || request.headers.origin !== origin || !session ||
      !canAccess(session, room) || room.expires <= Date.now() ||
      held >= settings.get('maxSocketsPerSession') || (!held && sessions >= settings.get('maxClients')) ||
      !moviePlayable(room.movieId)) {
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
      ws.send(JSON.stringify({ type: 'welcome', id, probe: !!room.probe,
        ...(room.voice ? { voice: room.voice } : {}),
        sync: { minBuffer, lowBuffer, reportTimeout, startDelay, tickMs: cadence.tickMs } })); broadcast(room);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('message', (data, isBinary) => {
        if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); messages = 0; }
        if (++messages > 40 || session.expires <= Date.now()) return ws.close(1008, 'Session invalide');
        if (isBinary) return voiceFrame(room, ws, data);
        try {
          const message = JSON.parse(data);
          if (message.type === 'identify') {
            if (typeof message.name !== 'string' || message.name.length > 40) throw new Error('Pseudo invalide.');
            const name = cleanText(message.name).trim();
            if (!name) throw new Error('Pseudo requis.');
            ws.displayName = name; broadcast(room); return;
          }
          if (message.type === 'ping' && Number.isFinite(message.sentAt)) {
            return ws.send(JSON.stringify({ type: 'pong', sentAt: message.sentAt, serverNow: performance.now() }));
          }
          if (message.type === 'voice') return voiceControl(room, ws, message);
          if (message.type === 'report') {
            // Ordinary buffer reports share the ticker, transitions are sent immediately.
            if (!room.engine.report(id, message).changed) return;
          } else if (message.type === 'command') room.engine.command(id, { ...message, type: message.command });
          else throw new Error('Message inconnu.');
          broadcast(room);
        } catch (error) {
          console.warn(`[room ${room.code}] ${ws.displayName}: ${error.message}`);
          ws.send(JSON.stringify({ type: 'error', error: 'Commande invalide.' }));
        }
      });
      ws.on('close', () => {
        if (room.utterance?.ws === ws) releaseUtterance(room, room.utterance, 'aborted:disconnect');
        room.clients.delete(ws); room.engine.leave(id); if (rooms.has(room.id)) broadcast(room);
      });
    });
  });

  const tick = () => { for (const room of rooms.values()) { room.engine.tick(); broadcast(room); } };
  const sweep = () => {
    for (const room of rooms.values()) {
      if (room.expires <= Date.now()) {
        if (room.utterance) releaseUtterance(room, room.utterance, 'closed');
        for (const ws of room.clients) ws.close(1000, 'Room expirée'); rooms.delete(room.id); continue;
      }
      for (const ws of room.clients) {
        if (!ws.alive || !sessionActive(ws.session)) ws.terminate();
        else { ws.alive = false; ws.ping(); }
      }
    }
  };
  const ticker = setInterval(tick, cadence.tickMs);
  const sweeper = setInterval(sweep, cadence.sweepMs);

  return {
    create,
    attach,
    tune,
    get: id => rooms.get(id),
    state,
    findByCode: code => typeof code === 'string'
      ? [...rooms.values()].find(room => room.code === code.trim().toLowerCase() && room.expires > Date.now())
      : undefined,
    list: () => [...rooms.values()].map(room => ({ id: room.id, code: room.code, movieId: room.movieId,
      probe: !!room.probe, expires: room.expires, participants: countSessions(room),
      link: `${origin}/#invite=${room.code}` })),
    setMovie(room, movie) { room.movieId = movie.id; room.engine.load(movie.duration); broadcast(room); },
    remove(id) {
      const room = rooms.get(id);
      if (room) {
        if (room.utterance) releaseUtterance(room, room.utterance, 'closed');
        for (const client of room.clients) client.close(1000, 'Room fermée'); rooms.delete(id);
      }
    },
    // idleMovie guards edits; movie deletion guards any reference.
    movieInUse: movieId => [...rooms.values()].some(room => room.movieId === movieId && room.engine.members.size),
    movieAssigned: movieId => [...rooms.values()].some(room => room.movieId === movieId),
    async close() {
      clearInterval(ticker); clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
