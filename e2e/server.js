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
// micro réel. Le garde-fou silence/bruit est local au serveur (#45) ; un seul
// appel translate() renvoie langue, transcription et traduction (#44).
const voiceService = {
  // Un léger délai rend l'état 'processing' observable côté client : sans lui
  // la réponse arriverait avant que le navigateur n'affiche la transition.
  translate: async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return { language: 'fr', text: 'On se retrouve au générique.', target: 'ko', translation: '엔딩 크레딧에서 만나요.', confidence: 0.9 };
  },
};
const instance = createApplication({ dataDir, origin: 'http://localhost:3100', password: 'browser-test-password', voiceService });
instance.server.listen(3100, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await instance.close(); await rm(dataDir, { recursive: true, force: true }); process.exit(0);
});
