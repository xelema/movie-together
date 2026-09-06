import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat, statfs, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function run(binary, args, { timeout = 48 * 3600_000, cwd, onProgress } = {}) {
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
      if (code === 0) resolve(stdout);
      else reject(new Error(expired ? 'Traitement trop long.' : `${binary} : ${stderr.slice(-3000)}`));
    });
  });
}

export function inspectProbe(probe) {
  const streams = probe.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const dovi = video?.side_data_list?.find(item => item.side_data_type === 'DOVI configuration record');
  const hdr = ['smpte2084', 'arib-std-b67'].includes(video?.color_transfer) || !!dovi;
  const baseline = !hdr && video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' &&
    ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video.profile) &&
    video.level <= 42 && video.width <= 1920 && video.height <= 1080;
  const audio = streams.filter(stream => stream.codec_type === 'audio').map(stream => ({
    index: stream.index, codec: stream.codec_name, channels: stream.channels,
    language: stream.tags?.language ?? 'und', label: stream.tags?.title ?? stream.tags?.language ?? `Audio ${stream.index}`,
    compatible: !!stream.codec_name && stream.codec_name !== 'unknown',
    copy: stream.codec_name === 'aac' && stream.profile === 'LC' && stream.channels <= 2 &&
      [44100, 48000].includes(Number(stream.sample_rate)),
  }));
  const subtitles = streams.filter(stream => stream.codec_type === 'subtitle').map(stream => ({
    index: stream.index, codec: stream.codec_name, language: stream.tags?.language ?? 'und',
    label: stream.tags?.title ?? stream.tags?.language ?? `Sous-titres ${stream.index}`,
    compatible: ['subrip', 'webvtt', 'mov_text', 'ass', 'ssa'].includes(stream.codec_name),
  }));
  const duration = Number(probe.format?.duration);
  const videoCompatible = !!video?.codec_name && video.codec_name !== 'unknown' && video.width > 0 && video.height > 0;
  const [num, den = 1] = (video?.avg_frame_rate || video?.r_frame_rate || '24/1').split('/').map(Number);
  return { schema: 2, video: video ? { codec: video.codec_name, pixelFormat: video.pix_fmt,
    index: video.index, width: video.width, height: video.height, profile: video.profile, level: video.level,
    hdr, transfer: video.color_transfer, primaries: video.color_primaries, colorSpace: video.color_space,
    frameRate: num / den || 24, dolbyVision: dovi ?? null,
    direct: ['h264', 'hevc', 'av1', 'vp9'].includes(video.codec_name), baseline: !!baseline } : null,
    videoCompatible, audio, subtitles, duration,
    bitrate: Number(probe.format?.bit_rate) || null,
    compatible: videoCompatible && Number.isFinite(duration) && duration > 0 };
}

export async function probeFile(file) {
  return inspectProbe(JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file,
  ], { timeout: 120_000 })));
}

function quote(value) { return String(value).replace(/["\r\n\\]/g, '').slice(0, 100); }
function language(value) { return /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(value) ? value : 'und'; }

export async function writeMaster(directory, audio, subtitles, renditions) {
  const base = await readFile(path.join(directory, 'base.m3u8'), 'utf8');
  let audioIndex = 0;
  const lines = base.trim().split(/\r?\n/).map(line => {
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const track = audio[audioIndex++];
      return line.replace(/NAME="[^"]*"/, `NAME="${quote(track.label)}"`);
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
      info = info.replace(/,VIDEO-RANGE=[^,]+/, '') + `,VIDEO-RANGE=${rendition.videoRange}`;
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
    // The default URL always exposes the safest fully prepared version, never ABR across HDR/SDR.
    const fallback = renditions.find(item => item.id === 'compatible') ?? renditions[0];
    await writeFile(path.join(directory, 'master.m3u8.tmp'), await readFile(path.join(directory, fallback.manifest)));
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

export function compatibleFilter(video) {
  const scale = "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const dovi = video.dolbyVision;
  const base = dovi?.dv_bl_signal_compatibility_id;
  if (dovi && ![1, 2, 4].includes(base)) {
    // Dolby Vision without an HDR10/HLG/SDR base requires RPU-aware reshaping.
    return { vulkan: true, filter: `format=yuv420p10le,hwupload,libplacebo=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:apply_dolbyvision=1:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p,hwdownload,format=yuv420p,setsar=1` };
  }
  if (video.hdr && base !== 2) {
    const transfer = base === 1 ? 'smpte2084' : base === 4 ? 'arib-std-b67' : video.transfer;
    const input = `zscale=pin=${video.primaries === 'bt2020' || dovi ? 'bt2020' : 'bt2020'}:tin=${transfer}:min=bt2020nc:t=linear:npl=100`;
    return { vulkan: false, filter: `${input},format=gbrpf32le,${scale},tonemap=mobius:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,setsar=1` };
  }
  return { vulkan: false, filter: `${scale},format=yuv420p,setsar=1` };
}

export async function prepareMovie(store, movie, audioIndices, subtitleIndices, options = {}) {
  const source = path.join(store.directory(movie.id), 'source');
  // Reprobe old uploads: compatibility must not depend on a previous application's filter.
  movie.probe = await probeFile(source);
  if (!movie.probe.compatible) throw new Error('Aucune vidéo exploitable ou durée invalide.');
  const select = (tracks, indices) => {
    if (!Array.isArray(indices) || indices.length > 24 || new Set(indices).size !== indices.length) throw new Error('Sélection invalide.');
    return indices.map(index => {
      const track = tracks.find(item => item.index === index && item.compatible);
      if (!track) throw new Error('Piste incompatible.');
      return track;
    });
  };
  const audio = select(movie.probe.audio, audioIndices);
  const embeddedSubs = select(movie.probe.subtitles, subtitleIndices);
  if (movie.probe.audio.length && !audio.length) throw new Error('Choisir au moins une piste audio.');
  const video = movie.probe.video;
  const compatible = !video.direct || (!video.baseline && options.compatible !== false);
  const renditions = [];
  if (video.direct) renditions.push({ id: 'original', manifest: 'master_original.m3u8', streamIndex: 0,
    codec: video.codec, width: video.width, height: video.height, hdr: video.hdr,
    videoRange: video.transfer === 'arib-std-b67' ? 'HLG' : video.hdr ? 'PQ' : 'SDR', compatible: video.baseline });
  if (compatible) renditions.push({ id: 'compatible', manifest: 'master_compatible.m3u8', streamIndex: renditions.length,
    codec: 'h264', hdr: false, videoRange: 'SDR', compatible: true });
  const disk = await statfs(store.root);
  const estimated = (video.direct ? (movie.originalBytes ?? (await stat(source)).size) : 0) +
    (compatible ? movie.probe.duration * 8_000_000 / 8 : 0) + movie.probe.duration * audio.length * 192_000 / 8;
  if (disk.bavail * disk.bsize < estimated * 1.15 + 256 * 1024 ** 2) throw new Error('Espace disque insuffisant pour les versions préparées.');
  const generation = randomUUID();
  const directory = path.join(store.directory(movie.id), generation);
  await mkdir(directory, { recursive: true });
  const filtered = compatible ? compatibleFilter(video) : null;
  const threads = Math.max(1, Math.min(8, Number(process.env.ENCODE_THREADS) || 2));
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-filter_threads', String(threads)];
  if (filtered?.vulkan) args.push('-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk');
  args.push('-threads', String(threads), '-protocol_whitelist', 'file,pipe', '-i', source);
  for (const rendition of renditions) args.push('-map', `0:${video.index}`);
  for (const track of audio) args.push('-map', `0:${track.index}`);
  args.push('-c', 'copy');
  if (video.direct && video.codec === 'hevc') args.push('-tag:v:0', 'hvc1');
  if (compatible) {
    const index = renditions.find(item => item.id === 'compatible').streamIndex;
    const fps = Math.min(60, video.frameRate);
    args.push(`-c:v:${index}`, 'libx264', `-threads:v:${index}`, String(threads), `-filter:v:${index}`, filtered.filter,
      `-preset:v:${index}`, 'fast', `-crf:v:${index}`, '20', `-maxrate:v:${index}`, '8M', `-bufsize:v:${index}`, '16M',
      `-pix_fmt:v:${index}`, 'yuv420p', `-profile:v:${index}`, 'high', `-level:v:${index}`, '4.2',
      `-r:v:${index}`, String(fps), `-g:v:${index}`, String(Math.ceil(fps * 4)),
      `-force_key_frames:v:${index}`, 'expr:gte(t,n_forced*4)',
      `-color_primaries:v:${index}`, 'bt709', `-color_trc:v:${index}`, 'bt709', `-colorspace:v:${index}`, 'bt709');
  }
  for (const [index, track] of audio.entries()) {
    if (!track.copy) args.push(`-c:a:${index}`, 'aac', `-ac:a:${index}`, '2', `-ar:a:${index}`, '48000', `-b:a:${index}`, '192k');
  }
  args.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-hls_segment_filename', path.join(directory, 'segment_%v_%06d.m4s'),
    '-master_pl_name', 'base.m3u8', '-var_stream_map',
    [...renditions.map((track, index) => `v:${index}${audio.length ? ',agroup:audio' : ''}`), ...audio.map((track, index) => `a:${index},agroup:audio,language:${language(track.language)},default:${index === 0 ? 'yes' : 'no'}`)].join(' '),
    path.join(directory, 'stream_%v.m3u8'));
  try {
  await run(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd: directory, onProgress: seconds => options.onProgress?.({ stage: 'video', percent: Math.min(95, Math.round(seconds / movie.probe.duration * 95)) }) });
  for (const rendition of renditions) {
    const playlist = path.join(directory, `stream_${rendition.streamIndex}.m3u8`);
    const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-i', playlist,
      '-select_streams', 'v:0', '-show_streams', '-show_frames', '-read_intervals', '%+#32', '-of', 'json'], { timeout: 120_000 }));
    const frame = probe.frames?.find(frame => Number.isFinite(Number(frame.best_effort_timestamp_time)));
    if (!frame) throw new Error('Version préparée illisible.');
    rendition.timelineOffset = Number(frame.best_effort_timestamp_time);
    rendition.width = probe.streams[0].width; rendition.height = probe.streams[0].height;
    if (rendition.id === 'compatible' && (probe.streams[0].codec_name !== 'h264' || probe.streams[0].pix_fmt !== 'yuv420p')) throw new Error('Version compatible invalide.');
  }
  const subtitles = [];
  for (const track of embeddedSubs) {
    subtitles.push(await addSubtitle(directory, source, { ...track, duration: movie.probe.duration }));
  }
  options.onProgress?.({ stage: 'subtitles', percent: 96 });
  // Keep administrator-added subtitle files when rebuilding versions.
  for (const track of movie.subtitles ?? []) if (track.external && movie.generation) {
    await writeFile(path.join(directory, track.filename), await readFile(path.join(store.directory(movie.id), movie.generation, track.filename)));
    await writeFile(path.join(directory, `sub_${track.id}.m3u8`), await readFile(path.join(store.directory(movie.id), movie.generation, `sub_${track.id}.m3u8`)));
    subtitles.push(track);
  }
  const preparedAudio = audio.map(track => ({ ...track, sourceCodec: track.codec, codec: 'aac', channels: track.copy ? track.channels : 2, converted: !track.copy }));
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
    if (filtered?.vulkan) error.message = `Conversion Dolby Vision : FFmpeg avec libplacebo et Vulkan requis. ${error.message}`;
    throw error;
  }
}
