#!/usr/bin/env node
// Détecte et répare les PTS dupliquées des segments HLS fMP4 et les jointures
// où un fragment déborde sur le suivant (src/hls-pts.js, docs/playback.md).
// Lecture seule par défaut :
//   node scripts/repair-hls-pts.mjs --check data/movies    # toute la bibliothèque
//   node scripts/repair-hls-pts.mjs --fix --journal rep.jsonl <dossier|*.m4s>...
// Après une réparation de médias publiés, les clients sont invalidés par
// l'ETag lié au contenu (taille + mtime, cf. src/app.js) ; changer
// movie.generation force un reset dur.
import { readdir, readFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanSegment, scanFile, repairFile, repairSeams } from '../src/hls-pts.js';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const dryRun = args.includes('--dry-run');
const journal = args.includes('--journal') ? args[args.indexOf('--journal') + 1] : null;
const targets = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--journal');
if (!targets.length) {
  console.error('usage : repair-hls-pts.mjs [--check|--fix] [--dry-run] [--journal f.jsonl] <dossier|segment.m4s>...');
  process.exit(2);
}

// Les .m4s, récursivement : la bibliothèque vit en data/movies/<id>/<génération>/.
async function segments(target) {
  if (!(await stat(target)).isDirectory()) return [target];
  const found = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const file = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...await segments(file));
    else if (entry.name.endsWith('.m4s')) found.push(file);
  }
  return found.sort();
}

// Le timescale du trak vit dans le mdhd de l'init_N.mp4 du même dossier.
const initCache = new Map();
async function timescaleOf(file) {
  const dir = path.dirname(file);
  if (!initCache.has(dir)) {
    const timescales = {};
    for (const entry of await readdir(dir)) {
      const match = entry.match(/^init_(\d+)\.mp4$/);
      if (match) timescales[match[1]] = scanSegment(await readFile(path.join(dir, entry))).timescale;
    }
    initCache.set(dir, timescales);
  }
  const timescales = initCache.get(dir);
  const variant = path.basename(file).match(/^segment_(\d+)_/)?.[1];
  return timescales[variant] ?? Object.values(timescales)[0] ?? null;
}

let seen = 0, dupSegments = 0, dupTotal = 0, patchedFields = 0, left = 0;
const variants = new Map();
for (const target of targets) {
  for (const file of await segments(target)) {
    seen++;
    const timescale = await timescaleOf(file);
    const { patches = [], collisions, remaining = [] } = fix
      ? await repairFile(file, { timescale, dryRun })
      : { collisions: (await scanFile(file)).collisions };
    dupTotal += collisions.length; left += remaining.length; patchedFields += patches.length;
    if (collisions.length) {
      dupSegments++;
      const pairs = collisions.map(c => `${c.i}<->${c.j} pts=${c.pts}`).join(', ');
      console.log(`${file}: ${collisions.length} doublon(s) [${pairs}]` +
        (fix ? ` -> ${patches.length} cto décalé(s)${dryRun ? ' (dry-run)' : ''}` : ''));
      if (journal && patches.length && !dryRun) {
        for (const p of patches) await appendFile(journal, JSON.stringify({ file, ...p }) + '\n');
      }
    }
    for (const c of remaining) console.log(`${file}: doublon RESTANT ${c.i}<->${c.j} pts=${c.pts}`);
    // Les jointures se lisent par paires, une fois chaque variante complète.
    const variant = `${path.dirname(file)}/${path.basename(file).match(/^segment_(\d+)_/)?.[1] ?? ''}`;
    if (!variants.has(variant)) variants.set(variant, []);
    variants.get(variant).push(file);
  }
}
console.log(`${seen} segment(s), ${dupSegments} avec PTS dupliquées (${dupTotal} doublon(s))` +
  (fix ? `, ${patchedFields} champ(s) cto réécrit(s)${dryRun ? ' — dry-run, rien écrit' : ''}` : ''));

let seamTotal = 0, seamFields = 0, seamLeft = 0;
for (const files of variants.values()) {
  for (const seam of await repairSeams(files.sort(), { dryRun: !fix || dryRun })) {
    seamTotal++; seamLeft += seam.remaining ? 1 : 0;
    if (fix) seamFields += seam.patches.length;
    console.log(`${seam.file}: déborde de ${seam.overlap} tick(s) sur le fragment suivant` +
      (fix ? ` -> ${seam.patches.length} champ(s) réécrit(s)${dryRun ? ' (dry-run)' : ''}` : ''));
    if (fix && journal && seam.patches.length && !dryRun) {
      for (const p of seam.patches) await appendFile(journal, JSON.stringify({ file: seam.file, ...p }) + '\n');
    }
  }
}
console.log(`${seamTotal} jointure(s) débordante(s)` +
  (fix ? `, ${seamFields} champ(s) de jointure réécrit(s)${dryRun ? ' — dry-run, rien écrit' : ''}` : ''));
process.exit(fix ? (left || seamLeft ? 1 : 0) : (dupTotal || seamTotal ? 1 : 0));
