import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function run(binary, args, { timeout = 4 * 3600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4_000_000); });
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
  // Conservative baseline across desktop browsers and mobile hardware.
  const videoCompatible = video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p' &&
    ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video.profile) &&
    video.level <= 42 && video.width <= 1920 && video.height <= 1080;
  const audio = streams.filter(stream => stream.codec_type === 'audio').map(stream => ({
    index: stream.index, codec: stream.codec_name, channels: stream.channels,
    language: stream.tags?.language ?? 'und', label: stream.tags?.title ?? stream.tags?.language ?? `Audio ${stream.index}`,
    compatible: stream.codec_name === 'aac' && stream.profile === 'LC' && stream.channels <= 2 &&
      [44100, 48000].includes(Number(stream.sample_rate)),
  }));
  const subtitles = streams.filter(stream => stream.codec_type === 'subtitle').map(stream => ({
    index: stream.index, codec: stream.codec_name, language: stream.tags?.language ?? 'und',
    label: stream.tags?.title ?? stream.tags?.language ?? `Sous-titres ${stream.index}`,
    compatible: ['subrip', 'webvtt', 'mov_text', 'ass', 'ssa'].includes(stream.codec_name),
  }));
  const duration = Number(probe.format?.duration);
  return { video: video ? { codec: video.codec_name, pixelFormat: video.pix_fmt,
    index: video.index, width: video.width, height: video.height, profile: video.profile, level: video.level } : null,
    videoCompatible: !!videoCompatible, audio, subtitles, duration,
    bitrate: Number(probe.format?.bit_rate) || null,
    compatible: !!videoCompatible && audio.some(track => track.compatible) && Number.isFinite(duration) && duration > 0 };
}

export async function probeFile(file) {
  return inspectProbe(JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file,
  ], { timeout: 120_000 })));
}

function quote(value) { return String(value).replace(/["\r\n\\]/g, '').slice(0, 100); }
function language(value) { return /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(value) ? value : 'und'; }

export async function writeMaster(directory, audio, subtitles) {
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

export async function prepareMovie(store, movie, audioIndices, subtitleIndices) {
  if (!movie.probe?.compatible) throw new Error('Vidéo incompatible : H.264 8 bits, maximum 1080p / niveau 4.2, audio AAC-LC stéréo requis. Aucun réencodage.');
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
  if (!audio.length) throw new Error('Choisir au moins une piste AAC compatible.');
  const generation = randomUUID();
  const directory = path.join(store.directory(movie.id), generation);
  await mkdir(directory, { recursive: true });
  const source = path.join(store.directory(movie.id), 'source');
  const args = ['-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', `0:${movie.probe.video.index}`];
  for (const track of audio) args.push('-map', `0:${track.index}`);
  args.push('-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-hls_segment_filename', path.join(directory, 'segment_%v_%06d.m4s'),
    '-master_pl_name', 'base.m3u8', '-var_stream_map',
    [`v:0,agroup:audio`, ...audio.map((track, index) => `a:${index},agroup:audio,language:${language(track.language)},default:${index === 0 ? 'yes' : 'no'}`)].join(' '),
    path.join(directory, 'stream_%v.m3u8'));
  await run(process.env.FFMPEG_PATH || 'ffmpeg', args);
  const subtitles = [];
  for (const track of embeddedSubs) {
    subtitles.push(await addSubtitle(directory, source, { ...track, duration: movie.probe.duration }));
  }
  await writeMaster(directory, audio, subtitles);
  // Surface long GOPs: remuxing cannot create extra keyframes to shorten them.
  const playlist = await readFile(path.join(directory, 'stream_0.m3u8'), 'utf8');
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
  let bytes = 0;
  for (const file of await readdir(directory)) bytes += (await stat(path.join(directory, file))).size;
  return { generation, audio, subtitles, duration: movie.probe.duration, preparedBytes: bytes,
    maxSegmentSeconds: Math.max(...durations) };
}
