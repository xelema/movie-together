import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { run } from '../src/media.js';

const root = path.resolve('data/e2e');
await mkdir(root, { recursive: true });
await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
  '-t', '50', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-g', '40',
  '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
  '-c:a', 'aac', '-ac', '2', '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng', path.join(root, 'fixture.mp4')]);
const dataDir = path.join(root, randomUUID());
// Fournisseur factice au niveau de la couture serveur : aucune donnée réseau ni
// micro réel. Le garde-fou silence/bruit est local au serveur (#45). La session
// Live factice émet un fragment puis complète au flush, dans le sens figé (#44).
const voiceService = {
  // Un léger délai rend les partiels et l'état 'processing' observables côté
  // client : sans lui tout arriverait avant que le navigateur n'affiche.
  openSession({ source }) {
    const session = { onText: null, onSource: null, onEnd: null, closed: false };
    const heard = source === 'ko' ? '엔딩 크레딧에서 만나요.' : 'On se retrouve au générique.';
    const [first, rest] = source === 'ko' ? ['On se retrouve ', 'au générique.'] : ['엔딩 ', '크레딧에서 만나요.'];
    const timers = [
      setTimeout(() => session.onText?.(first), 200),
      setTimeout(() => session.onSource?.(heard), 300),
    ];
    session.send = () => {};
    session.flush = () => {
      timers.push(
        setTimeout(() => session.onText?.(rest), 200),
        setTimeout(() => session.onEnd?.(), 400),
      );
    };
    session.close = () => { session.closed = true; timers.forEach(clearTimeout); };
    return session;
  },
};
// Quota haut et cooldown court : une prise que le plafond de 20 s referme est
// rouverte dans le test, et chaque réouverture consomme le quota de la session.
const instance = createApplication({ dataDir, origin: 'http://localhost:3100', password: 'browser-test-password', voiceService,
  env: { ...process.env, VOICE_QUOTA: '10', VOICE_COOLDOWN: '1' } });
instance.server.listen(3100, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await instance.close(); await rm(dataDir, { recursive: true, force: true }); process.exit(0);
});
