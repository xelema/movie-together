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
// de son champ cto (ou -1 si le trun ne le porte pas).
function fragmentSamples(buf) {
  const samples = [];
  for (const box of walk(buf, 0, buf.length)) {
    if (box.type !== 'traf') continue;
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
        const sample = { dur: defaultDuration, cto: 0, ctoAt: -1 };
        if (flags & 0x100) { sample.dur = buf.readUInt32BE(at); at += 4; }
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
// segment : lire jusqu'à la fin du moof suffit pour scanner un fichier entier.
export async function scanFile(file) {
  const handle = await open(file, 'r');
  try {
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
    return scanSegment(bytesRead === end ? buf : Buffer.alloc(0));
  } finally { await handle.close(); }
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
