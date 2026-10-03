import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// A first paint can starve past one navigation budget on a loaded box: retry
// the navigation rather than stretch a single arbitrary timeout.
const goto = (page, url) => expect(async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
}).toPass({ timeout: 60_000 });

// La sélection vit dans le brouillon, pas dans les inputs : ajouter un
// sous-titre externe déclenche refresh() qui reconstruit tout le DOM. Sans
// le brouillon, les cases décochées et les noms édités repartaient aux
// défauts — c'est le bug que ce test verrouille.
test('the preparation assistant keeps the track selection across added subtitles', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
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
    await page.getByRole('button', { name: 'Préparer le film' }).click();
    const wizard = page.locator('#prepare-dialog');
    await expect(wizard).toBeVisible();
    // Étape 1 : le fixture a deux pistes audio — décocher la première et
    // renommer la seconde, une sélection qui n'est pas le défaut.
    const audioBoxes = wizard.locator('.track-row input[type=checkbox]');
    const audioNames = wizard.locator('.track-row input:not([type=checkbox])');
    await expect(audioBoxes).toHaveCount(2);
    await audioBoxes.first().uncheck();
    await audioNames.nth(1).fill('Version anglaise');
    // Étape 2 : aucun sous-titre embarqué dans le fixture.
    await wizard.getByRole('button', { name: 'Continuer' }).click();
    await expect(wizard).toContainText('Aucun sous-titre dans ce fichier.');
    // Étape 3 : l'ajout externe provoque un refresh() serveur complet.
    await wizard.getByRole('button', { name: 'Continuer' }).click();
    await wizard.locator('input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nUn sous-titre lisible.\n') });
    await wizard.getByLabel('Nom affiché').fill('Français');
    await wizard.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(wizard).toContainText('Français · fr');
    // Retour à l'étape 1 : la sélection non-défaut a survécu au rechargement.
    await wizard.getByRole('button', { name: 'Retour' }).click();
    await wizard.getByRole('button', { name: 'Retour' }).click();
    await expect(audioBoxes.first()).not.toBeChecked();
    await expect(audioBoxes.nth(1)).toBeChecked();
    await expect(audioNames.nth(1)).toHaveValue('Version anglaise');
    // Récapitulatif : la sélection exacte est relue avant le lancement.
    await wizard.getByRole('button', { name: 'Continuer' }).click();
    await wizard.getByRole('button', { name: 'Continuer' }).click();
    await wizard.getByRole('button', { name: 'Continuer' }).click();
    await expect(wizard).toContainText('Version anglaise');
    await expect(wizard).toContainText('Français · fr');
    await wizard.getByRole('button', { name: 'Confirmer et préparer' }).click();
    await expect(wizard).toBeHidden();
    await expect(page.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
    // La préparation a bien reçu la sélection : une seule piste, le nom choisi.
    const [movie] = await (await page.request.get('/api/movies')).json();
    expect(movie.audio).toHaveLength(1);
    expect(movie.audio[0].label).toBe('Version anglaise');
  } finally { await context.close(); }
});
