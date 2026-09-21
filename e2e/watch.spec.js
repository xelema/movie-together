import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webglProbe } from '../scripts/color-capability.js';

test('admin manages a film and two named viewers join in their language with one shared play', async ({ browser }) => {
  test.skip(process.platform === 'win32' && browser.browserType().name() === 'webkit', 'Playwright WebKit on Windows has neither HLS nor MSE decoding; run this project on macOS/Linux.');
  // One pass over the whole flow: upload, a real ffmpeg prepare (45 s budget),
  // two synced viewers, fullscreen, disconnect. CI needs more than the shared 90 s.
  test.setTimeout(150_000);
  const a = await browser.newContext(), b = await browser.newContext();
  const host = await a.newPage(), guest = await b.newPage(), latest = new Map(), errors = [];
  let releaseMedia = () => {};
  for (const page of [host, guest]) {
    // Loads share one CI box with ffmpeg and the previous engine's teardown:
    // navigation gets room while action checks stay tight.
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => ws.on('framereceived', event => { const message = JSON.parse(event.payload); if (message.type === 'state') latest.set(page, message); }));
  }
  // The fixture is HDR: each page needs its own WebGL2 probe before playback
  // assertions. A negative answer is missing browser coverage, not a pass.
  const [hostCaps, guestCaps] = await Promise.all([host.evaluate(webglProbe), guest.evaluate(webglProbe)]);
  if (!hostCaps.webgl2 || !guestCaps.webgl2) {
    const pages = [!hostCaps.webgl2 && 'host', !guestCaps.webgl2 && 'guest'].filter(Boolean).join('+');
    test.skip(true, `webgl-unavailable: no WebGL2 high-float context on ${pages}`);
  }
  const openDetails = async () => { if (!await host.locator('#movies details').evaluate(node => node.open)) await host.locator('#movies summary').click(); };
  // A first paint can starve past one navigation budget on a loaded box: retry
  // the navigation rather than stretch a single arbitrary timeout.
  const goto = (page, url) => expect(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  const reload = page => expect(async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  // A single hover can land inside the same auto-hide window on a loaded box:
  // wake Plyr, then wait for the controls state it actually reached.
  const showControls = page => expect(async () => {
    const point = await page.locator('.plyr__controls').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const hidden = el.closest('.plyr').classList.contains('plyr--hide-controls');
      return { x: rect.x + rect.width / 2, y: rect.y - (hidden ? rect.height : 0) + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.move(point.x + 1, point.y);
    await expect(page.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/, { timeout: 1000 });
    await page.mouse.move(point.x + 2, point.y);
  }).toPass({ timeout: 10_000 });
  // Point the mouse where the control lands once shown: the move wakes Plyr's controls
  // and the wiggle enters the bar, so its hover flag keeps them open while playing.
  // A click can dispatch its events and still time out on a loaded box, so toggling
  // controls pass a done check: a retry then skips the click instead of flipping back.
  const clickControl = (page, selector, done) => expect(async () => {
    if (done && await done()) return;
    const point = await page.locator(selector).evaluate(el => {
      const hidden = el.closest('.plyr').classList.contains('plyr--hide-controls');
      const r = el.getBoundingClientRect(), bar = el.closest('.plyr__controls').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y - (hidden ? bar.height : 0) + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.move(point.x + 1, point.y);
    // The action a previous click started can land while these moves run:
    // re-check before clicking or a toggle flips back while it is still landing.
    if (done && await done()) return;
    await page.locator(`.plyr:not(.plyr--hide-controls) ${selector}`).click({ timeout: 3000 });
    // A fullscreen request can take seconds to resolve on a loaded box: give the
    // done state a poll window before deciding the click missed.
    if (done) await expect.poll(done, { timeout: 4000 }).toBe(true);
  }).toPass({ timeout: 15_000 });
  try {
    await guest.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return window.testSoundAllowed ? play.call(this) : Promise.reject(new DOMException('Sound permission', 'NotAllowedError'));
      };
      document.addEventListener('click', event => { if (event.target.closest('#allow-sound')) window.testSoundAllowed = true; }, true);
    });
    await goto(guest, '/');
    await expect(guest.locator('#join-form input')).toHaveCount(1);
    await expect(guest.locator('#login-form')).toBeHidden();
    await guest.locator('#language').selectOption('ko'); await reload(guest);
    await expect(guest.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(guest.locator('#language-flag')).toHaveAttribute('src', '/flags/ko.svg');
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
    await goto(host, '/admin');
    await host.locator('#login-form input').fill('browser-test-password'); await host.locator('#login-form button').click();
    await expect(host.locator('#library')).toBeVisible();
    await expect(host.locator('#disk-space')).toContainText('libres');
    // Each engine uses the same temporary test server; start with an empty library.
    const headers = { Origin: 'http://localhost:3100' };
    for (const room of await (await host.request.get('/api/rooms')).json()) await host.request.delete(`/api/rooms/${room.id}`, { headers });
    for (const movie of await (await host.request.get('/api/movies')).json()) await host.request.delete(`/api/movies/${movie.id}`, { headers });
    await host.locator('#refresh').click();
    await host.locator('#upload-file').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await readFile('data/e2e/fixture.mp4') }); await host.locator('#upload-button').click();
    await expect(host.locator('#movies')).toContainText('À préparer');
    await openDetails();
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nUn sous-titre lisible.\n') });
    await host.getByLabel('Nom affiché').fill('Français');
    await host.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(host.locator('#movies')).toContainText('Français · fr');
    await openDetails();
    await host.getByRole('button', { name: 'Retirer' }).click();
    await expect(host.locator('#movies')).not.toContainText('Français · fr');
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'dialogue.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:49,000\nUn sous-titre lisible.\n') });
    await host.getByLabel('Nom affiché').fill('Français');
    await host.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(host.locator('#movies')).toContainText('Français · fr');
    await openDetails(); await host.getByRole('button', { name: 'Préparer le film' }).first().click();
    await expect(host.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 45_000 });
    await openDetails();
    await host.locator('#movies input[type=file]').setInputFiles({ name: 'extra.smi', mimeType: 'text/plain', buffer: Buffer.from('<SAMI>\n<BODY>\n<SYNC Start=10000><P Class=ENCC>Extra subtitle.\n</BODY>\n</SAMI>\n') });
    await host.getByLabel('Nom affiché').fill('English'); await host.getByLabel('Langue', { exact: true }).selectOption('en');
    await host.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(host.locator('#movies')).toContainText('English · en');
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
    await expect(host.locator('video')).toHaveCSS('filter', 'none');
    await expect(guest.locator('video')).toHaveCSS('filter', 'none');
    await expect(host.locator('#picture-settings')).toHaveCount(0);
    await expect(guest.locator('#picture-settings')).toHaveCount(0);
    await expect(host.locator('#participants')).toContainText('민지');
    // Member diagnostics go to admins only and can be arbitrarily long: the pill must
    // wrap instead of crushing the film column or overflowing the page. The injected
    // li mirrors what app.js builds for a waiting member and is measured before the
    // next state frame re-renders the list.
    const diagnosticBreaksLayout = () => host.evaluate(() => {
      const li = document.createElement('li'); li.dataset.ready = 'false';
      li.innerHTML = '<span class="avatar">C</span><strong>chrome</strong><span>Chargement…</span>' +
        '<small class="track-tag">not-ready: failure, activation, hidden, data [Ce film utilise un codec vidéo que cet appareil ne peut pas lire.]</small>';
      document.querySelector('#participants').append(li);
      const broken = document.querySelector('#movie-title').getBoundingClientRect().height > 120 || document.documentElement.scrollWidth > innerWidth;
      li.remove();
      return broken;
    });
    expect(await diagnosticBreaksLayout()).toBe(false);
    await host.setViewportSize({ width: 390, height: 844 });
    expect(await diagnosticBreaksLayout()).toBe(false);
    await host.setViewportSize({ width: 1280, height: 720 });
    await host.locator('.plyr__control--overlaid').click();
    await expect(host.locator('#buffering-label')).toContainText('민지');
    releaseMedia();
    await expect.poll(() => guest.locator('video').evaluate(video => video.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await expect(host.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
    await expect(guest.locator('.color-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
    await expect.poll(() => guest.locator('.color-canvas').evaluate(canvas => {
      const video = document.querySelector('video');
      return canvas.width <= Math.ceil(video.getBoundingClientRect().width * devicePixelRatio) && canvas.width < video.videoWidth;
    })).toBe(true);
    await expect(guest.locator('#screen #allow-sound')).toBeVisible();
    await guest.screenshot({ path: 'test-results/watch-sound.png', fullPage: true });
    await guest.locator('#allow-sound').click();
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => host.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(2);
    // Starting skew converges through the sync loop rather than being exact from frame one.
    await expect.poll(async () => {
      const [a, b] = await Promise.all([host, guest].map(page => page.locator('video').evaluate(video => video.currentTime)));
      return Math.abs(a - b);
    }, { timeout: 15_000 }).toBeLessThan(.35);
    await guest.evaluate(() => { window.testParticipant = document.querySelector('#participants li'); });
    // One post-action state frame proves the list survived a real broadcast;
    // a fixed sleep only made the same check slower and less precise.
    const guestState = latest.get(guest);
    await expect.poll(() => latest.get(guest) !== guestState).toBe(true);
    expect(await guest.evaluate(() => window.testParticipant === document.querySelector('#participants li'))).toBe(true);
    await clickControl(guest, '.plyr__controls [data-plyr=play]', () => guest.locator('video').evaluate(video => video.paused));
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(true);
    // Hold the first subtitle segment in flight: a fragment that finishes
    // parsing while its track is parked gets its cues dropped and is never
    // refetched, so the round trip below must still bring the cues back.
    let releaseSubtitle = () => {}, held = false;
    const subtitleGate = new Promise(resolve => { releaseSubtitle = resolve; });
    await guest.route('**/sub_*.vtt', async route => {
      if (!held) { held = true; await subtitleGate; }
      await route.continue();
    });
    await clickControl(guest, '#open-settings', () => guest.locator('#player-settings').isVisible());
    await guest.locator('#audio').selectOption('1'); await guest.locator('#subtitles').selectOption('0');
    await expect(guest.locator('#audio')).toBeInViewport(); await expect(guest.locator('#subtitles')).toBeInViewport();
    // Only one text track may render at once, whatever the engine exposes, and
    // glyph size follows the painted picture rather than the window.
    const subtitleModes = page => page.locator('video').evaluate(video =>
      Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind)).map(track => track.mode));
    const showingTracks = page => page.locator('video').evaluate(video =>
      Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind) && track.mode === 'showing').length);
    await expect.poll(() => showingTracks(guest)).toBe(1);
    // Simulate a WebKit-style duplicate: a second subtitle track forced to
    // showing is demoted again, and the selected track keeps its cues.
    await guest.locator('video').evaluate(video => {
      const subtitles = Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind));
      subtitles[1].mode = 'showing';
    });
    await expect.poll(() => showingTracks(guest)).toBe(1);
    await expect.poll(async () => (await subtitleModes(guest))[0]).toBe('showing');
    // Switch away while the first track's segment is still parsing. Once
    // released, the fragment finishes in the parked state: its cues must still
    // land there, before the track is ever re-selected.
    await expect.poll(() => held).toBe(true);
    await guest.locator('#subtitles').selectOption('1');
    await expect.poll(async () => (await subtitleModes(guest))[1]).toBe('showing');
    releaseSubtitle();
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind))[0].cues?.length ?? 0)).toBeGreaterThan(0);
    await guest.locator('#subtitles').selectOption('0');
    await expect.poll(async () => (await subtitleModes(guest))[0]).toBe('showing');
    // The reported failure was a showing track whose cues never activated.
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind))[0].activeCues?.length ?? 0)).toBeGreaterThan(0);
    const expectSubtitleSize = page => expect.poll(async () => page.locator('video').evaluate(video => {
      const rect = video.getBoundingClientRect(), aspect = video.videoWidth / video.videoHeight || 16 / 9;
      const picture = Math.min(rect.height, rect.width / aspect);
      const css = parseFloat(getComputedStyle(video.parentElement).getPropertyValue('--subtitle-size'));
      const captions = document.querySelector('.color-captions');
      const overlay = captions ? parseFloat(getComputedStyle(captions).fontSize) : css;
      return picture > 0 && Math.abs(css - Math.max(18, picture * 38.4 / 720)) < 1 && Math.abs(overlay - css) < 1;
    })).toBe(true);
    await expectSubtitleSize(guest);
    // Opening the overlay must never apply an image filter to video or an ancestor.
    for (const page of [host, guest]) expect(await page.locator('video').evaluate(video => {
      for (let node = video; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.filter !== 'none' || style.opacity !== '1' || style.mixBlendMode !== 'normal') return false;
      }
      return true;
    })).toBe(true);
    await guest.screenshot({ path: 'test-results/watch-settings.png', fullPage: true });
    await expect(guest.locator('#bandwidth-row')).toBeHidden();
    await guest.locator('#close-settings').click();
    await expect(guest.locator('#player-settings select')).toHaveCount(2);
    // Live bandwidth is admin-only: the host gets the toggle and the badge, the guest neither.
    await clickControl(host, '#open-settings', () => host.locator('#player-settings').isVisible());
    await expect(host.locator('#bandwidth-row')).toBeVisible();
    await host.locator('#bandwidth-toggle').check();
    await host.locator('#close-settings').click();
    await expect(host.locator('#bandwidth-badge')).toBeVisible();
    // hls.js exposes a live estimate; native HLS (Safari) shows the unavailable marker instead.
    await expect(host.locator('#bandwidth-badge')).toContainText(/[\d.]+ Mb\/s|—/, { timeout: 5000 });
    expect(await host.evaluate(() => localStorage.getItem('bandwidth-badge'))).toBe('on');
    await expect(guest.locator('#bandwidth-badge')).toBeHidden();
    await expect(host.locator('#audio')).toHaveValue('0');
    await host.locator('[data-plyr=seek]').fill('20'); await host.locator('[data-plyr=seek]').dispatchEvent('input');
    await expect.poll(() => guest.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(9);
    await host.locator('#screen').focus(); await host.keyboard.press('k');
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks).some(track => Array.from(track.activeCues ?? []).some(cue => cue.text === 'Un sous-titre lisible.' && cue.line === 84 && !cue.snapToLines)))).toBe(true);
    await expect(guest.locator('.color-captions')).toHaveText('Un sous-titre lisible.');
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    await expect(guest.locator('#buffering-overlay')).toBeHidden();
    for (const [width, height, name] of [[390,844,'mobile'],[820,1180,'tablet'],[1440,1000,'desktop']]) {
      await guest.setViewportSize({ width, height });
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await showControls(guest);
      await expectSubtitleSize(guest);
      if (width === 390) await expect.poll(() => guest.locator('video').evaluate(video =>
        Array.from(video.textTracks).some(track => Array.from(track.activeCues ?? []).some(cue => cue.line < 80)))).toBe(true);
      await guest.screenshot({ path: `test-results/watch-${name}.png`, fullPage: true });
    }
    // A track switch is local to the viewer: it must not pause the room.
    await clickControl(guest, '#open-settings', () => guest.locator('#player-settings').isVisible());
    // The visible survivor follows the selector: another language takes the
    // single showing slot, then none keeps every track off the screen.
    await guest.locator('#subtitles').selectOption('1');
    await expect.poll(() => showingTracks(guest)).toBe(1);
    await expect.poll(async () => (await subtitleModes(guest))[1]).toBe('showing');
    await guest.locator('#subtitles').selectOption('-1'); await guest.locator('#close-settings').click();
    await expect.poll(() => showingTracks(guest)).toBe(0);
    // The room broadcasts every tick; require a fresh post-switch frame rather
    // than sleeping for a duration that only approximates that round trip.
    const hostState = latest.get(host);
    await expect.poll(() => latest.get(host) !== hostState).toBe(true);
    await expect.poll(() => latest.get(host)?.state.phase).toBe('playing');
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(false);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // The 50 s fixture can end during the checks above and a member stall can
    // freeze the room mid-flight: Plyr pins its controls open unless the room is
    // verifiably playing, so every pass below first restores that state. A room
    // that refuses to resume fails on this poll, with the dump naming the gate.
    const ensurePlaying = () => expect.poll(async () => {
      const hostReady = await host.evaluate(() => {
        const video = document.querySelector('video'), player = window.player;
        if (video.currentTime >= 20) player.command('seek', 5);
        if (player.state?.phase === 'paused') player.command('play');
        return player.state?.phase === 'playing' && !video.paused && !video.seeking && video.currentTime < 20;
      });
      if (!hostReady) return false;
      const [hostTime, guestTime] = await Promise.all([host, guest].map(page =>
        page.locator('video').evaluate(video => video.paused || video.seeking || video.currentTime >= 20 ? -1 : video.currentTime)));
      // The sync loop converges members well under a second; a wider gap is a
      // member still realigning after a seek, not a settled room.
      return hostTime >= 0 && guestTime >= 0 && Math.abs(hostTime - guestTime) < 1;
    }, { timeout: 15_000 }).toBe(true);
    // Controls auto-hide while playing; hover until they are shown before clicking fullscreen.
    await expect(async () => {
      await ensurePlaying();
      if (await host.evaluate(() => document.fullscreenElement?.id) !== 'screen') {
        await clickControl(host, '[data-plyr=fullscreen]', () => host.evaluate(() => document.fullscreenElement?.id === 'screen'));
      }
      await expect.poll(() => host.evaluate(() => document.fullscreenElement?.id), { timeout: 5000 }).toBe('screen');
      // The renderer paints display pixels and never upscales the source:
      // assert that contract, not an equality tied to the fullscreen size.
      await expect.poll(() => host.locator('.color-canvas').evaluate(canvas => {
        const video = document.querySelector('video'), rect = video.getBoundingClientRect();
        if (canvas.dataset.ready !== 'true' || !video.videoWidth) return false;
        const scale = Math.min(1, rect.width * devicePixelRatio / video.videoWidth, rect.height * devicePixelRatio / video.videoHeight);
        return canvas.width === Math.max(1, Math.round(video.videoWidth * scale)) && canvas.height === Math.max(1, Math.round(video.videoHeight * scale));
      }), { timeout: 3000 }).toBe(true);
      await expectSubtitleSize(host);
      await expect(host.locator('#player-settings')).toBeHidden();
      await host.mouse.move(0, 0);
      await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/, { timeout: 4000 });
      await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '0', { timeout: 1000 });
      await expect(host.locator('video')).toHaveCSS('cursor', 'none', { timeout: 1000 });
    }).toPass({ timeout: 60_000 });
    await showControls(host);
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '1');
    await expect(host.locator('video')).not.toHaveCSS('cursor', 'none');
    await host.screenshot({ path: 'test-results/watch-fullscreen.png' }); await host.evaluate(() => document.exitFullscreen());
    await expectSubtitleSize(host);
    // A member that loses its network pauses itself on the offline event; the room
    // freezes as soon as its pause command lands or its report goes stale
    // (reportTimeout), and the host follows. Both directions are the contract.
    await b.setOffline(true);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    await expect(guest.locator('#buffering-label')).toContainText('연결이 끊겨');
    await expect.poll(() => host.locator('video').evaluate(video => video.paused), { timeout: 10_000 }).toBe(true);
    const contextLost = await host.locator('.color-canvas').evaluate(canvas => {
      const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) return false;
      extension.loseContext();
      return true;
    });
    if (!contextLost) test.skip(true, 'webgl-lose-context-unavailable: cannot exercise renderer failure');
    await expect(host.locator('#buffering-label')).toContainText('rendu des couleurs');
    await expect.poll(() => host.locator('video').evaluate(video => video.paused)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    const dump = async (page, role) => `${role}: ` + JSON.stringify({
      state: latest.get(page)?.state,
      media: await page.locator('video').evaluate(video => ({ ready: video.readyState, error: video.error?.message,
        paused: video.paused, seeking: video.seeking, time: video.currentTime, width: video.videoWidth,
        source: video.currentSrc, buffered: video.buffered.length, nativeHls: video.canPlayType('application/vnd.apple.mpegurl'),
        mse: window.Hls.isSupported(), vendor: navigator.vendor,
        tracks: Array.from(video.textTracks).map(track => ({ kind: track.kind, mode: track.mode,
          label: track.label, cues: track.cues?.length ?? 0, active: track.activeCues?.length ?? 0 })) })).catch(() => null),
      canvas: await page.locator('.color-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, ...canvas.dataset })).catch(() => null),
      label: await page.locator('#buffering-label').textContent().catch(() => null),
    });
    console.log('Failure:', error.message, 'Browser errors:', errors, await dump(host, 'host'), await dump(guest, 'guest'));
    throw error;
  }
  finally {
    releaseMedia();
    // Cleanup must not replace the first assertion with a context-close error.
    await Promise.allSettled([guest.unrouteAll({ behavior: 'ignoreErrors' }), a.close(), b.close()]);
  }
});
