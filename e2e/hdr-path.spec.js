import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Le chemin HDR adaptatif (#16) : shader tone-map sur ecran SDR, passthrough
// natif quand dynamic-range dit high et que MediaCapabilities confirme. La
// sonde matchMedia est simulee (aucun ecran HDR en CI) ; decodingInfo est
// controle par __hdrSupported pour couvrir les deux reponses du garde-fou.
test('hdr content follows the screen: shader on sdr, native on hdr, force shader escape', async ({ browser }) => {
  test.skip(process.platform === 'win32' && browser.browserType().name() === 'webkit', 'Playwright WebKit on Windows has neither HLS nor MSE decoding; run this project on macOS/Linux.');
  test.setTimeout(150_000);
  const context = await browser.newContext(), page = await context.newPage();
  await page.addInitScript(() => {
    const real = window.matchMedia, listeners = new Set();
    const fake = {
      matches: false, media: '(dynamic-range: high)', onchange: null,
      addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn),
      addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), dispatchEvent: () => true,
      set(value) { this.matches = value; for (const fn of listeners) fn({ matches: value }); },
    };
    window.__hdr = fake; window.__hdrSupported = true;
    window.matchMedia = query => query === fake.media ? fake : real(query);
    navigator.mediaCapabilities.decodingInfo = async () => ({ supported: window.__hdrSupported, smooth: true, powerEfficient: true });
  });
  await page.goto('/admin');
  await page.locator('#login-form input').fill('browser-test-password'); await page.locator('#login-form button').click();
  await page.locator('#upload-file').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await readFile('data/e2e/fixture.mp4') });
  await page.locator('#upload-button').click();
  await page.getByRole('button', { name: 'Préparer le film' }).first().click();
  const movieCard = page.locator('#movies article.card').filter({ hasText: 'fixture' }).last();
  await expect(movieCard.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
  await movieCard.getByRole('button', { name: 'Créer une séance', exact: true }).click();
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.locator('#name-dialog')).toBeVisible();
  await page.locator('#room-name').fill('HDR'); await page.locator('#name-dialog button').click();
  const roomId = (await (await page.request.get('/api/rooms')).json())[0].id;
  // Le hash seul ne recharge pas l'app : il faut un vrai reload pour relire
  // les parametres et reconstruire le SyncPlayer.
  const reenter = async hash => {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.reload();
    await expect(page.locator('#name-dialog')).toBeVisible();
    await page.locator('#room-name').fill('HDR'); await page.locator('#name-dialog button').click();
  };

  // Ecran SDR : le shader tone-map couvre la video.
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  // Fenetre sur un ecran HDR : le natif prend le relais, le canvas est retire.
  await page.evaluate(() => window.__hdr.set(true));
  await expect(page.locator('.color-canvas')).toHaveCount(0);
  await expect(page.locator('.color-captions')).toHaveCount(0);
  // Retour sur SDR : le shader revient sans rechargement.
  await page.evaluate(() => window.__hdr.set(false));
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  // Un pipeline qui ne confirme pas le HDR garde le shader meme sur ecran HDR.
  await reenter(`#room=${roomId}`);
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  await page.evaluate(() => { window.__hdrSupported = false; window.__hdr.set(true); });
  await page.waitForTimeout(1000);
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true');
  // #hdr=shader court-circuite le passthrough meme quand tout confirme.
  await reenter(`#room=${roomId}&hdr=shader`);
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  await page.evaluate(() => window.__hdr.set(true));
  await page.waitForTimeout(1000);
  await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true');
  await context.close();
});
