import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// A first paint can starve past one navigation budget on a loaded box: retry
// the navigation rather than stretch a single arbitrary timeout.
const goto = (page, url) => expect(async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
}).toPass({ timeout: 60_000 });

test('admin retimes an added subtitle track and the shift persists', async ({ browser }) => {
  test.setTimeout(90_000);
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
    await page.locator('#movies input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain',
      buffer: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nPremier sous-titre.\n\n2\n00:00:05,000 --> 00:00:07,000\nDeuxième réplique.\n') });
    await page.getByLabel('Nom affiché').fill('Français');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.locator('#movies')).toContainText('Français · fr');
    await openDetails();
    await page.getByRole('button', { name: 'Préparer le film' }).first().click();
    await expect(page.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
    await openDetails();
    await page.getByRole('button', { name: 'Éditer le timing' }).click();
    await expect(page.locator('#timing-dialog')).toBeVisible();
    await expect(page.locator('#timing-track .timing-cue')).toHaveCount(2);
    await expect(page.locator('#timing-cues li')).toHaveCount(2);
    // Le bouton IA est un placeholder visible : clic = notice, rien d'autre.
    await expect(page.locator('#timing-auto')).toBeEnabled();
    await page.locator('#timing-auto').click();
    await expect(page.locator('#notice')).toContainText('prochaine version');
    // Lecture/pause pilote bien l'élément vidéo de l'aperçu.
    await page.locator('#timing-play').click();
    await expect.poll(() => page.locator('#timing-video').evaluate(video => !video.paused), { timeout: 15_000 }).toBe(true);
    await page.locator('#timing-play').click();
    await expect.poll(() => page.locator('#timing-video').evaluate(video => video.paused)).toBe(true);
    const firstCue = page.locator('#timing-cues li').first();
    await expect(firstCue).toContainText('00:00:01.000');
    await page.locator('#timing-offset-plus-1s').click();
    await expect(firstCue).toContainText('00:00:02.000');
    await page.locator('#timing-save').click();
    await expect(page.locator('#timing-dialog')).toBeHidden();
    const [movie] = await (await page.request.get('/api/movies')).json();
    const track = movie.subtitles.find(item => item.external);
    const saved = await (await page.request.get(`/api/movies/${movie.id}/subtitles/${track.id}/cues`)).json();
    expect(saved.cues[0].start).toBe(2);
    expect(saved.cues[1].start).toBe(6);
  } finally { await context.close(); }
});
