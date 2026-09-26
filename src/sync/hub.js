import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { Room, validThresholds, cleanText } from './room.js';
import { createSettings } from '../settings.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
// Bornes du protocole voix décidées dans #39 : trames PCM s16 mono 16 kHz de
// 30 ms (960 octets), 20 s d'écoute, 10 s de traitement et 2 000 caractères par
// texte produit. Les durées restent injectables pour les tests. Le débit des
// trames est borné par socket à trois fois le rythme nominal (~33/s).
const VOICE_FRAME = 960, VOICE_TEXT_MAX = 2000, VOICE_FRAME_RATE = 100;
const VOICE_MESSAGES = {
  'no-speech': 'Aucune parole détectée.',
  'inconsistent': 'Traduction incohérente, réessayez.',
  'provider': 'Service de traduction indisponible.',
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
  const timing = { listenMs: 20_000, processMs: 10_000, idleMs: 2_000, ...voiceTiming };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const rooms = new Map();
  const countSessions = room => new Set([...room.clients].map(client => client.session)).size;

  // Waiting diagnostics are for the host: guests only need the shared bit.
  const state = (room, { details = true } = {}) => ({ type: 'state', roomId: room.id, code: room.code,
    probe: !!room.probe, ...(room.voice ? { voice: room.voice } : {}), ...(room.webcam ? { webcam: room.webcam } : {}),
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
      console.log(`[room ${room.tag}] phase ${room.loggedPhase ?? 'new'} -> ${current.state.phase}`);
      room.loggedPhase = current.state.phase;
    }
    for (const member of current.members) {
      const signature = member.waiting
        ? `waiting ${member.reason}${member.blockers?.length ? ` (${member.blockers.join(', ')})` : ''}${member.failure ? ` [${member.failure}]` : ''}`
        : 'ready';
      if (room.logged.get(member.id) !== signature) {
        room.logged.set(member.id, signature);
        console.log(`[room ${room.tag}] ${member.id}: ${signature}`);
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
  // serveur. La traduction part en direct vers une session Live Translate dès
  // que le garde-fou local atteste la parole ; les surtitres partiels sont
  // diffusés à tous sous séquence et révision, la transcription source reste
  // locale à l'orateur. Toute libération ferme la session amont, efface
  // l'audio et arme le délai de reprise décidé dans #39.
  const voiceSend = (ws, payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice', ...payload }));
  };
  const broadcastVoice = (room, payload) => {
    const message = JSON.stringify({ type: 'voice', ...payload });
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };
  const refuse = (room, ws, error, message, extra = {}) => {
    console.log(`[room ${room.tag}] voix refused:${error}`);
    voiceSend(ws, { state: 'failed', error, message, ...extra });
  };
  // Toute sortie ferme la session amont et détruit l'audio en mémoire : rien
  // n'est persisté ni journalisé. Un surtitre partiel déjà diffusé est retiré.
  const releaseUtterance = (room, utterance, category) => {
    clearTimeout(utterance.timer);
    clearInterval(utterance.idlePoll);
    utterance.live?.close();
    utterance.live = null;
    if (utterance.chunks) for (const chunk of utterance.chunks) chunk.fill(0);
    utterance.chunks = null;
    if (utterance.partialSent && !utterance.resultSent) {
      broadcastVoice(room, { state: 'withdrawn', utterance: utterance.id, seq: utterance.seq });
    }
    if (room.utterance === utterance) room.utterance = null;
    room.voiceReleased?.set(utterance.session, Date.now());
    console.log(`[room ${room.tag}] voix ${category}`);
  };
  const failUtterance = (room, utterance, error, message) => {
    if (room.utterance !== utterance) return;
    releaseUtterance(room, utterance, `failed:${error}`);
    voiceSend(utterance.ws, { state: 'failed', utterance: utterance.id, seq: utterance.seq,
      error, message: message ?? VOICE_MESSAGES[error] ?? VOICE_MESSAGES.provider });
  };
  const voiceStart = (room, ws, message) => {
    if (!room.voice?.enabled || typeof voiceService?.openSession !== 'function') {
      return refuse(room, ws, 'unavailable', 'Traduction vocale indisponible.');
    }
    // La langue d'interface de l'orateur fixe le sens de la prise (#44) : elle
    // est lue une fois au départ et figée, jamais détectée ni redemandée.
    const source = message.lang;
    if (!room.voice.pair.includes(source)) return refuse(room, ws, 'invalid', 'Sens de traduction invalide.');
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
      speaker: ws.displayName, source, target: room.voice.pair.find(code => code !== source),
      chunks: [], bytes: 0, gate: { energy: 0, crossings: 0, samples: 0, previous: 0 },
      live: null, translation: '', heard: '', rev: 0, lastOutput: 0, stoppedAt: 0,
      partialSent: false, resultSent: false, state: 'listening', timer: null, idlePoll: null };
    utterance.timer = setTimeout(() => finishUtterance(room, utterance), timing.listenMs);
    room.utterance = utterance;
    console.log(`[room ${room.tag}] voix started`);
    voiceSend(ws, { state: 'started', utterance: utterance.id, seq: utterance.seq });
  };
  const voiceFrame = (room, ws, data) => {
    const utterance = room.utterance;
    if (!utterance || utterance.ws !== ws || utterance.state !== 'listening') return;
    // Le transport est une suite de trames de 30 ms. Toute autre taille est rejetée.
    if (!data.length || data.length % VOICE_FRAME ||
      utterance.bytes + data.length > Math.ceil(timing.listenMs / 30 + 10) * VOICE_FRAME) {
      return failUtterance(room, utterance, 'invalid', 'Trame vocale invalide.');
    }
    utterance.bytes += data.length;
    // Session déjà ouverte : la trame part au fournisseur puis est effacée.
    if (utterance.live) { utterance.live.send(data); data.fill(0); return; }
    // Sinon elle s'accumule pour le garde-fou et pour l'envoi groupé à
    // l'ouverture : aucun fournisseur n'est sollicité avant la parole attestée.
    utterance.chunks.push(data);
    gatePush(utterance.gate, data);
    if (gateHasSpeech(utterance.gate)) openLive(room, utterance);
  };
  // La session fournisseur ne s'ouvre qu'une fois la parole attestée (#45) :
  // c'est l'ouverture réelle qui consomme le quota, pas la demande de prise.
  const openLive = (room, utterance) => {
    const calls = room.voiceCalls.get(utterance.session) ?? [];
    calls.push(Date.now());
    room.voiceCalls.set(utterance.session, calls);
    let live;
    try { live = utterance.live = voiceService.openSession({ source: utterance.source, target: utterance.target }); }
    catch { return failUtterance(room, utterance, 'provider'); }
    live.onText = chunk => {
      if (room.utterance !== utterance || typeof chunk !== 'string' || !chunk) return;
      utterance.translation = (utterance.translation + chunk).slice(0, VOICE_TEXT_MAX + 1);
      utterance.lastOutput = Date.now();
      utterance.partialSent = true;
      broadcastVoice(room, { state: 'partial', utterance: utterance.id, seq: utterance.seq,
        rev: ++utterance.rev, speaker: utterance.speaker, text: utterance.translation });
    };
    live.onSource = chunk => {
      if (room.utterance !== utterance || typeof chunk !== 'string' || !chunk) return;
      utterance.heard = (utterance.heard + chunk).slice(0, VOICE_TEXT_MAX + 1);
      voiceSend(utterance.ws, { state: 'heard', utterance: utterance.id, seq: utterance.seq, text: utterance.heard });
    };
    live.onEnd = error => {
      if (room.utterance !== utterance) return;
      if (error || utterance.state === 'listening') return failUtterance(room, utterance, 'provider');
      settleUtterance(room, utterance);
    };
    // L'audio accumulé avant l'ouverture part d'un coup puis est effacé.
    for (const chunk of utterance.chunks) { live.send(chunk); chunk.fill(0); }
    utterance.chunks = null;
    console.log(`[room ${room.tag}] voix session`);
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
    if (message.action === 'start') return voiceStart(room, ws, message);
    if (message.action === 'stop') return voiceStop(room, ws);
    if (message.action === 'cancel') return voiceCancel(room, ws);
    throw new Error('Message inconnu.');
  };
  // Visio face-à-face : le hub ne fait que relayer la signalisation WebRTC
  // entre les participants d'une séance équipée. Le flux vidéo ne transite
  // jamais par le serveur ; l'identité de l'émetteur est posée ici et jamais
  // reprise du message entrant.
  const webcamControl = (room, ws, message) => {
    if (!room.webcam?.enabled) return;
    const others = [...room.clients].filter(client => client !== ws && client.readyState === WebSocket.OPEN);
    if (message.action === 'signal') {
      if (!message.signal || typeof message.signal !== 'object' || JSON.stringify(message.signal).length >= 8192) {
        throw new Error('Message invalide.');
      }
      const data = JSON.stringify({ type: 'webcam', action: 'signal', from: ws.memberId, name: ws.displayName, signal: message.signal });
      for (const client of others) {
        if (message.to !== undefined && client.memberId !== message.to) continue;
        client.send(data);
      }
      return;
    }
    if (message.action === 'status') {
      const data = JSON.stringify({ type: 'webcam', action: 'status', from: ws.memberId, name: ws.displayName, active: !!message.active });
      for (const client of others) client.send(data);
      return;
    }
    throw new Error('Message inconnu.');
  };
  // Garde-fou local avant toute session facturée (#45), alimenté trame par
  // trame : le silence a une énergie nulle, un offset continu un taux de
  // passage par zéro nul malgré l'énergie et un bruit large bande un taux
  // proche de 0,5. La parole reste entre les deux. Rien d'autre ne doit
  // atteindre le fournisseur.
  const gatePush = (gate, pcm) => {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i);
      gate.samples++;
      if (gate.samples === 1) { gate.previous = sample; continue; }
      gate.energy += Math.abs(sample);
      if (sample < 0 !== gate.previous < 0) gate.crossings++;
      gate.previous = sample;
    }
  };
  const gateHasSpeech = gate => gate.samples > 1 &&
    gate.energy / gate.samples / 32768 > 0.01 &&
    gate.crossings / (gate.samples - 1) > 0.005 && gate.crossings / (gate.samples - 1) < 0.4;
  // À l'arrêt (appui ou plafond d'écoute) la session reçoit son silence de
  // terminaison puis on attend le texte qui traîne : le modèle n'émet aucun
  // signal de fin fiable, on clôt après idleMs sans nouveau texte.
  const finishUtterance = (room, utterance) => {
    if (room.utterance !== utterance || utterance.state !== 'listening') return;
    utterance.state = 'processing';
    clearTimeout(utterance.timer);
    for (const chunk of utterance.chunks ?? []) chunk.fill(0);
    utterance.chunks = null;
    if (!utterance.live) return failUtterance(room, utterance, 'no-speech');
    utterance.live.flush();
    utterance.stoppedAt = Date.now();
    utterance.timer = setTimeout(() => failUtterance(room, utterance, 'timeout'), timing.processMs);
    utterance.idlePoll = setInterval(() => {
      if (Date.now() - Math.max(utterance.stoppedAt, utterance.lastOutput) >= timing.idleMs) {
        settleUtterance(room, utterance);
      }
    }, Math.max(20, Math.min(100, timing.idleMs / 4)));
  };
  // Clôture normale : la traduction accumulée est validée dans le sens figé
  // (#45) puis partagée à tous ; la transcription reste chez l'orateur. Une
  // phrase sans traduction exploitable est retirée et comptée comme échec.
  const HANGUL = /[ᄀ-ᅟ㄰-㆏가-힯]/;
  const settleUtterance = (room, utterance) => {
    if (room.utterance !== utterance || utterance.state !== 'processing') return;
    const { translation, heard, bytes } = utterance;
    if (!translation || translation.length > VOICE_TEXT_MAX ||
      (heard && heard.length > VOICE_TEXT_MAX)) {
      return failUtterance(room, utterance, 'invalid-response');
    }
    if (HANGUL.test(translation) !== (utterance.target === 'ko') ||
      (heard && HANGUL.test(heard) !== (utterance.source === 'ko'))) {
      return failUtterance(room, utterance, 'inconsistent');
    }
    utterance.resultSent = true;
    releaseUtterance(room, utterance, `completed ${Math.round(bytes / 32)}ms`);
    if (heard) voiceSend(utterance.ws, { state: 'understood', utterance: utterance.id, seq: utterance.seq, text: heard });
    broadcastVoice(room, { state: 'result', utterance: utterance.id, seq: utterance.seq,
      speaker: utterance.speaker, text: translation });
  };

  const create = ({ movieId, duration, code, probe, voice, webcam }) => {
    if (rooms.size >= settings.get('maxRooms')) throw fail(409, 'Fermer une room avant d’en créer une autre.');
    if (code !== undefined && (typeof code !== 'string' || !/^[a-z0-9-]{4,32}$/i.test(code.trim()))) throw fail(400, 'Code : 4 à 32 lettres, chiffres ou tirets.');
    code = code?.trim().toLowerCase() || randomBytes(8).toString('hex');
    if ([...rooms.values()].some(room => room.code === code && room.expires > Date.now())) throw fail(409, 'Ce code est déjà utilisé.');
    // Séance instrumentée : dix ans au lieu de douze heures, télémétrie activée.
    // Journaux voix : identifiant pseudonymisé (#39), jamais le code ni un nom.
    const id = randomUUID();
    const room = { id, tag: id.slice(0, 8), code, expires: Date.now() + (probe ? 10 * 365 * 86400_000 : settings.get('ttlHours') * 3600_000), movieId,
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
    // Visio face-à-face : capacité figée à la création, pensée pour les séances
    // à deux ; le serveur ne garde aucun état au-delà du relais.
    if (webcam) room.webcam = Object.freeze({ enabled: true });
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

  const isAllowedOrigin = (headerOrigin, request) => {
    if (headerOrigin === origin) return true;
    if (!origin.startsWith('https://') && headerOrigin) {
      try {
        const u = new URL(headerOrigin);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
        if (request?.headers?.host && u.host === request.headers.host) return true;
        if (u.hostname.endsWith('.loca.lt') || u.hostname.endsWith('.trycloudflare.com') || u.hostname.endsWith('.ngrok-free.app')) return true;
      } catch {}
    }
    return false;
  };
  const attach = server => server.on('upgrade', (request, socket, head) => {
    const session = sessionFor(request);
    const url = new URL(request.url, origin), room = rooms.get(url.searchParams.get('room'));
    // Capacity is per participant: sessions, not sockets. A session may hold a
    // spare socket so a reconnect is not locked out by its dying predecessor.
    const held = room ? [...room.clients].filter(client => client.session === session).length : 0;
    const sessions = room ? countSessions(room) : 0;
    const maxCapacity = room?.webcam ? 2 : settings.get('maxClients');
    if (url.pathname !== '/ws' || !isAllowedOrigin(request.headers.origin, request) || !session ||
      !canAccess(session, room) || room.expires <= Date.now() ||
      held >= settings.get('maxSocketsPerSession') || (!held && sessions >= maxCapacity) ||
      !moviePlayable(room.movieId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const id = randomUUID(); let messages = 0, frames = 0, windowAt = Date.now();
      ws.session = session; ws.alive = true; ws.memberId = id;
      ws.displayName = session.admin ? 'Hôte / 호스트' : 'Invité / 게스트';
      room.clients.add(ws); room.engine.join(id);
      // The client derives its cadence and buffer targets from these thresholds:
      // shipping them keeps the timing contract explicit instead of hardcoded twice.
      const { minBuffer, lowBuffer, reportTimeout, startDelay } = room.engine;
      ws.send(JSON.stringify({ type: 'welcome', id, probe: !!room.probe,
        ...(room.voice ? { voice: room.voice } : {}),
        ...(room.webcam ? { webcam: room.webcam } : {}),
        sync: { minBuffer, lowBuffer, reportTimeout, startDelay, tickMs: cadence.tickMs } })); broadcast(room);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('message', (data, isBinary) => {
        if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); messages = 0; frames = 0; }
        // Les trames PCM ont un budget propre, trois fois le rythme nominal
        // d'une écoute : une rafale est bornée sans toucher le compteur JSON.
        // La prise borne en plus taille de trame et total d'octets.
        if (isBinary) {
          if (++frames > VOICE_FRAME_RATE) return ws.close(1008, 'Trafic invalide');
          return voiceFrame(room, ws, data);
        }
        if (++messages > 40 || session.expires <= Date.now()) return ws.close(1008, 'Session invalide');
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
          if (message.type === 'webcam') return webcamControl(room, ws, message);
          if (message.type === 'report') {
            // Ordinary buffer reports share the ticker, transitions are sent immediately.
            if (!room.engine.report(id, message).changed) return;
          } else if (message.type === 'command') room.engine.command(id, { ...message, type: message.command });
          else throw new Error('Message inconnu.');
          broadcast(room);
        } catch (error) {
          console.warn(`[room ${room.tag}] ${ws.memberId}: ${error.message}`);
          ws.send(JSON.stringify({ type: 'error', error: 'Commande invalide.' }));
        }
      });
      ws.on('close', () => {
        if (room.utterance?.ws === ws) releaseUtterance(room, room.utterance, 'aborted:disconnect');
        room.clients.delete(ws); room.engine.leave(id);
        if (!rooms.has(room.id)) return;
        // Le pair restant raccroche sa session WebRTC : le flux n'a plus de
        // destinataire et sa vignette retombe sur l'attente.
        if (room.webcam) {
          const left = JSON.stringify({ type: 'webcam', action: 'peer-left', from: id });
          for (const client of room.clients) if (client.readyState === WebSocket.OPEN) client.send(left);
        }
        broadcast(room);
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
    countSessions: room => room ? countSessions(room) : 0,
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
      // Une prise encore en vol est un état terminal : l'audio est effacé.
      for (const room of rooms.values()) if (room.utterance) releaseUtterance(room, room.utterance, 'closed');
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
