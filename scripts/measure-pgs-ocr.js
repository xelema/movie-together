// Measure what the PGS recognition actually produces, against the text track of the
// same film. The witness for a change of model or preprocessing: run it before and
// after, and let it fail when the fidelity drops past the threshold.
//
//   node scripts/measure-pgs-ocr.js <film> [--pgs <ordinal>] [--reference <ordinal>]
//                                   [--max <percent>] [--window <seconds>]
//
// The reference defaults to a text track of the same language as the PGS track: the
// two are different editions of the same subtitles, so compare cues loosely (a window)
// and read the mean, not a single pair.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { probeFile } from '../src/media.js';
import { ocrSubtitleTrack } from '../src/pgs-ocr.js';
import { parseVtt } from '../public/subtitle-timing.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  pgs: { type: 'string' }, reference: { type: 'string' }, max: { type: 'string', default: '15' },
  window: { type: 'string', default: '6' }, out: { type: 'string', short: 'o' },
} });
const [film] = positionals;
if (!film) {
  console.error('usage: node scripts/measure-pgs-ocr.js <film> [--pgs <ordinal>] [--reference <ordinal>] [--max <percent>]');
  process.exit(2);
}

const probe = await probeFile(film);
const subtitles = probe.subtitles;
if (values.pgs === undefined) {
  for (const [ordinal, track] of subtitles.entries()) {
    console.log(`${ordinal}  ${track.codec}  ${track.language}  ${track.label}  ` +
      `${track.compatible ? 'texte' : track.recognisable ? 'image, relisible' : 'illisible'}`);
  }
  process.exit(0);
}

const pgs = subtitles[Number(values.pgs)];
if (!pgs?.recognisable) {
  console.error(`La piste ${values.pgs} n'est pas une piste image relisible.`);
  process.exit(2);
}
const reference = values.reference !== undefined ? subtitles[Number(values.reference)]
  : subtitles.find(track => track.compatible && track.language === pgs.language);
if (!reference?.compatible) {
  console.error('Aucune piste texte de référence : donnez --reference, ou rien à mesurer.');
  process.exit(2);
}

// The reference comes out of the film itself, in its own demuxer.
const referenceText = await new Promise((resolve, reject) => {
  execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', film,
    '-map', `0:s:${subtitles.indexOf(reference)}`, '-c:s', 'webvtt', '-f', 'webvtt', '-'],
  { maxBuffer: 1 << 28 }, (error, stdout, stderr) =>
    error ? reject(new Error(stderr?.trim() || error.message)) : resolve(stdout));
});

let previous = -1;
const started = Date.now();
const { cues } = await ocrSubtitleTrack(film, Number(values.pgs), { duration: probe.duration,
  temporaryDirectory: process.env.TMPDIR,
  onProgress: (done, total) => {
    const percent = Math.floor(done / total * 100);
    if (percent !== previous && percent % 10 === 0) {
      previous = percent;
      process.stderr.write(`\r${percent}% (${done}/${total} images, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  } });
process.stderr.write('\n');

const referenceCues = parseVtt(referenceText);
const words = text => text.replace(/<[^>]+>/g, ' ').replace(/[♪♩]/g, ' ')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
const characters = text => [...text.replace(/<[^>]+>/g, ' ').replace(/[♪♩]/g, ' ')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()];

function distance(from, to) {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let row = 1; row <= from.length; row++) {
    const current = [row];
    for (let column = 1; column <= to.length; column++) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
        previous[column - 1] + (from[row - 1] === to[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[to.length];
}
const rate = (reference, produced, split) => {
  const a = split(reference), b = split(produced);
  return a.length ? distance(a, b) / a.length : 0;
};

const window = Number(values.window);
const scored = [];
for (const cue of cues) {
  const nearby = referenceCues.filter(item => Math.abs(item.start - cue.start) <= window);
  if (!nearby.length) continue;
  let best = null;
  for (const item of nearby) {
    const score = rate(item.text, cue.text, characters);
    if (!best || score < best.character) best = { character: score, word: rate(item.text, cue.text, words), cue: item };
  }
  // The reference cue must not overwrite the recognised one: the report shows both.
  scored.push({ cue, reference: best.cue, character: best.character, word: best.word });
}
scored.sort((a, b) => b.character - a.character);

const mean = list => list.reduce((total, value) => total + value, 0) / Math.max(1, list.length);
const charactersRate = mean(scored.map(item => item.character));
const wordsRate = mean(scored.map(item => item.word));
const under = limit => scored.filter(item => item.character <= limit).length;

console.log(`${film}`);
console.log(`  piste PGS ${values.pgs} (${pgs.label}) contre ${subtitles.indexOf(reference)} (${reference.label})`);
console.log(`  répliques reconnues ${cues.length}, comparées ${scored.length}, références ${referenceCues.length}`);
console.log(`  CER moyen ${(charactersRate * 100).toFixed(2)} % · WER moyen ${(wordsRate * 100).toFixed(2)} %`);
console.log(`  CER sous 5 % : ${under(0.05)} · sous 10 % : ${under(0.1)} · sous 20 % : ${under(0.2)}`);
console.log('  pires écarts :');
for (const item of scored.slice(0, 5)) {
  console.log(`    [${item.cue.start.toFixed(2)}] CER ${(item.character * 100).toFixed(0)} %`);
  console.log(`      reconnu : ${item.cue.text.replace(/\n/g, ' | ').slice(0, 100)}`);
  console.log(`      référence : ${item.reference.text.replace(/\n/g, ' | ').slice(0, 100)}`);
}

const limit = Number(values.max) / 100;
if (charactersRate > limit) {
  console.error(`\nCER moyen ${(charactersRate * 100).toFixed(2)} % au-dessus du seuil ${values.max} %.`);
  process.exit(1);
}
console.log(`\nCER moyen sous le seuil de ${values.max} %.`);
