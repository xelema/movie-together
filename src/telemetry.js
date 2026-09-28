// Journal NDJSON de la télémétrie : un fichier par base de nom sous
// <root>/telemetry, alimenté en mémoire puis vidé par lot au plus une fois par
// seconde (et dès qu'un tampon dépasse ~256 Kio), rotation par taille et
// rétention par âge puis par volume. Aucune erreur ne remonte à l'appelant :
// un fichier en échec est signalé une fois puis ignoré pendant une minute.
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const FLUSH_MS = 1000;           // cadence partagée de vidage des tampons
const FLUSH_BYTES = 256 * 1024;  // vidage immédiat d'un tampon au-delà
const QUEUE_MAX = 5000;          // lignes en attente avant abandon des plus vieilles
const RETRY_MS = 60_000;         // silence d'un fichier après un échec d'écriture
const MIO = 1024 ** 2;

export function createJournal({ root, days, mb, fileMb, now = Date.now }) {
  const directory = path.join(root, 'telemetry');
  // Les bornes sont relues à chaque usage : l'administrateur peut les changer
  // à chaud, elles acceptent donc un accesseur aussi bien qu'un nombre.
  const value = option => typeof option === 'function' ? option() : option;
  const files = new Map();
  let pending = 0, warnedName = false;

  const fileFor = name => {
    let file = files.get(name);
    if (file) return file;
    file = { name, lines: [], bytes: 0, written: null, dropped: 0,
      muted: 0, warned: false, chain: Promise.resolve() };
    files.set(name, file);
    return file;
  };

  // Garde-fou mémoire : les lignes les plus vieilles partent en premier.
  // ponytail: on vide les fichiers dans l'ordre de création plutôt qu'un ordre
  // global strict — le plafond est indicatif (~5000) et le cas reste rare.
  const bound = () => {
    while (pending > QUEUE_MAX) {
      const oldest = [...files.values()].find(file => file.lines.length);
      if (!oldest) return;
      const dropped = oldest.lines.shift();
      pending--;
      oldest.bytes -= dropped.length;
      oldest.dropped++;
    }
  };

  const flushFile = async file => {
    if (!file.lines.length || file.muted > now()) return;
    const lines = file.lines.splice(0), bytes = file.bytes;
    pending -= lines.length; file.bytes = 0;
    let chunk = lines.join('');
    if (file.dropped) {
      chunk += JSON.stringify({ type: 'queue', dropped: file.dropped, size: lines.length }) + '\n';
    }
    const target = path.join(directory, `${file.name}.ndjson`);
    try {
      await mkdir(directory, { recursive: true });
      if (file.written === null) {
        file.written = await stat(target).then(info => info.size, () => 0);
      }
      if (file.written >= value(fileMb) * MIO) {
        // Rotation : <base>.ndjson devient <base>.<n>.ndjson au premier n
        // libre ; si le renommage échoue on continue d'écrire dedans plutôt
        // que de perdre des lignes.
        for (let n = 1; ; n++) {
          const rotated = path.join(directory, `${file.name}.${n}.ndjson`);
          if (await stat(rotated).then(() => true, () => false)) continue;
          if (await rename(target, rotated).then(() => true, () => false)) file.written = 0;
          break;
        }
      }
      await appendFile(target, chunk);
      file.written += Buffer.byteLength(chunk);
      file.dropped = 0;
      file.warned = false;
    } catch (error) {
      // Les lignes remontent en tête du tampon : elles seront retentées au
      // prochain vidage, après le silence d'une minute.
      file.lines = lines.concat(file.lines);
      file.bytes += bytes;
      pending += lines.length;
      file.muted = now() + RETRY_MS;
      if (!file.warned) {
        console.warn(`[telemetry] ${file.name} : ${error.message}`);
        file.warned = true;
      }
    }
  };

  // Les ajouts d'un même fichier sont sérialisés : jamais d'entrelacement ni
  // de réordonnancement de lignes.
  const pump = file => (file.chain = file.chain.then(() => flushFile(file)));

  const write = (name, entries) => {
    if (typeof name !== 'string' || !name || name !== path.basename(name)) {
      if (!warnedName) { console.warn(`[telemetry] nom de journal refusé : ${name}`); warnedName = true; }
      return;
    }
    if (!Array.isArray(entries)) return;
    const file = fileFor(name);
    for (const entry of entries) {
      let line;
      try { line = JSON.stringify(entry) + '\n'; } catch { continue; }
      file.lines.push(line); file.bytes += line.length; pending++;
    }
    bound();
    if (file.bytes >= FLUSH_BYTES) pump(file);
  };

  const flush = () => Promise.all([...files.values()].map(file => pump(file)));

  const timer = setInterval(() => {
    for (const file of files.values()) if (file.lines.length) pump(file);
  }, FLUSH_MS);
  timer.unref();

  // Rétention : d'abord les fichiers plus vieux que `days` (mtime), puis les
  // plus anciens tant que le dossier dépasse `mb`. Les fichiers encore
  // alimentés comptent dans le total mais ne sont jamais supprimés.
  const prune = async () => {
    let deleted = 0, freed = 0, total = 0;
    try {
      // Le dossier naît à la première écriture : une rétention sans journaux
      // ne crée rien.
      const entries = [];
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.ndjson')) continue;
        try {
          const info = await stat(path.join(directory, name));
          entries.push({ name, mtime: info.mtimeMs, size: info.size,
            live: files.has(name.slice(0, -'.ndjson'.length)) });
        } catch { }
      }
      const cutoff = now() - value(days) * 86400_000;
      const remove = async entry => {
        if (entry.live || entry.gone) return;
        if (await unlink(path.join(directory, entry.name)).then(() => true, () => false)) {
          entry.gone = true; deleted++; freed += entry.size; total -= entry.size;
        }
      };
      total = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) if (entry.mtime < cutoff) await remove(entry);
      const cap = value(mb) * MIO;
      for (const entry of entries.filter(entry => !entry.gone).sort((a, b) => a.mtime - b.mtime)) {
        if (total <= cap) break;
        await remove(entry);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[telemetry] rétention impossible : ${error.message}`);
    }
    console.log(`[telemetry] rétention : ${deleted} fichiers supprimés (${(freed / MIO).toFixed(1)} Mio), dossier à ${(total / MIO).toFixed(1)} Mio`);
    return { deleted, freed, bytes: total };
  };

  const stats = async () => {
    let count = 0, bytes = 0;
    try {
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.ndjson')) continue;
        try { bytes += (await stat(path.join(directory, name))).size; count++; } catch { }
      }
    } catch { }
    return { files: count, bytes };
  };

  const close = async () => { clearInterval(timer); await flush(); };

  return { write, flush, prune, stats, close };
}
