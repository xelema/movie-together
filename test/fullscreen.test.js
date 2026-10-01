import test from 'node:test';
import assert from 'node:assert/strict';
import { attachFullscreen } from '../public/fullscreen.js';

// Les globaux navigateurs que lit fullscreen.js sont posés puis restitués :
// document (fullscreenElement, exitFullscreen, écouteurs), window, les
// dimensions de la fenêtre. Les éléments sont de simples boîtes factices.
const rig = (t, { paintedRect, fullscreenElement = null, exitFullscreen, requestFullscreen } = {}) => {
  const names = ['document', 'window', 'innerWidth', 'innerHeight'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const calls = [], events = [], listeners = {};
  const classes = new Set();
  const screenEl = {
    getBoundingClientRect: () => paintedRect ?? { left: 0, top: 0, width: 900, height: 620 },
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
  const controls = {
    listeners: {},
    addEventListener: (name, fn) => (controls.listeners[name] ??= []).push(fn),
    removeEventListener: (name, fn) => { controls.listeners[name] = (controls.listeners[name] ?? []).filter(other => other !== fn); },
  };
  const player = {
    config: { classNames: { fullscreen: { fallback: 'plyr--fullscreen-fallback' } } },
    elements: { container: { classList: { contains: name => classes.has(name) } }, controls },
    fullscreen: { toggleFallback: value => {
      calls.push(`fallback:${value}`);
      classes[value ? 'add' : 'delete']('plyr--fullscreen-fallback');
    } },
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define('document', doc); define('window', win); define('innerWidth', 900); define('innerHeight', 620);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const fullscreen = attachFullscreen({ screen: screenEl, player, onEvent: (reason, detail) => events.push([reason, detail]) });
  return { fullscreen, calls, events, listeners, classes, doc, screenEl, controls };
};

test('hors plein écran, l\'appui demande le plein écran sans jamais sortir', async t => {
  const { fullscreen, calls } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
  assert.equal(fullscreen.active(), false);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['request']);
});

test('en plein écran peint, l\'appui sort sans jamais redemander', async t => {
  const { fullscreen, calls, doc, screenEl } = rig(t, {});
  doc.fullscreenElement = screenEl;
  assert.equal(fullscreen.active(), true);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['exit']);
});

test('état menteur : la sortie est soldée puis la rentrée demandée, dans l\'ordre', async t => {
  const { fullscreen, calls, doc, screenEl } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
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
  const { fullscreen, calls, events, doc, screenEl } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
  doc.fullscreenElement = screenEl;
  doc.exitFullscreen = () => { calls.push('exit'); return Promise.reject(new TypeError('Document not active')); };
  await fullscreen.toggle();
  assert.deepEqual(calls, ['exit', 'request']);
  assert.deepEqual(events, [['stale', 'TypeError']]);
});

test('reconcile solde un état menteur et ne touche pas un état cohérent', async t => {
  const { fullscreen, calls, doc, screenEl } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
  doc.fullscreenElement = screenEl;
  fullscreen.reconcile();
  assert.deepEqual(calls, ['exit']);
  // Peint et nommé : rien à solder.
  doc.fullscreenElement = null;
  screenEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 620 });
  doc.fullscreenElement = screenEl;
  fullscreen.reconcile();
  assert.deepEqual(calls, ['exit']);
});

test('le clic n\'est avalé que sur le contrôle plein écran, depuis la barre', t => {
  const { fullscreen, calls, listeners, controls } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
  assert.equal(controls.listeners.click.length, 1);
  // Jamais sur document : l'appui que la scène dépense sur la surcouche
  // (commencé sur l'image) doit passer avant cette interception.
  assert.equal(listeners.click, undefined);
  const click = controls.listeners.click[0];
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
  fullscreen.dispose();
  assert.equal(controls.listeners.click.length, 0);
});

test('la surcouche CSS de Plyr sort et entre sans toucher l\'API', async t => {
  const { fullscreen, calls, classes, doc } = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 } });
  classes.add('plyr--fullscreen-fallback');
  assert.equal(fullscreen.active(), true);
  await fullscreen.toggle();
  assert.deepEqual(calls, ['fallback:false']);
  // Sans requestFullscreen, l'entrée prend la même surcouche.
  doc.fullscreenElement = null;
  const plain = rig(t, { paintedRect: { left: 8, top: 8, width: 884, height: 150 }, requestFullscreen: undefined });
  delete plain.screenEl.requestFullscreen;
  await plain.fullscreen.toggle();
  assert.deepEqual(plain.calls, ['fallback:true']);
});
