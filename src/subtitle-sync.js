// Recalage global du timing d'une piste de sous-titres sur la bande son.
//
// Le principe : les répliques d'un sous-titre collent aux prises de parole du
// film. On construit donc deux signaux binaires au même pas — « une réplique
// est affichée » et « on parle » — et on cherche le décalage qui les fait le
// mieux coïncider. Le VAD neuronal (src/speech-mask.js) fournit le second ;
// ce module est pur, sans E/S, donc éprouvable sur des signaux fabriqués.
//
// Un décalage global suffit dans la quasi-totalité des cas réels : différence
// d'intro de studio, conversion 23,976/24/25 i/s, rip recoupé. Le recalage
// réplique par réplique déformerait la piste d'origine et demanderait une
// transcription complète — hors de propos ici.

export const HOP = 0.02;          // pas des enveloppes : 20 ms, sous l'image près
export const MAX_OFFSET = 60;     // amplitude annoncée : ±1 min
const COARSE = 0.1;               // balayage grossier au dixième avant l'affinage
const DISTINCT = 2;               // un pic à moins de 2 s est l'épaule du même pic
const MIN_CUES = 10;              // en deçà, aucun décalage n'est démontrable
const MIN_SPEECH = 5;             // secondes de parole nécessaires

const coverage = (signal, length) => {
  let on = 0;
  for (let i = 0; i < length; i++) if (signal[i]) on++;
  return length ? on / length : 0;
};

// « Une réplique est affichée » à l'instant t, au pas de l'enveloppe.
export function cueSignal(cues, length) {
  const signal = new Float64Array(length);
  for (const cue of cues) {
    const from = Math.max(0, Math.round(cue.start / HOP));
    const to = Math.min(length, Math.round(cue.end / HOP));
    for (let i = from; i < to; i++) signal[i] = 1;
  }
  return signal;
}

// « On parle » à l'instant t, depuis les intervalles du VAD.
export function speechSignal(intervals, length) {
  const signal = new Float64Array(length);
  for (const { start, end } of intervals) {
    const from = Math.max(0, Math.round(start / HOP));
    const to = Math.min(length, Math.round(end / HOP));
    for (let i = from; i < to; i++) signal[i] = 1;
  }
  return signal;
}

// Corrélation de Pearson sur la zone où les deux signaux se recouvrent.
function pearson(x, y, from, to) {
  let n = 0, sx = 0, sy = 0;
  for (let i = from; i < to; i++) { sx += x[i]; sy += y[i]; n++; }
  if (!n) return -1;
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = from; i < to; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : -1;
}

// Score d'un décalage o : une réplique à t doit se retrouver à t + o, donc on
// corrèle la présence des répliques décalée de o avec l'activité vocale.
function scoreAt(speech, cues, offset, hop) {
  const shift = Math.round(offset / hop), length = speech.length;
  let from = 0, to = length;
  if (shift > 0) from = shift; else to = length + shift;
  if (to - from < 4) return -1;
  const shifted = new Float64Array(length);
  for (let i = from; i < to; i++) shifted[i] = cues[i - shift];
  return pearson(shifted, speech, from, to);
}

// Deux passes : grossière au dixième sur toute l'amplitude, puis fine au pas de
// l'enveloppe autour des cinq meilleurs candidats distincts. Un pic grossier
// peut perdre après affinage : on tranche sur les scores fins.
function search(speech, cues, maxOffset) {
  const step = Math.round(COARSE / HOP);
  const coarseLength = Math.floor(speech.length / step);
  const coarseSpeech = new Float64Array(coarseLength), coarseCues = new Float64Array(coarseLength);
  for (let i = 0; i < coarseLength; i++) {
    let a = 0, c = 0;
    for (let j = 0; j < step; j++) { a += speech[i * step + j]; c += cues[i * step + j]; }
    coarseSpeech[i] = a / step; coarseCues[i] = c / step;
  }
  const ranked = [];
  for (let offset = -maxOffset; offset <= maxOffset; offset += COARSE) ranked.push([offset, scoreAt(coarseSpeech, coarseCues, offset, COARSE)]);
  ranked.sort((a, b) => b[1] - a[1]);
  const seeds = [];
  for (const [offset] of ranked) {
    if (seeds.every(seed => Math.abs(seed - offset) > DISTINCT)) seeds.push(offset);
    if (seeds.length === 5) break;
  }
  const refined = [];
  for (const seed of seeds) {
    let best = null;
    for (let offset = seed - COARSE; offset <= seed + COARSE + 1e-9; offset += HOP) {
      const score = scoreAt(speech, cues, offset, HOP);
      if (!best || score > best[1]) best = [+offset.toFixed(3), score];
    }
    if (best) refined.push(best);
  }
  refined.sort((a, b) => b[1] - a[1]);
  if (!refined.length) return { offset: 0, score: -1, second: -1, secondAt: null, peaks: [] };
  const second = refined.find(([offset]) => Math.abs(offset - refined[0][0]) > DISTINCT) ?? [null, -1];
  return { offset: refined[0][0], score: refined[0][1], second: second[1], secondAt: second[0], peaks: refined };
}

// Accord par tranches : le même décalage doit ressortir de chaque partie du
// film. Une tranche sans assez de répliques ne prouve rien et est écartée.
function agreement(speech, cues, offset, count = 8) {
  const span = Math.floor(speech.length / count), found = [];
  for (let index = 0; index < count; index++) {
    const from = index * span, to = index === count - 1 ? speech.length : from + span;
    const part = cues.subarray(from, to);
    let covered = 0, cues_ = 0;
    for (let i = 0; i < part.length; i++) if (part[i]) { covered++; if (i === 0 || !part[i - 1]) cues_++; }
    if (cues_ < 8 || covered / part.length < 0.05) { found.push(null); continue; }
    found.push(search(speech.subarray(from, to), part, Math.abs(offset) + 5).offset);
  }
  const valid = found.filter(value => value !== null);
  const near = valid.filter(value => Math.abs(value - offset) <= 0.25).length;
  return { chunks: found, valid: valid.length, near };
}

// Verdict lisible pour l'administrateur : un score net et un accord franc
// valent mieux qu'un pic isolé, et un doute se dit au lieu de se cacher.
function verdict({ score, second, near, valid }) {
  const margin = second < 0 ? score : score - second;
  const share = valid ? near / valid : null;
  if (score >= 0.5 && margin >= 0.12 && (share === null || share >= 0.75)) return 'high';
  if (score >= 0.35 && margin >= 0.06 && (share === null || share >= 0.5)) return 'medium';
  return 'low';
}

export function findOffset({ cues = [], speech = [], duration, maxOffset = MAX_OFFSET }) {
  const seconds = speech.reduce((total, item) => total + Math.max(0, item.end - item.start), 0);
  if (cues.length < MIN_CUES) return { offset: null, reason: 'too-few-cues', confidence: 'low' };
  if (seconds < MIN_SPEECH) return { offset: null, reason: 'no-speech', confidence: 'low' };
  const length = Math.max(
    Math.ceil((duration ?? 0) / HOP),
    Math.ceil(Math.max(...cues.map(cue => cue.end), ...speech.map(item => item.end)) / HOP) + 1);
  const speechEnvelope = speechSignal(speech, length);
  const cueEnvelope = cueSignal(cues, length);
  const { offset, score, second, secondAt, peaks } = search(speechEnvelope, cueEnvelope, maxOffset);
  const { chunks, valid, near } = agreement(speechEnvelope, cueEnvelope, offset);
  const confidence = verdict({ score, second, near, valid });
  return {
    offset, score: +score.toFixed(3), second: +second.toFixed(3), secondAt,
    margin: +(second < 0 ? score : score - second).toFixed(3),
    confidence, chunks, agreement: valid ? near / valid : null,
    candidates: peaks.filter(([, value]) => value > 0).map(([at, value]) => ({ offset: at, score: +value.toFixed(3) })),
    cueRatio: +coverage(cueEnvelope, length).toFixed(3),
    speechRatio: +coverage(speechEnvelope, length).toFixed(3),
  };
}
