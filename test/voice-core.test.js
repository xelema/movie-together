import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameAssembler, VOICE_FRAME_SAMPLES, VOICE_FRAME_BYTES } from '../public/voice-core.js';

test('a 48 kHz stream becomes 960-byte 30 ms frames at 16 kHz', () => {
  const asm = new FrameAssembler(48000);
  const block = new Float32Array(128).fill(0.5);
  let frames = [];
  for (let i = 0; i < 100; i++) frames = frames.concat(asm.push(block));
  // 100 * 128 native samples = 4266 output samples, so 8 full frames.
  assert.equal(frames.length, 8);
  for (const frame of frames) {
    assert.equal(frame.byteLength, VOICE_FRAME_BYTES);
    assert.equal(new Int16Array(frame).length, VOICE_FRAME_SAMPLES);
  }
  assert.equal(new Int16Array(frames[0])[0], Math.round(0.5 * 32767));
});

test('samples outside the s16 range clamp instead of wrapping', () => {
  const up = new FrameAssembler(48000);
  const [hot] = up.push(new Float32Array(1441).fill(2.5));
  assert.equal(new Int16Array(hot)[0], 32767);
  const down = new FrameAssembler(48000);
  const [cold] = down.push(new Float32Array(1441).fill(-2.5));
  assert.equal(new Int16Array(cold)[0], -32768);
});

test('one frame per 30 ms of source at every input rate', () => {
  for (const rate of [48000, 44100, 16000]) {
    const asm = new FrameAssembler(rate);
    const [frame] = asm.push(new Float32Array(Math.ceil(rate / 20) + 64).fill(0.25));
    assert.equal(new Int16Array(frame).length, VOICE_FRAME_SAMPLES);
    assert.equal(new Int16Array(frame)[10], Math.round(0.25 * 32767));
  }
});

test('a sine resampled to 16 kHz keeps its frequency', () => {
  const rate = 48000, freq = 440;
  const input = Float32Array.from({ length: Math.floor(rate * 0.24) },
    (_, i) => Math.sin(2 * Math.PI * freq * i / rate) * 0.8);
  const frames = new FrameAssembler(rate).push(input);
  assert.equal(frames.length, 7);
  const pcm = new Int16Array(frames[0]);
  for (const j of [10, 60, 120, 240, 400]) {
    const expected = Math.round(Math.sin(2 * Math.PI * freq * j / 16000) * 0.8 * 32767);
    assert.ok(Math.abs(pcm[j] - expected) < 400, `${j}: ${pcm[j]} vs ${expected}`);
  }
});

test('partial blocks accumulate until 30 ms of source exists', () => {
  const asm = new FrameAssembler(48000);
  const block = new Float32Array(128);
  for (let i = 0; i < 11; i++) assert.equal(asm.push(block).length, 0, `push ${i}`);
  assert.equal(asm.push(block).length, 1);
});
