import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SyncPlayer } from '../public/sync-player.js';

// Le lecteur marque la scène quand le canvas WebGL du rendu couleur couvre la
// vidéo native : la feuille de style y masque l'overlay anti-MPO de Firefox.
const stage = () => {
  const attributes = new Map();
  return {
    attributes,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    hasAttribute: name => attributes.has(name),
  };
};

const player = (fields = {}) => {
  const scene = stage();
  const video = { closest: selector => selector === '.video-stage' ? scene : null };
  const failures = [];
  const instance = Object.assign(Object.create(SyncPlayer.prototype), {
    video, rendition: { color: { transfer: 'smpte2084' } }, colorRenderer: null,
    failPlayback: message => failures.push(message), emit() { }, ...fields,
  });
  return { instance, scene, failures };
};

test('setShader pose data-shader tant que le rendu couleur est monté', () => {
  let disposed = 0;
  const renderer = { dispose: () => { disposed++; } };
  const { instance, scene } = player({ colorRenderer: renderer });
  instance.setShader(true);
  assert.equal(scene.hasAttribute('data-shader'), true, 'shader monté : overlay masqué');
  assert.equal(instance.colorRenderer, renderer, 'aucun remontage du rendu déjà actif');
  instance.setShader(false);
  assert.equal(disposed, 1);
  assert.equal(instance.colorRenderer, null);
  assert.equal(scene.hasAttribute('data-shader'), false, 'SDR natif : overlay rendu à Firefox');
});

test('un rendu couleur qui échoue à monter ne masque pas l’overlay', () => {
  // Sous Node, ColorRenderer n'a ni document ni WebGL : la construction jette.
  const { instance, scene, failures } = player();
  instance.setShader(true);
  assert.equal(instance.colorRenderer, null);
  assert.equal(failures.length, 1);
  assert.equal(scene.hasAttribute('data-shader'), false);
});

test('un changement de film ou un démontage retire la marque', () => {
  const { instance, scene } = player({ colorRenderer: { dispose() { } } });
  instance.markShader();
  assert.equal(scene.hasAttribute('data-shader'), true);
  instance.colorRenderer.dispose(); instance.colorRenderer = null;
  // load() part sur un état sans rendu : setShader(false) n'a rien à démonter
  // mais doit tout de même effacer une marque laissée par le film précédent.
  instance.setShader(false);
  assert.equal(scene.hasAttribute('data-shader'), false);
});

test('la feuille de style masque l’overlay sous le shader, dans la scène seulement', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(css, /\.video-stage\[data-shader\] #gecko-overlay-fix\{display:none\}/);
  // L'overlay doit être un descendant de .video-stage pour que la règle porte.
  const stageAt = html.indexOf('class="video-stage"'), overlayAt = html.indexOf('id="gecko-overlay-fix"');
  assert.ok(stageAt > 0 && overlayAt > stageAt);
  assert.ok(!html.slice(stageAt, overlayAt).includes('</div>'), 'overlay dans .video-stage');
});
