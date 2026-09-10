import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, readdir, stat, statfs, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function run(binary, args, { timeout = 48 * 3600_000, cwd, onProgress, includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    let progressBuffer = '';
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-4_000_000);
      if (onProgress) {
        progressBuffer += chunk;
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
        for (const line of lines) if (line.startsWith('out_time_us=')) onProgress(Number(line.slice(12)) / 1_000_000);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(includeStderr ? { stdout, stderr } : stdout);
      else reject(new Error(expired ? 'Traitement trop long.' : `${binary} : ${stderr.slice(-3000)}`));
    });
  });
}

export function inspectProbe(probe) {
  const streams = probe.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const sideData = video?.side_data_list ?? [];
  const dovi = sideData.find(data => data.side_data_type === 'DOVI configuration record');
  const color = key => !['unknown', 'unspecified', 'reserved'].includes(video?.[key]) ? video?.[key] : undefined;
  const transfer = color('color_transfer');
  const hdr = ['smpte2084', 'arib-std-b67'].includes(transfer) || !!dovi;
  const audio = streams.filter(stream => stream.codec_type === 'audio').map(stream => ({
    index: stream.index, codec: stream.codec_name, channels: stream.channels,
    language: stream.tags?.language ?? 'und', label: stream.tags?.title ?? stream.tags?.language ?? `Audio ${stream.index}`,
    compatible: !!stream.codec_name && stream.codec_name !== 'unknown',
    channelLayout: stream.channel_layout, sampleRate: Number(stream.sample_rate),
    copy: stream.codec_name === 'aac' && stream.profile === 'LC' && stream.channels > 0 && stream.channels <= 2 &&
      [44100, 48000].includes(Number(stream.sample_rate)),
  }));
  const subtitles = streams.filter(stream => stream.codec_type === 'subtitle').map(stream => ({
    index: stream.index, codec: stream.codec_name, language: stream.tags?.language ?? 'und',
    label: stream.tags?.title ?? stream.tags?.language ?? `Sous-titres ${stream.index}`,
    compatible: ['subrip', 'webvtt', 'mov_text', 'ass', 'ssa'].includes(stream.codec_name),
  }));
  const duration = Number(probe.format?.duration);
  const videoCompatible = ['h264', 'hevc', 'av1', 'vp9'].includes(video?.codec_name) && video.width > 0 && video.height > 0;
  const [num, den = 1] = (video?.avg_frame_rate || video?.r_frame_rate || '24/1').split('/').map(Number);
  return { schema: 4, video: video ? { codec: video.codec_name, pixelFormat: video.pix_fmt,
    index: video.index, width: video.width, height: video.height, profile: video.profile, level: video.level,
    frameRate: Number.isFinite(num / den) && num / den > 0 ? num / den : 24,
    sampleAspectRatio: video.sample_aspect_ratio,
    rotation: Number(sideData.find(data => data.rotation !== undefined)?.rotation ?? video.tags?.rotate) || 0,
    colorPrimaries: color('color_primaries'), colorTransfer: transfer,
    colorSpace: color('color_space'), colorRange: color('color_range'),
    hdr, dolbyVision: dovi ? { profile: dovi.dv_profile, level: dovi.dv_level,
      compatibilityId: dovi.dv_bl_signal_compatibility_id } : null,
  } : null,
    videoCompatible, audio, subtitles, duration,
    bitrate: Number(probe.format?.bit_rate) || null,
    compatible: videoCompatible && Number.isFinite(duration) && duration > 0 };
}

export async function probeFile(file) {
  const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file,
  ], { timeout: 120_000 }));
  return inspectProbe(probe);
}

function quote(value) { return String(value).replace(/["\r\n\\]/g, '').slice(0, 100); }
function language(value) { return /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(value) ? value : 'und'; }

// Chromium compresses the whole PQ range down to the peak the file declares, Firefox ignores it.
// 203 nits is the BT.2408 reference white and Chromium's floor: below it no compression is left,
// which is the brightest picture it will produce. Raising the value gives highlights back their
// detail and darkens everything else. See docs/playback.md.
const TONE_MAP_PEAK_NITS = Math.min(10000, Math.max(203, Number(process.env.HDR_PEAK_NITS) || 203));
const BOX_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const VISUAL_SAMPLE_ENTRIES = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe', 'avc1', 'avc3', 'vp09', 'av01']);

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0); header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function* boxes(buffer, start, end) {
  for (let offset = start; offset + 8 <= end;) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8 || offset + size > end) return;
    yield { offset, size, type: buffer.toString('latin1', offset + 4, offset + 8) };
    offset += size;
  }
}

function findVisualEntry(buffer, start, end, ancestors = []) {
  for (const { offset, size, type } of boxes(buffer, start, end)) {
    if (BOX_CONTAINERS.has(type)) {
      const found = findVisualEntry(buffer, offset + 8, offset + size, [...ancestors, offset]);
      if (found) return found;
    } else if (type === 'stsd') {
      for (const entry of boxes(buffer, offset + 16, offset + size)) {
        // A VisualSampleEntry keeps 78 fixed bytes before its own child boxes.
        if (VISUAL_SAMPLE_ENTRIES.has(entry.type)) return { entry, ancestors: [...ancestors, offset] };
      }
    }
  }
  return null;
}

function toneMapBoxes() {
  const mastering = Buffer.alloc(24);
  // Rec. 2020 primaries in units of 0.00002, green then blue then red, then the D65 white point.
  for (const [index, [x, y]] of [[8500, 39850], [6550, 2300], [35400, 14600], [15635, 16450]].entries()) {
    mastering.writeUInt16BE(x, index * 4); mastering.writeUInt16BE(y, index * 4 + 2);
  }
  mastering.writeUInt32BE(TONE_MAP_PEAK_NITS * 10000, 16); mastering.writeUInt32BE(1, 20);
  const light = Buffer.alloc(4); light.writeUInt16BE(TONE_MAP_PEAK_NITS, 0);
  return Buffer.concat([box('mdcv', mastering), box('clli', light)]);
}

function unescapeRbsp(nal) {
  const out = Buffer.alloc(nal.length);
  let length = 0, zeros = 0;
  for (const byte of nal) {
    if (zeros === 2 && byte === 3) { zeros = 0; continue; }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

function escapeRbsp(rbsp) {
  const out = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros === 2 && byte <= 3) { out.push(3); zeros = 0; }
    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }
  return Buffer.from(out);
}

// Supplemental enhancement information carries the mastering display (137) and content light
// level (144) messages that Chromium reads for HEVC. Their fields have a fixed width.
function rewriteSeiPayloads(rbsp) {
  let offset = 2, rewritten = false;
  while (offset < rbsp.length - 1 && rbsp[offset] !== 0x80) {
    let type = 0, size = 0;
    while (rbsp[offset] === 0xff) { type += 255; offset++; }
    type += rbsp[offset++];
    while (rbsp[offset] === 0xff) { size += 255; offset++; }
    size += rbsp[offset++];
    if (offset + size > rbsp.length) return rewritten;
    if (type === 137 && size >= 24) { rbsp.writeUInt32BE(TONE_MAP_PEAK_NITS * 10000, offset + 16); rewritten = true; }
    if (type === 144 && size >= 4) { rbsp.writeUInt16BE(TONE_MAP_PEAK_NITS, offset); rbsp.writeUInt16BE(0, offset + 2); rewritten = true; }
    offset += size;
  }
  return rewritten;
}

// Rewrites the peak luminance an HEVC segment announces. Coded pictures are never touched: only
// the two informational messages that sit before the first slice of the segment change.
export async function rewriteToneMapSei(file) {
  const handle = await open(file, 'r+');
  try {
    const head = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    let media = -1;
    for (let offset = 0; offset + 8 <= bytesRead;) {
      const size = head.readUInt32BE(offset);
      if (head.toString('latin1', offset + 4, offset + 8) === 'mdat') { media = offset + (size === 1 ? 16 : 8); break; }
      if (size < 8) break;
      offset += size;
    }
    if (media < 0) return false;
    let rewritten = false;
    for (let offset = media; offset + 6 <= bytesRead;) {
      const length = head.readUInt32BE(offset);
      if (length < 2 || offset + 4 + length > bytesRead) break;
      const type = (head[offset + 4] >> 1) & 0x3f;
      if (type < 32) break; // A coded slice ends the leading messages of the segment.
      if (type === 39 || type === 40) {
        const nal = head.subarray(offset + 4, offset + 4 + length);
        const rbsp = unescapeRbsp(nal);
        if (rewriteSeiPayloads(rbsp)) {
          const escaped = escapeRbsp(rbsp);
          // Equal length keeps every sample size in the fragment header valid.
          if (escaped.length === length) { escaped.copy(head, offset + 4); rewritten = true; }
        }
      }
      offset += 4 + length;
    }
    if (rewritten) await handle.write(head, 0, bytesRead, 0);
    return rewritten;
  } finally {
    await handle.close();
  }
}

// Rewrites the light level of a PQ initialisation segment. No video sample is read or written.
export async function writeToneMapMetadata(file) {
  const buffer = await readFile(file);
  // Growing the header would move every chunk offset of a progressive file. Initialisation
  // segments hold no media, so they are the only safe input.
  for (const { type } of boxes(buffer, 0, buffer.length)) if (type === 'mdat') return false;
  const found = findVisualEntry(buffer, 0, buffer.length);
  if (!found) return false;
  const { entry, ancestors } = found;
  const body = entry.offset + 8 + 78, kept = [];
  let perceptualQuantizer = false;
  for (const child of boxes(buffer, body, entry.offset + entry.size)) {
    if (child.type === 'colr' && buffer.toString('latin1', child.offset + 8, child.offset + 12) === 'nclx') {
      perceptualQuantizer = buffer.readUInt16BE(child.offset + 14) === 16;
    }
    if (child.type !== 'mdcv' && child.type !== 'clli') kept.push(buffer.subarray(child.offset, child.offset + child.size));
  }
  if (!perceptualQuantizer) return false;
  const replacement = Buffer.concat([...kept, toneMapBoxes()]);
  const patched = Buffer.concat([buffer.subarray(0, body), replacement, buffer.subarray(entry.offset + entry.size)]);
  const delta = patched.length - buffer.length;
  for (const offset of [...ancestors, entry.offset]) patched.writeUInt32BE(patched.readUInt32BE(offset) + delta, offset);
  await writeFile(file, patched);
  return true;
}

export async function writeMaster(directory, audio, subtitles, renditions) {
  const base = await readFile(path.join(directory, 'base.m3u8'), 'utf8');
  let audioIndex = 0;
  const lines = base.trim().split(/\r?\n/).map(line => {
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const track = audio[audioIndex++];
      return line.replace(/NAME="[^"]*"/, `NAME="${quote(track.label)}"`).replace(/,CHANNELS="[^"]*"/, '') + `,CHANNELS="${track.channels || 2}"`;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:') && subtitles.length) return `${line},SUBTITLES="subs"`;
    return line;
  });
  const entries = subtitles.map(track => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${quote(track.label)}",LANGUAGE="${language(track.language)}",AUTOSELECT=NO,DEFAULT=NO,FORCED=NO,URI="sub_${track.id}.m3u8"`);
  lines.splice(1, 0, ...entries);
  // Atomic replacement keeps readers from seeing partially written manifests.
  const { rename } = await import('node:fs/promises');
  await writeFile(path.join(directory, 'master.m3u8.tmp'), `${lines.join('\n')}\n`);
  await rename(path.join(directory, 'master.m3u8.tmp'), path.join(directory, 'master.m3u8'));
  if (renditions?.length) {
    const shared = lines.filter(line => !line.startsWith('#EXT-X-STREAM-INF:') && !/^stream_\d+\.m3u8$/.test(line) && !line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
    for (const rendition of renditions) {
      const index = lines.findIndex(line => line === `stream_${rendition.streamIndex}.m3u8`);
      if (index < 1) throw new Error('Manifeste vidéo incomplet.');
      let info = lines[index - 1];
      info = info.replace(/,VIDEO-RANGE=[^,]+/, '');
      if (rendition.videoRange) info += `,VIDEO-RANGE=${rendition.videoRange}`;
      rendition.codecs = info.match(/CODECS="([^"]+)"/)?.[1] ?? '';
      const subs = [];
      for (const track of subtitles) {
        const name = `sub_${track.id}_${rendition.id}`;
        const raw = (await readFile(path.join(directory, track.filename), 'utf8')).replace(/^X-TIMESTAMP-MAP=.*\r?\n/gm, '');
        const mapped = raw.replace(/^WEBVTT[^\r\n]*/, `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${Math.round(rendition.timelineOffset * 90000)}`);
        await writeFile(path.join(directory, `${name}.vtt`), mapped);
        const playlist = (await readFile(path.join(directory, `sub_${track.id}.m3u8`), 'utf8')).replace(track.filename, `${name}.vtt`);
        await writeFile(path.join(directory, `${name}.m3u8`), playlist);
        subs.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${quote(track.label)}",LANGUAGE="${language(track.language)}",AUTOSELECT=NO,DEFAULT=NO,FORCED=NO,URI="${name}.m3u8"`);
      }
      await writeFile(path.join(directory, `${rendition.manifest}.tmp`), [...shared, ...subs, info, lines[index]].join('\n') + '\n');
      await rename(path.join(directory, `${rendition.manifest}.tmp`), path.join(directory, rendition.manifest));
    }
    // Both entry points reference the same video bytes.
    await writeFile(path.join(directory, 'master.m3u8.tmp'), await readFile(path.join(directory, renditions[0].manifest)));
    await rename(path.join(directory, 'master.m3u8.tmp'), path.join(directory, 'master.m3u8'));
  }
}

export async function addSubtitle(directory, input, { label, language: lang, index, duration }) {
  const id = randomUUID();
  const filename = `sub_${id}.vtt`;
  const args = ['-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input];
  if (index !== undefined) args.push('-map', `0:${index}`);
  args.push('-c:s', 'webvtt', path.join(directory, filename));
  await run(process.env.FFMPEG_PATH || 'ffmpeg', args);
  await writeFile(path.join(directory, `sub_${id}.m3u8`),
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(duration)}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${duration},\n${filename}\n#EXT-X-ENDLIST\n`);
  return { id, label: quote(label), language: language(lang), filename };
}

export async function prepareMovie(store, movie, audioIndices, subtitleIndices, options = {}) {
  const source = path.join(store.directory(movie.id), 'source');
  // Reprobe old uploads: compatibility must not depend on a previous application's filter.
  movie.probe = await probeFile(source);
  if (!movie.probe.compatible) throw new Error('Aucune vidéo exploitable ou durée invalide.');
  // Names shown to viewers come from the administrator; a bare language code lets the page translate it.
  const select = (tracks, indices, kind) => {
    if (!Array.isArray(indices) || indices.length > 24 || new Set(indices).size !== indices.length) throw new Error('Sélection invalide.');
    return indices.map((index, position) => {
      const track = tracks.find(item => item.index === index && item.compatible);
      if (!track) throw new Error('Piste incompatible.');
      const chosen = movie.trackNames?.[kind]?.[index];
      const fallback = track.language && track.language !== 'und' ? track.language
        : kind === 'audio' ? `Piste ${position + 1}` : `Sous-titres ${position + 1}`;
      return { ...track, label: quote(chosen || fallback) };
    });
  };
  const external = movie.externalTracks ?? [];
  const audio = [...select(movie.probe.audio, audioIndices, 'audio').map(track => ({ ...track, input: 0 })),
    ...external.filter(track => track.kind === 'audio').map((track, index) => ({ ...track, input: index + 1, copy: false }))];
  const embeddedSubs = select(movie.probe.subtitles, subtitleIndices, 'subtitles');
  if (movie.probe.audio.length && !audio.length) throw new Error('Choisir au moins une piste audio.');
  const video = movie.probe.video;
  const renditions = [{ id: 'original', manifest: 'master_original.m3u8', streamIndex: 0,
    codec: video.codec, width: video.width, height: video.height,
    videoRange: video.colorTransfer === 'smpte2084' ? 'PQ' : video.colorTransfer === 'arib-std-b67' ? 'HLG' : undefined }];
  const disk = await statfs(store.root);
  const estimated = (movie.originalBytes ?? (await stat(source)).size) + movie.probe.duration * audio.length * 256_000 / 8;
  if (disk.bavail * disk.bsize < estimated * 1.15 + 256 * 1024 ** 2) throw new Error('Espace disque insuffisant pour les versions préparées.');
  const generation = randomUUID();
  const directory = path.join(store.directory(movie.id), generation);
  await mkdir(directory, { recursive: true });
  const threads = Math.max(1, Math.min(8, Number(process.env.ENCODE_THREADS) || 2));
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-filter_threads', String(threads)];
  args.push('-threads', String(threads), '-protocol_whitelist', 'file,pipe', '-i', source);
  for (const track of audio.filter(track => track.input > 0)) args.push('-protocol_whitelist', 'file,pipe', '-i', path.join(store.directory(movie.id), track.filename));
  args.push('-map', `0:${video.index}`);
  for (const track of audio) args.push('-map', `${track.input}:${track.index}`);
  args.push('-c', 'copy');
  if (video.codec === 'hevc') args.push('-tag:v:0', 'hvc1');
  for (const [index, track] of audio.entries()) {
    if (!track.copy) {
      const filter = 'aresample=48000:ochl=stereo:rematrix_maxval=1' + (track.input > 0 ? `,apad,atrim=duration=${movie.probe.duration}` : '');
      args.push(`-filter:a:${index}`, filter, `-c:a:${index}`, 'aac', `-profile:a:${index}`, 'aac_low',
        `-ac:a:${index}`, '2', `-ar:a:${index}`, '48000', `-b:a:${index}`, '256k');
    }
  }
  args.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-hls_segment_filename', path.join(directory, 'segment_%v_%06d.m4s'),
    '-master_pl_name', 'base.m3u8', '-var_stream_map',
    [...renditions.map((track, index) => `v:${index}${audio.length ? ',agroup:audio' : ''}`), ...audio.map((track, index) => `a:${index},agroup:audio,language:${language(track.language)},default:${index === 0 ? 'yes' : 'no'}`)].join(' '),
    path.join(directory, 'stream_%v.m3u8'));
  try {
  await run(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd: directory, onProgress: seconds => options.onProgress?.({ stage: 'packaging', percent: Math.min(95, Math.round(seconds / movie.probe.duration * 95)) }) });
  if (video.colorTransfer === 'smpte2084') for (const file of await readdir(directory)) {
    if (/^init_\d+\.mp4$/.test(file)) await writeToneMapMetadata(path.join(directory, file));
    // Chromium ignores the container boxes for HEVC and reads the segments instead.
    else if (video.codec === 'hevc' && file.startsWith(`segment_${renditions[0].streamIndex}_`)) await rewriteToneMapSei(path.join(directory, file));
  }
  for (const rendition of renditions) {
    const playlist = path.join(directory, `stream_${rendition.streamIndex}.m3u8`);
    const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-i', playlist,
      '-select_streams', 'v:0', '-show_streams', '-show_frames', '-read_intervals', '%+#32', '-of', 'json'], { timeout: 120_000 }));
    const frame = probe.frames?.find(frame => Number.isFinite(Number(frame.best_effort_timestamp_time)));
    if (!frame) throw new Error('Version préparée illisible.');
    rendition.timelineOffset = Number(frame.best_effort_timestamp_time);
    rendition.width = probe.streams[0].width; rendition.height = probe.streams[0].height;
  }
  const subtitles = [];
  for (const track of embeddedSubs) {
    subtitles.push(await addSubtitle(directory, source, { ...track, duration: movie.probe.duration }));
  }
  for (const track of external.filter(track => track.kind === 'subtitle')) {
    subtitles.push(await addSubtitle(directory, path.join(store.directory(movie.id), track.filename), { ...track, duration: movie.probe.duration }));
  }
  options.onProgress?.({ stage: 'subtitles', percent: 96 });
  // Keep administrator-added subtitle files when rebuilding versions.
  for (const track of movie.subtitles ?? []) if (track.external && movie.generation) {
    await writeFile(path.join(directory, track.filename), await readFile(path.join(store.directory(movie.id), movie.generation, track.filename)));
    await writeFile(path.join(directory, `sub_${track.id}.m3u8`), await readFile(path.join(store.directory(movie.id), movie.generation, `sub_${track.id}.m3u8`)));
    subtitles.push(track);
  }
  const preparedAudio = audio.map(track => ({ ...track, sourceCodec: track.codec, codec: 'aac', channels: track.copy ? track.channels : 2,
    sampleRate: track.copy ? track.sampleRate : 48000, channelLayout: track.copy ? track.channelLayout : 'stereo', converted: !track.copy }));
  await writeMaster(directory, preparedAudio, subtitles, renditions);
  // Surface long GOPs: remuxing cannot create extra keyframes to shorten them.
  const playlist = await readFile(path.join(directory, 'stream_0.m3u8'), 'utf8');
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
  let bytes = 0;
  for (const file of await readdir(directory)) bytes += (await stat(path.join(directory, file))).size;
  return { generation, audio: preparedAudio, subtitles, renditions, duration: movie.probe.duration, preparedBytes: bytes,
    maxSegmentSeconds: Math.max(...durations) };
  } catch (error) {
    // A generation is never served before it is complete. Remove only this fresh UUID directory.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
