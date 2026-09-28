import { test, expect } from '@playwright/test';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { webglProbe } from '../scripts/color-capability.js';

// Un import réel et une préparation ffmpeg sont payés ici, comme dans la
// première passe de watch.spec.js : le journal de séance ne se prouve qu'avec
// un film joué par un vrai navigateur.
test.setTimeout(180_000);

const TELEMETRY_ROOT = path.resolve('data/e2e');

// Le journal d'une séance vit sous data/e2e/<instance>/telemetry/ : l'instance
// est tirée au sort par e2e/server.js, donc le ou les fichiers sont retrouvés
// par leur date de modification, jamais par un chemin supposé.
async function journals(since) {
  const found = [];
  let instances = [];
  try { instances = await readdir(TELEMETRY_ROOT); } catch { return found; }
  for (const instance of instances) {
    const directory = path.join(TELEMETRY_ROOT, instance, 'telemetry');
    let files = [];
    try { files = await readdir(directory); } catch { continue; }
    for (const file of files) {
      const full = path.join(directory, file);
      const info = await stat(full);
      if (!info.isFile() || info.mtimeMs < since) continue;
      const lines = (await readFile(full, 'utf8')).split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      found.push({ file, full, size: info.size, lines });
    }
  }
  return found;
}

test('une séance ordinaire écrit son journal client et serveur sur le disque', async ({ page, baseURL, browserName }) => {
  // Le film de test est étiqueté HDR : sans contexte WebGL2 high-float, le
  // moteur de couleurs ne s'initialise pas et l'application refuse la lecture.
  // Le palier est ignoré — comme dans watch.spec.js — au lieu d'attendre une
  // lecture que la machine ne peut pas produire.
  test.skip(!(await page.evaluate(webglProbe))?.webgl2, 'webgl-unavailable: pas de contexte WebGL2 high-float');

  const since = Date.now() - 1000;
  const headers = { Origin: baseURL };

  // Entrée admin : le cookie de session est partagé avec request, ce qui laisse
  // l'import et la préparation se faire par l'API plutôt qu'à la souris.
  await page.goto('/admin');
  await page.locator('#login-form input').fill('browser-test-password');
  await page.locator('#login-form button').click();
  await expect(page.locator('#library')).toBeVisible();

  for (const room of await (await page.request.get('/api/rooms')).json()) await page.request.delete(`/api/rooms/${room.id}`, { headers });
  for (const movie of await (await page.request.get('/api/movies')).json()) await page.request.delete(`/api/movies/${movie.id}`, { headers });

  const source = await readFile('data/e2e/fixture.mp4');
  const created = await (await page.request.post('/api/uploads', { headers, data: { name: 'fixture.mp4', size: source.length } })).json();
  for (let offset = 0; offset < source.length; offset += created.chunkSize)
    await page.request.put(`/api/uploads/${created.id}`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'upload-offset': String(offset) },
      data: source.subarray(offset, offset + created.chunkSize),
    });
  const movie = await (await page.request.post(`/api/uploads/${created.id}/complete`, { headers })).json();
  expect(movie.status).not.toBe('failed');
  // Le dialogue admin passe toujours les pistes choisies : l'API ne retombe pas
  // seule sur les pistes sondées, qui vivent dans le sondage du film.
  const audio = (movie.probe?.audio ?? movie.audio ?? []).map(track => track.index);
  expect(audio.length).toBeGreaterThan(0);
  await page.request.post(`/api/movies/${movie.id}/prepare`, { headers, data: { audio } });
  await expect.poll(async () => (await (await page.request.get('/api/movies')).json()).find(entry => entry.id === movie.id)?.status,
    { timeout: 150_000 }).toBe('ready');

  const code = `Tele-${Date.now().toString(36).slice(-4)}`;
  const room = await (await page.request.post('/api/rooms', { headers, data: { movieId: movie.id, code, voice: false, webcam: false } })).json();
  expect(room.code).toBeTruthy();

  // Séance ordinaire : ni sonde ni drapeau probe, la télémétrie doit vivre dans
  // n'importe quelle séance.
  await page.goto('/');
  await page.locator('#join-form input').fill(room.code);
  await page.locator('#join-form button').click();
  await expect(page.locator('#name-dialog')).toBeVisible();
  await page.locator('#room-name').fill('Journal');
  await page.locator('#name-dialog button').click();
  await expect(page.locator('#movie-title')).toHaveText('fixture');

  // Les lots partent par POST : le statut est la preuve que le serveur accepte
  // la séance ordinaire, le fichier sur disque celle que la ligne a survécu.
  // Toute erreur de page est relevée : un attachement silencieusement refusé
  // doit se voir ici plutôt que dans un journal absent.
  const posted = [], pageErrors = [], consoleErrors = [];
  page.on('response', response => {
    if (!response.url().includes('/telemetry')) return;
    posted.push(`${response.status()} ${(response.request().postData() ?? '').slice(0, 120)}`);
  });
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  // Première activation : le son exige un vrai geste. Le bouton de secours
  // (#allow-sound) apparaît quand l'autoplay est refusé, le bouton central de
  // Plyr disparaît dès que la séance joue — un moteur masque l'un ou l'autre.
  // Le geste est donc tenté sur ce qui est visible, puis la lecture est
  // confirmée sur l'état de la séance, jamais sur la présence d'un bouton.
  const allow = page.locator('#allow-sound'), overlaid = page.locator('.plyr__control--overlaid');
  if (await allow.isVisible()) await allow.click();
  else if (await overlaid.isVisible()) await overlaid.click();
  const playing = () => page.evaluate(() => {
    const element = document.querySelector('video');
    if (window.player?.state?.phase === 'paused') window.player.command('play');
    return window.player?.state?.phase === 'playing' && !element.paused && element.currentTime > 0;
  });
  try {
    await expect.poll(playing, { timeout: 30_000 }).toBe(true);
  } catch (error) {
    // Un échec doit nommer la barrière rencontrée, pas seulement un booléen.
    const dump = await page.evaluate(() => {
      const video = document.querySelector('video');
      return { phase: window.player?.state?.phase, paused: video.paused, readyState: video.readyState, media: video.error?.message,
        time: video.currentTime, blocked: window.player?.activationBlocked, failure: window.player?.failure,
        controls: document.querySelector('.plyr__control--overlaid')?.checkVisibility?.() ?? false,
        allowSound: document.querySelector('#allow-sound')?.checkVisibility?.() ?? false };
    });
    throw new Error(`la séance ne joue pas : ${JSON.stringify(dump)} — ${error.message}`);
  }

  // Le curseur de transport est un pourcentage : 50 % d'un film de 50 s vise 25 s.
  await page.locator('[data-plyr=seek]').fill('50');
  await page.locator('[data-plyr=seek]').dispatchEvent('change');
  await page.keyboard.press('m');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime), { timeout: 30_000 }).toBeGreaterThan(1);

  const memberId = await page.evaluate(() => window.player?.memberId ?? null);
  await expect.poll(() => posted.length, { timeout: 30_000,
    message: () => JSON.stringify({ posted, pageErrors, consoleErrors, memberId }) }).toBeGreaterThan(0);
  expect(posted.join('\n')).toContain('204');
  expect(pageErrors).toEqual([]);

  // La sortie de séance vide la file par sendBeacon : c'est le dernier lot, et
  // celui qui porte la fin de session. Le serveur ne le journalise qu'après son
  // propre vidage, donc la fin est attendue sur le disque, jamais supposée.
  await page.locator('#leave').click();
  const entries = () => journals(since).then(found => found.filter(entry => !entry.file.endsWith('-server.ndjson')));
  await expect.poll(async () => (await entries()).some(entry => entry.lines.some(line => line.type === 'session-end')),
    { timeout: 30_000, message: 'fin de session dans le journal client' }).toBe(true);

  const onDisk = await journals(since);
  const participant = onDisk.find(entry => !entry.file.endsWith('-server.ndjson')
    && entry.lines.some(line => line.type === 'session-start' && line.code?.toLowerCase() === room.code.toLowerCase()));
  const server = onDisk.find(entry => entry.file.endsWith('-server.ndjson'));
  expect(participant, 'journal client de la séance').toBeTruthy();
  expect(server, 'journal serveur de la séance').toBeTruthy();

  const types = participant.lines.map(line => line.type);
  for (const type of ['session-start', 'caps', 'tick', 'action', 'report']) expect(types, `type ${type}`).toContain(type);
  expect(types).toContain('session-end');

  // Chaque ligne porte l'enveloppe du contrat : horodatage, heure de page, sid.
  for (const line of participant.lines) { expect(typeof line.t).toBe('number'); expect(typeof line.p).toBe('number'); expect(line.sid).toMatch(/^[a-f0-9]{16}$/); }

  const start = participant.lines.find(line => line.type === 'session-start');
  expect(start.probe).toBe(false);
  expect(start.code).toBe(room.code);

  const caps = participant.lines.find(line => line.type === 'caps');
  expect(caps.movie.id).toBe(movie.id);
  expect(caps.movie.bufferRisk.level).toBeTruthy();
  expect(caps.room.probe).toBe(false);
  // Les sondes de codecs appartiennent au moteur, pas à la séance : là où le
  // poste répond, la valeur est un booléen ; la lecture H.264 n'est acquise que
  // sur le palier Chromium.
  if (browserName === 'chromium') {
    expect(caps.canPlay.h264).toBe(true);
    expect(caps.mediaCap.h264.supported).toBe(true);
  } else {
    expect(typeof caps.canPlay.h264).toBe('boolean');
  }

  const ticks = participant.lines.filter(line => line.type === 'tick');
  expect(ticks.length).toBeGreaterThan(2);
  expect(ticks.some(tick => tick.pos > 0)).toBe(true);
  expect(ticks.some(tick => tick.phase === 'playing' || tick.phase === 'buffering')).toBe(true);
  expect(ticks.some(tick => Number.isFinite(tick.frames))).toBe(true);

  // Les intentions utilisateur sont horodatées avec la position et la phase.
  const actions = participant.lines.filter(line => line.type === 'action').map(line => line.act);
  expect(actions).toContain('join');
  const seek = participant.lines.find(line => line.type === 'action' && line.act === 'seek');
  // La valeur journalisée est la position visée en secondes, pas le pourcentage.
  expect(seek?.value).toBeGreaterThan(20);

  // Rapport de synchronisation du participant, reçu et accepté par le serveur.
  const report = participant.lines.find(line => line.type === 'report');
  expect(report.epoch).toEqual(expect.any(Number));

  const serverTypes = server.lines.map(line => line.type);
  for (const type of ['create', 'connect', 'phase']) expect(serverTypes, `serveur ${type}`).toContain(type);
  for (const line of server.lines) { expect(typeof line.at).toBe('number'); expect(line.room).toBeTruthy(); }

  // Le journal ne contient jamais de texte parlé : seuls des compteurs de
  // longueur et des libellés d'état sont écrits.
  for (const line of participant.lines) {
    for (const value of Object.values(line)) {
      if (typeof value !== 'string') continue;
      expect(/[가-힣]|Un sous-titre/.test(value), `texte parlé dans ${line.type}`).toBe(false);
    }
  }
});
