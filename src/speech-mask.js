// Masque de parole du film, par VAD neuronal (Silero) — le signal sur lequel
// src/subtitle-sync.js recale les répliques.
//
// Pourquoi un réseau et pas un seuil d'énergie : sur une bande son musicale,
// l'énergie ne distingue pas « on parle » de « il y a du son ». Mesuré sur un
// trailer à nappe continue, un seuil d'énergie annonçait 87 % de parole (contre
// 43 % en vrai) et la corrélation se trompait de 42 s ; le VAD neuronal la
// ramène à 0,08 s d'erreur. Le modèle pèse 2,3 Mo et tourne en pur Node, sans
// Python, sans torch et sans appel réseau.
//
// Contrat du modèle v5/v6, qui piège : chaque fenêtre de 512 échantillons (32 ms
// à 16 kHz) doit être précédée des 64 échantillons qui la précèdent dans le
// flux, soit une entrée de 576 ; un état récurrent [2,1,128] circule entre les
// fenêtres. Une boucle naïve en [1,512] ne sort pas d'erreur : elle rend une
// probabilité constante et un masque vide.

import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MODEL = fileURLToPath(new URL('./models/silero_vad.onnx', import.meta.url));
const RATE = 16000, WINDOW = 512, CONTEXT = 64;
const HOP = WINDOW / RATE;                       // 32 ms
const THRESHOLD = 0.5, RELEASE = 0.35;
const MIN_SPEECH = 0.25, MIN_SILENCE = 0.1, PAD = 0.03;

let loading = null;
// Chargé à la première analyse : un binaire absent ne doit pas empêcher
// l'application de démarrer, l'erreur remonte alors sur la route concernée.
const session = () => (loading ??= import('onnxruntime-node').then(async ort => ({
  ort, run: await ort.InferenceSession.create(MODEL),
})));

// Fenêtres de parole depuis les probabilités, avec les mêmes réglages que
// silero_vad.get_speech_timestamps : seuil haut pour entrer, seuil bas pour
// sortir, les silences courts ne coupent pas une prise de parole.
function toIntervals(probs) {
  const minSpeech = MIN_SPEECH / HOP, minSilence = MIN_SILENCE / HOP, pad = PAD / HOP;
  const spans = [];
  let start = -1, silence = 0;
  for (let index = 0; index < probs.length; index++) {
    if (start < 0) { if (probs[index] >= THRESHOLD) { start = index; silence = 0; } continue; }
    if (probs[index] < RELEASE) {
      if (++silence >= minSilence) {
        if (index - silence - start >= minSpeech) spans.push([start, index - silence + 1]);
        start = -1; silence = 0;
      }
    } else silence = 0;
  }
  if (start >= 0 && probs.length - start >= minSpeech) spans.push([start, probs.length]);
  // Le remplissage ne doit pas faire chevaucher deux prises de parole voisines.
  return spans.map(([from, to], index) => ({
    start: Math.max(index ? spans[index - 1][1] + pad : 0, from - pad) * HOP,
    end: Math.min(index + 1 < spans.length ? spans[index + 1][0] - pad : probs.length, to + pad) * HOP,
  })).map(({ start, end }) => ({ start: +start.toFixed(3), end: +end.toFixed(3) }));
}

// Analyse la piste audio `index` du fichier `source` en flux : ffmpeg écrit du
// PCM 16 kHz mono sur sa sortie standard, qui est découpée en fenêtres au fil
// de l'eau — jamais 230 Mo de WAV intermédiaire sur le disque.
//
// `cache` (facultatif) : chemin d'un fichier JSON où garder le masque. Il ne
// dépend que de la piste audio, et le recalculer coûte ~4 min sur un film de
// 2 h contre quelques millisecondes de lecture. À placer dans le dossier de la
// génération courante : le film re-préparé change de génération et l'ancien
// dossier est supprimé, donc le cache ne peut pas survivre à un nouveau source.
export async function speechMask(source, { index = 0, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', signal, cache } = {}) {
  if (cache) {
    const kept = await readFile(cache, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (Array.isArray(kept?.intervals)) return kept;
  }
  const { ort, run } = await session();
  const process_ = spawn(ffmpeg, ['-v', 'error', '-i', source, '-map', `0:${index}`,
    '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { signal });
  const errors = [];
  process_.stderr.on('data', chunk => errors.push(chunk));
  // Un ffmpeg introuvable n'émet ni 'close' ni données : sans ce rejet, la
  // promesse ne se réglerait jamais et l'analyse resterait « en cours » à vie.
  const failed = new Promise((_, reject) => process_.once('error', error =>
    reject(Object.assign(new Error(`ffmpeg : ${error.message}`), { status: 500 }))));
  // Enregistré au spawn, pas après la lecture du flux : un process qui sort
  // avant qu'on s'abonne émettrait 'close' dans le vide et l'attente pendrait.
  const closed = new Promise(resolve => process_.once('close', resolve));
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  let context = new Float32Array(CONTEXT);
  let tail = new Float32Array(0), carry = Buffer.alloc(0), samples = 0;
  const probs = [];
  const feed = async chunk => {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buffer.length - (buffer.length % 2);
    carry = buffer.subarray(usable);
    if (!usable) return;
    const block = new Float32Array(usable / 2);
    for (let i = 0; i < block.length; i++) block[i] = buffer.readInt16LE(i * 2) / 32768;
    samples += block.length;
    const joined = new Float32Array(tail.length + block.length);
    joined.set(tail); joined.set(block, tail.length);
    let at = 0;
    for (; at + WINDOW <= joined.length; at += WINDOW) {
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(context, 0);
      input.set(joined.subarray(at, at + WINDOW), CONTEXT);
      const out = await run.run({ input: new ort.Tensor('float32', input, [1, CONTEXT + WINDOW]), state, sr });
      probs.push(out.output.data[0]);
      state = out.stateN;
      context = input.slice(WINDOW);
    }
    tail = joined.slice(at);
  };
  await Promise.race([(async () => { for await (const chunk of process_.stdout) await feed(chunk); })(), failed]);
  const code = await Promise.race([closed, failed]);
  if (code !== 0) {
    const detail = Buffer.concat(errors).toString().trim().split('\n').pop();
    throw Object.assign(new Error(detail || 'Piste audio illisible.'), { status: 400 });
  }
  const duration = samples / RATE;
  const intervals = toIntervals(probs);
  const spoken = intervals.reduce((total, item) => total + item.end - item.start, 0);
  const result = { intervals, duration, speechRatio: duration ? spoken / duration : 0 };
  // Un cache qu'on n'a pas su écrire ne doit jamais faire échouer l'analyse.
  if (cache) await writeFile(`${cache}.tmp`, JSON.stringify(result)).then(() => rename(`${cache}.tmp`, cache)).catch(() => {});
  return result;
}
