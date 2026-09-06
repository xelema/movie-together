import { test, expect } from '@playwright/test';

test('two viewers play, pause, seek, choose audio independently and stop when disconnected', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const host = await a.newPage(), guest = await b.newPage();
  const errors = [];
  const latest = new Map();
  host.on('pageerror', error => errors.push(error.message)); guest.on('pageerror', error => errors.push(error.message));
  for (const page of [host, guest]) {
    page.on('websocket', ws => ws.on('framereceived', event => {
      const data = JSON.parse(event.payload); if (data.type === 'state') latest.set(page, data);
    }));
    page.on('console', message => {
      if (message.type() === 'error') console.log('Browser:', message.text());
      if (message.text().includes('Content Security Policy')) errors.push(message.text());
    });
    page.on('response', response => { if (response.status() >= 400) console.log('HTTP:', response.status(), response.url()); });
  }
  try {
    await host.goto('/');
    await host.getByLabel(/Mot de passe/).fill('browser-test-password');
    await host.getByRole('button', { name: 'Se connecter' }).click();
    await expect(host.getByRole('heading', { name: 'Bibliothèque' })).toBeVisible();
    await host.locator('#upload-file').setInputFiles('data/e2e/fixture.mp4');
    await host.getByRole('button', { name: 'Envoyer le film' }).click();
    await expect(host.getByText(/^À préparer \/ /)).toBeVisible({ timeout: 15_000 });
    await host.getByText(/^Gérer le film et les pistes \/ /).click();
    await host.getByRole('button', { name: 'Préparer les pistes sélectionnées' }).click();
    await expect(host.getByRole('button', { name: 'Créer une room' })).toBeVisible({ timeout: 20_000 });
    await host.getByText(/^Gérer le film et les pistes \/ /).click();
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'test.srt', mimeType: 'text/plain',
      buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nSubtitle test.\n') });
    await host.getByLabel(/Nom affiché/).fill('Test subtitles');
    await Promise.all([
      host.waitForResponse(response => response.url().includes('/subtitles?') && response.status() === 200),
      host.getByRole('button', { name: /^Ajouter les sous-titres \/ / }).click(),
    ]);
    await host.getByRole('button', { name: 'Créer une room' }).click();
    const invite = (await host.locator('#notice').textContent()).match(/http:\/\/\S+/)[0];
    let releaseMedia;
    const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
    await guest.route('**/*.m4s', async route => { await mediaGate; await route.continue().catch(() => {}); });
    await guest.goto(invite);
    await expect(guest.locator('#movie-title')).toHaveText('fixture');
    await expect.poll(() => host.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    await host.getByRole('button', { name: 'Activer mon lecteur' }).click();
    await host.getByRole('button', { name: 'Lecture pour tous' }).click();
    await expect.poll(() => latest.get(host)?.state.phase).toBe('buffering');
    expect(await host.locator('video').evaluate(video => video.paused)).toBe(true);
    releaseMedia();
    for (const page of [host, guest]) {
      await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
      if (await page.getByRole('button', { name: 'Activer mon lecteur' }).isVisible()) await page.getByRole('button', { name: 'Activer mon lecteur' }).click();
      await expect(page.getByRole('button', { name: 'Activer mon lecteur' })).toBeHidden();
    }
    await host.getByRole('button', { name: 'Lecture pour tous' }).click();
    await expect.poll(() => host.locator('video').evaluate(video => video.currentTime), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    const drift = await Promise.all([host, guest].map(page => page.locator('video').evaluate(video => video.currentTime)));
    expect(Math.abs(drift[0] - drift[1])).toBeLessThan(0.25);
    console.log(`Measured initial viewer difference: ${Math.round(Math.abs(drift[0] - drift[1]) * 1000)} ms`);
    await guest.getByRole('button', { name: 'Pause pour tous' }).click();
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(true);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    await guest.locator('#audio').selectOption('1');
    await expect(host.locator('#audio')).toHaveValue('0'); await expect(guest.locator('#audio')).toHaveValue('1');
    await guest.locator('#subtitles').selectOption('0');
    await expect(host.locator('#subtitles')).toHaveValue('-1');
    await expect(guest.locator('#subtitles')).toHaveValue('0');
    await host.locator('#seek').fill('25'); await host.locator('#seek').dispatchEvent('change');
    await expect.poll(() => guest.locator('video').evaluate(video => Math.abs(video.currentTime - 25))).toBeLessThan(0.15);
    await host.getByRole('button', { name: 'Lecture pour tous' }).click();
    await expect.poll(() => host.locator('video').evaluate(video => video.currentTime), { timeout: 15_000 }).toBeGreaterThan(26);
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks)
      .some(track => track.mode === 'showing' && Array.from(track.activeCues ?? []).some(cue => cue.text === 'Subtitle test.')))).toBe(true);
    await host.screenshot({ path: 'test-results/movie-night-desktop.png', fullPage: true });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: 'test-results/movie-night-mobile.png', fullPage: true });
    await b.setOffline(true);
    await expect.poll(() => host.locator('video').evaluate(video => video.paused), { timeout: 6000 }).toBe(true);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused), { timeout: 6000 }).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    for (const page of [host, guest]) console.log('Playback state:', latest.get(page), await page.locator('video').evaluate(video => ({
      time: video.currentTime, paused: video.paused, readyState: video.readyState, hidden: document.hidden,
      ranges: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
    })));
    throw error;
  } finally { await a.close(); await b.close(); }
});
