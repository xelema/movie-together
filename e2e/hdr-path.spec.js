import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webglProbe } from '../scripts/color-capability.js';

// Le chemin HDR adaptatif (#16) : shader tone-map sur ecran SDR, passthrough
// natif quand dynamic-range dit high et que MediaCapabilities confirme. La
// sonde matchMedia est simulee (aucun ecran HDR en CI) ; decodingInfo est
// controle par __hdrSupported pour couvrir les deux reponses du garde-fou.
test('hdr content follows the screen: shader on sdr, native on hdr, force shader escape', async ({ browser }) => {
  test.skip(process.platform === 'win32' && browser.browserType().name() === 'webkit', 'Playwright WebKit on Windows has neither HLS nor MSE decoding; run this project on macOS/Linux.');
  test.setTimeout(150_000);
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
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
    const decodingInfo = async () => ({ supported: window.__hdrSupported, smooth: true, powerEfficient: true });
    const capabilities = navigator.mediaCapabilities ?? {};
    if (!navigator.mediaCapabilities) {
      try { Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value: capabilities }); } catch { }
    }
    try { Object.defineProperty(capabilities, 'decodingInfo', { configurable: true, value: decodingInfo }); }
    catch { capabilities.decodingInfo = decodingInfo; }
    window.__hdrMocked = navigator.mediaCapabilities?.decodingInfo === decodingInfo;
  });
  // A first paint can starve past one navigation budget on a loaded box: retry
  // the navigation rather than stretch a single arbitrary timeout.
  const goto = url => expect(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  const reload = () => expect(async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  try {
    await goto('/admin');
    // Le shader exige WebGL2 high-float : meme sonde que check-colors, avant
    // toute assertion (le Firefox de CI peut refuser le contexte).
    const { webgl2 } = await page.evaluate(webglProbe);
    if (!await page.evaluate(() => window.__hdrMocked)) test.skip(true, 'mediacapabilities-unavailable: decodingInfo cannot be controlled');
    await page.locator('#login-form input').fill('browser-test-password'); await page.locator('#login-form button').click();
    await expect(page.locator('#library')).toBeVisible();
    // Le serveur est partage entre les projets : repartir d'une bibliotheque
    // vide, puis lire l'id dans le hash plutot que prendre la premiere room.
    const headers = { Origin: 'http://localhost:3100' };
    for (const room of await (await page.request.get('/api/rooms')).json()) await page.request.delete(`/api/rooms/${room.id}`, { headers });
    for (const movie of await (await page.request.get('/api/movies')).json()) await page.request.delete(`/api/movies/${movie.id}`, { headers });
    await page.locator('#refresh').click();
    await page.locator('#upload-file').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await readFile('data/e2e/fixture.mp4') });
    await page.getByRole('button', { name: 'Préparer le film' }).first().click();
    const movieCard = page.locator('#movies article.card').filter({ hasText: 'fixture' }).last();
    await expect(movieCard.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
    await movieCard.getByRole('button', { name: 'Créer une séance', exact: true }).click();
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(page.locator('#name-dialog')).toBeVisible();
    await page.locator('#room-name').fill('HDR'); await page.locator('#name-dialog button').click();
    await expect(page.locator('#movie-title')).toHaveText('fixture');
    const roomId = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('room'));
    expect(roomId).toBeTruthy();
    // Le hash seul ne recharge pas l'app : il faut un vrai reload pour relire
    // les parametres et reconstruire le SyncPlayer.
    const reenter = async hash => {
      await page.evaluate(h => { location.hash = h; }, hash);
      await reload();
      await expect(page.locator('#name-dialog')).toBeVisible();
      await page.locator('#room-name').fill('HDR'); await page.locator('#name-dialog button').click();
      await expect(page.locator('#movie-title')).toHaveText('fixture');
    };

    if (!webgl2) {
      // Chemin degrade : sans WebGL2 le renderer jette, l'echec doit rester
      // visible et le passthrough HDR natif ne cree aucun canvas. La suite
      // suppose un shader : skip nomme, jamais un faux succes.
      await expect(page.locator('#buffering-label')).toContainText('accélération graphique', { timeout: 15_000 });
      await expect(page.locator('.color-canvas')).toHaveCount(0);
      await page.evaluate(() => window.__hdr.set(true));
      await expect.poll(() => page.evaluate(() => window.player?.hdrPipeline === true)).toBe(true);
      await expect(page.locator('.color-canvas')).toHaveCount(0);
      test.skip(true, 'webgl-unavailable: no WebGL2 context with high-float fragment precision');
    }

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
    await expect.poll(() => page.evaluate(() => window.player?.hdrPipeline === false && !window.player?.probing)).toBe(true);
    await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true');
    // #hdr=shader court-circuite le passthrough meme quand tout confirme.
    await reenter(`#room=${roomId}&hdr=shader`);
    await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
    await page.evaluate(() => window.__hdr.set(true));
    await expect.poll(() => page.evaluate(() => window.player?.hdrScreen.matches === true && !!window.player?.colorRenderer)).toBe(true);
    await expect(page.locator('.color-canvas')).toHaveAttribute('data-ready', 'true');
  } finally {
    await context.close().catch(() => {});
  }
});
