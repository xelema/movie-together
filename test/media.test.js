import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';
import { run, probeFile, prepareMovie } from '../src/media.js';

test('copies 4K video and prepares external audio and subtitles on the same timeline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root), movie = { id: randomUUID(), title: 'Test', status: 'uploaded' }; store.save(movie);
  const directory = store.directory(movie.id), source = path.join(directory, 'source');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=3840x2160:rate=2', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-f', 'matroska', source]);
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-f', 'wav', path.join(directory, 'audio')]);
  await writeFile(path.join(directory, 'subtitles'), '1\n00:00:00,000 --> 00:00:01,500\nBonjour.\n');
  movie.externalTracks = [{ kind: 'audio', filename: 'audio', label: 'Français', language: 'fr', index: 0 }, { kind: 'subtitle', filename: 'subtitles', label: 'Français', language: 'fr', index: 0 }];
  const result = await prepareMovie(store, movie, [], []);
  assert.equal(result.renditions.length, 1); assert.equal(result.renditions[0].width, 3840);
  assert.equal(result.audio[0].codec, 'aac'); assert.equal(result.subtitles.length, 1);
  const prepared = path.join(directory, result.generation);
  const hash = input => run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  assert.equal(await hash(source), await hash(path.join(prepared, 'stream_0.m3u8')));
  const audio = await probeFile(path.join(prepared, 'stream_1.m3u8'));
  assert.ok(Math.abs(audio.duration - 2) < 0.1);
  assert.match(await readFile(path.join(prepared, result.subtitles[0].filename), 'utf8'), /Bonjour/);
});
