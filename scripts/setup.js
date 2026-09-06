import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const target = path.resolve('.env');
if (existsSync(target)) {
  console.log('Le fichier .env existe déjà, aucune modification.');
} else {
  const settings = [`ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`, 'APP_ORIGIN=http://localhost:3000', 'PORT=3000', 'DATA_DIR=./data'];
  if (process.platform === 'win32') {
    const probe = path.join(process.env.ChocolateyInstall || 'C:/ProgramData/chocolatey', 'lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe');
    if (existsSync(probe)) settings.push(`FFPROBE_PATH=${probe.replaceAll('\\', '/')}`);
  }
  writeFileSync(target, `${settings.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Configuration locale créée dans .env. Le mot de passe administrateur y est enregistré.');
}
