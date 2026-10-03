import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// A first paint can starve past one navigation budget on a loaded box: retry
// the navigation rather than stretch a single arbitrary timeout.
const goto = (page, url) => expect(async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
}).toPass({ timeout: 60_000 });

test('admin retimes an added subtitle track and the shift persists', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
  const openDetails = async () => { if (!await page.locator('#movies details').evaluate(node => node.open)) await page.locator('#movies summary').click(); };
  try {
    await goto(page, '/admin');
    await page.locator('#login-form input').fill('browser-test-password');
    await page.locator('#login-form button').click();
    await expect(page.locator('#library')).toBeVisible();
    // Each engine uses the same temporary test server; start with an empty library.
    const headers = { Origin: 'http://localhost:3100' };
    for (const room of await (await page.request.get('/api/rooms')).json()) await page.request.delete(`/api/rooms/${room.id}`, { headers });
    for (const movie of await (await page.request.get('/api/movies')).json()) await page.request.delete(`/api/movies/${movie.id}`, { headers });
    await page.locator('#refresh').click();
    await page.locator('#upload-file').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await readFile('data/e2e/fixture.mp4') });
    await expect(page.locator('#movies')).toContainText('À préparer');
    await openDetails();
    // Dix répliques minimum pour que le recalage automatique accepte de
    // mesurer (le moteur refuse en deçà) : le srt en porte douze.
    const srt = Array.from({ length: 12 }, (_, index) => {
      const at = index * 4 + 1;
      const stamp = seconds => `00:00:${String(seconds).padStart(2, '0')},000`;
      return `${index + 1}\n${stamp(at)} --> ${stamp(at + 2)}\nRéplique ${index + 1}.\n`;
    }).join('\n');
    await page.locator('#movies input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
    await page.getByLabel('Nom affiché').fill('Français');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.locator('#movies')).toContainText('Français · fr');
    await openDetails();
    await page.getByRole('button', { name: 'Préparer le film' }).first().click();
    await expect(page.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
    await openDetails();
    await page.getByRole('button', { name: 'Éditer le timing' }).click();
    await expect(page.locator('#timing-dialog')).toBeVisible();
    await expect(page.locator('#timing-track .timing-cue')).toHaveCount(12);
    await expect(page.locator('#timing-cues li')).toHaveCount(12);
    // Le film de test n'a que des sinusoïdes : le VAD n'y trouve aucune parole
    // et l'analyse le dit honnêtement (ffmpeg + modèle, attente large).
    await expect(page.locator('#timing-auto')).toBeEnabled();
    await page.locator('#timing-auto').click();
    await expect(page.locator('#timing-auto')).toBeDisabled();
    await expect(page.locator('#notice')).toContainText('Aucune parole détectée', { timeout: 60_000 });
    await expect(page.locator('#timing-auto')).toBeEnabled();
    // Lecture/pause pilote bien l'élément vidéo de l'aperçu.
    await page.locator('#timing-play').click();
    await expect.poll(() => page.locator('#timing-video').evaluate(video => !video.paused), { timeout: 15_000 }).toBe(true);
    await page.locator('#timing-play').click();
    await expect.poll(() => page.locator('#timing-video').evaluate(video => video.paused)).toBe(true);
    const firstCue = page.locator('#timing-cues li').first();
    await expect(firstCue).toContainText('00:00:01.000');
    // Fraîchement importée, la piste n'a aucun décalage et la
    // réinitialisation n'a rien à rétablir.
    await expect(page.locator('#timing-origin')).toContainText('Décalage actuel : 0,000 s');
    await expect(page.locator('#timing-reset')).toBeDisabled();
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#timing-offset-plus-1s').click();
    await expect(firstCue).toContainText('00:00:02.000');
    // Le décalage courant se lit par rapport au fichier importé.
    await expect(page.locator('#timing-origin')).toContainText('Décalage actuel : +1,000 s');
    await expect(page.locator('#timing-reset')).toBeEnabled();
    // La réinitialisation réécrit le .vtt servi : les répliques reviennent
    // au timing d'origine sans enregistrer.
    await page.locator('#timing-reset').click();
    await expect(firstCue).toContainText('00:00:01.000');
    await expect(page.locator('#timing-origin')).toContainText('Décalage actuel : 0,000 s');
    await expect(page.locator('#timing-reset')).toBeDisabled();
    await page.locator('#timing-offset-plus-1s').click();
    await expect(firstCue).toContainText('00:00:02.000');
    await page.locator('#timing-save').click();
    await expect(page.locator('#timing-dialog')).toBeHidden();
    const [movie] = await (await page.request.get('/api/movies')).json();
    const track = movie.subtitles.find(item => item.external);
    const saved = await (await page.request.get(`/api/movies/${movie.id}/subtitles/${track.id}/cues`)).json();
    expect(saved.cues[0].start).toBe(2);
    expect(saved.cues[1].start).toBe(6);
    expect(saved.shift).toMatchObject({ origin: true, uniform: true, shiftMs: 1000 });
  } finally { await context.close(); }
});
