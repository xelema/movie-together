import { createApplication } from './app.js';
import { refreshStaleProbes } from './media.js';

const port = Number(process.env.PORT || 3000);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const application = createApplication({
  dataDir: process.env.DATA_DIR,
  password: process.env.ADMIN_PASSWORD,
  origin,
  secure: origin.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1',
});
await refreshStaleProbes(application.store);
application.server.listen(port, '0.0.0.0', () => console.log(`Movie Night écoute sur le port ${port}.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await application.close(); process.exit(0);
});
