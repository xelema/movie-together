import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

// La bande son d'un film est déjà normalisée : son gain de 1,5× se juge sur une
// crête pleine échelle, là où l'écrêtage montrerait sa tête. Le fixture des
// autres specs est à -21 dBFS et n'exercerait que le gain, jamais le limiteur.
const FIXTURE = 'data/e2e/audio-boost.mp4';
const loudFixture = async () => {
  if (await stat(FIXTURE).then(file => file.size > 0, () => false)) return FIXTURE;
  await new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=10',
    '-f', 'lavfi', '-i', 'aevalsrc=0.98*sin(2*PI*440*t)|0.98*sin(2*PI*440*t):s=48000',
    '-f', 'lavfi', '-i', 'aevalsrc=0.98*sin(2*PI*880*t)|0.98*sin(2*PI*880*t):s=48000',
    '-t', '40', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-g', '40',
    '-c:a', 'aac', '-ac', '2', '-b:a', '256k',
    '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng', FIXTURE],
    (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve()));
  return FIXTURE;
};

// Le moteur routé qui confisque le volume de l'élément est indétectable depuis
// le film lui-même : une fois la source média créée, il n'y a plus de retour en
// arrière, et un moteur qui ignore le curseur ne le dit qu'en jouant. Cette sonde
// tient donc la mesure qui justifie le refus du gain par audio-boost.js.
const toneProbe = () => {
  const tone = (seconds, frequency, amplitude) => {
    const rate = 48_000, count = rate * seconds, buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
    const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, count * 2, true);
    for (let index = 0; index < count; index++) view.setInt16(44 + index * 2, Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * amplitude * 32767), true);
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return `data:audio/wav;base64,${btoa(binary)}`;
  };
  const media = document.getElementById('tone'), context = new AudioContext(), analyser = context.createAnalyser();
  analyser.fftSize = 4096;
  const source = context.createMediaElementSource(media);
  source.connect(analyser); analyser.connect(context.destination);
  window.readTone = () => {
    const buffer = new Float32Array(4096);
    analyser.getFloatTimeDomainData(buffer);
    let squares = 0;
    for (const value of buffer) squares += value * value;
    return Math.sqrt(squares / buffer.length);
  };
  document.getElementById('start').addEventListener('click', async () => {
    media.src = tone(2, 440, 0.9); media.loop = true;
    await media.play();
  });
};

// Ce que le graphe porte réellement, mesuré sur la sortie de chaque étage : le
// gain avant/après (exact, l'étage est sans mémoire), le niveau et la crête qui
// entrent, ceux qui sortent. Le navigateur ne rend pas ces valeurs observables
// autrement, et le volume de l'élément s'applique en amont de la source : le
// baisser mesure le régime ordinaire, loin du plafond.
const sampleGraph = () => new Promise(resolve => {
  const { context, source, stage, limiter } = window.audioBoost.graph;
  const node = target => { const analyser = context.createAnalyser(); analyser.fftSize = 4096; target.connect(analyser); return analyser; };
  const taps = { source: node(source), stage: node(stage), limiter: node(limiter) };
  const buffer = new Float32Array(4096);
  const read = analyser => {
    analyser.getFloatTimeDomainData(buffer);
    let squares = 0, peak = 0;
    for (const value of buffer) { squares += value * value; peak = Math.max(peak, Math.abs(value)); }
    return { rms: Math.sqrt(squares / buffer.length), peak };
  };
  const best = Object.fromEntries(Object.keys(taps).map(key => [key, { rms: 0, peak: 0 }]));
  const video = document.querySelector('#video');
  const deadline = performance.now() + 6000;
  const tick = () => {
    if (performance.now() >= deadline) return resolve({ state: context.state, played: !video.paused, taps: best });
    if (!video.paused && video.readyState >= 2) for (const [key, analyser] of Object.entries(taps)) {
      const sample = read(analyser);
      best[key].rms = Math.max(best[key].rms, sample.rms);
      best[key].peak = Math.max(best[key].peak, sample.peak);
    }
    setTimeout(tick, 60);
  };
  tick();
});

test('le volume de l\'élément atteint le graphe, sauf là où le gain est refusé', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext(), page = await context.newPage();
  const apple = browser.browserType().name() === 'webkit';
  try {
    await page.setContent('<button id="start">start</button><audio id="tone"></audio>', { waitUntil: 'load' });
    await page.evaluate(toneProbe);
    // Le contexte et la lecture naissent du geste : c'est la condition réelle du
    // lecteur, et la politique d'autoplay la refuse autrement.
    await page.click('#start');
    await expect.poll(() => page.evaluate(() => window.readTone()), { timeout: 15_000 }).toBeGreaterThan(0.1);
    // La lecture démarre en fondu et la fenêtre d'analyse se remplit : la
    // référence se lit une fois le niveau posé, jamais sur la rampe.
    await expect.poll(() => page.evaluate(() => window.readTone()), { timeout: 15_000 }).toBeGreaterThan(0.6);
    const full = await page.evaluate(() => window.readTone());
    await page.evaluate(() => { document.getElementById('tone').volume = 0.5; });
    if (apple) {
      // WebKit : curseur et muet n'ont plus d'effet une fois l'élément routé, le
      // gain du lecteur y est donc refusé pour que le film reste baissable.
      await page.waitForTimeout(700);
      expect(await page.evaluate(() => window.readTone()) / full).toBeGreaterThan(0.9);
      await page.evaluate(() => { document.getElementById('tone').muted = true; });
      await page.waitForTimeout(700);
      expect(await page.evaluate(() => window.readTone()) / full).toBeGreaterThan(0.9);
    } else {
      // Un changement de volume se joue en fondu court : la mesure attend que le
      // rapport se soit posé plutôt que de lire une valeur de transition.
      await expect.poll(async () => (await page.evaluate(() => window.readTone())) / full,
        { timeout: 10_000 }).toBeCloseTo(0.5, 1);
      await page.evaluate(() => { document.getElementById('tone').muted = true; });
      await expect.poll(() => page.evaluate(() => window.readTone()), { timeout: 10_000 }).toBeLessThan(0.001);
    }
  } finally { await context.close(); }
});

// La bande son ne sort que d'ici : le graphe est branché sur l'élément pendant
// que le film joue. Deux régimes, deux mesures : une crête pleine échelle, où le
// gain doit se retenir sans écrêter, et le régime ordinaire d'un film, loin du
// plafond, où il passe exactement.
test('le film passe 1,5× dans le graphe, et le limiteur tient la crête', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
  // A first paint can starve past one navigation budget on a loaded box: retry
  // the navigation rather than stretch a single arbitrary timeout.
  const goto = url => expect(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
  try {
    const fixture = await loudFixture();
    await goto('/admin');
    // Le graphe naît d'un geste : aucune interaction, aucun AudioContext.
    expect(await page.evaluate(() => window.audioBoost.armed)).toBe(false);
    await page.locator('#login-form input').fill('browser-test-password');
    await page.locator('#login-form button').click();
    await expect(page.locator('#library')).toBeVisible();
    const headers = { Origin: 'http://localhost:3100' };
    for (const room of await (await page.request.get('/api/rooms')).json()) await page.request.delete(`/api/rooms/${room.id}`, { headers });
    for (const movie of await (await page.request.get('/api/movies')).json()) await page.request.delete(`/api/movies/${movie.id}`, { headers });
    await page.locator('#refresh').click();
    await page.locator('#upload-file').setInputFiles({ name: 'audio-boost.mp4', mimeType: 'video/mp4', buffer: await readFile(fixture) });
    await page.getByRole('button', { name: 'Préparer le film' }).click();
    const wizard = page.locator('#prepare-dialog');
    await expect(wizard).toBeVisible();
    for (let step = 0; step < 3; step++) await wizard.getByRole('button', { name: 'Continuer' }).click();
    await wizard.getByRole('button', { name: 'Confirmer et préparer' }).click();
    const card = page.locator('#movies article.card').filter({ hasText: 'audio-boost' }).last();
    await expect(card.getByRole('button', { name: 'Créer une séance', exact: true })).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Créer une séance', exact: true }).click();
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(page.locator('#name-dialog')).toBeVisible();
    await page.locator('#room-name').fill('Boost'); await page.locator('#name-dialog button').click();
    await expect(page.locator('#movie-title')).toHaveText('audio-boost');
    // Le moteur qui confisque le volume de l'élément ne reçoit pas le gain : le
    // film y reste baissable, et rien ici ne peut plus être mesuré sans mentir.
    if (browser.browserType().name() === 'webkit') {
      expect(await page.evaluate(() => window.audioBoost.supported)).toBe(false);
      expect(await page.evaluate(() => window.audioBoost.armed)).toBe(false);
      test.skip(true, 'webkit: le gain y est refusé, le volume de l\'élément ne passe pas dans le graphe');
    }
    // Les clics de l'entrée ont armé le graphe : le film entier passe par lui.
    await expect.poll(() => page.evaluate(() => window.audioBoost.armed)).toBe(true);
    // Le bouton de lecture porte le geste qui autorise le son ; si la politique
    // d'autoplay l'a refusé, le bouton son le reprend dans le même geste.
    const startPlaying = () => expect(async () => {
      if (await page.locator('#allow-sound').isVisible().catch(() => false)) await page.locator('#allow-sound').click();
      if (!await page.locator('#video').evaluate(video => video.paused)) return;
      await page.locator('.plyr__controls [data-plyr=play]').click({ timeout: 3000 }).catch(() => {});
      await expect.poll(() => page.locator('#video').evaluate(video => !video.paused), { timeout: 5000 }).toBe(true);
    }).toPass({ timeout: 45_000 });
    await startPlaying();

    const loud = await page.evaluate(sampleGraph);
    const loudDetail = JSON.stringify(loud), { source, stage, limiter } = loud.taps;
    // Le film joue, le graphe le porte : sans signal ici, rien des mesures en
    // aval ne dit quelque chose d'un film audible.
    expect(limiter.rms, loudDetail).toBeGreaterThan(0.1);
    // L'étage porte le gain voulu (1,5×) diminué de ce que le limiteur ajoute
    // sous son seuil (1,067×) : la mesure tient les deux facteurs ensemble.
    expect(stage.rms / source.rms, loudDetail).toBeCloseTo(1.4, 1);
    // La source est chaude : une piste à -21 dBFS laisserait le limiteur inerte
    // et le test passerait sans rien prouver du plafond.
    expect(source.peak, loudDetail).toBeGreaterThan(0.5);
    // Le gain pousse la crête au-delà de la pleine échelle — c'est l'objet de la
    // demande — et ce qui sort reste au plafond : sans limiteur, 1,48 en sortie.
    expect(stage.peak, loudDetail).toBeGreaterThan(1.05);
    expect(limiter.peak, loudDetail).toBeLessThan(1.01);

    // Régime ordinaire : un film s'écoute dix à vingt décibels sous sa crête, le
    // limiteur n'a rien à y limiter et le gain y passe tel quel — c'est là que se
    // mesure la demande, 1,5× à l'oreille.
    await page.locator('#video').evaluate(video => { video.volume = 0.4; });
    const quiet = await page.evaluate(sampleGraph);
    const quietDetail = JSON.stringify(quiet), { source: quietSource, stage: quietStage, limiter: quietLimiter } = quiet.taps;
    expect(quietSource.peak, quietDetail).toBeGreaterThan(0.1);
    expect(quietLimiter.rms / quietSource.rms, quietDetail).toBeCloseTo(1.5, 1);
    // Le limiteur n'est pas transparent sous son seuil : la courbe normalisée du
    // Web Audio ajoute 1,067×, que l'étage de gain compense. La mesure ici
    // verrouille ce facteur : s'il bougeait, le gain net suivrait.
    expect(quietLimiter.rms / quietStage.rms, quietDetail).toBeCloseTo(1.067, 1);
  } finally { await context.close(); }
});
