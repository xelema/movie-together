import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVoice } from '../public/voice.js';
import { SyncPlayer } from '../public/sync-player.js';

// The 64 KiB bound decided in #39 lives in sendFrame: at the threshold the
// frame is refused rather than queued, and the caller aborts the prise.
test('sendFrame refuses the frame once the socket buffer reaches 64 KiB', () => {
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [], send(frame) { this.sent.push(frame); } };
  const player = { ws };
  assert.equal(SyncPlayer.prototype.sendFrame.call(player, new Uint8Array(8)), true);
  ws.bufferedAmount = 65535;
  assert.equal(SyncPlayer.prototype.sendFrame.call(player, new Uint8Array(8)), true);
  ws.bufferedAmount = 65536;
  assert.equal(SyncPlayer.prototype.sendFrame.call(player, new Uint8Array(8)), false);
  assert.equal(ws.sent.length, 2);
  ws.readyState = WebSocket.CLOSING;
  assert.equal(SyncPlayer.prototype.sendFrame.call(player, new Uint8Array(8)), false);
});

// Minimal stand-ins for the browser seams attachVoice consumes: the mic
// button, the two text cards, and the capture stack. Assertions stay on
// observable state: dataset.state, card contents and messages to the player.
const fakeButton = () => {
  const listeners = {};
  return {
    dataset: {}, attributes: {},
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); },
    setAttribute(name, value) { this.attributes[name] = value; },
    click() { for (const fn of listeners.click ?? []) fn(); },
  };
};
class FakeAudioContext {
  constructor() { this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  close() { return Promise.resolve(); }
}
class FakeWorkletNode {
  static instances = [];
  constructor() { this.port = {}; this.connected = false; FakeWorkletNode.instances.push(this); }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
}
const stubCapture = t => {
  const saved = ['AudioContext', 'AudioWorkletNode', 'navigator']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const streams = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { mediaDevices: { getUserMedia: async () => {
      const stream = { track, getAudioTracks: () => [track], getTracks: () => [track] };
      streams.push(stream);
      return stream;
    } } },
  });
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeWorkletNode;
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { streams, track };
};

test('a saturated socket aborts the prise: local error, clean teardown, retry works', async t => {
  const { streams, track } = stubCapture(t);
  const mic = fakeButton(), local = { textContent: '', hidden: true, dataset: {} }, supertitle = { textContent: '', hidden: true, dataset: {} };
  const player = { sent: [], send(message) { this.sent.push(message); }, sendFrame: () => false };
  const voice = attachVoice({ mic, local, supertitle, player, t: fr => fr, label: message => message });
  mic.click();
  assert.equal(mic.dataset.state, 'starting');
  await voice.message({ state: 'started', utterance: 'u1', seq: 1 });
  assert.equal(mic.dataset.state, 'listening');
  // The worklet's next PCM frame meets a socket that cannot take it (#40).
  FakeWorkletNode.instances.at(-1).port.onmessage({ data: new ArrayBuffer(960) });
  assert.equal(mic.dataset.state, 'error');
  assert.equal(local.hidden, false);
  assert.match(local.textContent, /Connexion lente/);
  // The room is told to release the lock. Nothing else ever left the page:
  // no stop, no command, no result and the supertitle stays untouched.
  assert.deepEqual(player.sent, [
    { type: 'voice', action: 'start', lang: 'fr' },
    { type: 'voice', action: 'cancel' },
  ]);
  assert.equal(FakeWorkletNode.instances.at(-1).connected, false);
  assert.equal(track.enabled, false);
  assert.equal(supertitle.hidden, true);
  assert.equal(mic.attributes['aria-label'], 'Réessayer de parler');
  // The participant retries: the kept stream arms again without a new
  // permission prompt and the granted prise goes back to listening.
  mic.click();
  assert.equal(mic.dataset.state, 'starting');
  await voice.message({ state: 'started', utterance: 'u2', seq: 2 });
  assert.equal(mic.dataset.state, 'listening');
  assert.equal(local.hidden, true);
  assert.equal(track.enabled, true);
  assert.equal(streams.length, 1);
  assert.deepEqual(player.sent.at(-1), { type: 'voice', action: 'start', lang: 'fr' });
  // Le texte compris reste local, sans préfixe et marqué pour l'italique (#47).
  await voice.message({ state: 'understood', utterance: 'u2', seq: 2, text: 'Bonjour le film.' });
  assert.equal(local.textContent, 'Bonjour le film.');
  assert.equal(local.dataset.kind, 'transcript');
  clearTimeout(local.hideTimer);
  voice.dispose();
  assert.equal(mic.dataset.state, 'idle');
  assert.equal(track.stopped, true);
});

// La langue d'interface au premier appui fixe le sens (#44) : une interface
// coréenne demande une prise coréen -> français.
test('the start request carries the interface language of the speaker', async t => {
  stubCapture(t);
  const mic = fakeButton(), local = { textContent: '', hidden: true, dataset: {} }, supertitle = { textContent: '', hidden: true, dataset: {} };
  const player = { sent: [], send(message) { this.sent.push(message); }, sendFrame: () => true };
  const voice = attachVoice({ mic, local, supertitle, player, t: (fr, ko) => ko, label: message => message });
  mic.click();
  assert.deepEqual(player.sent, [{ type: 'voice', action: 'start', lang: 'ko' }]);
  voice.dispose();
});
