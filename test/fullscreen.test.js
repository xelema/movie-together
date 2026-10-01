import test from 'node:test';
import assert from 'node:assert/strict';
import { attachFullscreen } from '../public/fullscreen.js';

// Les globaux navigateurs que lit fullscreen.js sont posés puis restitués :
// document (fullscreenElement, exitFullscreen, écouteurs), window, l'écran
// physique, et les dimensions de la fenêtre. Les éléments sont des boîtes
// factices. `grantedAt` se pose par l'événement fullscreenchange, comme dans le
// navigateur : les cas de sortie subie se jouent donc en déplaçant la fenêtre
// après l'accord.
const FULL = { left: 0, top: 0, width: 900, height: 620 };
const WINDOWED = { left: 8, top: 8, width: 884, height: 150 };

const rig = (t, { paintedRect = WINDOWED, fullscreenElement = null, display = { width: 900, height: 620 },
  exitFullscreen, requestFullscreen } = {}) => {
  const names = ['document', 'window', 'screen', 'innerWidth', 'innerHeight'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const calls = [], events = [], listeners = {};
  const classes = new Set();
  const screenEl = {
    id: 'screen',
    // Un élément plein écran recouvre la fenêtre courante : la boîte suit donc
    // le viewport, d'où les mesures de sortie subie qui la lisent rétrécie.
    getBoundingClientRect: () => (paintedRect === FULL
      ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : paintedRect),
    requestFullscreen: requestFullscreen ?? (() => { calls.push('request'); return Promise.resolve(); }),
  };
  const doc = {
    fullscreenElement, hidden: false,
    exitFullscreen: exitFullscreen ?? (() => { calls.push('exit'); return Promise.resolve(); }),
    addEventListener: (name, fn) => (listeners[name] ??= []).push(fn),
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] ?? []).filter(other => other !== fn); },
  };
  const win = {
    addEventListener: (name, fn) => (listeners[`w:${name}`] ??= []).push(fn),
    removeEventListener: (name, fn) => { listeners[`w:${name}`] = (listeners[`w:${name}`] ?? []).filter(other => other !== fn); },
  };
  const container = {
    listeners: {},
    classList: { contains: name => classes.has(name) },
    addEventListener: (name, fn) => (container.listeners[name] ??= []).push(fn),
    removeEventListener: (name, fn) => { container.listeners[name] = (container.listeners[name] ?? []).filter(other => other !== fn); },
  };
  const player = {
    config: { classNames: { fullscreen: { fallback: 'plyr--fullscreen-fallback' } } },
    elements: { container },
    fullscreen: { toggleFallback: value => {
      calls.push(`fallback:${value}`);
      classes[value ? 'add' : 'delete']('plyr--fullscreen-fallback');
    } },
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define('document', doc); define('window', win); define('screen', display);
  define('innerWidth', 900); define('innerHeight', 620);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const fullscreen = attachFullscreen({ screen: screenEl, player, onEvent: (reason, detail) => events.push([reason, detail]) });
  // Entrer en plein écran comme le navigateur : l'API, l'événement, puis la
  // fenêtre accordée — c'est l'ordre dont dépend le repère du module.
  const grant = ({ w = 900, h = 620 } = {}) => {
    define('innerWidth', w); define('innerHeight', h);
    doc.fullscreenElement = screenEl;
    for (const fn of listeners.fullscreenchange ?? []) fn();
  };
  const move = (w, h) => { define('innerWidth', w); define('innerHeight', h); };
  return { fullscreen, calls, events, listeners, classes, doc, screenEl, container, grant, move, define };
};

test('hors plein écran, l\'appui demande le plein écran sans jamais sortir', async t => {
  const { fullscreen, calls } = rig(t);
  assert.equal(fullscreen.active(), false);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['request']);
});

test('en plein écran, l\'appui sort sans jamais redemander', async t => {
  const { fullscreen, calls, grant } = rig(t, { paintedRect: FULL });
  grant();
  assert.equal(fullscreen.active(), true);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['exit']);
});

test('état menteur : la sortie est soldée puis la rentrée demandée, dans l\'ordre', async t => {
  const { fullscreen, calls, doc, screenEl } = rig(t, { paintedRect: WINDOWED });
  doc.fullscreenElement = screenEl;
  let release;
  doc.exitFullscreen = () => { calls.push('exit'); return new Promise(resolve => { release = resolve; }); };
  assert.equal(fullscreen.active(), false);
  const pending = fullscreen.toggle();
  // Tant que la sortie n'est pas soldée, Blink ignorerait la demande.
  assert.deepEqual(calls, ['exit']);
  release();
  await pending;
  assert.deepEqual(calls, ['exit', 'request']);
});

test('état menteur : une sortie refusée n\'empêche pas la rentrée', async t => {
  const { fullscreen, calls, events, doc, screenEl } = rig(t, { paintedRect: WINDOWED });
  doc.fullscreenElement = screenEl;
  doc.exitFullscreen = () => { calls.push('exit'); return Promise.reject(new TypeError('Document not active')); };
  await fullscreen.toggle();
  assert.deepEqual(calls, ['exit', 'request']);
  assert.deepEqual(events, [['stale', 'TypeError']]);
});

test('sortie subie par le navigateur : la fenêtre rétrécie vaut sortie, l\'appui rentre', async t => {
  // Téléphone en paysage : accordé en 853x394, puis la barre du navigateur
  // revient et la fenêtre tombe à 291 — l'API nomme encore l'élément, le CSS
  // :fullscreen le colle à cette fenêtre rétrécie, seul le repère le dit.
  const { fullscreen, calls, doc, grant, move, define } = rig(t, { paintedRect: FULL, display: { width: 853, height: 394 } });
  define('innerWidth', 853); define('innerHeight', 394);
  doc.fullscreenElement = null;
  grant({ w: 853, h: 394 });
  assert.equal(fullscreen.active(), true);
  move(853, 291);
  assert.equal(fullscreen.active(), false);
  // La rentrée solde d'abord l'élément menteur, dans le même geste.
  doc.exitFullscreen = () => { calls.push('exit'); return Promise.reject(new TypeError('Document not active')); };
  await fullscreen.toggle();
  assert.deepEqual(calls, ['exit', 'request']);
});

test('la rotation en plein écran reste du plein écran', async t => {
  const { fullscreen, doc, grant, move, define } = rig(t, { paintedRect: FULL, display: { width: 853, height: 394 } });
  define('innerWidth', 853); define('innerHeight', 394);
  grant({ w: 853, h: 394 });
  move(394, 853);
  define('screen', { width: 394, height: 853 });
  assert.equal(fullscreen.active(), true);
});

test('une fenêtre figée plus petite que l\'écran ne vaut pas sortie (environnement sans gestionnaire de fenêtres)', async t => {
  // La CI lance le navigateur sous xvfb : le viewport n'a jamais la taille de
  // l'écran X. Aucun rétrécissement n'a lieu, le repère tient donc encore.
  const { fullscreen, doc, grant } = rig(t, { paintedRect: FULL, display: { width: 1280, height: 1024 } });
  grant({ w: 900, h: 620 });
  assert.equal(fullscreen.active(), true);
  assert.equal(doc.fullscreenElement.id, 'screen');
});

test('une demande qui ne se résout jamais ne retient pas le bouton', async t => {
  const { fullscreen, calls, events } = rig(t, { requestFullscreen: () => { calls.push('request'); return new Promise(() => {}); } });
  await fullscreen.toggle();
  assert.deepEqual(calls, ['request']);
  // L'appui a rendu la main : le journal dit pourquoi, et l'appui suivant retente.
  assert.deepEqual(events, [['enter-pending', '1500']]);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['request', 'request']);
});

test('reconcile journalise la sortie subie et se tait quand l\'état est cohérent', async t => {
  const { fullscreen, events, doc, grant, move, define, listeners } = rig(t, { paintedRect: FULL, display: { width: 853, height: 394 } });
  define('innerWidth', 853); define('innerHeight', 394);
  grant({ w: 853, h: 394 });
  fullscreen.reconcile();
  assert.deepEqual(events, []);
  move(853, 291);
  for (const fn of listeners['w:resize'] ?? []) fn();
  assert.deepEqual(events, [['dropped', '853x291']]);
  // Hors plein écran nommé, plus rien à signaler.
  doc.fullscreenElement = null;
  move(853, 394);
  fullscreen.reconcile();
  assert.equal(events.length, 1);
});

test('le clic est intercepté sur le conteneur, avant les écouteurs de la scène', t => {
  const { fullscreen, calls, listeners, container } = rig(t, { paintedRect: WINDOWED });
  assert.equal(container.listeners.click.length, 1);
  // Posé avant les écouteurs de la scène, sur le même nœud et en capture :
  // l'appui ne peut plus être avalé avant d'atteindre le contrôle.
  const order = [];
  container.addEventListener('click', () => order.push('scene'), true);
  const click = container.listeners.click[0];
  const foreign = { target: { closest: () => null }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  click(foreign);
  assert.equal(foreign.prevented, false);
  assert.equal(foreign.stopped, false);
  const button = {};
  const onButton = { target: { closest: selector => selector === '[data-plyr="fullscreen"]' ? button : null },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  click(onButton);
  assert.equal(onButton.prevented, true);
  assert.equal(onButton.stopped, true);
  assert.deepEqual(calls, ['request']);
  assert.equal(listeners.click, undefined);
  fullscreen.dispose();
  assert.equal(container.listeners.click.length, 1, 'seul l\'écouteur de scène reste');
});

test('la surcouche CSS de Plyr sort et entre sans toucher l\'API', async t => {
  const { fullscreen, calls, classes } = rig(t, { paintedRect: WINDOWED });
  classes.add('plyr--fullscreen-fallback');
  assert.equal(fullscreen.active(), true);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['fallback:false']);
  // Sans requestFullscreen, l'entrée prend la même surcouche.
  const plain = rig(t, { requestFullscreen: undefined });
  delete plain.screenEl.requestFullscreen;
  await plain.fullscreen.toggle();
  assert.deepEqual(plain.calls, ['fallback:true']);
});
