import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { scanSegment, repairSegment, scanFile } from '../src/hls-pts.js';

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../scripts/repair-hls-pts.mjs');

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; };
const box = (type, ...payload) => { const body = Buffer.concat(payload); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, version, flags, ...payload) => box(type, u32(((version & 0xff) << 24) | flags), ...payload);

// fMP4 minimal : styp + moof(mfhd, traf(tfhd, tfdt v1, trun dur|size|cto)) + mdat.
// entries = [{ dur, size, cto }] ; base = baseMediaDecodeTime du tfdt.
function segment(entries, base = 0) {
  const trun = full('trun', 0, 0x0b05, u32(entries.length), u32(0), u32(0x02000000),
    ...entries.flatMap(e => [u32(e.dur), u32(e.size), u32(e.cto)]));
  const traf = box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u32(Math.floor(base / 2 ** 32)), u32(base)), trun);
  const moof = box('moof', full('mfhd', 0, 0, u32(1)), traf);
  return Buffer.concat([
    box('styp', Buffer.from('msdh', 'latin1'), u32(0), Buffer.from('msdhmsix', 'latin1')),
    moof, box('mdat', Buffer.alloc(entries.reduce((n, e) => n + e.size, 0)))]);
}

const clean = segment([{ dur: 40, size: 8, cto: 80 }, { dur: 40, size: 8, cto: 0 }, { dur: 40, size: 8, cto: 40 }]);
// PTS[1] = 40 + 0xffffff = PTS[0] = 0 + 0x1000027 : le cto à patcher est
// 0xffffffff -> +16 = 0x0100000f, les 4 octets du champ changent.
const dup = segment([{ dur: 40, size: 8, cto: 0x1000027 }, { dur: 40, size: 8, cto: 0xffffff }, { dur: 40, size: 8, cto: 50 }]);

test('scanSegment : segment sain ok, collision PTS détectée', () => {
  assert.deepEqual(scanSegment(clean), { timescale: null, count: 3, collisions: [], ok: true });
  const scan = scanSegment(dup);
  assert.equal(scan.count, 3);
  assert.equal(scan.ok, false);
  assert.deepEqual(scan.collisions, [{ i: 1, j: 0, pts: 0x1000027 }]);
});

test('repairSegment : PTS toutes distinctes, seul le champ cto bouge, idempotent', () => {
  const { buf, patches, collisions, remaining } = repairSegment(dup);
  assert.equal(collisions.length, 1);
  assert.deepEqual(patches, [{ offset: patches[0].offset, before: 0xffffff, after: 0x100000f }]);
  assert.equal(remaining.length, 0);
  assert.ok(scanSegment(buf).ok);
  const diff = [];
  for (let i = 0; i < dup.length; i++) if (dup[i] !== buf[i]) diff.push(i);
  assert.deepEqual(diff, [patches[0].offset, patches[0].offset + 1, patches[0].offset + 2, patches[0].offset + 3]);
  const again = repairSegment(buf);
  assert.equal(again.patches.length, 0);
  assert.ok(again.buf.equals(buf));
});

test('repairSegment : le pas suit le timescale (1 ms) et itère les collisions en chaîne', () => {
  const { patches } = repairSegment(dup, { timescale: 90000 });
  assert.equal(patches[0].after - patches[0].before, 90);
  // Quatre échantillons sur la même PTS : chaque passe re-crée une collision.
  const pile = segment([0, 1, 2, 3].map(i => ({ dur: 40, size: 8, cto: 500 - 40 * i })));
  const repaired = repairSegment(pile);
  assert.equal(repaired.patches.length, 6);
  assert.ok(scanSegment(repaired.buf).ok);
});

test('scanFile lit la même table que le buffer complet', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hls-pts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'segment_0_000000.m4s');
  await writeFile(file, dup);
  assert.deepEqual(await scanFile(file), scanSegment(dup));
});

test('cli : --check signale, --fix répare en place, le journal permet le retour arrière', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hls-pts-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'segment_0_000000.m4s');
  await writeFile(file, dup);
  const journal = path.join(dir, 'rep.jsonl');

  await assert.rejects(exec(process.execPath, [CLI, '--check', dir]), error => error.code === 1);
  const fixed = await exec(process.execPath, [CLI, '--fix', '--journal', journal, dir]);
  assert.match(fixed.stdout, /1 champ\(s\) cto réécrit/);
  await exec(process.execPath, [CLI, '--check', dir]);
  // Deuxième passage : rien à faire, le fichier n'est pas réécrit.
  const second = await exec(process.execPath, [CLI, '--fix', dir]);
  assert.match(second.stdout, /0 champ\(s\) cto réécrit/);

  // Rejouer le journal à l'envers restaure l'original octet pour octet.
  const repaired = await readFile(file);
  const entries = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const { offset, before } of entries.reverse()) repaired.writeUInt32BE(before >>> 0, offset);
  assert.ok(repaired.equals(dup));
});
