import test from 'node:test';
import assert from 'node:assert/strict';
import { codecPlayable } from '../public/backends.js';

test('codecPlayable blocks a video codec the device rejects', () => {
  assert.equal(codecPlayable({ codec: 'hevc' }, () => false), false);
});

test('codecPlayable prefers the manifest codecs string', () => {
  let seen;
  codecPlayable({ codec: 'hevc', codecs: 'hvc1.2.4.L153.B0,mp4a.40.2' }, mime => { seen = mime; return true; });
  assert.equal(seen, 'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"');
});

test('codecPlayable maps codec names to a probe string', () => {
  let seen;
  codecPlayable({ codec: 'hevc' }, mime => { seen = mime; return true; });
  assert.equal(seen, 'video/mp4; codecs="hvc1.1.6.L93.B0"');
});

test('codecPlayable lets unknown codecs through to the engine', () => {
  assert.equal(codecPlayable({}, () => false), true);
});
