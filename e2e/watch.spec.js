import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { webglProbe } from '../scripts/color-capability.js';

// The séance journey below runs as four serial passes sharing the live pages:
// the upload, the real ffmpeg prepare and the joins are paid once in the first
// pass, while each pass keeps its own slice of the budget the single 150 s
// monolith used to burst on a loaded box. `joined` gates the passes after it.
test.describe.configure({ mode: 'serial' });

let a, b, host, guest, releaseMedia = () => {}, joined = false;
const latest = new Map(), errors = [];

// Micro factice déterministe : un oscillateur WebAudio alimente un vrai
// MediaStream, le pipeline de capture et le worklet restent réels. Seule
// la source matérielle est remplacée, sans réseau ni permission à mimer.
const fakeMic = () => {
  window.voiceTest = { micCalls: 0, streams: [], pending: [], hold: false };
  // WebKit peut remplacer l'objet MediaDevices en cours de vie de la page :
  // la propriété est interceptée sur navigator, jamais sur l'instance.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    get: () => ({ getUserMedia: () => {
      window.voiceTest.micCalls++;
      // Chaque appel produit un vrai flux distinct, armé dans le geste même :
      // résolu plus tard quand `hold` est levé, jamais réutilisé d'un appel
      // à l'autre pour qu'un flux orphelin soit observable.
      const context = new AudioContext();
      const osc = context.createOscillator(), gain = context.createGain();
      const dest = context.createMediaStreamDestination();
      osc.type = 'sawtooth'; osc.frequency.value = 330; gain.gain.value = .4;
      osc.connect(gain); gain.connect(dest); osc.start();
      context.resume();
      window.voiceTest.stream = dest.stream;
      window.voiceTest.streams.push(dest.stream);
      if (window.voiceTest.hold) return new Promise(resolve => window.voiceTest.pending.push(() => resolve(dest.stream)));
      return Promise.resolve(dest.stream);
    } }),
  });
};

// A first paint can starve past one navigation budget on a loaded box: retry
// the navigation rather than stretch a single arbitrary timeout.
const goto = (page, url) => expect(async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
}).toPass({ timeout: 60_000 });
const reload = page => expect(async () => {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
}).toPass({ timeout: 60_000 });
// Only a real mouseenter latches Plyr's hover flag, the state that keeps its
// hide timer from dropping the chrome between the wake and the click. Any
// internal toggleControls pass (loading tick, media event) drops the bar
// while the flag is off, so the crossing is owned by the poll itself: each
// pass reads the flag first — a latched pass costs one probe — then parks
// the pointer over the picture, a container mousemove that re-arms the
// timer and wakes a dropped bar, and sweeps into the live center once the
// hit test proves the bar owns it. :hover tells whether the pointer is
// really inside, so the leave only runs when the crossing needs it; a
// mid-slide miss retries on fresh geometry instead of a stale point.
// What the poll has to prove is that the bar is on screen and clickable, which
// is all a click needs. `controls.hover` is the mic/webcam hold latch the app
// sets around the mic, not "the pointer is on the bar", and a playing element
// never falls back to the paused shortcut: in fullscreen the flag stayed false
// while the bar was up, so the old predicate could never latch.
const latchHover = (page, timeout = 5000) => expect.poll(async () => {
  try {
    const probe = await page.locator('.plyr__controls').evaluate(el => {
      const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const plyr = el.closest('.plyr'), style = getComputedStyle(el);
      const hit = document.elementFromPoint(x, y);
      const shown = !plyr.classList.contains('plyr--hide-controls') && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && r.width > 0 && r.height > 0;
      return { x, y, out: Math.max(plyr.getBoundingClientRect().top + 8, 4),
        shown, over: el.matches(':hover'), ok: shown && !!hit && el.contains(hit) };
    });
    if (probe.ok && probe.over) return true;
    if (probe.over || !probe.ok) await page.mouse.move(probe.x, probe.out);
    if (!probe.ok) return false;
    await page.mouse.move(probe.x, probe.y, { steps: 4 });
    return await page.locator('.plyr__controls').evaluate(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !el.closest('.plyr').classList.contains('plyr--hide-controls') && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && r.width > 0 && r.height > 0 && !!hit && el.contains(hit);
    });
  } catch { return false; }
}, { timeout }).toBe(true);

// Latching hover is also what shows the chrome: the poll itself re-wakes a
// dropped bar on every pass, so a wider budget replaces the assertion retry
// and a transient evaluate error just costs one probe instead of the pass.
const showControls = page => latchHover(page, 12_000);
// A freeze that pins the controls open (Plyr shows them on pause) can land between
// two clicks, so a toggle is asserted against the state the click actually found.
const hiddenControls = page => page.locator('.plyr').evaluate(el => el.classList.contains('plyr--hide-controls'));
// A prise closed before its first frame reaches the room ends 'no-speech',
// correctly: the heard marker is the only proof the gate saw audio and the
// live session is open. It is re-armed per utterance at 'started', so it
// cannot pass on a stale card.
const heardSpeech = page => expect(page.locator('#voice-local')).toHaveAttribute('data-kind', 'transcript');
// A click can dispatch its events and still time out on a loaded box, so toggling
// controls pass a done check: a retry then skips the click instead of flipping back.
const clickControl = (page, selector, done) => expect(async () => {
  if (done && await done()) return;
  await latchHover(page);
  // The action a previous click started can land while the latch ran:
  // re-check before clicking or a toggle flips back while it is still landing.
  if (done && await done()) return;
  // Le clic n'est pas la preuve : en plein écran l'action aboutit (le bouton passe
  // a [pressed]) alors que le controle d'actionnabilité expire pendant la
  // transition. C'est l'etat observe juste apres qui decide, et le toPass rejoue
  // le geste tant qu'il n'est pas atteint.
  await page.locator(`.plyr:not(.plyr--hide-controls) ${selector}`).click({ timeout: 3000 }).catch(() => {});
  // A fullscreen request can take seconds to resolve on a loaded box: give the
  // done state a poll window before deciding the click missed.
  if (done) await expect.poll(done, { timeout: 4000 }).toBe(true);
}).toPass({ timeout: 15_000 });

const subtitleModes = page => page.locator('video').evaluate(video =>
  Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind)).map(track => track.mode));
const showingTracks = page => page.locator('video').evaluate(video =>
  Array.from(video.textTracks).filter(track => ['subtitles', 'captions'].includes(track.kind) && track.mode === 'showing').length);

const expectSubtitleSize = page => expect.poll(async () => page.locator('video').evaluate(video => {
  const rect = video.getBoundingClientRect(), aspect = video.videoWidth / video.videoHeight || 16 / 9;
  const picture = Math.min(rect.height, rect.width / aspect);
  const css = parseFloat(getComputedStyle(video.parentElement).getPropertyValue('--subtitle-size'));
  const captions = document.querySelector('.color-captions');
  const overlay = captions ? parseFloat(getComputedStyle(captions).fontSize) : css;
  return picture > 0 && Math.abs(css - Math.max(18, picture * 38.4 / 720)) < 1 && Math.abs(overlay - css) < 1;
})).toBe(true);

// A member stall freezes its element while the room still broadcasts
// 'playing', so one snapshot is not proof of playback: the picture must
// verifiably advance between two samples a real interval apart. -1 reads as
// "not flowing".
const flowingTime = page => page.locator('video').evaluate(video => new Promise(resolve => {
  if (video.paused || video.seeking || video.readyState < 3) return resolve(-1);
  const at = video.currentTime;
  setTimeout(() => resolve(!video.paused && !video.seeking && video.currentTime > at ? at : -1), 400);
})).catch(() => -1);

// The 50 s fixture can end during the checks above and a member stall can
// freeze the room mid-flight: Plyr pins its controls open unless the room is
// verifiably playing, so every pass below first restores that state. A room
// that refuses to resume fails on this poll, with the dump naming the gate.
const ensurePlaying = () => expect.poll(async () => {
  try {
    const phase = await host.evaluate(() => {
      const video = document.querySelector('video'), player = window.player, state = player.state;
      if (!state) return undefined;
      // Une commande par époque : 'seek' et 'play' figent la séance et vident
      // les rapports dont la reprise attend l'alignement. Re-commander pendant
      // qu'une commande précédente est encore en vol rallonge le cycle au lieu
      // de le finir, et la cible de la séance — pas le temps de l'élément — dit
      // si un recalage est encore utile : une position déjà basse signifie que
      // la salle converge, l'élément rattrape tout seul.
      const gate = window.__e2eGate ??= { epoch: -1, at: 0 };
      // Une commande vraiment perdue (socket refermée au mauvais moment) ne fait
      // jamais avancer l'époque : après 2 s sans nouvel état, retenter coûte un
      // cycle, attendre bloque la passe entière.
      if (state.epoch !== gate.epoch || performance.now() - gate.at > 2000) {
        gate.epoch = state.epoch; gate.at = performance.now();
        if (state.phase === 'paused') {
          if (state.position >= 15) player.command('seek', 5); else player.command('play');
        } else if (state.phase === 'playing' && player.target() >= 20) {
          player.command('seek', 5);
        }
      }
      return state.phase;
    });
    if (phase !== 'playing') return false;
    const [hostTime, guestTime] = await Promise.all([host, guest].map(flowingTime));
    // The sync loop converges members well under a second. A wider gap is a
    // member still realigning after a seek, not a settled room.
    return hostTime >= 0 && hostTime < 20 && guestTime >= 0 && Math.abs(hostTime - guestTime) < 1;
  } catch { return false; }
}, { timeout: 15_000 }).toBe(true);

// Plyr pins the chrome while the element is paused or loading, so auto-hide
// is only owed once the picture verifiably flows; a stalled member freezes
// mid-wait with the room still broadcasting 'playing'. A waiting tick can
// also flap the hide class off again within a frame of it landing, and the
// fade itself is a compositor transition that jank can stretch: the end
// state is the chrome verifiably hidden — class, opacity and cursor in one
// read — not the class alone. Re-arm a paused room, no timer to guess.
const controlsAutoHide = page => expect.poll(async () => {
  try {
    if (await page.evaluate(() => window.player?.state?.phase === 'paused' ||
        (document.querySelector('video')?.currentTime ?? 0) >= 40)) await ensurePlaying();
    if (await flowingTime(page) < 0) return false;
    return await page.locator('.plyr').evaluate(plyr => plyr.classList.contains('plyr--hide-controls') &&
      getComputedStyle(plyr.querySelector('.plyr__controls')).opacity === '0' &&
      getComputedStyle(plyr.querySelector('video')).cursor === 'none');
  } catch { return false; }
}, { timeout: 30_000 }).toBe(true);

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
const reportFailure = async error =>
  console.log('Failure:', error.message, 'Browser errors:', errors, host && await dump(host, 'host'), guest && await dump(guest, 'guest'));

test('admin manages a film and two named viewers join in their language with one shared play', async ({ browser }) => {
  test.skip(process.platform === 'win32' && browser.browserType().name() === 'webkit', 'Playwright WebKit on Windows has neither HLS nor MSE decoding; run this project on macOS/Linux.');
  // The upload and the real ffmpeg prepare (45 s budget) dominate this pass.
  test.setTimeout(90_000);
  a = await browser.newContext(); b = await browser.newContext();
  host = await a.newPage(); guest = await b.newPage();
  for (const page of [host, guest]) {
    // Loads share one CI box with ffmpeg and the previous engine's teardown:
    // navigation gets room while action checks stay tight.
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', ws => ws.on('framereceived', event => { const message = JSON.parse(event.payload); if (message.type === 'state') latest.set(page, message); }));
  }
  await host.addInitScript(fakeMic); await guest.addInitScript(fakeMic);
  // The fixture is HDR: each page needs its own WebGL2 probe before playback
  // assertions. A negative answer is missing browser coverage, not a pass.
  const [hostCaps, guestCaps] = await Promise.all([host.evaluate(webglProbe), guest.evaluate(webglProbe)]);
  if (!hostCaps.webgl2 || !guestCaps.webgl2) {
    const pages = [!hostCaps.webgl2 && 'host', !guestCaps.webgl2 && 'guest'].filter(Boolean).join('+');
    test.skip(true, `webgl-unavailable: no WebGL2 high-float context on ${pages}`);
  }
  const openDetails = async () => { if (!await host.locator('#movies details').evaluate(node => node.open)) await host.locator('#movies summary').click(); };
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
    await host.getByRole('tab', { name: 'Séances' }).click();
    await expect(host.locator('#rooms-empty')).toBeVisible();
    await host.getByRole('tab', { name: 'Réglages' }).click();
    // Réglages opérationnels : le formulaire groupe les paramètres, une
    // modification persiste au rechargement et le reset rend les défauts.
    await expect(host.locator('#settings-form fieldset')).toHaveCount(7);
    // L'input compact garde ses 86 px : la règle globale input{width:100%} ne
    // doit pas écraser le libellé de la ligne.
    const settingRow = host.locator('.setting-row').first();
    const inputBox = await settingRow.locator('input').boundingBox();
    const spanBox = await settingRow.locator('label > span').boundingBox();
    expect(inputBox.width).toBe(86);
    expect(spanBox.width).toBeGreaterThan(inputBox.width);
    // Chaque réglage porte une description française exposée au survol via title.
    await expect(host.locator('.setting-row label > span[title]')).toHaveCount(25);
    await expect(host.locator('.setting-row label > span').filter({ hasText: 'Buffer de démarrage' }))
      .toHaveAttribute('title', /tampon à accumuler/);
    await expect(host.locator('#set-loginLimit')).toHaveAttribute('title', /15 minutes/);
    await host.locator('#set-maxRooms').fill('25');
    await host.locator('#settings-save').click();
    await expect(host.locator('#notice')).toContainText('enregistrés');
    await reload(host);
    await expect(host.locator('#library')).toBeVisible();
    await expect(host.locator('#set-maxRooms')).toHaveValue('25');
    await host.locator('#settings-reset').click();
    await expect(host.locator('#set-maxRooms')).toHaveValue('20');
    await host.getByRole('tab', { name: 'Films' }).click();
    await host.locator('#upload-file').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await readFile('data/e2e/fixture.mp4') });
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
    // La traduction vocale est proposée décochée. Une séance ordinaire n'expose
    // ni indicateur ni contrôle micro.
    await expect(host.locator('#create-voice')).not.toBeChecked();
    await host.locator('#random-code').click(); await expect(host.locator('#create-code')).toHaveValue(/^[a-f0-9]{8}$/);
    await host.locator('#create-code').fill('Sans-Voix');
    await host.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(host.locator('#name-dialog')).toBeVisible(); await host.locator('#room-name').fill('Alex'); await host.locator('#name-dialog button').click();
    await expect(host.locator('#movie-title')).toHaveText('fixture', { timeout: 15_000 });
    await expect(host.locator('#voice-badge')).toHaveCount(0); await expect(host.locator('#voice-mic')).toBeHidden();
    await host.locator('#leave').click();
    await host.getByRole('button', { name: 'Créer une séance', exact: true }).click();
    await expect(host.locator('#create-voice')).not.toBeChecked();
    await host.locator('#create-voice').check();
    await host.locator('#create-code').fill('Cine-Soir');
    await host.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(host.locator('#name-dialog')).toBeVisible(); await host.locator('#name-dialog button').click();
    await expect(host.locator('#movie-title')).toHaveText('fixture', { timeout: 15_000 });
    await expect(host.locator('#voice-badge')).toHaveCount(0);
    await expect(host.locator('#voice-mic')).toBeVisible(); await expect(host.locator('#voice-mic')).toBeEnabled();
    const gate = new Promise(resolve => { releaseMedia = resolve; });
    await guest.route('**/*.m4s', async route => { await gate; await route.continue().catch(() => {}); });
    await guest.locator('#join-form input').fill('cine-soir'); await guest.locator('#join-form button').click();
    await expect(guest.locator('#name-dialog')).toBeVisible(); await guest.locator('#room-name').fill('민지'); await guest.locator('#name-dialog button').click();
    await expect(guest.locator('#movie-title')).toHaveText('fixture', { timeout: 15_000 }); await expect(guest.locator('#choose-film')).toBeHidden();
    // La capacité arrive dans l'état autoritatif et affiche le contrôle chez l'invité aussi.
    await expect.poll(() => latest.get(guest)?.voice).toMatchObject({ enabled: true, pair: ['fr', 'ko'] });
    expect(typeof latest.get(guest)?.voice?.available).toBe('boolean');
    await expect(guest.locator('#voice-mic')).toBeVisible();
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
    joined = true;
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
});

test('track and settings choices stay viewer-local while only the transport moves the room', async ({ browser }) => {
  test.skip(!joined, 'the séance setup pass did not complete');
  // Chromium alone pays the trusted-touch pass: this is the longest slice, and
  // it spends ~102 s on real playback waits (subtitle handoff, a seek, the
  // bandwidth badge). The budget is a ceiling for a hang, not a race mask, so
  // it keeps real headroom on a loaded runner instead of sitting at 85%.
  test.setTimeout(180_000);
  try {
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
    await expect(guest.locator('#player-settings select')).toHaveCount(3);
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
    await expect.poll(() => guest.locator('video').evaluate(video => Array.from(video.textTracks).some(track => Array.from(track.activeCues ?? []).some(cue => cue.text === 'Un sous-titre lisible.' && cue.line === 84 && !cue.snapToLines))), { timeout: 15_000 }).toBe(true);
    await expect(guest.locator('.color-captions')).toHaveText('Un sous-titre lisible.');
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    await expect(guest.locator('#buffering-overlay')).toBeHidden();
    // The fixture ends at 50 s: rewind so the overlay checks and the sections
    // after them still have room to play.
    await showControls(host);
    await host.evaluate(() => window.player.command('seek', 5));
    await host.locator('#screen').focus();
    await expect.poll(() => guest.locator('video').evaluate(video => video.currentTime)).toBeLessThan(15);
    // Clicking the picture only swaps the controls and cursor, never playback:
    // a playing room keeps playing through the toggle.
    await showControls(host);
    await host.locator('.plyr__video-wrapper').dispatchEvent('click');
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '0');
    await expect(host.locator('video')).toHaveCSS('cursor', 'none');
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // A click in place brings them back; the room is still untouched. The bar a
    // freeze pins open while the room buffers can sit between the two clicks, so
    // the direction is read from the state the click found instead of assuming the
    // hide above is still standing; the hidden -> visible direction is pinned in
    // the paused pass, where a pause holds the bar open and no freeze moves it.
    const wasHidden = await hiddenControls(host);
    await host.locator('.plyr__video-wrapper').dispatchEvent('click');
    await expect.poll(() => hiddenControls(host)).toBe(!wasHidden);
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', wasHidden ? '1' : '0');
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // Only Plyr's own transport moves the room: the bar's play button pauses.
    await clickControl(host, '.plyr__controls [data-plyr=play]', () => host.locator('video').evaluate(video => video.paused));
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    // Paused, the picture still only toggles: a click drops the pinned controls,
    // the next brings them back, and the room stays paused through both.
    await host.locator('.plyr__video-wrapper').dispatchEvent('click');
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    await expect(host.locator('.plyr__control--overlaid')).toBeHidden();
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    await host.locator('.plyr__video-wrapper').dispatchEvent('click');
    await expect(host.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(true);
    // The overlaid center button is the other transport and resumes the room.
    await host.locator('.plyr__control--overlaid').click();
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // A touch that dies before its click leaves a stale hidden snapshot: the
    // next real mouse click must drop it and still only flip the overlay.
    await showControls(host);
    await host.locator('.plyr__video-wrapper').dispatchEvent('click');
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    await host.locator('.plyr__video-wrapper').evaluate(el => el.dispatchEvent(new Event('touchstart')));
    await showControls(host);
    await host.locator('.plyr__video-wrapper').evaluate(el => el.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: 'mouse' })));
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    // A plain MouseEvent click has no pointerType: it must drop the stale
    // snapshot the same way and still only flip the overlay.
    await host.locator('.plyr__video-wrapper').evaluate(el => el.dispatchEvent(new Event('touchstart')));
    await showControls(host);
    await host.locator('.plyr__video-wrapper').evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // A mouse move over the video brings the controls and cursor back, and the
    // following click drops them again with playback untouched.
    await showControls(host);
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '1');
    await expect(host.locator('video')).not.toHaveCSS('cursor', 'none');
    await host.locator('.plyr__video-wrapper').click({ position: { x: 10, y: 10 } });
    await expect(host.locator('.plyr')).toHaveClass(/plyr--hide-controls/);
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // A real finger tap starts on the poster, the controls slide up under the
    // finger during the hold, and the click Chrome synthesizes at touchend is
    // hit-tested against the transport they carry: it must still only toggle
    // the overlay. Trusted touch input needs CDP, a Chromium-only pass.
    if (browser.browserType().name() === 'chromium') {
      await ensurePlaying();
      const touchContext = await browser.newContext({ hasTouch: true });
      const phone = await touchContext.newPage();
      phone.setDefaultTimeout(10_000); phone.setDefaultNavigationTimeout(30_000);
      phone.on('pageerror', error => errors.push(error.message));
      phone.on('websocket', ws => ws.on('framereceived', event => { const message = JSON.parse(event.payload); if (message.type === 'state') latest.set(phone, message); }));
      await goto(phone, '/');
      await phone.locator('#join-form input').fill('cine-soir'); await phone.locator('#join-form button').click();
      await expect(phone.locator('#name-dialog')).toBeVisible(); await phone.locator('#room-name').fill('Sam'); await phone.locator('#name-dialog button').click();
      await expect(phone.locator('#movie-title')).toHaveText('fixture');
      // The first play can still be gated: a tap on the prompt is the gesture.
      await expect.poll(() => phone.evaluate(() =>
        !document.querySelector('video')?.paused || document.querySelector('#allow-sound')?.checkVisibility() === true), { timeout: 15_000 }).toBe(true);
      if (await phone.locator('#allow-sound').isVisible()) await phone.locator('#allow-sound').tap();
      await expect.poll(() => latest.get(phone)?.state?.phase, { timeout: 15_000 }).toBe('playing');
      await expect.poll(() => phone.locator('video').evaluate(video => video.paused), { timeout: 10_000 }).toBe(false);
      await expect(phone.locator('#buffering-overlay')).toBeHidden();
      await controlsAutoHide(phone);
      const cdp = await touchContext.newCDPSession(phone);
      const tap = async (point, hold = 0) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        if (hold) await phone.waitForTimeout(hold);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      // offsetTop ignores the hide transform: this is where the play button
      // sits once the sheet is up, while the tap still starts on the poster.
      const spot = await phone.evaluate(() => {
        const controls = document.querySelector('.plyr__controls'), button = controls.querySelector('[data-plyr=play]');
        const box = controls.closest('.plyr').getBoundingClientRect();
        return { x: box.left + controls.offsetLeft + button.offsetLeft + button.offsetWidth / 2,
                 y: box.top + controls.offsetTop + button.offsetTop + button.offsetHeight / 2 };
      });
      await tap(spot, 550);
      await expect(phone.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/);
      // A wrongly delivered press pauses the room within a frame or two.
      await phone.waitForTimeout(500);
      // A resume only lands once the phone's own buffer passes the room gate:
      // the phase leaves 'buffering' when every member reports enough ahead.
      await expect.poll(() => latest.get(phone)?.state?.phase, { timeout: 15_000 }).toBe('playing');
      await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
      // A tap that starts on the shown transport is a real press and moves the room.
      // On a loaded box the 3 s touch hide can win before the press: the tap then
      // starts on the picture and its click is spent on the overlay like the wake
      // tap above. It leaves the sheet shown, so re-tapping lands the real press;
      // a room already paused skips the tap instead of toggling back.
      await expect(async () => {
        if (await guest.locator('video').evaluate(video => video.paused)) return;
        await tap(spot);
        await expect.poll(() => guest.locator('video').evaluate(video => video.paused), { timeout: 2000 }).toBe(true);
      }).toPass({ timeout: 15_000 });
      await tap(spot);
      await expect.poll(() => latest.get(phone)?.state?.phase, { timeout: 15_000 }).toBe('playing');
      await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
      await touchContext.close();
      // A member leaving pauses the room: wait for it, then resume.
      await expect.poll(() => latest.get(host)?.state?.phase).toBe('paused');
      await host.evaluate(() => window.player.command('play'));
      await expect.poll(() => latest.get(host)?.state?.phase).toBe('playing');
    }
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
});

test('the picture layout holds across viewports and fullscreen', async () => {
  test.skip(!joined, 'the séance setup pass did not complete');
  test.setTimeout(90_000);
  try {
    // The toggles above never pause the room now, so it kept burning the
    // fixture: rewind again for the viewport pass and the sections after it.
    await showControls(host);
    await host.evaluate(() => window.player.command('seek', 5));
    await expect.poll(() => guest.locator('video').evaluate(video => video.currentTime)).toBeLessThan(15);
    for (const [width, height, name] of [[390,844,'mobile'],[820,1180,'tablet'],[1440,1000,'desktop']]) {
      await guest.setViewportSize({ width, height });
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await showControls(guest);
      await expectSubtitleSize(guest);
      await expect(guest.locator('#voice-mic')).toBeInViewport();
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
    // Controls auto-hide while playing; hover until they are shown before
    // clicking fullscreen. Every step waits on its own observable state, so a
    // mid-pass stall is absorbed by controlsAutoHide rather than restarting
    // the whole block.
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
    // Entering fullscreen resets Plyr's hover flag and re-arms its hide
    // timer at once: the mic follows the chrome, so wake the bar before
    // asserting its visibility rather than racing the countdown.
    await showControls(host);
    await expect(host.locator('#voice-mic')).toBeVisible();
    await host.mouse.move(0, 0);
    // The helper only returns once the chrome reads hidden — hide class,
    // settled opacity, none cursor — while the picture verifiably flows.
    await controlsAutoHide(host);
    await ensurePlaying();
    await showControls(host);
    await expect(host.locator('.plyr__controls')).toHaveCSS('opacity', '1');
    await expect(host.locator('video')).not.toHaveCSS('cursor', 'none');
    await host.screenshot({ path: 'test-results/watch-fullscreen.png' }); await host.evaluate(() => document.exitFullscreen());
    await expectSubtitleSize(host);
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
});

test('the voice mic follows the player chrome across hover and focus', async () => {
  test.skip(!joined, 'the séance setup pass did not complete');
  test.setTimeout(120_000);
  try {
    // Le micro suit la visibilité des contrôles Plyr hors enregistrement (#47) :
    // overlay caché, micro caché. L'overlay revient, le micro revient.
    await ensurePlaying();
    await host.mouse.move(0, 0);
    await controlsAutoHide(host);
    await expect(host.locator('#voice-mic')).toBeHidden();
    await showControls(host);
    await expect(host.locator('#voice-mic')).toBeVisible();
    // Survol du micro : la barre reste levée tant que le pointeur y stationne,
    // comme sur les contrôles. La fenêtre de masquage de Plyr (2 s) est
    // dépassée en se synchronisant sur l'horloge de la page, jamais sur un
    // délai arbitraire ; le départ du pointeur rend l'auto-masquage.
    const micPoint = await host.locator('#voice-mic').boundingBox()
      .then(box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));
    await host.mouse.move(micPoint.x, micPoint.y, { steps: 4 });
    const hoveredAt = await host.evaluate(() => performance.now());
    await host.waitForFunction(at => performance.now() - at > 2600, hoveredAt);
    await expect(host.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/);
    await expect(host.locator('#watch')).toHaveAttribute('data-chrome', 'true');
    // Le saut direct de la barre vers le micro tient en une seule étape de
    // hit-test : Chromium livre l'entrée du micro avant le leave de la barre,
    // et sans le relais le verrou est effacé après avoir été posé. C'est le
    // cas réel des écrans bas où le micro touche le haut des contrôles ; une
    // traversée en plusieurs étapes passe par la vidéo et ne le voit jamais.
    // Une chute même transitoire du chrome compte : une fois le micro caché,
    // le pointeur retombe sur la vidéo et l'auto-masquage reprend.
    await host.evaluate(() => {
      const plyr = document.querySelector('.plyr');
      window.chromeDrops = 0;
      new MutationObserver(() => { if (plyr.matches('.plyr--hide-controls')) window.chromeDrops++; })
        .observe(plyr, { attributes: true, attributeFilter: ['class'] });
    });
    const barPoint = await host.locator('.plyr__controls').boundingBox()
      .then(box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));
    await host.mouse.move(barPoint.x, barPoint.y);
    await host.mouse.move(micPoint.x, micPoint.y);
    // Le verrou survit à la traversée : Plyr ne l'a pas effacé après l'entrée.
    await expect.poll(() => host.locator('.plyr__controls').evaluate(el => el.hover)).toBe(true);
    const crossedAt = await host.evaluate(() => performance.now());
    await host.waitForFunction(at => performance.now() - at > 2600, crossedAt);
    await expect(host.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/);
    await expect(host.locator('#voice-mic')).toBeVisible();
    expect(await host.evaluate(() => window.chromeDrops)).toBe(0);
    // Le départ du micro sans focus rend l'auto-masquage immédiat.
    await host.mouse.move(0, 0);
    await controlsAutoHide(host);
    await expect(host.locator('#voice-mic')).toBeHidden();
    await showControls(host);
    await expect(host.locator('#voice-mic')).toBeVisible();
    // Le focus clavier retient la barre de la même façon (:focus-visible) :
    // une entrée clavier réelle donne la modalité, le pointeur part, le focus
    // seul maintient, et le blur rend l'auto-masquage.
    await host.keyboard.press('Tab');
    await host.locator('#voice-mic').focus();
    await host.mouse.move(0, 0);
    const focusedAt = await host.evaluate(() => performance.now());
    await host.waitForFunction(at => performance.now() - at > 2600, focusedAt);
    await expect(host.locator('.plyr')).not.toHaveClass(/plyr--hide-controls/);
    await host.evaluate(() => document.querySelector('#voice-mic').blur());
    await ensurePlaying();
    await controlsAutoHide(host);
    await expect(host.locator('#watch')).toHaveAttribute('data-chrome', 'false');
    await showControls(host);
    await expect(host.locator('#voice-mic')).toBeVisible();
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
});

test('a voice prise is exclusive to one speaker and orphan permissions stay mute', async () => {
  test.skip(!joined, 'the séance setup pass did not complete');
  test.setTimeout(120_000);
  try {
    // Traduction vocale : la permission micro n'est demandée qu'au premier
    // appui, une seule prise est acceptée, le texte compris reste local et le
    // surtitre traduit est partagé. La lecture ne bouge pas (#40, #48).
    await ensurePlaying();
    const micCalls = page => page.evaluate(() => window.voiceTest.micCalls);
    expect(await micCalls(host)).toBe(0); expect(await micCalls(guest)).toBe(0);
    await showControls(host);
    await expect(host.locator('#voice-mic')).toBeVisible();
    await host.locator('#voice-mic').click();
    expect(await micCalls(host)).toBe(1);
    await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening');
    // Surtitre incrémental : la traduction seule s'affiche chez tous pendant
    // la prise, avant même l'arrêt. Le nom de l'orateur n'y figure plus.
    await Promise.all([
      expect(host.locator('#voice-result')).toContainText('엔딩'),
      expect(guest.locator('#voice-result')).toContainText('엔딩'),
      expect(host.locator('#voice-result')).not.toContainText('Alex'),
      expect(guest.locator('#voice-result')).not.toContainText('Alex'),
    ]);
    await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening');
    // Pendant l'enregistrement le micro reste visible et rouge même quand
    // l'overlay se cache.
    await host.mouse.move(0, 0);
    await controlsAutoHide(host);
    await Promise.all([
      expect(host.locator('#voice-mic')).toBeVisible(),
      expect(host.locator('#voice-mic')).toHaveCSS('color', 'rgb(229, 72, 77)'),
      expect(host.locator('#voice-mic .voice-icon')).toBeHidden(),
      expect(host.locator('#voice-mic .voice-spectrogram')).toBeVisible(),
    ]);
    await expect.poll(() => host.locator('#voice-mic .voice-bar')
      .evaluateAll(els => {
        const heights = els.map(el => parseFloat(el.style.height) || 0);
        return heights.filter(h => h > 6).length >= 3 && heights[2] > 6;
      })).toBe(true);
    // Pendant la prise de l'hôte, l'invité est refusé localement, en coréen,
    // et aucun état intermédiaire ne fuite vers l'hôte. Sa demande de
    // permission reste suspendue : c'est elle qui deviendra orpheline pendant
    // la prise suivante, sans rien ajouter à la fenêtre d'écoute courante.
    await guest.evaluate(() => { window.voiceTest.hold = true; });
    // L'appui est synthétique : la permission retenue et le refus occupé sont
    // ce qui compte, pas le hit-test. La prise de l'hôte est plafonnée à 20 s
    // et réveiller la barre de l'invité peut en brûler la moitié.
    await guest.locator('#voice-mic').evaluate(el => el.click());
    await expect(guest.locator('#voice-local')).toContainText('다른 참가자가 말하고 있습니다');
    await expect(guest.locator('#voice-mic')).toHaveAttribute('data-state', 'error');
    expect(await micCalls(guest)).toBe(1);
    // La carte de l'hôte peut déjà porter sa transcription incrémentale :
    // l'invariant est que le refus de l'invité n'y apparaît jamais.
    await expect(host.locator('#voice-local')).not.toContainText('다른 참가자가 말하고 있습니다');
    // Second appui : la prise passe en traitement puis produit le résultat. Le
    // passage par 'processing' est bref : on l'enregistre au lieu de le sonder.
    // L'écoute est plafonnée à 20 s côté produit : le second appui doit tomber
    // pendant 'listening', jamais sur une prise que le plafond a déjà refermée.
    await host.evaluate(() => {
      window.voiceTest.states = [];
      new MutationObserver(mutations => {
        for (const mutation of mutations) window.voiceTest.states.push(mutation.target.dataset.state);
      }).observe(document.querySelector('#voice-mic'), { attributes: true, attributeFilter: ['data-state'] });
    });
    await expect(async () => {
      // Un appui ne clôt qu'une prise 'listening' (public/voice.js) : l'état est
      // lu avant l'appui, et une prise que le plafond de 20 s a refermée pendant
      // le refus de l'invité est rouverte d'abord — appui synthétique, son
      // hit-test n'est pas l'objet de ce passage — pour que l'appui réel qui
      // suit la clôt vraiment au lieu d'en démarrer une autre.
      const state = await host.locator('#voice-mic').evaluate(el => el.dataset.state);
      if (state !== 'listening' && state !== 'starting') await host.locator('#voice-mic').evaluate(el => el.click());
      await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening', { timeout: 6_000 });
      await host.locator('#voice-mic').click({ timeout: 5_000 });
      await expect(host.locator('#voice-mic')).not.toHaveAttribute('data-state', 'listening', { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    // À l'arrêt chaque barre relâche sa hauteur inline : aucune traînée de
    // pixels ne survit au-dessus ou en dessous du spectrogramme replié.
    await expect.poll(() => host.locator('#voice-mic .voice-bar')
      .evaluateAll(els => els.every(el => !el.style.height))).toBe(true);
    // Texte compris local : italique, sans préfixe « Compris : » (#47).
    await expect(host.locator('#voice-local')).toBeVisible();
    await expect(host.locator('#voice-local')).toHaveText('On se retrouve au générique.');
    await expect(host.locator('#voice-local')).toHaveCSS('font-style', 'italic');
    // Carte et surtitre s'effacent après RESULT_MS (8 s) : chaque boîte est
    // prise dès que son texte est là, un runner lent brûle le reste du délai.
    const cardBox = await host.locator('#voice-local').boundingBox();
    expect(await host.evaluate(() => window.voiceTest.states)).toContain('processing');
    // Hors écoute le rond rouge rend l'icône micro : traitement en orange
    // puis blanc une fois le résultat affiché.
    await expect(host.locator('#voice-mic .voice-icon')).toBeVisible();
    await expect(host.locator('#voice-mic .voice-spectrogram')).toBeHidden();
    await expect(host.locator('#voice-result')).toBeVisible();
    await expect(host.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
    const resultBox = await host.locator('#voice-result').boundingBox();
    await expect(guest.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
    // Le surtitre reprend la typographie des sous-titres (.color-captions,
    // video::cue) sans plaque sombre ni préfixe : seul le cyan le distingue.
    const supertitleStyle = await host.locator('#voice-result').evaluate(el => {
      const style = getComputedStyle(el), captions = document.querySelector('.color-captions');
      const reference = captions && getComputedStyle(captions);
      return { background: style.backgroundColor, color: style.color,
        typography: !!reference && ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textShadow']
          .every(key => style[key] === reference[key]) };
    });
    expect(supertitleStyle.typography).toBe(true);
    expect(supertitleStyle.background).toBe('rgba(0, 0, 0, 0)');
    expect(supertitleStyle.color).toBe('rgb(79, 215, 232)');
    // Placement variante B : micro sur le bord droit, carte locale en bas à
    // gauche, surtitre centré en haut de l'image.
    const stage = await host.locator('.video-stage').boundingBox();
    await showControls(host);
    const micBox = await host.locator('#voice-mic').boundingBox();
    expect(micBox.x + micBox.width / 2).toBeGreaterThan(stage.x + stage.width * .7);
    expect(cardBox.x - stage.x).toBeLessThan(stage.width * .2);
    expect(cardBox.y - stage.y).toBeGreaterThan(stage.height * .6);
    expect(Math.abs(resultBox.x + resultBox.width / 2 - stage.x - stage.width / 2)).toBeLessThan(stage.width * .15);
    expect(resultBox.y - stage.y).toBeLessThan(stage.height * .3);
    // La carte de refus de l'invité s'est effacée seule (RESULT_MS), sans
    // action ni nouveau message.
    await expect(guest.locator('#voice-local')).toBeHidden({ timeout: 12_000 });
    // Le fixture de 50 s peut finir pendant la prise : position fraîche avant
    // la suite, comme en tête de passe.
    await ensurePlaying();
    // Hors écoute, la piste est muette : pas de micro actif au repos.
    await expect.poll(() => host.evaluate(() =>
      window.voiceTest.stream?.getAudioTracks().every(track => !track.enabled) ?? false)).toBe(true);
    // Le texte compris n'atteint jamais l'invité et le film continue.
    await expect(guest.locator('#voice-local')).not.toContainText('On se retrouve');
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused)).toBe(false);
    // Un événement périmé ne remplace pas un surtitre plus récent.
    await guest.evaluate(() => window.player.onVoice({ type: 'voice', state: 'result', utterance: 'stale', seq: 0, speaker: 'Ghost', text: 'STALE' }));
    await expect(guest.locator('#voice-result')).toContainText('엔딩 크레딧');
    await expect(guest.locator('#voice-result')).not.toContainText('Ghost');
    // Les permissions en vol ont leur fenêtre d'écoute dédiée, ouverte par une
    // seconde prise de l'hôte. Le délai de reprise peut encore courir : l'appui
    // n'est tenté que hors prise en cours, et un refus en 'cooldown' retente
    // jusqu'à l'accord, jamais pendant 'listening' où un clic terminerait.
    await expect(async () => {
      const state = await host.locator('#voice-mic').evaluate(el => el.dataset.state);
      if (state !== 'listening' && state !== 'starting') {
        await showControls(host);
        await host.locator('#voice-mic').click({ timeout: 5_000 });
      }
      await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening', { timeout: 3000 });
    }).toPass({ timeout: 15_000 });
    // La nouvelle demande de l'invité se superpose à celle restée suspendue :
    // deux demandes qui se chevauchent produisent un flux orphelin. L'appui
    // est synthétique : le micro du refusé peut être sous des contrôles cachés,
    // c'est la permission en vol qui compte, pas le hit-test.
    await guest.locator('#voice-mic').evaluate(el => el.click());
    await expect.poll(() => guest.evaluate(() => window.voiceTest.micCalls)).toBe(2);
    await expect(guest.locator('#voice-mic')).toHaveAttribute('data-state', 'error');
    await guest.evaluate(() => {
      window.voiceTest.hold = false;
      window.voiceTest.pending.splice(0).forEach(grant => grant());
    });
    // Le micro refusé n'est jamais devenu actif : le flux adopté reste muet et
    // le flux orphelin est arrêté.
    await expect.poll(() => guest.evaluate(() =>
      window.voiceTest.streams.length === 2 &&
      window.voiceTest.streams[0].getAudioTracks().every(track => track.readyState === 'ended') &&
      window.voiceTest.streams[1].getAudioTracks().every(track => !track.enabled))).toBe(true);
    // Une autorisation orpheline est refermée sans toucher l'état ni le micro
    // de l'orateur.
    await guest.evaluate(() => window.player.onVoice({ type: 'voice', state: 'started', utterance: 'ghost', seq: 99 }));
    await expect(guest.locator('#voice-mic')).toHaveAttribute('data-state', 'error');
    // Second appui, même garde : la fenêtre d'écoute est petite et bornée.
    await expect(async () => {
      const state = await host.locator('#voice-mic').evaluate(el => el.dataset.state);
      if (state !== 'listening' && state !== 'starting') await host.locator('#voice-mic').evaluate(el => el.click());
      await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening', { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
    await heardSpeech(host);
    await host.locator('#voice-mic').click();
    await expect(host.locator('#voice-local')).toHaveText('On se retrouve au générique.');
    await expect(host.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
    await expect(guest.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
  } catch (error) {
    await reportFailure(error);
    throw error;
  }
});

test('a voice prise survives member journeys and member failures pause the room', async ({ browser }) => {
  test.skip(!joined, 'the séance setup pass did not complete');
  // Chromium alone pays the trusted-touch pass on top of the prise journey.
  test.setTimeout(120_000);
  try {
    // Après l'erreur, l'invité reprend la parole : interface coréenne, sens
    // figé ko -> fr. Changer la langue du site pendant l'écoute n'y touche pas.
    await ensurePlaying();
    await showControls(guest);
    await guest.locator('#voice-mic').click();
    await expect(guest.locator('#voice-mic')).toHaveAttribute('data-state', 'listening');
    await guest.locator('#language').selectOption('fr');
    await expect(guest.locator('html')).toHaveAttribute('lang', 'fr');
    await heardSpeech(guest);
    await guest.locator('#voice-mic').click();
    await expect(guest.locator('#voice-local')).toHaveText('엔딩 크레딧에서 만나요.');
    await expect(guest.locator('#voice-local')).toHaveCSS('font-style', 'italic');
    await expect(guest.locator('#voice-result')).toHaveText('On se retrouve au générique.');
    await expect(host.locator('#voice-result')).toHaveText('On se retrouve au générique.');
    await expect(guest.locator('#voice-result')).not.toContainText('민지');
    await guest.locator('#language').selectOption('ko');
    await expect(guest.locator('html')).toHaveAttribute('lang', 'ko');
    // La reprise suit une panne de membre : elle n'est pas instantanee sous
    // charge, et le reste du fichier attend la meme chose avec ce budget.
    await expect.poll(() => guest.locator('video').evaluate(video => video.paused), { timeout: 15_000 }).toBe(false);
    // Clavier (#47) : le micro est un vrai bouton, Entrée tient lieu d'appui
    // pour démarrer comme pour clore. Le délai de reprise peut encore courir,
    // la pression est retentée tant que la prise n'est pas accordée.
    await expect(async () => {
      const state = await host.locator('#voice-mic').evaluate(el => el.dataset.state);
      if (state !== 'listening' && state !== 'starting') {
        await showControls(host);
        await host.locator('#voice-mic').focus();
        await host.keyboard.press('Enter');
      }
      await expect(host.locator('#voice-mic')).toHaveAttribute('data-state', 'listening', { timeout: 3000 });
    }).toPass({ timeout: 15_000 });
    await heardSpeech(host);
    await host.keyboard.press('Enter');
    await expect(host.locator('#voice-local')).toHaveText('On se retrouve au générique.');
    await expect(host.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
    await expect(guest.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
    // Tactile (#47) : un vrai tap sur le micro démarre puis clôt la prise.
    // Comme le tap CDP plus haut, l'entrée tactile de confiance est un
    // passage Chromium.
    if (browser.browserType().name() === 'chromium') {
      const touchContext = await browser.newContext({ hasTouch: true });
      const phone = await touchContext.newPage();
      phone.setDefaultTimeout(10_000); phone.setDefaultNavigationTimeout(30_000);
      phone.on('pageerror', error => errors.push(error.message));
      await phone.addInitScript(fakeMic);
      await goto(phone, '/');
      await phone.locator('#join-form input').fill('cine-soir'); await phone.locator('#join-form button').click();
      await expect(phone.locator('#name-dialog')).toBeVisible(); await phone.locator('#room-name').fill('Sam'); await phone.locator('#name-dialog button').click();
      await expect(phone.locator('#movie-title')).toHaveText('fixture');
      // La permission sonore peut encore bloquer la lecture. La prise n'en
      // dépend pas, seulement du micro visible.
      if (await phone.locator('#allow-sound').isVisible()) await phone.locator('#allow-sound').tap();
      await expect(async () => {
        if (await phone.locator('#voice-mic').isHidden()) await phone.locator('.plyr__video-wrapper').tap();
        await expect(phone.locator('#voice-mic')).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 10_000 });
      await phone.locator('#voice-mic').tap();
      await expect(phone.locator('#voice-mic')).toHaveAttribute('data-state', 'listening');
      await heardSpeech(phone);
      await phone.locator('#voice-mic').tap();
      await expect(phone.locator('#voice-local')).toHaveText('On se retrouve au générique.');
      await expect(phone.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
      await expect(host.locator('#voice-result')).toHaveText('엔딩 크레딧에서 만나요.');
      await expect(phone.locator('#voice-result')).not.toContainText('Sam');
      // Après les taps aucun :hover ne reste accroché au micro : la barre et
      // le micro repartent en auto-masquage tactile.
      await controlsAutoHide(phone);
      await expect(phone.locator('#voice-mic')).toBeHidden();
      await touchContext.close();
      // Le départ du membre fige la séance ou la laisse reprendre seule :
      // attendre la phase, jouer si nécessaire, jamais un délai.
      await ensurePlaying();
    } else {
      test.info().annotations.push({ type: 'skip', description: 'trusted-touch mic activation needs CDP-grade input, chromium-only pass' });
    }
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
    await reportFailure(error);
    throw error;
  }
});

test.afterAll(async () => {
  releaseMedia();
  // Cleanup must not replace the first assertion with a context-close error.
  await Promise.allSettled([guest?.unrouteAll({ behavior: 'ignoreErrors' }), a?.close(), b?.close()]);
});
