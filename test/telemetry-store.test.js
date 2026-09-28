import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, utimes, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJournal } from '../src/telemetry.js';

const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const dir = root => path.join(root, 'telemetry');

test('les écritures sont tamponnées puis vidées en NDJSON par fichier', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createJournal({ root, days: 7, mb: 16, fileMb: 16 });
  t.after(() => journal.close());
  journal.write('seance-a', [{ type: 'caps' }, { type: 'tick', pos: 1 }]);
  journal.write('seance-b', [{ type: 'tick', pos: 2 }]);
  // Rien n'a encore touché le disque : le tampon attend la vidange.
  assert.equal((await readdir(dir(root)).catch(() => [])).length, 0);
  await journal.flush();
  assert.deepEqual((await lines(path.join(dir(root), 'seance-a.ndjson'))).map(e => e.type), ['caps', 'tick']);
  assert.equal((await lines(path.join(dir(root), 'seance-b.ndjson')))[0].pos, 2);
  // L'ordre des lignes d'un même fichier est conservé entre deux vidanges.
  journal.write('seance-a', [{ type: 'tick', pos: 3 }]);
  await journal.flush();
  assert.equal((await lines(path.join(dir(root), 'seance-a.ndjson'))).at(-1).pos, 3);
  assert.deepEqual(await journal.stats(), { files: 2, bytes: (await lines(path.join(dir(root), 'seance-a.ndjson'))).length * 0 + (await readFile(path.join(dir(root), 'seance-a.ndjson'))).length + (await readFile(path.join(dir(root), 'seance-b.ndjson'))).length });
});

test('un fichier qui atteint le plafond est renommé et repart à neuf', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // ~1 Kio : le journal accepte une fraction pour les tests.
  const journal = createJournal({ root, days: 7, mb: 16, fileMb: 0.001 });
  t.after(() => journal.close());
  journal.write('seance-x', Array.from({ length: 30 }, (_, i) => ({ type: 'tick', i, pad: 'x'.repeat(80) })));
  await journal.flush();
  assert.deepEqual(await readdir(dir(root)), ['seance-x.ndjson']);
  // Le plafond est franchi : la vidange suivante bascule vers <base>.1.ndjson.
  journal.write('seance-x', [{ type: 'tick', i: 'suite' }]);
  await journal.flush();
  const names = (await readdir(dir(root))).sort();
  assert.deepEqual(names, ['seance-x.1.ndjson', 'seance-x.ndjson']);
  const rotated = await lines(path.join(dir(root), 'seance-x.1.ndjson'));
  assert.equal(rotated.length, 30);
  assert.ok(rotated.every(line => line.type === 'tick' && Number.isInteger(line.i)));
  assert.deepEqual(await lines(path.join(dir(root), 'seance-x.ndjson')), [{ type: 'tick', i: 'suite' }]);
});

test('la rétention supprime les fichiers trop vieux puis les plus anciens', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir(root), { recursive: true });
  // Trois fichiers : un trop vieux, deux récents dont un plus ancien.
  await writeFile(path.join(dir(root), 'vieux.ndjson'), 'x'.repeat(400));
  await writeFile(path.join(dir(root), 'ancien.ndjson'), 'x'.repeat(600));
  await writeFile(path.join(dir(root), 'recent.ndjson'), 'x'.repeat(400));
  const now = Date.now() / 1000;
  await utimes(path.join(dir(root), 'vieux.ndjson'), now - 10 * 86400, now - 10 * 86400);
  await utimes(path.join(dir(root), 'ancien.ndjson'), now - 86400, now - 86400);
  // `mb` est relu à chaque appel : l'âge d'abord, puis le volume après durcissement.
  let capMb = 16;
  const journal = createJournal({ root, days: 7, mb: () => capMb, fileMb: 16 });
  t.after(() => journal.close());
  const first = await journal.prune();
  assert.equal(first.deleted, 1);
  assert.deepEqual((await readdir(dir(root))).sort(), ['ancien.ndjson', 'recent.ndjson']);
  // Plafond de volume : le plus ancien part en premier jusqu'à rentrer.
  capMb = 0.0005;
  const second = await journal.prune();
  assert.equal(second.deleted, 1);
  assert.deepEqual(await readdir(dir(root)), ['recent.ndjson']);
});

test('un fichier encore alimenté n\'est jamais supprimé par la rétention', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createJournal({ root, days: 1, mb: 0.0001, fileMb: 16 });
  t.after(() => journal.close());
  journal.write('vivant', [{ type: 'tick' }]);
  await journal.flush();
  const old = now => now - 5 * 86400;
  const file = path.join(dir(root), 'vivant.ndjson');
  await utimes(file, old(Date.now() / 1000), old(Date.now() / 1000));
  const result = await journal.prune();
  assert.equal(result.deleted, 0);
  assert.deepEqual(await readdir(dir(root)), ['vivant.ndjson']);
});

test('au-delà du plafond mémoire les plus vieilles lignes tombent et sont comptées', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createJournal({ root, days: 7, mb: 16, fileMb: 16 });
  t.after(() => journal.close());
  journal.write('surcharge', Array.from({ length: 6000 }, (_, i) => ({ type: 'tick', i })));
  await journal.flush();
  const events = await lines(path.join(dir(root), 'surcharge.ndjson'));
  const queue = events.filter(event => event.type === 'queue');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].dropped, 1000);
  assert.ok(queue[0].size > 0);
  // Les plus vieilles lignes ont disparu : l'ordre reste indexé à partir de 1000.
  assert.equal(events.find(event => event.type === 'tick').i, 1000);
});

test('write() ne rejette jamais, même quand le dossier est inaccessible', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  await chmod(root, 0o500);
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = warn; });
  const journal = createJournal({ root, days: 7, mb: 16, fileMb: 16 });
  t.after(() => journal.close());
  // Ni l'appel ni la vidange ne doivent rejeter : l'erreur part en avertissement.
  journal.write('seance-y', [{ type: 'tick' }]);
  await journal.flush();
  await journal.flush();
  assert.equal(warnings.filter(line => line.includes('[telemetry]')).length, 1);
});

test('un nom avec séparateur de chemin est refusé sans écrire', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createJournal({ root, days: 7, mb: 16, fileMb: 16 });
  t.after(() => journal.close());
  journal.write('../escape', [{ type: 'x' }]);
  journal.write('ok', [{ type: 'x' }]);
  await journal.flush();
  assert.deepEqual(await readdir(dir(root)), ['ok.ndjson']);
});
