import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function createStore(root) {
  root = path.resolve(root);
  for (const dir of ['movies', 'uploads']) mkdirSync(path.join(root, dir), { recursive: true });
  const movies = new Map();
  for (const id of readdirSync(path.join(root, 'movies'))) {
    const metadata = path.join(root, 'movies', id, 'movie.json');
    try {
      const movie = JSON.parse(readFileSync(metadata, 'utf8'));
      if (['processing', 'probing'].includes(movie.status)) {
        movie.status = 'failed'; movie.error = 'Import interrompu. Relancer la préparation.';
      }
      movies.set(id, movie);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {
    root, movies,
    directory: id => path.join(root, 'movies', id),
    settings() {
      try { return JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8')); }
      catch { return null; }
    },
    saveSettings(settings) {
      writeFileSync(path.join(root, 'settings.json.tmp'), JSON.stringify(settings, null, 2));
      renameSync(path.join(root, 'settings.json.tmp'), path.join(root, 'settings.json'));
    },
    // Séances instrumentées : recréées à chaque démarrage, repérées par leur code.
    rooms() {
      try { return JSON.parse(readFileSync(path.join(root, 'rooms.json'), 'utf8')); }
      catch { return []; }
    },
    saveRooms(rooms) {
      writeFileSync(path.join(root, 'rooms.json.tmp'), JSON.stringify(rooms, null, 2));
      renameSync(path.join(root, 'rooms.json.tmp'), path.join(root, 'rooms.json'));
    },
    save(movie) {
      const dir = path.join(root, 'movies', movie.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'movie.json.tmp'), JSON.stringify(movie, null, 2));
      renameSync(path.join(dir, 'movie.json.tmp'), path.join(dir, 'movie.json'));
      movies.set(movie.id, movie);
    },
  };
}
