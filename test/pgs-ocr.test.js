import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeRun, parseDisplaySets, coverage, cuesFromDisplaySets, ocrSubtitleTrack } from '../src/pgs-ocr.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/pgs-en.sup', import.meta.url));

test('decodeRun paints a single pixel per bare byte, runs from 0x00, and ends lines', () => {
  // 3 transparent, two pixels of colour 1, 3 transparent, end of line, then a full
  // transparent line: the shape every PGS encoder emits.
  const data = Buffer.from([0x00, 0x03, 0x01, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00]);
  assert.deepEqual([...decodeRun(data, 8, 2)], [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('decodeRun reads the explicit colour and the extended length flags', () => {
  // 0x85 = run of five, colour from the next byte; 0xC1 0x00 = run of 256, colour 2.
  const explicit = decodeRun(Buffer.from([0x00, 0x85, 0x07, 0x00, 0x00]), 5, 1);
  assert.deepEqual([...explicit], [7, 7, 7, 7, 7]);
  const extended = decodeRun(Buffer.from([0x00, 0xc1, 0x00, 0x02, 0x00, 0x00]), 256, 1);
  assert.equal(extended.every(pixel => pixel === 2), true);
});

test('cuesFromDisplaySets extends a repeated image and closes on an empty screen', () => {
  const cues = cuesFromDisplaySets([
    { time: 1, text: 'Bonjour' },
    { time: 2, text: 'Bonjour' },   // the same image again: one cue, not two
    { time: 3, text: '' },          // the screen clears
    { time: 4, text: 'Au revoir' },
  ], 6);
  assert.deepEqual(cues, [
    { start: 1, end: 3, text: 'Bonjour' },
    { start: 4, end: 6, text: 'Au revoir' },
  ]);
});

test('cuesFromDisplaySets closes the last cue without inventing a duration', () => {
  const open = cuesFromDisplaySets([{ time: 10, text: 'Fin' }], undefined);
  assert.deepEqual(open, [{ start: 10, end: 12, text: 'Fin' }]);
});

test('a PGS track of a real film decodes to images the recogniser can read', async () => {
  const sets = parseDisplaySets(await readFile(FIXTURE));
  assert.ok(sets.length >= 5, `expected display sets, got ${sets.length}`);
  const shots = sets.map(set => ({ time: set.pts / 90000, image: coverage(set) })).filter(shot => shot.image);
  assert.ok(shots.length > 0, 'expected at least one display set painting a bitmap');
  // The fixture starts on the film's first caption: an announcer line over two rows.
  const { cues } = await ocrSubtitleTrack(FIXTURE, 0, { duration: 45 });
  const cue = cues.find(item => item.start > 26 && item.start < 31);
  assert.ok(cue, `expected a cue near 28s, got ${JSON.stringify(cues.slice(0, 3))}`);
  // The engine is not exact (the guard for fidelity is the measuring script, not this
  // test), so assert on what the caption says, not on a perfect transcription.
  assert.match(cue.text, /hot, sunny day/);
  assert.match(cue.text, /Southern Ca/);
});

// A minimal PGS stream: one presentation per display set showing object 1 at the
// origin (optionally cropped), a palette, the object once, then END segments.
const segment = (type, body, pts = 0) => {
  const head = Buffer.alloc(13);
  head.write('PG', 0, 'latin1'); head.writeUInt32BE(pts, 2); head[10] = type; head.writeUInt16BE(body.length, 11);
  return Buffer.concat([head, body]);
};
const presentation = crop => {
  const body = Buffer.alloc(11 + 8 + (crop ? 8 : 0));
  body[10] = 1; body.writeUInt16BE(1, 11); body[14] = crop ? 0x40 : 0;
  if (crop) { body.writeUInt16BE(crop.x, 19); body.writeUInt16BE(crop.y, 21); body.writeUInt16BE(crop.width, 23); body.writeUInt16BE(crop.height, 25); }
  return body;
};
const pgsStream = ({ width, height, sets, crop }) => {
  // One opaque line of colour 1 across the object, then end of line.
  const line = Buffer.from([0x00, 0xc0 | (width >> 8), width & 0xff, 0x01, 0x00, 0x00]);
  const object = Buffer.alloc(11); object.writeUInt16BE(1, 0); object[3] = 0xc0;
  object.writeUIntBE(4 + line.length, 4, 3); object.writeUInt16BE(width, 7); object.writeUInt16BE(height, 9);
  const parts = [segment(0x16, presentation(crop)), segment(0x14, Buffer.from([0, 0, 1, 235, 128, 128, 255])),
    segment(0x15, Buffer.concat([object, line])), segment(0x80, Buffer.alloc(0))];
  for (let n = 1; n < sets; n++) parts.push(segment(0x16, presentation(crop), n * 90000), segment(0x80, Buffer.alloc(0), n * 90000));
  return Buffer.concat(parts);
};

test('an object larger than any picture is skipped instead of allocated', () => {
  // 6000 x 6000 is 34 MiB per bitmap; the audit's 314-byte track reached 470 MiB.
  const before = process.memoryUsage().arrayBuffers;
  const sets = parseDisplaySets(pgsStream({ width: 6000, height: 6000, sets: 6 }));
  assert.equal(sets.length, 6);
  assert.ok(sets.every(set => set.items[0].object === null));
  assert.ok(sets.every(set => coverage(set) === null));
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 ** 2);
});

test('display sets over the same object share its bitmap', () => {
  const sets = parseDisplaySets(pgsStream({ width: 1920, height: 200, sets: 40 }));
  assert.equal(sets.length, 40);
  const pixels = sets[0].items[0].object.pixels;
  assert.equal(pixels.length, 1920 * 200);
  assert.ok(sets.every(set => set.items[0].object.pixels === pixels));
  const image = coverage(sets[0]);
  assert.equal(image.width, 1920);
  assert.equal(image.gray[0], 0);
});

test('a crop is bounded by its object, not by the stream', () => {
  const [set] = parseDisplaySets(pgsStream({ width: 400, height: 40, sets: 1, crop: { x: 0, y: 0, width: 65535, height: 65535 } }));
  const image = coverage(set);
  assert.deepEqual([image.width, image.height], [400, 40]);
});
