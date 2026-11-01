// ffmpeg écrase le cto du premier échantillon d'un fragment fMP4 quand la
// segmentation HLS démarre sur une keyframe suivie d'images leading (open
// GOP) : la keyframe est présentée après elles, son cto est ramené sur la
// plus petite PTS du fragment et deux échantillons se retrouvent avec la
// même PTS. Chrome/MSE rejette alors tout l'append, sans erreur. Décaler le
// cto fautif d'une milliseconde rend les PTS distinctes. Voir docs/playback.md.
import { open, readFile, writeFile, rename } from 'node:fs/promises';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'moof', 'traf', 'mvex', 'mfra', 'stbl']);

function* boxes(buf, start = 0, end = buf.length) {
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at), head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
    else if (size === 0) size = end - at;
    if (size < head || at + size > end) break;
    yield { type: buf.toString('latin1', at + 4, at + 8), off: at, size, head };
    at += size;
  }
}

function* walk(buf, start, end) {
  for (const box of boxes(buf, start, end)) {
    yield box;
    if (CONTAINERS.has(box.type)) yield* walk(buf, box.off + box.head, box.off + box.size);
  }
}

// Pas de mdhd dans un segment seul : il faut l'init pour connaître le timescale.
function mdhdTimescale(buf) {
  for (const box of walk(buf, 0, buf.length)) {
    if (box.type !== 'mdhd') continue;
    return buf.readUInt32BE(box.off + box.head + (buf[box.off + box.head] === 1 ? 20 : 12));
  }
  return null;
}

function tfdtBase(buf, tfdt) {
  const at = tfdt.off + tfdt.head;
  return buf[at] === 1 ? Number(buf.readBigUInt64BE(at + 4)) : buf.readUInt32BE(at + 4);
}

// Repli quand le trun ne porte pas de durées : tfhd flag 0x08.
function tfhdDefaultDuration(buf, tfhd) {
  const flags = buf.readUInt32BE(tfhd.off + tfhd.head) & 0xffffff;
  let at = tfhd.off + tfhd.head + 8;
  if (flags & 0x01) at += 8;
  if (flags & 0x02) at += 4;
  return flags & 0x08 ? buf.readUInt32BE(at) : 0;
}

// Chaque échantillon de chaque traf de chaque moof, avec la position absolue
// de ses champs durée et cto (ou -1 si le trun ne les porte pas).
function fragmentSamples(buf) {
  const samples = [];
  let traf = -1;
  for (const box of walk(buf, 0, buf.length)) {
    if (box.type !== 'traf') continue;
    traf++;
    let base = 0, defaultDuration = 0;
    const truns = [];
    for (const child of boxes(buf, box.off + box.head, box.off + box.size)) {
      if (child.type === 'tfhd') defaultDuration = tfhdDefaultDuration(buf, child);
      else if (child.type === 'tfdt') base = tfdtBase(buf, child);
      else if (child.type === 'trun') truns.push(child);
    }
    let dts = base;
    for (const trun of truns) {
      const head = trun.off + trun.head;
      const version = buf[head], flags = buf.readUInt32BE(head) & 0xffffff;
      let at = head + 4;
      const count = buf.readUInt32BE(at); at += 4;
      if (flags & 0x01) at += 4; // data_offset
      if (flags & 0x04) at += 4; // first_sample_flags
      for (let i = 0; i < count; i++) {
        const sample = { traf, dur: defaultDuration, durAt: -1, cto: 0, ctoAt: -1, ctoSigned: version === 1 };
        if (flags & 0x100) { sample.durAt = at; sample.dur = buf.readUInt32BE(at); at += 4; }
        if (flags & 0x200) at += 4; // sample_size
        if (flags & 0x400) at += 4; // sample_flags
        if (flags & 0x800) {
          sample.ctoAt = at;
          sample.cto = version === 1 ? buf.readInt32BE(at) : buf.readUInt32BE(at);
          at += 4;
        }
        sample.pts = dts + sample.cto;
        dts += sample.dur;
        samples.push(sample);
      }
    }
  }
  return samples;
}

function collisionsOf(samples) {
  const seen = new Map(), collisions = [];
  samples.forEach((sample, i) => {
    if (seen.has(sample.pts)) collisions.push({ i, j: seen.get(sample.pts), pts: sample.pts });
    else seen.set(sample.pts, i);
  });
  return collisions;
}

export function scanSegment(buf) {
  const samples = fragmentSamples(buf);
  const collisions = collisionsOf(samples);
  return { timescale: mdhdTimescale(buf), count: samples.length, collisions, ok: samples.length > 0 && !collisions.length };
}

// La réparation validée dans Chrome : +1 ms (round(timescale/1000), repli 16
// ticks) sur le cto de l'échantillon en collision, recalculé jusqu'à 8 fois.
// Seuls ces champs de 4 octets sont réécrits.
export function repairSegment(buf, { timescale } = {}) {
  const step = Math.round((timescale ?? mdhdTimescale(buf) ?? 16000) / 1000) || 16;
  const fixed = Buffer.from(buf);
  const patches = [];
  let samples = fragmentSamples(fixed);
  let collisions = collisionsOf(samples);
  const detected = collisions;
  for (let iteration = 0; collisions.length && iteration < 8; iteration++) {
    let touched = false;
    for (const i of new Set(collisions.map(({ i }) => i))) {
      const { ctoAt, cto: before } = samples[i];
      if (ctoAt < 0) continue;
      const after = before + step;
      fixed.writeUInt32BE(after >>> 0, ctoAt);
      patches.push({ offset: ctoAt, before, after });
      touched = true;
    }
    if (!touched) break;
    samples = fragmentSamples(fixed);
    collisions = collisionsOf(samples);
  }
  return { buf: fixed, patches, collisions: detected, remaining: collisions };
}

// Les tables du trun vivent dans le moof, avant le mdat qui porte la masse du
// segment : lire jusqu'à la fin du moof suffit. Les offsets restent ceux du
// fichier, la tête commençant à l'octet 0.
async function readHead(handle) {
  const head = Buffer.alloc(16);
  let at = 0, end = 0;
  while (end === 0) {
    const { bytesRead } = await handle.read(head, 0, 16, at);
    if (bytesRead < 8) break;
    let size = head.readUInt32BE(0);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = (await handle.stat()).size - at;
    if (size < 8) break;
    at += size;
    if (head.toString('latin1', 4, 8) === 'moof') end = at;
  }
  const buf = Buffer.alloc(end);
  const { bytesRead } = await handle.read(buf, 0, end, 0);
  return bytesRead === end ? buf : Buffer.alloc(0);
}

export async function scanFile(file) {
  const handle = await open(file, 'r');
  try { return scanSegment(await readHead(handle)); } finally { await handle.close(); }
}

// Réécriture atomique (fichier temporaire dans le même dossier puis rename),
// seulement quand le scan d'en-tête trouve des doublons.
export async function repairFile(file, { timescale, dryRun } = {}) {
  if (!(await scanFile(file)).collisions.length) return { patches: [], collisions: [], remaining: [] };
  const { buf, patches, collisions, remaining } = repairSegment(await readFile(file), { timescale });
  if (patches.length && !dryRun) {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
  }
  return { patches, collisions, remaining };
}

// Jointures entre fragments. ffmpeg écrit la durée d'un échantillon comme
// l'écart de DTS avec le suivant, alors que l'écart de PTS peut différer d'un
// tick de source (horodatage à la milliseconde d'un MKV : 656/672/688 ticks à
// 16000 Hz). La dernière image présentée d'un fragment peut alors finir 1 ms
// APRÈS la keyframe du fragment suivant. Joués dans l'ordre, rien ne se voit ;
// mais quand hls.js ajoute un fragment devant un voisin déjà tamponné (seek en
// arrière, rechargement d'un fragment), le retrait des images recouvertes
// (MSE, « coded frame removal ») efface cette keyframe et toutes les images
// qui en dépendent : le fragment voisin entier disparaît sous Firefox, le
// suivant sous Chrome, et la lecture bute sur le trou. Voir docs/playback.md.

export const presentationTimes = buf => fragmentSamples(buf).map(sample => sample.pts);

// Plus petite PTS du fragment : là où commence sa présentation.
export function fragmentStart(buf) {
  const samples = fragmentSamples(buf);
  return samples.length ? Math.min(...samples.map(sample => sample.pts)) : null;
}

// Ramène la fin de présentation de chaque échantillon sur `nextStart`, le début
// du fragment suivant. La durée raccourcie fait reculer la DTS des échantillons
// suivants ; leur cto grandit d'autant, donc aucune PTS ne bouge. Seuls des
// champs de 4 octets du trun changent ; un second passage ne change rien.
export function trimSeam(buf, nextStart) {
  const fixed = Buffer.from(buf);
  const patches = [];
  let samples = fragmentSamples(fixed);
  const overlap = Math.max(0, ...samples.map(sample => sample.pts + sample.dur - nextStart));
  const trafs = new Set(samples.map(sample => sample.traf));
  // Une seule piste par segment ici ; plusieurs traf n'auraient pas de début commun.
  if (!Number.isFinite(nextStart) || trafs.size !== 1) return { buf: fixed, patches, overlap, remaining: overlap };
  for (let guard = 0; guard < samples.length; guard++) {
    const index = samples.findIndex(sample => sample.pts + sample.dur > nextStart);
    if (index < 0) break;
    const sample = samples[index], excess = sample.pts + sample.dur - nextStart;
    const later = samples.slice(index + 1);
    if (sample.durAt < 0 || sample.dur <= excess || later.some(next => next.ctoAt < 0)) break;
    fixed.writeUInt32BE(sample.dur - excess, sample.durAt);
    patches.push({ offset: sample.durAt, before: sample.dur, after: sample.dur - excess });
    for (const next of later) {
      fixed.writeUInt32BE((next.cto + excess) >>> 0, next.ctoAt);
      patches.push({ offset: next.ctoAt, before: next.cto >>> 0, after: (next.cto + excess) >>> 0 });
    }
    samples = fragmentSamples(fixed);
  }
  const remaining = Math.max(0, ...samples.map(sample => sample.pts + sample.dur - nextStart));
  return { buf: fixed, patches, overlap, remaining };
}

// Les segments d'une même variante, dans l'ordre de lecture. Chaque champ
// patché est réécrit en place (4 octets) : le mdat de plusieurs Mo ne bouge pas.
export async function repairSeams(files, { dryRun } = {}) {
  const heads = [];
  for (const file of files) {
    const handle = await open(file, 'r');
    try { heads.push(await readHead(handle)); } finally { await handle.close(); }
  }
  const seams = [];
  for (let i = 0; i + 1 < files.length; i++) {
    const nextStart = fragmentStart(heads[i + 1]);
    const { patches, overlap, remaining } = trimSeam(heads[i], nextStart);
    if (!overlap) continue;
    seams.push({ file: files[i], overlap, remaining, patches });
    if (!patches.length || dryRun) continue;
    const handle = await open(files[i], 'r+');
    try {
      for (const { offset, after } of patches) {
        const field = Buffer.alloc(4); field.writeUInt32BE(after >>> 0);
        await handle.write(field, 0, 4, offset);
      }
    } finally { await handle.close(); }
  }
  return seams;
}
