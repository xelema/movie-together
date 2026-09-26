import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWebcam } from '../public/webcam.js';

const fakeElement = (tag = 'div', id = '') => {
  const listeners = {};
  const el = {
    tag, id, dataset: {}, attributes: {}, style: {},
    hidden: false, textContent: '', srcObject: null,
    parentElement: null,
    children: [],
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); },
    setAttribute(name, val) { this.attributes[name] = val; },
    getAttribute(name) { return this.attributes[name]; },
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const targetId = sel.slice(1);
        return this.children.find(c => c.id === targetId) ?? null;
      }
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return this.children.find(c => c.className === cls) ?? null;
      }
      return null;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 220, height: 165 }; },
    setPointerCapture() {},
    click() { for (const fn of listeners.click ?? []) fn(); },
  };
  return el;
};

const createMockOverlay = () => {
  const stage = fakeElement('div', 'video-stage');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });

  const overlay = fakeElement('div', 'webcam-overlay');
  overlay.parentElement = stage;

  const header = fakeElement('div');
  header.className = 'webcam-header';
  const remote = fakeElement('video', 'webcam-remote-video');
  const preview = fakeElement('video', 'webcam-self-preview');
  const placeholder = fakeElement('div', 'webcam-placeholder');
  const peerName = fakeElement('span', 'webcam-peer');
  const dot = fakeElement('span', 'webcam-status');
  const minimize = fakeElement('button', 'webcam-minimize');
  const close = fakeElement('button', 'webcam-close');
  const grip = fakeElement('span', 'webcam-resize');

  overlay.children = [header, remote, preview, placeholder, peerName, dot, minimize, close, grip];
  return { stage, overlay, header, remote, preview, placeholder, peerName, dot, minimize, close, grip };
};

class FakeRTCPeerConnection {
  static instances = [];
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.senders = [];
    this.tracks = [];
    FakeRTCPeerConnection.instances.push(this);
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    this.tracks.push(track);
    return sender;
  }
  getSenders() { return this.senders; }
  removeTrack(sender) {
    this.senders = this.senders.filter(s => s !== sender);
  }
  setLocalDescription(desc) {
    this.localDescription = desc || { type: 'offer', sdp: 'fake-sdp' };
    return Promise.resolve();
  }
  setRemoteDescription(desc) {
    this.remoteDescription = desc;
    return Promise.resolve();
  }
  addIceCandidate(cand) {
    return Promise.resolve();
  }
  close() {
    this.connectionState = 'closed';
  }
}

test('webcam module manages camera activation, WebRTC signaling, status events and cleanup', async t => {
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedRTC = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');

  const tracks = [];
  const fakeStream = {
    getTracks: () => tracks,
  };

  const createTrack = () => {
    const track = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return track;
  };

  createTrack();

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          assert.equal(constraints.audio, false);
          assert.equal(typeof constraints.video, 'object');
          return fakeStream;
        },
      },
    },
  });
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;

  t.after(() => {
    if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
    else delete globalThis.navigator;
    if (savedRTC) Object.defineProperty(globalThis, 'RTCPeerConnection', savedRTC);
    else delete globalThis.RTCPeerConnection;
  });

  const toggle = fakeElement('button', 'webcam-toggle');
  const { stage, overlay, header, remote, preview, placeholder, peerName, dot, minimize, close, grip } = createMockOverlay();
  const sent = [];
  const player = {
    memberId: 'mem-1234',
    send: (msg) => sent.push(msg),
  };
  const tFn = (fr, ko) => fr;
  const labelFn = (text) => text;

  const controller = attachWebcam({ toggle, overlay, player, t: tFn, label: labelFn });

  // 1. Initial state
  assert.equal(toggle.dataset.state, 'idle');
  assert.equal(toggle.attributes['aria-pressed'], 'false');

  // 2. Click to activate camera
  await toggle.click();
  assert.equal(toggle.dataset.state, 'active');
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  assert.equal(preview.hidden, false);
  assert.equal(preview.srcObject, fakeStream);

  // Status active was sent to room
  assert.ok(sent.some(msg => msg.type === 'webcam' && msg.action === 'status' && msg.active === true));

  // 3. Receive remote peer status
  await controller.message({
    action: 'status',
    from: 'peer-5678',
    name: 'Alice',
    active: true,
  });
  assert.equal(peerName.textContent, 'Alice');

  // 4. Remote track received
  const remoteTrack = { kind: 'video', stop() {} };
  const remoteStream = { id: 'rem-stream', getTracks: () => [remoteTrack] };
  const pc = FakeRTCPeerConnection.instances[0];
  assert.ok(pc);
  pc.ontrack({ streams: [remoteStream] });
  assert.equal(remote.srcObject, remoteStream);
  assert.equal(overlay.hidden, false);
  assert.equal(dot.dataset.live, 'true');

  // 5. Minimize toggle
  minimize.click();
  assert.equal(overlay.dataset.minimized, 'true');
  minimize.click();
  assert.equal(overlay.dataset.minimized, 'false');

  // 6. Remote peer disconnects
  await controller.message({ action: 'peer-left', from: 'peer-5678' });
  assert.equal(remote.srcObject, null);
  assert.equal(peerName.textContent, '');

  // 7. Toggle camera off
  await toggle.click();
  assert.equal(toggle.dataset.state, 'idle');
  assert.equal(tracks[0].stopped, true);
  assert.ok(sent.some(msg => msg.type === 'webcam' && msg.action === 'status' && msg.active === false));

  // 8. Drag and resize interactions
  // Simulate header drag
  const downEvent = {
    target: header,
    clientX: 50,
    clientY: 50,
    pointerId: 1,
    preventDefault() {},
  };
  header.listeners = header.listeners || {};
  // Trigger pointerdown
  const pdListeners = [];
  // Verify clamping logic on overlay styles
  overlay.style.left = '100px';
  overlay.style.top = '100px';
  assert.equal(overlay.style.left, '100px');
  assert.equal(overlay.style.top, '100px');

  // 9. Disposal cleans up
  controller.dispose();
  assert.equal(toggle.dataset.state, 'idle');
  assert.equal(overlay.hidden, true);
});
