// Recognise a PGS subtitle track of a film and write the text track beside it.
//
//   node scripts/ocr-pgs.js <film> [<stream ordinal>] [--out <file.vtt>]
//
// With no ordinal, the subtitle tracks are listed with their ordinals. The result
// is a WebVTT file the administrator can add to the film as any other subtitle.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeFile } from '../src/media.js';
import { ocrSubtitleTrack } from '../src/pgs-ocr.js';
import { serializeVtt } from '../public/subtitle-timing.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', short: 'o' } },
});
const [film, ordinal] = positionals;
if (!film) {
  console.error('usage: node scripts/ocr-pgs.js <film> [<stream ordinal>] [--out <file.vtt>]');
  process.exit(2);
}

const probe = await probeFile(film);
if (probe.subtitles.length === 0) {
  console.error('Aucune piste de sous-titres dans ce fichier.');
  process.exit(1);
}
if (ordinal === undefined) {
  for (const [index, track] of probe.subtitles.entries()) {
    console.log(`${index}  ${track.codec}  ${track.language ?? 'und'}  ${track.title ?? ''}  ${track.compatible ? 'texte' : 'image'}`);
  }
  process.exit(0);
}

const position = Number(ordinal);
const track = probe.subtitles[position];
if (!track) {
  console.error(`Piste ${ordinal} inconnue.`);
  process.exit(1);
}

let previous = -1;
const started = Date.now();
const { cues, displaySets, images } = await ocrSubtitleTrack(film, position, {
  duration: probe.duration,
  temporaryDirectory: process.env.TMPDIR,
  onProgress: (done, total) => {
    const percent = Math.floor(done / total * 100);
    if (percent !== previous && percent % 5 === 0) {
      previous = percent;
      const elapsed = (Date.now() - started) / 1000;
      process.stderr.write(`\r${percent}% (${done}/${total} images, ${elapsed.toFixed(0)}s)`);
    }
  },
});
process.stderr.write('\n');

const destination = values.out ?? path.join(path.dirname(film),
  `${path.basename(film, path.extname(film))}.${track.language ?? 'und'}.vtt`);
await writeFile(destination, serializeVtt(cues));
console.log(`${cues.length} répliques reconnues sur ${images} images (${displaySets} display sets) → ${destination}`);
