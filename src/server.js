import { createApplication } from './app.js';

const port = Number(process.env.PORT || 3000);
const application = createApplication({
  dataDir: process.env.DATA_DIR,
  password: process.env.ADMIN_PASSWORD,
  origin: process.env.APP_ORIGIN || `http://localhost:${port}`,
  secure: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === '1',
  syncOptions: { minBuffer: Number(process.env.MIN_BUFFER_SECONDS || 8), lowBuffer: Number(process.env.LOW_BUFFER_SECONDS || 3) },
});
application.server.listen(port, '0.0.0.0', () => console.log(`Movie Night écoute sur le port ${port}.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await application.close(); process.exit(0);
});
