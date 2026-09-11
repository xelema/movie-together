import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';
import { run, probeFile, prepareMovie, inspectProbe } from '../src/media.js';

// Retagging rewrites the sequence header, so compare decoded samples: no picture may change.
const decodedVideo = input => run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-f', 'framemd5', '-']);
// Browsers read the colour box of the track, not the sequence header, so that is what preparation sets.
const colourBox = async directory => {
  const bytes = await readFile(path.join(directory, 'init_0.mp4'));
  const at = bytes.indexOf('colrnclx') + 8;
  assert.ok(at > 8, 'aucune boîte colr nclx');
  return { primaries: bytes.readUInt16BE(at), transfer: bytes.readUInt16BE(at + 2),
    matrix: bytes.readUInt16BE(at + 4), fullRange: !!(bytes[at + 6] & 0x80) };
};

test('copies 4K video exactly and prepares external audio and subtitles on the same timeline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root), movie = { id: randomUUID(), title: 'Test', status: 'uploaded' }; store.save(movie);
  const directory = store.directory(movie.id), source = path.join(directory, 'source');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=3840x2160:rate=2', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-f', 'matroska', source]);
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-f', 'wav', path.join(directory, 'audio')]);
  await writeFile(path.join(directory, 'subtitles'), '1\n00:00:00,000 --> 00:00:01,500\nBonjour.\n');
  movie.externalTracks = [{ kind: 'audio', filename: 'audio', label: 'Français', language: 'fr', index: 0 }, { kind: 'subtitle', filename: 'subtitles', label: 'Français', language: 'fr', index: 0 }];
  const original = await readFile(source);
  const result = await prepareMovie(store, movie, [], []);
  assert.equal(result.renditions.length, 1); assert.equal(result.renditions[0].width, 3840);
  assert.equal(result.audio[0].codec, 'aac'); assert.equal(result.subtitles.length, 1);
  const prepared = path.join(directory, result.generation);
  assert.deepEqual(await readFile(source), original);
  const video = await probeFile(path.join(prepared, 'stream_0.m3u8'));
  assert.equal(video.video.codec, 'h264'); assert.equal(video.video.pixelFormat, 'yuv420p');
  assert.equal(video.video.frameRate, 2);
  assert.equal(await decodedVideo(source), await decodedVideo(path.join(prepared, 'stream_0.m3u8')));
  // HLS demuxing needs its own protocol allowlist, unlike uploaded files.
  const audio = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(prepared, 'stream_1.m3u8')]));
  assert.ok(Math.abs(Number(audio.format.duration) - 2) < 0.1);
  assert.equal(audio.streams[0].channels, 2); assert.equal(audio.streams[0].sample_rate, '48000');
  assert.match(await readFile(path.join(prepared, result.subtitles[0].filename), 'utf8'), /Bonjour/);
  assert.match(await readFile(path.join(prepared, 'master.m3u8'), 'utf8'), /VIDEO-RANGE=SDR/);
  assert.deepEqual(await colourBox(prepared), { primaries: 1, transfer: 13, matrix: 1, fullRange: false });
  assert.match(await readFile(path.join(prepared, 'master.m3u8'), 'utf8'), /CHANNELS="2"/);
  assert.ok(result.maxSegmentSeconds <= 4.05);
});

test('reads color metadata without guessing or treating Dolby Vision as SDR', () => {
  const inspect = extra => inspectProbe({ streams: [{ codec_type: 'video', codec_name: 'hevc', index: 0,
    width: 3840, height: 2160, pix_fmt: 'yuv420p10le', avg_frame_rate: '24000/1001', ...extra }], format: { duration: '12' } }).video;
  assert.equal(inspect({}).colorPrimaries, undefined);
  assert.equal(inspect({}).colorTransfer, undefined);
  for (const transfer of ['smpte2084', 'arib-std-b67']) {
    const video = inspect({ color_transfer: transfer });
    assert.equal(video.hdr, true); assert.equal(video.colorTransfer, transfer);
  }
  const dv = (profile, compatibilityId) => inspect({ side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: profile, dv_bl_signal_compatibility_id: compatibilityId }] });
  assert.equal(dv(5, 0).hdr, true); assert.equal(dv(5, 0).colorTransfer, undefined);
  assert.equal(dv(8, 4).dolbyVision.compatibilityId, 4);
  for (const rate of [44100, 48000]) {
    const audio = inspectProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: String(rate) }] }).audio[0];
    assert.equal(audio.copy, true); assert.equal(audio.sampleRate, rate);
  }
});

test('serves PQ and HLG as sRGB transport while keeping the source colour metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-hdr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  for (const transfer of ['smpte2084', 'arib-std-b67']) {
    const store = createStore(root), movie = { id: randomUUID(), title: transfer }; store.save(movie);
    const source = path.join(store.directory(movie.id), 'source');
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=128x72:rate=24', '-t', '1',
      '-vf', `format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc:range=limited`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', transfer,
      '-colorspace', 'bt2020nc', '-color_range', 'tv', '-f', 'matroska', source]);
    const result = await prepareMovie(store, movie, [], []);
    const prepared = path.join(store.directory(movie.id), result.generation, 'stream_0.m3u8');
    assert.equal(result.renditions.length, 1);
    assert.equal(await decodedVideo(source), await decodedVideo(prepared));
    // The coded stream is untouched: its sequence header still describes the source.
    const frame = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-i', prepared,
      '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#1', '-of', 'json'])).frames[0];
    assert.equal(frame.color_transfer, transfer); assert.equal(frame.pix_fmt, 'yuv420p10le');
    // The transport is what every browser decodes the same way; the shader restores the source.
    assert.deepEqual(await colourBox(path.dirname(prepared)),
      { primaries: 1, transfer: 13, matrix: 1, fullRange: false });
    assert.deepEqual(result.renditions[0].color, { version: 1, transfer, primaries: 'bt2020',
      matrix: 'bt2020nc', fullRange: false, bitDepth: 10, peakNits: 1000 });
    const master = await readFile(path.join(store.directory(movie.id), result.generation, 'master.m3u8'), 'utf8');
    assert.match(master, /VIDEO-RANGE=SDR/);
  }
});

test('tags the transport in the container only and reports the source peak', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-tonemap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const store = createStore(root), movie = { id: randomUUID(), title: 'Peak' }; store.save(movie);
  const source = path.join(store.directory(movie.id), 'source');
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=128x72:rate=24', '-t', '1',
    '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=limited',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(40000000,1):max-cll=1033,311:repeat-headers=1',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv',
    '-tag:v', 'hvc1', '-f', 'mp4', source]);
  const result = await prepareMovie(store, movie, [], []);
  const prepared = path.join(store.directory(movie.id), result.generation, 'stream_0.m3u8');
  assert.equal(await decodedVideo(source), await decodedVideo(prepared));
  assert.equal(result.renditions[0].color.peakNits, 1033);
  assert.equal(result.renditions[0].color.transfer, 'smpte2084');
  assert.deepEqual(await colourBox(path.dirname(prepared)),
    { primaries: 1, transfer: 13, matrix: 1, fullRange: false });
  // The coded stream is byte-identical: no bitstream filter runs, so no source can be corrupted.
  const compressed = input => run(process.env.FFMPEG_PATH || 'ffmpeg',
    ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  assert.equal(await compressed(source), await compressed(prepared));
});

test('downmixes center-channel dialogue to both speakers in one pass and preserves silence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const store = createStore(root), movie = { id: randomUUID(), title: 'Dialogue' }; store.save(movie);
  const directory = store.directory(movie.id);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=128x72:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=0|0|0.02*sin(2*PI*440*t)|0|0|0:s=48000:c=5.1',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '12', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-c:a', 'pcm_s16le', '-f', 'matroska', path.join(directory, 'source')]);
  movie.trackNames = { audio: { 1: 'Version originale' } };
  const result = await prepareMovie(store, movie, [1, 2], []);
  const output = path.join(directory, result.generation);
  const master = await readFile(path.join(output, 'master.m3u8'), 'utf8');
  assert.match(master, /NAME="Version originale"/);
  assert.equal(result.audio[0].label, 'Version originale');
  assert.equal(result.audio[1].label, 'Piste 2');
  const measure = async (stream, filters) => (await run(ffmpeg, ['-hide_banner', '-nostats', '-i', path.join(output, `stream_${stream}.m3u8`),
    '-af', filters, '-f', 'null', '-'], { includeStderr: true })).stderr;
  const channels = [...(await measure(1, 'astats')).matchAll(/RMS level dB: ([-\d.]+)/g)].map(match => Number(match[1]));
  assert.ok(channels.length >= 2); assert.ok(Math.abs(channels[0] - channels[1]) < 0.1);
  assert.ok(channels[0] > -50 && channels[0] < -30, String(channels));
  assert.equal(result.audio[0].channels, 2); assert.equal(result.audio[0].converted, true);
  assert.match(await measure(2, 'volumedetect'), /max_volume: -91/);
});

test('preserves full-range SDR black and white and the original color metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-levels-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const store = createStore(root), movie = { id: randomUUID(), title: 'Levels' }; store.save(movie);
  const directory = store.directory(movie.id);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    "nullsrc=s=128x72:r=24,geq=lum='if(lt(X,64),0,255)':cb=128:cr=128,setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    '-t', '1', '-c:v', 'libx264', '-crf', '0', '-f', 'matroska', path.join(directory, 'source')]);
  const result = await prepareMovie(store, movie, [], []);
  const output = path.join(directory, result.generation, 'stream_0.m3u8');
  const stats = await run(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
  assert.match(stats, /lavfi.signalstats.YMIN=0\r?\n/);
  assert.match(stats, /lavfi.signalstats.YMAX=255\r?\n/);
  const video = (await probeFile(output)).video;
  assert.equal(video.colorRange, 'pc'); assert.equal(video.colorPrimaries, 'bt709');
  assert.equal(result.renditions[0].color.fullRange, true);
  assert.equal(await decodedVideo(path.join(directory, 'source')), await decodedVideo(output));
});
