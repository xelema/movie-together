import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt, serializeVtt, formatTimestamp, shiftCues, cueIndexAt, clampCues } from '../public/subtitle-timing.js';

test('parseVtt reads timestamps, settings and multi-line cue text', () => {
  const cues = parseVtt(`WEBVTT

00:00:01.250 --> 00:00:03.500 align:start line:90%
Première ligne
deuxième ligne

2
00:05.000 --> 00:06.250
Court format.\n`);
  assert.deepEqual(cues, [
    { start: 1.25, end: 3.5, text: 'Première ligne\ndeuxième ligne', settings: 'align:start line:90%' },
    { start: 5, end: 6.25, text: 'Court format.' },
  ]);
});

test('parseVtt ignores headers, NOTE blocks and cleans X-TIMESTAMP-MAP', () => {
  const cues = parseVtt(`WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000

NOTE this is a comment
spanning two lines

STYLE
::cue { color: #fff }

00:00:02.000 --> 00:00:04.000
Visible.\n`);
  assert.deepEqual(cues, [{ start: 2, end: 4, text: 'Visible.' }]);
});

test('serializeVtt round-trips cues and emits the rendition timestamp map', () => {
  const cues = [{ start: 1.5, end: 3, text: 'Allô ?', settings: 'position:20%' }, { start: 5, end: 6.5, text: 'Oui.' }];
  const text = serializeVtt(cues, { timestampMap: 'LOCAL:00:00:00.000,MPEGTS:126000' });
  assert.match(text, /^WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00\.000,MPEGTS:126000\n/);
  assert.match(text, /1\n00:00:01\.500 --> 00:00:03\.000 position:20%\nAllô \?/);
  assert.deepEqual(parseVtt(text), cues);
  // Sans mapping : l'en-tête repart propre.
  const plain = serializeVtt(cues);
  assert.equal(plain.startsWith('WEBVTT\n\n'), true);
  assert.deepEqual(parseVtt(plain), cues);
});

test('formatTimestamp prints HH:MM:SS.mmm', () => {
  assert.equal(formatTimestamp(0), '00:00:00.000');
  assert.equal(formatTimestamp(3661.5), '01:01:01.500');
  assert.equal(formatTimestamp(59.9994), '00:00:59.999');
});

test('shiftCues moves whole cues and never produces a negative start', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 4, end: 6, text: 'b' }, { start: 8, end: 9, text: 'c' }];
  assert.deepEqual(shiftCues(cues, 1.5).map(cue => [cue.start, cue.end]), [[2.5, 3.5], [5.5, 7.5], [9.5, 10.5]]);
  // Un décalage négatif borné à 0 garde la durée de la réplique.
  assert.deepEqual(shiftCues(cues, -3)[0], { start: 0, end: 1, text: 'a' });
  const partial = shiftCues(cues, 10, 1, 2);
  assert.equal(partial[0].start, 1);
  assert.equal(partial[1].start, 14);
  assert.equal(partial[2].start, 8);
});

test('cueIndexAt finds the live cue and nothing between cues', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 4, end: 6, text: 'b' }];
  assert.equal(cueIndexAt(cues, 1.5), 0);
  assert.equal(cueIndexAt(cues, 3), -1);
  assert.equal(cueIndexAt(cues, 6), -1);
});

test('clampCues sorts, drops hopeless cues and trims the film tail', () => {
  const cues = [
    { start: 8, end: 9, text: 'c' },
    { start: -1, end: 2, text: 'a' },
    { start: 4, end: 4, text: 'vide' },
    { start: 5, end: 30, text: 'déborde' },
  ];
  assert.deepEqual(clampCues(cues, 10).map(cue => [cue.start, cue.end, cue.text]),
    [[0, 2, 'a'], [5, 10, 'déborde'], [8, 9, 'c']]);
  // Une réplique entièrement au-delà du film survit au bornage.
  assert.deepEqual(clampCues([{ start: 20, end: 22, text: 'loin' }], 10)[0], { start: 20, end: 22, text: 'loin' });
});
