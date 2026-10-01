import test from 'node:test';
import assert from 'node:assert/strict';
import { getUserMedia } from '../public/media-permission.js';

const named = name => Object.assign(new Error(name), { name });

// Une invite de permission ne doit jamais s'ouvrir pendant que la page est en
// plein écran : l'axe de ces tests est l'ordre des appels — la sortie avant la
// demande, la rentrée après — et le fait que rien n'attende sans borne.
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const rig = (t, { fullscreen = true, permission = 'prompt', userAgent = ANDROID, getUserMedia, requestFullscreen } = {}) => {
  const saved = ['document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const calls = [], events = [], listeners = {};
  const element = { id: 'screen', isConnected: true,
    requestFullscreen: requestFullscreen ?? (() => { calls.push('request'); return Promise.resolve(); }) };
  const doc = {
    fullscreenElement: fullscreen ? element : null,
    exitFullscreen: () => {
      calls.push('exit');
      doc.fullscreenElement = null;
      for (const fn of listeners.fullscreenchange ?? []) fn();
      return Promise.resolve();
    },
    addEventListener: (name, fn) => (listeners[name] ??= []).push(fn),
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] ?? []).filter(other => other !== fn); },
  };
  const nav = {
    userAgent,
    mediaDevices: { getUserMedia: constraints => { calls.push('gum'); return (getUserMedia ?? (() => Promise.resolve({ constraints })))(constraints); } },
    permissions: { query: () => Promise.resolve({ state: permission }) },
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define('document', doc); define('navigator', nav);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const journal = (reason, detail) => events.push([reason, detail]);
  const settled = () => new Promise(resolve => setTimeout(resolve, 5));
  return { calls, events, doc, element, journal, settled, getUserMedia: () => getUserMedia, nav };
};

test('hors plein écran, la demande passe telle quelle', async t => {
  const { calls, journal } = rig(t, { fullscreen: false });
  assert.deepEqual((await getUserMedia('camera', { video: true }, journal)).constraints, { video: true });
  assert.deepEqual(calls, ['gum']);
});

test('permission déjà accordée : aucune invite ne s\'ouvre, donc aucune sortie', async t => {
  const { calls, events } = rig(t, { permission: 'granted' });
  await getUserMedia('camera', { video: true }, (reason, detail) => events.push([reason, detail]));
  assert.deepEqual(calls, ['gum']);
  assert.deepEqual(events, []);
});

test('hors Android, une invite en plein écran ne coûte rien : rien n\'est soldé', async t => {
  const { calls, events } = rig(t, { userAgent: DESKTOP });
  await getUserMedia('camera', { video: true }, (reason, detail) => events.push([reason, detail]));
  assert.deepEqual(calls, ['gum']);
  assert.deepEqual(events, []);
});

test('permission sans état connu (API absente) : rien n\'est soldé', async t => {
  const rigged = rig(t, {});
  rigged.nav.permissions = undefined;
  await getUserMedia('camera', { video: true }, rigged.journal);
  assert.deepEqual(rigged.calls, ['gum']);
});

test('invite à venir : la sortie précède la demande, la rentrée suit', async t => {
  const { calls, events, settled } = rig(t, {});
  await getUserMedia('camera', { video: true }, (reason, detail) => events.push([reason, detail]));
  assert.deepEqual(calls, ['exit', 'gum', 'request']);
  await settled();
  assert.deepEqual(events, [['permission-exit', 'camera'], ['permission-return', 'camera']]);
});

test('rentrée refusée : le refus est journalisé, la demande a bien eu lieu', async t => {
  const { calls, events, settled } = rig(t, { requestFullscreen: () => { calls.push('request'); return Promise.reject(named('NotAllowedError')); } });
  await getUserMedia('microphone', { audio: true }, (reason, detail) => events.push([reason, detail]));
  await settled();
  assert.deepEqual(calls, ['exit', 'gum', 'request']);
  assert.deepEqual(events, [['permission-exit', 'microphone'], ['permission-return-denied', 'NotAllowedError']]);
});

test('une demande qui ne se résout pas ne retient pas la promesse rendue', async t => {
  const { calls, events } = rig(t, { getUserMedia: () => new Promise(() => {}) });
  const pending = getUserMedia('camera', { video: true }, (reason, detail) => events.push([reason, detail]));
  // La sortie a eu lieu et la demande est partie : la promesse peut rester en
  // attente, elle n'est pas la nôtre — c'est celle du navigateur.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['exit', 'gum']);
  const outcome = await Promise.race([pending.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('pending'), 20))]);
  assert.equal(outcome, 'pending');
  assert.deepEqual(events, [['permission-exit', 'camera']]);
});

test('un refus de la demande remonte à l\'appelant, la rentrée reste tentée', async t => {
  const { calls, events, settled } = rig(t, { getUserMedia: () => Promise.reject(named('NotAllowedError')) });
  await assert.rejects(() => getUserMedia('camera', { video: true }, (reason, detail) => events.push([reason, detail])), { name: 'NotAllowedError' });
  await settled();
  assert.deepEqual(calls, ['exit', 'gum', 'request']);
  assert.deepEqual(events, [['permission-exit', 'camera'], ['permission-return', 'camera']]);
});
