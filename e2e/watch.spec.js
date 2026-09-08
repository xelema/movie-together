import { test, expect } from '@playwright/test';

test('admin manages a film and two named viewers join in their language with one shared play', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const host = await a.newPage(), guest = await b.newPage(), latest = new Map(), errors = [];
  let releaseMedia = () => {};
  for (const page of [host, guest]) {
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => ws.on('framereceived', event => { const message = JSON.parse(event.payload); if (message.type === 'state') latest.set(page, message); }));
  }
  const openDetails = async () => { if (!await host.locator('#movies details').evaluate(node => node.open)) await host.locator('#movies summary').click(); };
  const controls = page => page.locator('.plyr').hover();
  try {
    await guest.goto('/');
    await expect(guest.locator('#join-form input')).toHaveCount(1);
    await expect(guest.locator('#login-form')).toBeHidden();
    await guest.locator('#language').selectOption('ko'); await guest.reload();
    await expect(guest.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(guest.locator('#language-flag')).toHaveAttribute('src', '/flags/ko.svg');
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
    await host.goto('/admin'); await host.locator('#login-form input').fill('browser-test-password'); await host.locator('#login-form button').click();
    await expect(host.locator('#library')).toBeVisible();
    await host.locator('#upload-file').setInputFiles('data/e2e/fixture.mp4'); await host.locator('#upload-button').click();
    await expect(host.locator('#movies')).toContainText('À préparer');
    await openDetails();
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nUn sous-titre lisible.\n') });
    await host.getByLabel('Nom affiché').fill('Français');
    await host.getByRole('button', { name: 'Ajouter le fichier' }).click();
    await expect(host.locator('#movies')).toContainText('Fichier ajouté : Français');
    await openDetails();
    await host.getByLabel('Type de fichier').selectOption('audio');
    await host.locator('#movies input[type=file]').setInputFiles('data/e2e/external.wav');
    await host.getByLabel('Nom affiché').fill('한국어'); await host.getByLabel('Langue', { exact: true }).selectOption('ko');
    await host.getByRole('button', { name: 'Ajouter le fichier' }).click();
    await expect(host.locator('#movies')).toContainText('Fichier ajouté : 한국어');
    await openDetails(); await host.getByRole('button', { name: 'Préparer le film' }).click();
    await expect(host.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 45_000 });
    await host.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true });
    await host.setViewportSize({ width: 390, height: 844 });
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.screenshot({ path: 'test-results/admin-mobile.png', fullPage: true });
    await host.setViewportSize({ width: 1280, height: 720 });
    await host.getByRole('button', { name: 'Créer une séance', exact: true }).click();
    await host.locator('#random-code').click(); await expect(host.locator('#create-code')).toHaveValue(/^[a-f0-9]{8}$/);
    await host.locator('#create-code').fill('Cine-Soir');
    await host.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(host.locator('#name-dialog')).toBeVisible(); await host.locator('#room-name').fill('Alex'); await host.locator('#name-dialog button').click();
    await expect(host.locator('#movie-title')).toHaveText('fixture');
    const gate = new Promise(resolve => { releaseMedia = resolve; });
    await guest.route('**/*.m4s', async route => { await gate; await route.continue().catch(() => {}); });
    await guest.locator('#join-form input').fill('cine-soir'); await guest.locator('#join-form button').click();
    await expect(guest.locator('#name-dialog')).toBeVisible(); await guest.locator('#room-name').fill('민지'); await guest.locator('#name-dialog button').click();
    await expect(guest.locator('#movie-title')).toHaveText('fixture'); await expect(guest.locator('#choose-film')).toBeHidden();
    await expect(host.locator('#participants')).toContainText('민지');
    await controls(host); await host.locator('[data-plyr=play]').click();
    await expect(host.locator('#buffering-label')).toContainText('민지');
    releaseMedia();
    await expect.poll(() => guest.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    if (await guest.locator('#allow-sound').isVisible()) await guest.locator('#allow-sound').click();
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => host.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(2);
    const times = await Promise.all([host, guest].map(page => page.locator('video').evaluate(video => video.currentTime)));
    expect(Math.abs(times[0] - times[1])).toBeLessThan(.35);
    await controls(guest); await guest.locator('[data-plyr=play]').click();
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(true);
    await guest.locator('#open-settings').click(); await guest.locator('#audio').selectOption('2'); await guest.locator('#subtitles').selectOption('0'); await guest.locator('#close-settings').click();
    await expect(host.locator('#audio')).toHaveValue('0');
    await host.locator('[data-plyr=seek]').fill('20'); await host.locator('[data-plyr=seek]').dispatchEvent('input');
    await expect.poll(() => guest.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(9);
    await host.locator('[data-plyr=play]').click();
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks).some(track => Array.from(track.activeCues ?? []).some(cue => cue.text === 'Un sous-titre lisible.' && cue.line === 82 && !cue.snapToLines)))).toBe(true);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    await expect(guest.locator('#buffering-overlay')).toBeHidden();
    for (const [width, height, name] of [[390,844,'mobile'],[820,1180,'tablet'],[1440,1000,'desktop']]) {
      await guest.setViewportSize({ width, height });
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await guest.screenshot({ path: `test-results/watch-${name}.png`, fullPage: true });
    }
    await controls(host); await host.locator('[data-plyr=fullscreen]').click();
    await expect.poll(() => host.evaluate(() => document.fullscreenElement?.id)).toBe('screen');
    await expect(host.locator('#player-settings')).toBeHidden();
    await host.mouse.move(0,0); await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/, { timeout: 5000 });
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '0');
    await host.screenshot({ path: 'test-results/watch-fullscreen.png' }); await host.evaluate(() => document.exitFullscreen());
    await b.setOffline(true); await expect.poll(() => host.locator('video').evaluate(video => video.paused), { timeout: 6000 }).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) { console.log('Failure:', error.message, 'Browser errors:', errors, 'State:', latest.get(host)?.state); throw error; }
  finally { releaseMedia(); await guest.unrouteAll({ behavior: 'ignoreErrors' }); await a.close(); await b.close(); }
});
