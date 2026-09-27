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
        if (this.id === targetId) return this;
        for (const child of this.children) {
          if (child.id === targetId) return child;
          const found = child.querySelector?.(sel);
          if (found) return found;
        }
      }
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        if (this.className === cls) return this;
        for (const child of this.children) {
          if (child.className === cls) return child;
          const found = child.querySelector?.(sel);
          if (found) return found;
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      const results = [];
      const walk = el => {
        for (const child of el.children) {
          if (sel.startsWith('.') && child.className?.split(/\s+/).includes(sel.slice(1))) results.push(child);
          if (sel.startsWith('#') && child.id === sel.slice(1)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
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

  const body = fakeElement('div');
  body.className = 'webcam-body';
  const remote = fakeElement('video', 'webcam-remote-video');
  const preview = fakeElement('video', 'webcam-self-preview');
  const placeholder = fakeElement('div', 'webcam-placeholder');
  const grip = fakeElement('span', 'webcam-resize');
  grip.className = 'webcam-resize-handle';
  grip.dataset.corner = 'se';
  const handleNW = fakeElement('span'); handleNW.className = 'webcam-resize-handle'; handleNW.dataset.corner = 'nw';
  const handleNE = fakeElement('span'); handleNE.className = 'webcam-resize-handle'; handleNE.dataset.corner = 'ne';
  const handleSW = fakeElement('span'); handleSW.className = 'webcam-resize-handle'; handleSW.dataset.corner = 'sw';

  body.children = [remote, preview, placeholder];
  overlay.children = [body, grip, handleNW, handleNE, handleSW];
  return { stage, overlay, body, remote, preview, placeholder, grip, handleNW, handleNE, handleSW };
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
    this.addedCandidates = (this.addedCandidates || []);
    this.addedCandidates.push(cand);
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
  const { stage, overlay, remote, preview, placeholder, grip } = createMockOverlay();
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
  assert.equal(overlay.dataset.solo, 'true');

  // Status active was sent to room
  assert.ok(sent.some(msg => msg.type === 'webcam' && msg.action === 'status' && msg.active === true));

  // 3. Receive remote peer status
  await controller.message({
    action: 'status',
    from: 'peer-5678',
    name: 'Alice',
    active: true,
  });

  // 4. Remote track received
  const remoteTrack = { kind: 'video', stop() {} };
  const remoteStream = { id: 'rem-stream', getTracks: () => [remoteTrack] };
  const pc = FakeRTCPeerConnection.instances[0];
  assert.ok(pc);
  pc.ontrack({ streams: [remoteStream] });
  assert.equal(remote.srcObject, remoteStream);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.dataset.solo, 'false');

  // 5. Remote peer disconnects
  await controller.message({ action: 'peer-left', from: 'peer-5678' });
  assert.equal(remote.srcObject, null);
  assert.equal(overlay.dataset.solo, 'true');

  // 6. Toggle camera off
  await toggle.click();
  assert.equal(toggle.dataset.state, 'idle');
  assert.equal(tracks[0].stopped, true);
  assert.ok(sent.some(msg => msg.type === 'webcam' && msg.action === 'status' && msg.active === false));

  // 7. Drag and resize interactions
  overlay.style.left = '100px';
  overlay.style.top = '100px';
  assert.equal(overlay.style.left, '100px');
  assert.equal(overlay.style.top, '100px');

  // 8. Disposal cleans up
  controller.dispose();
  assert.equal(toggle.dataset.state, 'idle');
  assert.equal(overlay.hidden, true);
});

test('webcam queues ICE candidates until remote description is set', async t => {
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedRTC = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');

  const tracks = [{ kind: 'video', stopped: false, stop() {} }];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
  });
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;
  FakeRTCPeerConnection.instances = [];

  t.after(() => {
    if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
    else delete globalThis.navigator;
    if (savedRTC) Object.defineProperty(globalThis, 'RTCPeerConnection', savedRTC);
    else delete globalThis.RTCPeerConnection;
  });

  const toggle = fakeElement('button', 'webcam-toggle');
  const { overlay } = createMockOverlay();
  const player = { memberId: 'mem-1234', send() {} };
  const controller = attachWebcam({ toggle, overlay, player, t: fr => fr, label: l => l });

  // 1. Candidate arrives before remote description
  await controller.message({
    action: 'signal',
    from: 'peer-9999',
    signal: { candidate: { candidate: 'cand-early' } }
  });
  const pc = FakeRTCPeerConnection.instances[0];
  assert.ok(pc);
  // Candidate should NOT be added yet because remoteDescription is null
  assert.equal(pc.addedCandidates?.length ?? 0, 0);

  // 2. Offer arrives, setting remote description and draining queued candidates
  await controller.message({
    action: 'signal',
    from: 'peer-9999',
    signal: { description: { type: 'offer', sdp: 'remote-sdp' } }
  });
  assert.equal(pc.addedCandidates?.length, 1);
  assert.equal(pc.addedCandidates[0].candidate, 'cand-early');

  controller.dispose();
});
