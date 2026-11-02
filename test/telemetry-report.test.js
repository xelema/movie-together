import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/telemetry-report.js', import.meta.url));

// Le rapport est un CLI : il est rejoué sur un journal écrit comme celui d'un
// navigateur (une ligne par seconde, enveloppe t/p/sid).
const report = (t, lines) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'telemetry-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ABCD-0123abcd.ndjson');
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
};
const ticks = (count, fields) => Array.from({ length: count }, (_, i) => ({
  type: 'tick', t: 1_760_000_000_000 + i * 1000, p: i * 1000, sid: 'a'.repeat(16),
  phase: 'playing', paused: false, pos: i, target: i, ahead: 20, rtt: 40, off: 0, ...fields(i),
}));

test('rVFC muet : le rapport retombe sur le delta de totalVideoFrames', t => {
  // TV à plan vidéo matériel : fps absent, totalVideoFrames avance à 24 i/s.
  const out = report(t, ticks(10, i => ({ frames: 1000 + 24 * i, dropped: 0 })));
  assert.match(out, /images : rVFC muet — 24 i\/s décodées/);
});

test('le rapport affiche les images sautées, les callbacks manqués et le raf', t => {
  const out = report(t, ticks(10, i => ({
    fps: 22, frames: 24 * i, dropped: 0, skip: i % 2 ? 2 : 0, miss: 0, ovl: true,
    raf: i === 2 ? 60 : undefined,
  })));
  assert.match(out, /présentation : 10 images sautées à l'écran sur 10 s de lecture \(1 \/s · 5 ticks touchés\)/);
  assert.match(out, /0 présentées sans callback rVFC/);
  assert.match(out, /rafraîchissement 60 Hz \(rAF, 1 échantillons/);
  assert.match(out, /overlay gecko affiché 10\/10 ticks/);
  assert.match(out, /images : 22 i\/s réelles/);
});
