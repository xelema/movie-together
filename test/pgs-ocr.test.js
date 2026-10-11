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
