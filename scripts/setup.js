import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const target = path.resolve('.env');
if (existsSync(target)) {
  console.log('Le fichier .env existe déjà, aucune modification.');
} else {
  const settings = [`ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`, 'APP_ORIGIN=http://localhost:3000', 'PORT=3000', 'DATA_DIR=./data'];
  if (process.platform === 'win32') {
    for (const binary of ['ffmpeg', 'ffprobe']) {
      const executable = ['ffmpeg-full', 'ffmpeg'].map(pkg => path.join(process.env.ChocolateyInstall || 'C:/ProgramData/chocolatey', `lib/${pkg}/tools/ffmpeg/bin/${binary}.exe`)).find(existsSync);
      if (executable) settings.push(`${binary.toUpperCase()}_PATH=${executable.replaceAll('\\', '/')}`);
    }
  }
  writeFileSync(target, `${settings.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Configuration locale créée dans .env. Le mot de passe administrateur y est enregistré.');
}
