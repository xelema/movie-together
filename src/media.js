import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat, statfs, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import jschardet from 'jschardet';

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

// Text subtitle codecs ffmpeg can decode to WebVTT. Image codecs (dvd_subtitle, hdmv_pgs_subtitle,
// dvb_subtitle, xsub) and decoder-less formats (aqtitle, mpsub, scc, ttml) stay out.
const SUBTITLE_CODECS = ['subrip', 'webvtt', 'mov_text', 'ass', 'ssa', 'sami', 'microdvd', 'mpl2',
  'jacosub', 'pjs', 'realtext', 'stl', 'subviewer', 'subviewer1', 'vplayer', 'eia_608'];
// Accepted upload extensions, each mapped to the demuxers worth forcing with -f.
// .sub covers both MicroDVD and SubViewer; the conversion check decides.
export const SUBTITLE_EXTENSIONS = { srt: ['srt'], vtt: ['webvtt'], smi: ['sami'], sami: ['sami'],
  ass: ['ass'], ssa: ['ass'], sub: ['microdvd', 'subviewer'], sbv: ['subviewer', 'subviewer1'], lrc: ['lrc'] };
// For external tracks recorded before they stored their demuxer name.
const SUBTITLE_DEMUXERS = { subrip: 'srt', webvtt: 'webvtt', ass: 'ass', ssa: 'ass', sami: 'sami',
  microdvd: 'microdvd', mpl2: 'mpl2', jacosub: 'jacosub', pjs: 'pjs', realtext: 'realtext', stl: 'stl',
  subviewer: 'subviewer', subviewer1: 'subviewer1', vplayer: 'vplayer' };

// Uploaded subtitle files come in any legacy charset: normalize to UTF-8 once, at ingest.
export function decodeSubtitleText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return new TextDecoder('utf-8').decode(buffer.subarray(3));
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const detected = jschardet.detect(buffer)?.encoding?.toLowerCase();
  const singleByte = !detected || /^(windows-125|iso-8859|ascii|tis-620|koi8|x-mac)/.test(detected);
  // A single-byte guess can silently mangle real EUC-KR text, while its strict decoder only accepts the genuine thing.
  const labels = [...new Set(singleByte ? ['utf-8', 'euc-kr', detected, 'windows-1252'] : [detected, 'utf-8', 'euc-kr', 'windows-1252'])];
  for (const label of labels) {
    try { return new TextDecoder(label, { fatal: true }).decode(buffer); } catch { }
  }
  return new TextDecoder('windows-1252').decode(buffer);
}

// Probing alone cannot name these formats (microdvd and lrc have no read_probe): validate by
// converting and checking the output holds at least one cue. `null` format lets ffmpeg detect.
export async function subtitleFileFormat(input, formats = []) {
  for (const format of [...formats, null]) {
    const args = ['-v', 'error', '-protocol_whitelist', 'file,pipe'];
    if (format) args.push('-f', format);
    args.push('-i', input, '-map', '0:s:0', '-c:s', 'webvtt', '-f', 'webvtt', '-');
    try { if (/-->/m.test(await run(process.env.FFMPEG_PATH || 'ffmpeg', args))) return { format }; }
    catch { }
  }
  return null;
}

export function inspectProbe(probe) {
  const streams = probe.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  // HEVC carries mastering and light level as SEI: they only show up on a decoded frame.
  const sideData = [...(video?.side_data_list ?? []),
    ...(probe.frames?.find(frame => frame.media_type === 'video')?.side_data_list ?? [])];
  const dovi = sideData.find(data => data.side_data_type === 'DOVI configuration record');
  const mastering = sideData.find(data => data.side_data_type === 'Mastering display metadata');
  const light = sideData.find(data => data.side_data_type === 'Content light level metadata');
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
    label: stream.tags?.title ?? stream.tags?.language ?? `Subtitles ${stream.index}`,
    compatible: SUBTITLE_CODECS.includes(stream.codec_name),
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
    peakNits: Number(light?.max_content) || (() => { const [n, d = 1] = String(mastering?.max_luminance ?? '').split('/').map(Number); return n / d || undefined; })(),
    hdr, dolbyVision: dovi ? { profile: dovi.dv_profile, level: dovi.dv_level,
      compatibilityId: dovi.dv_bl_signal_compatibility_id } : null,
  } : null,
    videoCompatible, audio, subtitles, duration,
    bitrate: Number(probe.format?.bit_rate) || null,
    compatible: videoCompatible && Number.isFinite(duration) && duration > 0 };
}

export async function probeFile(file) {
  const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format',
    '-show_frames', '-read_intervals', '%+#1', '-of', 'json', file,
  ], { timeout: 120_000 }));
  return inspectProbe(probe);
}

function quote(value) { return String(value).replace(/["\r\n\\]/g, '').slice(0, 100); }
function language(value) { return /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(value) ? value : 'und'; }

// Only the container colour box changes. Rewriting the bitstream is not an option: any FFmpeg
// bitstream filter that touches the packets corrupts some real HEVC files. See docs/playback.md.
export function transportMetadata(video) {
  const doviBase = { 1: 'smpte2084', 2: 'bt709', 4: 'arib-std-b67' }[video.dolbyVision?.compatibilityId];
  const args = video.codec === 'hevc' ? ['-tag:v:0', 'hvc1'] : [];
  // Dolby Vision without a standard base layer is not decodable as HDR10, HLG or SDR: leave it native.
  if (video.dolbyVision && !doviBase) return { args, color: undefined,
    videoRange: video.colorTransfer === 'smpte2084' ? 'PQ' : video.colorTransfer === 'arib-std-b67' ? 'HLG' : undefined };
  args.push('-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709');
  return { args, videoRange: 'SDR', color: { version: 1, transfer: video.colorTransfer || doviBase || 'bt709',
    primaries: video.colorPrimaries || 'bt709', matrix: video.colorSpace || (video.height < 720 ? 'smpte170m' : 'bt709'),
    fullRange: video.colorRange === 'pc', bitDepth: Number(video.pixelFormat?.match(/(10|12)(?:le|be)?$/)?.[1]) || 8,
    peakNits: video.peakNits || 1000 } };
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

export async function addSubtitle(directory, input, { label, language: lang, index, duration, format }) {
  const id = randomUUID();
  const filename = `sub_${id}.vtt`;
  const args = ['-y', '-v', 'error', '-protocol_whitelist', 'file,pipe'];
  if (format) args.push('-f', format);
  args.push('-i', input);
  if (index !== undefined) args.push('-map', `0:${index}`);
  args.push('-c:s', 'webvtt', path.join(directory, filename));
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', args);
    // A forced demuxer accepts anything, so check a cue actually came out.
    if (format && !/-->/m.test(await readFile(path.join(directory, filename), 'utf8'))) throw new Error('Ce fichier ne contient aucune piste utilisable.');
  } catch (error) {
    await unlink(path.join(directory, filename)).catch(() => {});
    throw error;
  }
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
        : kind === 'audio' ? `Track ${position + 1}` : `Subtitles ${position + 1}`;
      return { ...track, label: quote(chosen || fallback) };
    });
  };
  const external = movie.externalTracks ?? [];
  const audio = select(movie.probe.audio, audioIndices, 'audio');
  const embeddedSubs = select(movie.probe.subtitles, subtitleIndices, 'subtitles');
  if (movie.probe.audio.length && !audio.length) throw new Error('Choisir au moins une piste audio.');
  const video = movie.probe.video;
  const transport = transportMetadata(video);
  const renditions = [{ id: 'original', manifest: 'master_original.m3u8', streamIndex: 0,
    codec: video.codec, width: video.width, height: video.height,
    videoRange: transport.videoRange, color: transport.color }];
  const disk = await statfs(store.root);
  const estimated = (movie.originalBytes ?? (await stat(source)).size) + movie.probe.duration * audio.length * 256_000 / 8;
  if (disk.bavail * disk.bsize < estimated * 1.15 + 256 * 1024 ** 2) throw new Error('Espace disque insuffisant pour les versions préparées.');
  const generation = randomUUID();
  const directory = path.join(store.directory(movie.id), generation);
  await mkdir(directory, { recursive: true });
  const threads = Math.max(1, Math.min(8, Number(process.env.ENCODE_THREADS) || 2));
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-filter_threads', String(threads)];
  args.push('-threads', String(threads), '-protocol_whitelist', 'file,pipe', '-i', source);
  args.push('-map', `0:${video.index}`);
  for (const track of audio) args.push('-map', `0:${track.index}`);
  args.push('-c', 'copy', ...transport.args);
  for (const [index, track] of audio.entries()) {
    if (!track.copy) {
      args.push(`-filter:a:${index}`, 'aresample=48000:ochl=stereo:rematrix_maxval=1', `-c:a:${index}`, 'aac', `-profile:a:${index}`, 'aac_low',
        `-ac:a:${index}`, '2', `-ar:a:${index}`, '48000', `-b:a:${index}`, '256k');
    }
  }
  args.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    // FFmpeg only expands %v when the stream map holds more than one variant.
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', audio.length ? 'init_%v.mp4' : 'init_0.mp4',
    '-hls_segment_filename', path.join(directory, 'segment_%v_%06d.m4s'),
    '-master_pl_name', 'base.m3u8', '-var_stream_map',
    [...renditions.map((track, index) => `v:${index}${audio.length ? ',agroup:audio' : ''}`), ...audio.map((track, index) => `a:${index},agroup:audio,language:${language(track.language)},default:${index === 0 ? 'yes' : 'no'}`)].join(' '),
    path.join(directory, 'stream_%v.m3u8'));
  try {
  await run(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd: directory, onProgress: seconds => options.onProgress?.({ stage: 'packaging', percent: Math.min(95, Math.round(seconds / movie.probe.duration * 95)) }) });
  for (const rendition of renditions) {
    const playlist = path.join(directory, `stream_${rendition.streamIndex}.m3u8`);
    const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-i', playlist,
      '-select_streams', 'v:0', '-show_streams', '-show_frames', '-read_intervals', '%+#32', '-of', 'json'], { timeout: 120_000 }));
    const frame = probe.frames?.find(frame => Number.isFinite(Number(frame.best_effort_timestamp_time)));
    if (!frame) throw new Error('Version préparée illisible.');
    // A muxer accepts streams no decoder can read. Decode the opening seconds before serving them.
    const { stderr } = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', playlist,
      '-map', '0:v:0', '-t', '2', '-f', 'null', '-'], { includeStderr: true, timeout: 300_000 });
    if (stderr.trim()) throw new Error('Version préparée illisible.');
    rendition.timelineOffset = Number(frame.best_effort_timestamp_time);
    rendition.width = probe.streams[0].width; rendition.height = probe.streams[0].height;
  }
  const subtitles = [];
  for (const track of embeddedSubs) {
    subtitles.push(await addSubtitle(directory, source, { ...track, duration: movie.probe.duration }));
  }
  const consumedExternal = external.filter(track => track.kind === 'subtitle');
  for (const track of consumedExternal) {
    subtitles.push({ ...await addSubtitle(directory, path.join(store.directory(movie.id), track.filename),
      { ...track, format: track.format ?? SUBTITLE_DEMUXERS[track.codec], duration: movie.probe.duration }), external: true });
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
  // Consumed external files become flagged prepared subtitles; the source files are no longer needed.
  for (const track of consumedExternal) await unlink(path.join(store.directory(movie.id), track.filename)).catch(() => {});
  return { generation, audio: preparedAudio, subtitles, renditions, duration: movie.probe.duration, preparedBytes: bytes,
    externalTracks: external.filter(track => track.kind !== 'subtitle'),
    maxSegmentSeconds: Math.max(...durations) };
  } catch (error) {
    // A generation is never served before it is complete. Remove only this fresh UUID directory.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
