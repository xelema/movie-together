import { createApplication } from './app.js';
import { probeFile } from './media.js';
import path from 'node:path';

const port = Number(process.env.PORT || 3000);
const application = createApplication({
  dataDir: process.env.DATA_DIR,
  password: process.env.ADMIN_PASSWORD,
  origin: process.env.APP_ORIGIN || `http://localhost:${port}`,
  secure: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  syncOptions: { minBuffer: Number(process.env.MIN_BUFFER_SECONDS || 20), lowBuffer: Number(process.env.LOW_BUFFER_SECONDS || 5) },
});
// Upgrade metadata without uploading again or launching a lengthy video conversion.
for (const movie of application.store.movies.values()) {
  if (movie.probe?.schema === 3 || movie.status === 'ready') continue;
  try {
    movie.probe = await probeFile(path.join(application.store.directory(movie.id), 'source'));
    movie.status = movie.probe.compatible ? 'uploaded' : 'incompatible'; movie.error = null;
  } catch (error) { movie.status = 'failed'; movie.error = error.message; }
  application.store.save(movie);
}
application.server.listen(port, '0.0.0.0', () => console.log(`Movie Night écoute sur le port ${port}.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await application.close(); process.exit(0);
});
