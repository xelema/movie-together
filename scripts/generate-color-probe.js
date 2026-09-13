// Builds the colour-probe fixtures embedded in public/color-probe-data.js.
// Each clip goes through the production transport: the bitstream keeps its own
// VUI while the container colr box claims BT.709/sRGB, like prepareMovie does.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../src/media.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

// Eight patches: four neutral greys, four saturated colours.
// Values are 8-bit limited-range YCbCr; the 10-bit clip scales them by 4.
// Sizes match a real film stream so the device picks the same decoder path.
const WIDTH = 1920, HEIGHT = 752, PW = 480, PH = 94;
const patches = [
  { x: 0, y: 0, yuv: [64, 128, 128] }, { x: 480, y: 0, yuv: [128, 128, 128] },
  { x: 960, y: 0, yuv: [192, 128, 128] }, { x: 1440, y: 0, yuv: [235, 128, 128] },
  { x: 0, y: 94, yuv: [96, 96, 210] }, { x: 480, y: 94, yuv: [150, 54, 54] },
  { x: 960, y: 94, yuv: [70, 210, 110] }, { x: 1440, y: 94, yuv: [105, 200, 200] },
];

function pattern(depth) {
  const scale = depth === 10 ? 4 : 1;
  const raw = Buffer.alloc(WIDTH * HEIGHT * 3 / 2 * (depth === 10 ? 2 : 1));
  const put = (index, value) => depth === 10 ? raw.writeUInt16LE(value, index * 2) : raw.writeUInt8(value, index);
  for (const patch of patches) {
    const [y, cb, cr] = patch.yuv.map(v => v * scale);
    for (let row = patch.y; row < patch.y + PH; row++) for (let col = patch.x; col < patch.x + PW; col++)
      put(row * WIDTH + col, y);
    for (let row = patch.y / 2; row < (patch.y + PH) / 2; row++) for (let col = patch.x / 2; col < (patch.x + PW) / 2; col++) {
      put(WIDTH * HEIGHT + row * WIDTH / 2 + col, cb);
      put(WIDTH * HEIGHT * 5 / 4 + row * WIDTH / 2 + col, cr);
    }
  }
  return raw;
}

// RFC 6381 codec string from the fMP4 sample description.
function codecString(buffer, codec) {
  if (codec === 'h264') {
    const at = buffer.indexOf('avcC') + 5; // version, profile, compat, level
    const [profile, compat, level] = buffer.subarray(at, at + 3);
    return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
  }
  const b = buffer.subarray(buffer.indexOf('hvcC') + 4); // version, profile byte, compat(4), constraint(6), level
  const space = ['', 'A', 'B', 'C'][b[1] >> 6], idc = b[1] & 0x1f, tier = b[1] & 0x20 ? 'H' : 'L';
  const compat = [...b.subarray(2, 6)].map(v => v.toString(16).padStart(2, '0')).join('').replace(/0+$/, '') || '0';
  return `hvc1.${space}${idc}.${compat}.${tier}${b[12]}`;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'color-probe-'));
try {
  const clips = [];
  for (const def of [
    { name: 'A-h264-vui-absente', codec: 'libx264', depth: 8, params: [] },
    { name: 'B-h264-vui-709', codec: 'libx264', depth: 8, params: ['colormatrix=bt709', 'colorprim=bt709', 'transfer=bt709'] },
    { name: 'C-hevc-vui-2020pq', codec: 'libx265', depth: 10, params: ['colormatrix=bt2020nc', 'colorprim=bt2020', 'transfer=smpte2084', 'log-level=0'] },
  ]) {
    const input = path.join(root, `${def.name}.yuv`);
    await writeFile(input, pattern(def.depth));
    const mkv = path.join(root, `${def.name}.mkv`);
    const paramArgs = def.params.length ? [`-x${def.codec === 'libx265' ? '265' : '264'}-params`, def.params.join(':')] : [];
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pixel_format', def.depth === 10 ? 'yuv420p10le' : 'yuv420p',
      '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', '24', '-i', input, '-frames:v', '48',
      '-c:v', def.codec, '-profile:v', def.codec === 'libx265' ? 'main10' : 'high', '-preset', 'medium',
      '-threads', '2', ...paramArgs, '-f', 'matroska', mkv]);
    const fmp4 = path.join(root, `${def.name}.mp4`);
    // Same flags as transportMetadata: copy packets, only the container declares BT.709/sRGB.
    await run(ffmpeg, ['-y', '-v', 'error', '-i', mkv, '-c', 'copy',
      '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', fmp4]);
    const bytes = await readFile(fmp4);
    // The colr atom must carry nclx 1/13/1 (BT.709 primaries, sRGB transfer, BT.709 matrix).
    const at = bytes.indexOf('nclx');
    if (at < 0 || bytes.readUInt16BE(at + 4) !== 1 || bytes.readUInt16BE(at + 6) !== 13 || bytes.readUInt16BE(at + 8) !== 1)
      throw new Error(`${def.name}: boîte colr absente ou incorrecte`);
    clips.push({ name: def.name, width: WIDTH, height: HEIGHT, pw: PW, ph: PH, bitDepth: def.depth,
      mime: `video/mp4; codecs="${codecString(bytes, def.codec === 'libx265' ? 'hevc' : 'h264')}"`,
      // Fallbacks in case the parsed string does not match isTypeSupported exactly.
      fallbacks: def.codec === 'libx265' ? ['video/mp4; codecs="hvc1"', 'video/mp4; codecs="hev1"'] : [`video/mp4; codecs="avc1.42E028"`],
      patches, base64: bytes.toString('base64') });
    console.log(def.name, '|', clips.at(-1).mime, '|', Math.round(bytes.length / 1024), 'KB | colr ok');
  }
  const out = `// Generated by scripts/generate-color-probe.js. Do not edit.\nexport const clips = ${JSON.stringify(clips)};\n`;
  await writeFile(new URL('../public/color-probe-data.js', import.meta.url), out);
  console.log('wrote public/color-probe-data.js');
} finally {
  await rm(root, { recursive: true, force: true });
}
