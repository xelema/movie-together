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
    await expect(host.getByRole('button', { name: 'Créer une room' })).toBeVisible({ timeout: 60_000 });
    await host.getByText(/^Gérer le film et les pistes \/ /).click();
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'test.srt', mimeType: 'text/plain',
      buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nSubtitle test.\n') });
    await host.getByLabel(/Nom affiché/).fill('Test subtitles');
    await Promise.all([
      host.waitForResponse(response => response.url().includes('/subtitles?') && response.status() === 200),
      host.getByRole('button', { name: /^Ajouter les sous-titres \/ / }).click(),
    ]);
    await host.getByRole('button', { name: 'Créer une room' }).click();
    await expect(host.locator('#notice')).toContainText('http://localhost:3100/#invite=');
    const invite = (await host.locator('#notice').textContent()).match(/http:\/\/\S+/)[0];
    let releaseMedia;
    const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
    await guest.route('**/*.m4s', async route => { await mediaGate; await route.continue().catch(() => {}); });
    // The guest's media requests are deliberately held; navigation must not wait for them.
    await guest.goto(invite, { waitUntil: 'domcontentloaded' });
    await expect(guest.locator('#movie-title')).toHaveText('fixture');
    await expect(host.locator('#quality')).toHaveValue('compatible');
    await host.locator('#quality').selectOption('original');
    await expect(guest.locator('#quality')).toHaveValue('compatible');
    await expect.poll(() => host.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    await host.locator('#display-name').fill('Alex');
    await host.locator('#name-form button').click();
    await guest.locator('#display-name').fill('민지');
    await guest.locator('#name-form button').click();
    await expect(host.locator('#participants')).toContainText('민지');
    await expect(guest.locator('#participants')).toContainText('Alex');
    await host.locator('[data-plyr=play]').click();
    await expect.poll(() => latest.get(host)?.state.phase).toBe('buffering');
    await expect(host.locator('#buffering-overlay')).toBeVisible();
    await expect(host.locator('#buffering-label')).toContainText('민지');
    expect(await host.locator('video').evaluate(video => video.paused)).toBe(true);
    releaseMedia();
    for (const page of [host, guest]) {
      await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    }
    await guest.locator('[data-plyr=play]').click();
    await expect.poll(() => host.locator('video').evaluate(video => video.currentTime), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    const drift = await Promise.all([host, guest].map(async page => {
      const version = await page.locator('#quality').inputValue();
      const offset = latest.get(page).movie.renditions.find(item => item.id === version).timelineOffset;
      return (await page.locator('video').evaluate(video => video.currentTime)) - offset;
    }));
    expect(Math.abs(drift[0] - drift[1])).toBeLessThan(0.25);
    console.log(`Measured initial viewer difference: ${Math.round(Math.abs(drift[0] - drift[1]) * 1000)} ms`);
    await guest.locator('[data-plyr=play]').click();
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(true);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    await guest.locator('#audio').selectOption('1');
    await expect(host.locator('#audio')).toHaveValue('0'); await expect(guest.locator('#audio')).toHaveValue('1');
    await guest.locator('#subtitles').selectOption('0');
    await expect(host.locator('#subtitles')).toHaveValue('-1');
    await expect(guest.locator('#subtitles')).toHaveValue('0');
    const percent = 25 / latest.get(host).state.duration * 100;
    await host.locator('[data-plyr=seek]').fill(String(percent));
    await host.locator('[data-plyr=seek]').dispatchEvent('input');
    const guestOffset = latest.get(guest).movie.renditions.find(item => item.id === 'compatible').timelineOffset;
    await expect.poll(() => guest.locator('video').evaluate((video, offset) => Math.abs(video.currentTime - offset - 25), guestOffset)).toBeLessThan(0.15);
    await host.locator('[data-plyr=play]').click();
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
    console.log('Test failure:', error.message, 'Browser errors:', errors);
    for (const page of [host, guest]) console.log('Playback state:', latest.get(page), await page.locator('video').evaluate(video => ({
      time: video.currentTime, paused: video.paused, readyState: video.readyState, hidden: document.hidden,
      ranges: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
    }), undefined, { timeout: 1000 }).catch(() => 'No player available'));
    throw error;
  } finally { await guest.unrouteAll({ behavior: 'ignoreErrors' }); await a.close(); await b.close(); }
});
