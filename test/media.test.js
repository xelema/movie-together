import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';
import { run, probeFile, prepareMovie, compatibleFilter } from '../src/media.js';

test('prepares 4K HDR HEVC and surround AC3 as original plus SDR with shared AAC audio', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-hdr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root), movie = { id: randomUUID(), title: 'HDR', status: 'uploaded' };
  store.save(movie);
  const source = path.join(store.directory(movie.id), 'source');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=3840x2160:rate=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'pools=2:frame-threads=1:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
    '-c:a', 'ac3', '-f', 'matroska', source]);
  movie.originalBytes = (await stat(source)).size;
  movie.probe = await probeFile(source);
  assert.equal(movie.probe.compatible, true, JSON.stringify(movie.probe));
  assert.equal(movie.probe.video.hdr, true, JSON.stringify(movie.probe));
  assert.equal(movie.probe.audio[0].copy, false);
  const prepared = await prepareMovie(store, movie, [1], []);
  assert.deepEqual(prepared.renditions.map(item => item.id), ['original', 'compatible']);
  assert.equal(prepared.renditions[0].width, 3840);
  assert.equal(prepared.renditions[1].width, 1920);
  assert.equal(prepared.audio[0].converted, true);
  const directory = path.join(store.directory(movie.id), prepared.generation);
  const fallback = await probeFile(path.join(directory, 'stream_1.m3u8'));
  assert.equal(fallback.video.codec, 'h264'); assert.equal(fallback.video.hdr, false);
  assert.equal(fallback.video.transfer, 'bt709'); assert.equal(fallback.video.pixelFormat, 'yuv420p');
  const audio = await probeFile(path.join(directory, 'stream_2.m3u8'));
  assert.equal(audio.audio[0].codec, 'aac'); assert.equal(audio.audio[0].channels, 2);
  const hash = input => run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  assert.equal(await hash(source), await hash(path.join(directory, 'stream_0.m3u8')));
  assert.match(await readFile(path.join(directory, 'master_original.m3u8'), 'utf8'), /VIDEO-RANGE=PQ/);
  assert.match(await readFile(path.join(directory, 'master_compatible.m3u8'), 'utf8'), /VIDEO-RANGE=SDR/);
  assert.equal(await readFile(path.join(directory, 'master.m3u8'), 'utf8'), await readFile(path.join(directory, 'master_compatible.m3u8'), 'utf8'));
});

test('does not apply ordinary HDR tone mapping to Dolby Vision without a compatible base', () => {
  assert.equal(compatibleFilter({ hdr: true, dolbyVision: { dv_profile: 5, dv_bl_signal_compatibility_id: 0 } }).vulkan, true);
  assert.equal(compatibleFilter({ hdr: true, dolbyVision: { dv_profile: 8, dv_bl_signal_compatibility_id: 1 } }).vulkan, false);
});
