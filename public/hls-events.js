// Traduction des événements hls.js vers les lignes du journal de télémétrie.
// Module pur : aucune API navigateur n'est lue au chargement, seul l'objet
// `hls` reçu est sondé (bufferController pour les plages par piste). Toutes
// les lectures sont gardées : une sonde en échec ne doit jamais casser le
// moteur de lecture qui l'appelle.

const r2 = value => Number.isFinite(value) ? +value.toFixed(2) : undefined;
const g = fn => { try { return fn(); } catch { return undefined; } };

// Les événements du cycle de vie suivis par la télémétrie.
export const HLS_EVENTS = [
  'MEDIA_ATTACHED', 'MANIFEST_PARSED', 'LEVEL_LOADED', 'LEVEL_SWITCHED',
  'FRAG_LOADING', 'FRAG_LOADED', 'FRAG_BUFFERED', 'FRAG_CHANGED',
  'BUFFER_APPENDED', 'BUFFER_FLUSHING', 'BUFFER_FLUSHED', 'BUFFER_EOS',
  'BUFFER_CODECS',
];

// Plages d'un TimeRanges (ou pseudo-équivalent hls.js) en [début, fin] arrondis.
export const rangesOf = buffer => g(() => {
  const out = [];
  for (let i = 0; i < (buffer?.length ?? 0); i++) out.push([r2(buffer.start(i)), r2(buffer.end(i))]);
  return out;
}) ?? [];

// État des SourceBuffer vus par hls.js : plages décodées par piste et
// métadonnées de chaque buffer (mise à jour, mode, fenêtre d'ajout, offset).
// `audiovideo` (piste multiplexée) est rapportée sous `video` ; une seconde
// piste audio devient `audio2`.
export function sourceBufferState(hls) {
  const out = { sb: [] };
  let audio = 0;
  for (const [type, sb] of g(() => hls?.bufferController?.sourceBuffers) ?? []) {
    if (!type || !sb) continue;
    const key = type === 'audiovideo' ? 'video' : type === 'audio' && audio++ ? 'audio2' : type;
    out[key] = rangesOf(g(() => sb.buffered));
    out.sb.push({ n: type, updating: g(() => sb.updating) || undefined, mode: g(() => sb.mode),
      aws: r2(g(() => sb.appendWindowStart)), awe: r2(g(() => sb.appendWindowEnd)), to: r2(g(() => sb.timestampOffset)) });
  }
  return out;
}

// Plages par piste au moment de l'appel : c'est la lecture qui sépare un ajout
// refusé d'un fragment marqué puis sauté. Sans SourceBuffer (natif, test) la
// valeur est absente.
const trackRanges = hls => {
  const state = sourceBufferState(hls);
  delete state.sb;
  return Object.keys(state).length ? state : undefined;
};

const fragFields = frag => frag ? {
  level: frag.level, sn: frag.sn, start: r2(frag.start), end: r2(frag.end), track: frag.type,
} : {};

// Durée d'une étape LoaderStats (loading, parsing, buffering…), en ms réels.
const stepMs = (stats, key) => g(() =>
  Number.isFinite(stats?.[key]?.end) && Number.isFinite(stats?.[key]?.start)
    ? Math.round(stats[key].end - stats[key].start) : undefined);

// Les niveaux du master : débit, définition et codecs pour comparer au poste.
const levelFields = levels => Array.isArray(levels) ? levels.map(level => ({
  bitrate: level.bitrate, w: level.width, h: level.height,
  codecs: level.attrs?.CODECS ?? level.codecs, td: r2(level.details?.targetDuration),
})) : undefined;

// name : clé de window.Hls.Events (MEDIA_ATTACHED, FRAG_BUFFERED, …).
// Retourne les champs de l'événement `hls`, ou null pour un nom non suivi.
export function hlsEventPayload(name, data = {}, hls) {
  const frag = data.frag ?? data.part?.frag;
  switch (name) {
    case 'MEDIA_ATTACHED':
      return { ev: 'media-attached', ms: undefined };
    case 'MANIFEST_PARSED':
      return { ev: 'manifest-parsed', levels: levelFields(data.levels),
        audio: Array.isArray(data.audioTracks) ? data.audioTracks.length : undefined,
        subtitles: Array.isArray(data.subtitleTracks) ? data.subtitleTracks.length : undefined };
    case 'LEVEL_LOADED':
      return { ev: 'level-loaded', level: data.level, td: r2(data.details?.targetDuration),
        total: r2(data.details?.totalduration), ms: stepMs(data.stats, 'loading') };
    case 'LEVEL_SWITCHED':
      return { ev: 'level-switched', level: data.level };
    case 'FRAG_LOADING':
      return { ev: 'frag-loading', ...fragFields(frag) };
    case 'FRAG_LOADED':
      return { ev: 'frag-loaded', ...fragFields(frag), ms: stepMs(frag?.stats, 'loading') ?? stepMs(data.stats, 'loading'),
        bytes: g(() => frag?.stats?.loaded?.total) ?? g(() => data.stats?.loaded?.total) ?? g(() => data.payload?.byteLength) };
    case 'FRAG_BUFFERED':
      return { ev: 'frag-buffered', ...fragFields(frag), ms: stepMs(frag?.stats, 'buffering'), tracks: trackRanges(hls) };
    case 'FRAG_CHANGED':
      return { ev: 'frag-changed', ...fragFields(frag) };
    case 'BUFFER_APPENDED':
      // data.timeRanges : pseudo-TimeRanges par type de piste au moment du push.
      return { ev: 'buffer-appended', track: data.type,
        tracks: g(() => Object.fromEntries(Object.entries(data.timeRanges ?? {}).map(([key, buffer]) => [key, rangesOf(buffer)]))) };
    case 'BUFFER_FLUSHING':
      // Plages encore présentes avant le vidage ; BUFFER_FLUSHED porte l'après.
      return { ev: 'buffer-flushing', start: r2(data.startOffset), end: r2(data.endOffset), track: data.type, tracks: trackRanges(hls) };
    case 'BUFFER_FLUSHED':
      return { ev: 'buffer-flushed', start: r2(data.startOffset), end: r2(data.endOffset), track: data.type, tracks: trackRanges(hls) };
    case 'BUFFER_EOS':
      return { ev: 'buffer-eos' };
    case 'BUFFER_CODECS':
      return { ev: 'buffer-codecs', tracks: g(() => Object.fromEntries(Object.entries(data).map(([key, track]) => [key, track?.codec ?? track?.container]))) };
    default:
      return null;
  }
}

// Erreur hls.js (fatale ou non) : type/détails plus le fragment et les plages
// en cause, pour confronter l'échec au tampon réel du poste.
export function hlsErrorPayload(data = {}, hls) {
  const frag = data.frag ?? data.part?.frag;
  const media = g(() => hls?.media);
  const buffered = rangesOf(media?.buffered);
  const head = buffered.length ? buffered[buffered.length - 1][1] : undefined;
  const time = g(() => media?.currentTime);
  return {
    type: data.type, details: data.details, fatal: data.fatal,
    reason: data.reason ?? g(() => data.error?.name), errmsg: g(() => data.error?.message)?.slice(0, 300),
    level: frag?.level ?? data.level?.level ?? data.level, sn: frag?.sn,
    start: r2(frag?.start), end: r2(frag?.end),
    bytes: g(() => frag?.stats?.loaded?.total) ?? g(() => data.stats?.loaded?.total),
    ranges: buffered.length ? buffered : undefined,
    sbranges: trackRanges(hls),
    bufferLen: r2(Number.isFinite(head) && Number.isFinite(time) ? head - time : undefined),
  };
}
