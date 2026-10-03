// Timing des sous-titres, partagé serveur/client comme subtitle-formats.js :
// l'éditeur admin retime les cues, le serveur réécrit les .vtt en place.
// Fonctions pures, sans DOM ni dépendance Node.

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/;
const parseTime = value => {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, hours = '0', minutes, seconds, millis] = match;
  const result = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
  // Sans heures le champ minute peut dépasser 59 (MM:SS.mmm étendu).
  return Number.isFinite(result) ? result : null;
};

export function formatTimestamp(seconds) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(millis / 3600_000), m = Math.floor(millis / 60_000) % 60, s = Math.floor(millis / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
}

// Une cue garde ses réglages verbatim (position, align…) : retimer ne doit pas
// aplatir la mise en page qu'une conversion ASS a pu produire.
export function parseVtt(text) {
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '');
    if (!lines.length) continue;
    // NOTE peut s'étendre sur plusieurs lignes ; WEBVTT et son en-tête
    // (X-TIMESTAMP-MAP compris) ne portent aucune cue.
    if (/^(NOTE|STYLE|REGION|WEBVTT)/.test(lines[0])) continue;
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to = ''] = lines[timing].split('-->');
    const start = parseTime(from), [endPart, ...settings] = to.trim().split(/\s+/);
    const end = parseTime(endPart);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: lines.slice(timing + 1).join('\n'),
      ...(settings.length ? { settings: settings.join(' ') } : {}) });
  }
  return cues;
}

export function serializeVtt(cues, { timestampMap } = {}) {
  const head = ['WEBVTT'];
  if (timestampMap) head.push(`X-TIMESTAMP-MAP=${timestampMap}`);
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}${cue.settings ? ' ' + cue.settings : ''}`,
    cue.text].join('\n'));
  return `${head.join('\n')}\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

// Décalage d'une plage de répliques : toute la réplique bouge d'un bloc (sa
// durée est conservée) et aucune ne peut partir avant 0.
export function shiftCues(cues, delta, fromIndex = 0, toIndex = cues.length) {
  return cues.map((cue, index) => {
    if (index < fromIndex || index >= toIndex) return { ...cue };
    const start = Math.max(0, cue.start + delta);
    return { ...cue, start, end: start + (cue.end - cue.start) };
  });
}

export function cueIndexAt(cues, time) {
  return cues.findIndex(cue => cue.start <= time && time < cue.end);
}

// Garde-fou avant écriture : tri chronologique, pas de temps négatif, et une
// réplique doit durer au moins un centième de seconde pour rester valide.
// Une réplique qui déborde la fin du film est bornée ; une réplique entièrement
// au-delà est conservée telle quelle (un grand décalage reste réversible).
export function clampCues(cues, duration) {
  return cues
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end))
    .map(cue => {
      const start = Math.max(0, cue.start);
      const end = Number.isFinite(duration) && cue.end > duration && start < duration ? duration : cue.end;
      return { ...cue, start, end };
    })
    .filter(cue => cue.end - cue.start >= 0.01)
    .sort((a, b) => a.start - b.start);
}
