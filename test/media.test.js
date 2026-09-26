import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';
import { run, probeFile, prepareMovie, inspectProbe, codecString, decodeSubtitleText, subtitleFileFormat, addSubtitle, refreshStaleProbes, PROBE_SCHEMA } from '../src/media.js';
import { defaultTrackNames } from '../public/track-names.js';

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

test('copies 4K video exactly and prepares embedded audio and external subtitles on the same timeline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root), movie = { id: randomUUID(), title: 'Test', status: 'uploaded' }; store.save(movie);
  const directory = store.directory(movie.id), source = path.join(directory, 'source');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=3840x2160:rate=2',
    '-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*440*t):s=48000', '-t', '2', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'matroska', source]);
  await writeFile(path.join(directory, 'subtitles'), '1\n00:00:00,000 --> 00:00:01,500\nBonjour.\n');
  movie.externalTracks = [{ kind: 'subtitle', filename: 'subtitles', label: 'French', language: 'fr', index: 0 }];
  const original = await readFile(source);
  const result = await prepareMovie(store, movie, [1], []);
  assert.equal(result.renditions.length, 1); assert.equal(result.renditions[0].width, 3840);
  assert.equal(result.audio[0].codec, 'aac'); assert.equal(result.subtitles.length, 1);
  assert.equal(result.subtitles[0].external, true); assert.deepEqual(result.externalTracks, []);
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
  assert.deepEqual(await colourBox(prepared), { primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  assert.match(await readFile(path.join(prepared, 'master.m3u8'), 'utf8'), /CHANNELS="2"/);
  assert.match(await readFile(path.join(prepared, 'stream_0.m3u8'), 'utf8'), /#EXT-X-INDEPENDENT-SEGMENTS/);
  assert.ok(result.maxSegmentSeconds <= 4.05);
});

test('startup refresh reprobes only movies stored with an older probe schema', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-probes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const stale = { id: randomUUID(), title: 'Old', status: 'uploaded', probe: { schema: PROBE_SCHEMA - 1 } };
  const current = { id: randomUUID(), title: 'New', status: 'uploaded', probe: { schema: PROBE_SCHEMA } };
  const ready = { id: randomUUID(), title: 'Ready', status: 'ready', probe: { schema: 1 } };
  for (const movie of [stale, current, ready]) store.save(movie);
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=128x72:rate=24',
    '-t', '1', '-c:v', 'libx264', '-f', 'matroska', path.join(store.directory(stale.id), 'source')]);
  // current and ready have no source: probing either would fail and mark the movie 'failed'.
  await refreshStaleProbes(store);
  assert.equal(stale.probe.schema, PROBE_SCHEMA);
  assert.equal(stale.probe.video.codec, 'h264');
  assert.equal(current.status, 'uploaded');
  assert.equal(ready.status, 'ready');
});

test('decodes legacy subtitle charsets to UTF-8', () => {
  // EUC-KR bytes for « 안녕하세요. 반갑습니다. 한국어 자막입니다 » repeated for confident detection.
  const korean = '안녕하세요. 반갑습니다. 한국어 자막입니다';
  const eucKr = Buffer.from([0xBE, 0xC8, 0xB3, 0xE7, 0xC7, 0xCF, 0xBC, 0xBC, 0xBF, 0xE4, 0x2E, 0x20,
    0xB9, 0xDD, 0xB0, 0xA9, 0xBD, 0xC0, 0xB4, 0xCF, 0xB4, 0xD9, 0x2E, 0x20,
    0xC7, 0xD1, 0xB1, 0xB9, 0xBE, 0xEE, 0x20, 0xC0, 0xDA, 0xB8, 0xB7, 0xC0, 0xD4, 0xB4, 0xCF, 0xB4, 0xD9]);
  assert.equal(decodeSubtitleText(eucKr), korean);
  assert.equal(decodeSubtitleText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Café', 'utf8')])), 'Café');
  assert.equal(decodeSubtitleText(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Café', 'utf16le')])), 'Café');
  assert.equal(decodeSubtitleText(Buffer.from('Caf\xE9 \xE0 la f\xEAte', 'latin1')), 'Café à la fête');
  assert.equal(decodeSubtitleText(Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nPlain.\n')), '1\n00:00:01,000 --> 00:00:03,000\nPlain.\n');
});

test('identifies subtitle files without extension by converting them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-subs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'external_test');
  await writeFile(input, '<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=KRCC>안녕\n<SYNC Start=3000><P Class=KRCC>다시\n</BODY>\n</SAMI>\n');
  assert.deepEqual(await subtitleFileFormat(input, ['sami']), { format: 'sami' });
  await writeFile(input, '{25}{75}MicroDVD line\n{100}{150}Other\n');
  assert.deepEqual(await subtitleFileFormat(input, ['microdvd', 'subviewer']), { format: 'microdvd' });
  await writeFile(input, '[INFORMATION]\n[TITLE]x\n[END INFORMATION]\n[SUBTITLE]\n00:00:01.00,00:00:03.00\nSubViewer line\n');
  assert.deepEqual(await subtitleFileFormat(input, ['microdvd', 'subviewer']), { format: 'subviewer' });
  await writeFile(input, Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]));
  assert.equal(await subtitleFileFormat(input, ['microdvd', 'subviewer']), null);
});

test('converts a forced-format subtitle file and rejects one with no cues', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-addsub-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'subtitle-input');
  await writeFile(input, '<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=KRCC>안녕하세요\n</BODY>\n</SAMI>\n');
  const track = await addSubtitle(root, input, { label: 'Korean', language: 'ko', index: 0, duration: 60, format: 'sami' });
  const vtt = await readFile(path.join(root, track.filename), 'utf8');
  assert.match(vtt, /WEBVTT/); assert.match(vtt, /안녕하세요/); assert.match(vtt, /00:01\.000 --> /);
  await writeFile(input, 'no timed text here\n');
  await assert.rejects(addSubtitle(root, input, { label: 'x', language: 'und', index: 0, duration: 60, format: 'sami' }), /piste utilisable/);
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

test('serves PQ and HLG with the source colour in the container tags', async t => {
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
    // The container repeats the stream colour: the decoder matrix always matches the shader.
    assert.deepEqual(await colourBox(path.dirname(prepared)),
      { primaries: 9, transfer: transfer === 'smpte2084' ? 16 : 18, matrix: 9, fullRange: false });
    assert.deepEqual(result.renditions[0].color, { version: 1, transfer, primaries: 'bt2020',
      matrix: 'bt2020nc', fullRange: false, bitDepth: 10,
      peakNits: transfer === 'smpte2084' ? 10000 : 1000 });
    const master = await readFile(path.join(store.directory(movie.id), result.generation, 'master.m3u8'), 'utf8');
    assert.match(master, new RegExp(`VIDEO-RANGE=${transfer === 'smpte2084' ? 'PQ' : 'HLG'}`));
  }
});

test('tags the container with the source colour and reports the source peak', async t => {
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
  assert.equal(result.renditions[0].color.peakNits, 4000);
  assert.equal(result.renditions[0].color.transfer, 'smpte2084');
  assert.deepEqual(await colourBox(path.dirname(prepared)),
    { primaries: 9, transfer: 16, matrix: 9, fullRange: false });
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
  assert.equal(result.audio[1].label, 'Track 2');
  const measure = async (stream, filters) => (await run(ffmpeg, ['-hide_banner', '-nostats', '-i', path.join(output, `stream_${stream}.m3u8`),
    '-af', filters, '-f', 'null', '-'], { includeStderr: true })).stderr;
  const channels = [...(await measure(1, 'astats')).matchAll(/RMS level dB: ([-\d.]+)/g)].map(match => Number(match[1]));
  assert.ok(channels.length >= 2); assert.ok(Math.abs(channels[0] - channels[1]) < 0.1);
  assert.ok(channels[0] > -50 && channels[0] < -30, String(channels));
  assert.equal(result.audio[0].channels, 2); assert.equal(result.audio[0].converted, true);
  assert.match(await measure(2, 'volumedetect'), /max_volume: -91/);
});

test('names duplicate tracks by flag, original title or layout, numbering last', () => {
  const names = (tracks, kind) => [...defaultTrackNames(tracks, kind).values()];
  const sub = extra => ({ index: 0, language: 'fr', label: 'fr', compatible: true, codec: 'subrip', ...extra });
  assert.deepEqual(names([sub({ index: 2 }), sub({ index: 3, language: 'en', label: 'en' })], 'subtitles'), ['French', 'English']);
  assert.deepEqual(names([sub({ index: 2 }), sub({ index: 3, forced: true })], 'subtitles'), ['French', 'French (forced)']);
  assert.deepEqual(names([sub({ index: 2 }), sub({ index: 3, label: 'FR FORCED' })], 'subtitles'), ['French', 'French (forced)']);
  assert.deepEqual(names([sub({ index: 2, label: 'SDH' }), sub({ index: 3, label: 'Signs' })], 'subtitles'), ['French (SDH)', 'French (Signs)']);
  const audio = extra => ({ index: 0, language: 'en', label: 'en', compatible: true, codec: 'aac', ...extra });
  assert.deepEqual(names([audio({ index: 1, channels: 2, channelLayout: 'stereo' }),
    audio({ index: 2, channels: 6, channelLayout: '5.1(side)' })], 'audio'), ['English (stereo)', 'English (5.1)']);
  assert.deepEqual(names([audio({ index: 1 }), audio({ index: 2 })], 'audio'), ['English', 'English 2']);
  // Incompatible tracks never collide: they cannot be selected.
  assert.deepEqual(names([sub({ index: 2 }), sub({ index: 3, compatible: false, codec: 'hdmv_pgs_subtitle' })], 'subtitles'), ['French', 'French']);
});

test('keeps stream dispositions so forced and commentary tracks can be named', () => {
  const probe = inspectProbe({ format: { duration: '10' }, streams: [
    { codec_type: 'audio', codec_name: 'aac', index: 1, channels: 2, sample_rate: '48000', profile: 'LC',
      disposition: { default: 1, comment: 1 }, tags: { language: 'eng' } },
    { codec_type: 'subtitle', codec_name: 'subrip', index: 3, disposition: { forced: 1 }, tags: { language: 'fra', title: 'FR FORCED' } },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', index: 4, tags: { language: 'fra' } }] });
  assert.equal(probe.audio[0].commentary, true);
  assert.equal(probe.audio[0].defaultTrack, true);
  assert.equal(probe.subtitles[0].forced, true);
  assert.equal(probe.subtitles[1].compatible, false);
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
  assert.deepEqual(await colourBox(path.dirname(output)), { primaries: 1, transfer: 1, matrix: 1, fullRange: true });
  assert.equal(await decodedVideo(path.join(directory, 'source')), await decodedVideo(output));
});

// ffmpeg writes no CODECS for a stream it copied without parsing; the string is
// recovered from the codec configuration record inside the init segment.
test('codecString decodes the RFC 6381 form from a configuration record', () => {
  const box = (type, payload) => {
    const buffer = Buffer.alloc(8 + payload.length);
    buffer.writeUInt32BE(buffer.length); buffer.write(type, 4); payload.copy(buffer, 8);
    return buffer;
  };
  const moov = inner => box('moov', inner);
  // hvcC: version 1, Main (profile_idc 1), compatibility 0x60000000 prints
  // bit-reversed, constraint bytes drop trailing zeros, level 63.
  const hvcC = Buffer.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 63]);
  assert.equal(codecString(moov(box('hvcC', hvcC))), 'hvc1.1.6.L63.90');
  const hvcC10 = Buffer.from([1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 63]);
  assert.equal(codecString(moov(box('hvcC', hvcC10))), 'hvc1.2.4.L63.90');
  const avcC = Buffer.from([1, 0x64, 0x00, 0x28]);
  assert.equal(codecString(moov(box('avcC', avcC))), 'avc1.640028');
  assert.equal(codecString(Buffer.alloc(64)), '');
});

test('a copied HEVC stream still gets a precise CODECS attribute', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'movie-night-hevc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const store = createStore(root), movie = { id: randomUUID(), title: 'HEVC' }; store.save(movie);
  const source = path.join(store.directory(movie.id), 'source');
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=128x72:rate=24', '-t', '1',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error',
    '-tag:v', 'hvc1', '-f', 'matroska', source]);
  const result = await prepareMovie(store, movie, [], []);
  const master = await readFile(path.join(store.directory(movie.id), result.generation, 'master.m3u8'), 'utf8');
  assert.match(result.renditions[0].codecs, /^hvc1\.2\.4\.L\d+/);
  assert.match(master, new RegExp(`CODECS="${result.renditions[0].codecs}"`));
});
