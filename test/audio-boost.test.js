import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAudioBoost, supportsAudioBoost, BOOST_GAIN, BOOST_MAKEUP, BOOST_CEILING_DB } from '../public/audio-boost.js';

// Le plafond du <video> est 0 dBFS : le gain vit dans un graphe Web Audio. Ces
// doublures ne mesurent rien, elles tiennent l'ordre des opérations et l'état
// exact des paramètres, que le navigateur ne peut pas rendre observable.
class FakeParam {
  constructor(value) { this.value = value; }
}
class FakeNode {
  constructor(kind) { this.kind = kind; this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
}
class FakeGain extends FakeNode {
  constructor() { super('gain'); this.gain = new FakeParam(1); }
}
class FakeLimiter extends FakeNode {
  constructor() { super('limiter'); this.threshold = new FakeParam(0); this.knee = new FakeParam(0);
    this.ratio = new FakeParam(1); this.attack = new FakeParam(0); this.release = new FakeParam(0); }
}
class FakeSource extends FakeNode {
  constructor(media) { super('source'); this.media = media; }
}
// Un élément ne se route qu'une fois dans la vie de la page : le navigateur
// lève sur la seconde source, la doublure suit pour que le test le remarque.
const routed = new WeakSet();
class FakeAudioContext {
  static opened = [];
  constructor({ fail = false, refuseSource = false } = {}) {
    this.fail = fail; this.refuseSource = refuseSource;
    this.state = 'suspended'; this.resumes = 0; this.closed = false; this.destination = { kind: 'destination' };
    FakeAudioContext.opened.push(this);
  }
  createGain() { return new FakeGain(); }
  createDynamicsCompressor() { return new FakeLimiter(); }
  createMediaElementSource(media) {
    if (this.fail) throw new Error('AudioContext indisponible');
    if (this.refuseSource || routed.has(media)) throw new Error('InvalidStateError');
    routed.add(media); return new FakeSource(media);
  }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}
const fakeTarget = () => {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, options) { listeners.push({ type, fn, capture: Boolean(options?.capture) }); },
    removeEventListener(type, fn) { const at = listeners.findIndex(entry => entry.type === type && entry.fn === fn); if (at >= 0) listeners.splice(at, 1); },
    // Un doigt posé : seuls les écouteurs en capture voient passer le geste.
    gesture(type = 'pointerdown') { for (const entry of [...listeners]) if (entry.type === type && entry.capture) entry.fn({ type }); },
    count: () => listeners.length,
  };
};
const fakeMedia = () => {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== fn)); },
    emit(type) { for (const fn of listeners.get(type) ?? []) fn({ type }); },
    count: () => [...listeners.values()].reduce((total, list) => total + list.length, 0),
  };
};
const rig = (options = {}) => {
  const target = fakeTarget(), media = fakeMedia(), contexts = [];
  const create = () => { const context = new FakeAudioContext(options); contexts.push(context); return context; };
  const boost = attachAudioBoost(media, { target, create, ...(options.boost ?? {}) });
  return { target, media, contexts, boost };
};

test('le gain ne naît qu\'au premier geste et s\'intercale entre l\'élément et la sortie', () => {
  const { target, media, contexts, boost } = rig();
  // Rien avant un geste : un contexte né hors appui démarre suspendu, et iOS ne
  // le relance jamais seul — le film serait muet.
  assert.equal(boost.armed, false);
  assert.equal(contexts.length, 0);
  target.gesture('pointerdown');
  assert.equal(boost.armed, true);
  assert.equal(contexts.length, 1);
  const { source, stage, limiter, context } = boost.graph;
  assert.equal(source.media, media);
  assert.deepEqual(source.connections, [stage]);
  assert.deepEqual(stage.connections, [limiter]);
  assert.deepEqual(limiter.connections, [context.destination]);
  // L'étage porte le gain voulu diminué de ce que le limiteur ajoute sous son
  // seuil : 1,5× à l'oreille, 1,4× dans le gain.
  assert.equal(stage.gain.value, BOOST_GAIN / BOOST_MAKEUP);
  assert.equal(limiter.threshold.value, BOOST_CEILING_DB);
  assert.equal(limiter.knee.value, 0);
  assert.equal(limiter.ratio.value, 20);
  assert.equal(limiter.attack.value, 0.003);
  assert.equal(limiter.release.value, 0.25);
  assert.equal(context.state, 'running');
});

test('un geste de plus reprend un contexte suspendu sans remonter un second graphe', () => {
  const { target, contexts, boost } = rig();
  target.gesture();
  const first = boost.graph;
  // Mise en arrière-plan : le contexte se suspend, l'élément continue de jouer
  // par le graphe — le geste suivant doit le relancer, pas le réinstaller.
  first.context.state = 'suspended';
  const resumes = first.context.resumes;
  target.gesture('keydown');
  assert.equal(contexts.length, 1);
  assert.equal(boost.graph, first);
  assert.equal(first.context.resumes, resumes + 1);
  assert.equal(first.context.state, 'running');
});

test('un appareil sans AudioContext garde le son de l\'élément, jamais un silence', () => {
  const warned = [];
  const log = console.warn;
  console.warn = message => warned.push(message);
  try {
    const { target, contexts, boost } = rig({ fail: true });
    target.gesture();
    assert.equal(boost.armed, false);
    assert.equal(boost.graph, null);
    // Un contexte qui n'a rien pris à l'élément se referme au lieu de rester ouvert.
    assert.equal(contexts[0].closed, true);
    assert.match(warned.join('\n'), /AudioContext indisponible/);
  } finally { console.warn = log; }
});

test('une source média refusée laisse le film jouer par l\'élément', () => {
  const warned = [];
  const log = console.warn;
  console.warn = message => warned.push(message);
  try {
    const { target, contexts, boost } = rig({ refuseSource: true });
    target.gesture();
    assert.equal(boost.armed, false);
    assert.equal(contexts[0].closed, true);
    assert.match(warned.join('\n'), /InvalidStateError/);
  } finally { console.warn = log; }
});

test('un moteur qui confisque le volume de l\'élément garde le son intact', () => {
  // WebKit : le routage y laisse curseur et muet sans effet, le film ne serait
  // plus baissable — aucun contexte n'est donc même ouvert.
  const { target, contexts, boost } = rig({ boost: { supported: false } });
  assert.equal(boost.supported, false);
  target.gesture('pointerdown');
  assert.equal(boost.armed, false);
  assert.equal(boost.graph, null);
  assert.equal(contexts.length, 0);
});

test('la sonde de moteur refuse Apple et laisse passer les autres', () => {
  assert.equal(supportsAudioBoost({ vendor: 'Apple Computer, Inc.' }), false);
  assert.equal(supportsAudioBoost({ vendor: 'Google Inc.' }), true);
  assert.equal(supportsAudioBoost({ vendor: '' }), true);
  assert.equal(supportsAudioBoost({}), true);
  assert.equal(supportsAudioBoost(undefined), true);
});

test('le graphe se relance quand l\'élément repart, et stop() retire les gestes', () => {
  const { target, media, boost } = rig();
  assert.equal(target.count(), 3);
  assert.equal(media.count(), 1);
  target.gesture();
  const resumes = boost.graph.context.resumes;
  boost.graph.context.state = 'suspended';
  media.emit('play');
  assert.equal(boost.graph.context.resumes, resumes + 1);
  boost.stop();
  assert.equal(target.count(), 0);
  assert.equal(media.count(), 0);
});
