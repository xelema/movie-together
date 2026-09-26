import { createApplication } from './app.js';
import { refreshStaleProbes } from './media.js';
import { createVoiceService } from './voice.js';

const port = Number(process.env.PORT || 3000);
let origin = process.env.APP_ORIGIN;
if (!origin || (process.env.PORT && origin.startsWith('http://localhost:'))) {
  origin = `http://localhost:${port}`;
}
const application = createApplication({
  dataDir: process.env.DATA_DIR,
  password: process.env.ADMIN_PASSWORD,
  origin,
  secure: origin.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1',
  // Sans GEMINI_API_KEY/GOOGLE_API_KEY le service est null : les séances voix
  // annoncent la traduction indisponible au lieu de la simuler (#44).
  voiceService: createVoiceService(),
});
await refreshStaleProbes(application.store);
application.server.listen(port, '0.0.0.0', () => console.log(`Movie Night écoute sur le port ${port}.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await application.close(); process.exit(0);
});
