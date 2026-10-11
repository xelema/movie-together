// PGS (Blu-ray bitmap subtitles) to text, inside the preparation pipeline.
//
// The stream is a sequence of display sets: each one replaces the screen, either
// with a bitmap or with nothing. We decode the bitmap ourselves (see decodeRun
// below), recognise it with PP-OCRv6 tiny through onnxruntime-node, and turn the
// sequence into cues: a display set carrying text opens a cue that runs until the
// next display set, and a repeated image extends the cue it belongs to.
//
// Timings come from the stream itself, so the produced cues are frame-accurate.

import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';

const DET_MODEL = fileURLToPath(new URL('./models/pgs-ocr-det.onnx', import.meta.url));
const REC_MODEL = fileURLToPath(new URL('./models/pgs-ocr-rec.onnx', import.meta.url));
const CHARSET = fileURLToPath(new URL('./models/pgs-ocr-charset.json', import.meta.url));

const SEGMENT_PALETTE = 0x14, SEGMENT_OBJECT = 0x15, SEGMENT_PRESENTATION = 0x16, SEGMENT_END = 0x80;
const TRANSPARENT = 0;      // palette entry 0 is transparent, whatever the stream stored
const UNTOUCHED = 255;      // marker for canvas the display set never painted

// Run-length bitmap: a bare byte paints one pixel of that palette index; 0x00 opens a
// run whose length is the low six bits of the next byte (0x40 extends it by one byte)
// and whose colour is the following byte when 0x80 is set, transparent otherwise. A
// zero-length run ends the line.
export function decodeRun(data, width, height) {
  const pixels = new Uint8Array(width * height).fill(TRANSPARENT);
  const limit = width * height;
  let at = 0, index = 0, line = 0;
  while (index < data.length && line < height) {
    let color = data[index++], run = 1;
    if (color === 0) {
      const flags = data[index++];
      run = flags & 0x3f;
      if (flags & 0x40) run = (run << 8) + data[index++];
      color = (flags & 0x80) ? data[index++] : TRANSPARENT;
    }
    if (run > 0 && at + run <= limit) { pixels.fill(color, at, at + run); at += run; }
    else if (!run) line++;
  }
  return pixels;
}

// YCbCr to RGB, the same limited-range conversion libavcodec applies to palettes.
function toRgb(y, cr, cb) {
  const clamp = value => value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  const scaled = (value, coefficient) => coefficient * (value - 128);
  return [clamp(y + 1.402 * scaled(cr, 1)), clamp(y - scaled(cb, 0.344136) - scaled(cr, 0.714136)),
    clamp(y + 1.772 * scaled(cb, 1))];
}

// Segments carry presentation, window, palette and object definitions; a display set
// ends with an END segment, which is where we snapshot what the screen shows.
export function parseDisplaySets(buffer) {
  const palettes = new Map(), objects = new Map(), windows = new Map();
  const sets = [];
  let pending = null, presentation = null;
  let at = 0;
  while (at + 13 <= buffer.length) {
    if (buffer[at] !== 0x50 || buffer[at + 1] !== 0x47) { at++; continue; }
    const pts = buffer.readUInt32BE(at + 2);
    const type = buffer[at + 10], size = buffer.readUInt16BE(at + 11);
    const start = at + 13, end = start + size;
    if (end > buffer.length) break;
    if (type === SEGMENT_PRESENTATION) {
      const count = buffer[start + 10], items = [];
      let cursor = start + 11;
      for (let n = 0; n < count; n++) {
        const objectId = buffer.readUInt16BE(cursor), windowId = buffer[cursor + 2], cropped = buffer[cursor + 3];
        let x = buffer.readUInt16BE(cursor + 4), y = buffer.readUInt16BE(cursor + 6), crop = null;
        cursor += 8;
        if (cropped) {
          crop = { x: buffer.readUInt16BE(cursor), y: buffer.readUInt16BE(cursor + 2),
            width: buffer.readUInt16BE(cursor + 4), height: buffer.readUInt16BE(cursor + 6) };
          cursor += 8;
        }
        items.push({ objectId, windowId, crop, x, y });
      }
      presentation = { pts, paletteId: buffer[start + 9], items };
    } else if (type === 0x17) {
      const count = buffer[start];
      let cursor = start + 1;
      for (let n = 0; n < count; n++) {
        windows.set(buffer[cursor], { x: buffer.readUInt16BE(cursor + 1), y: buffer.readUInt16BE(cursor + 3),
          width: buffer.readUInt16BE(cursor + 5), height: buffer.readUInt16BE(cursor + 7) });
        cursor += 9;
      }
    } else if (type === SEGMENT_PALETTE) {
      const id = buffer[start], table = palettes.get(id) ?? new Uint8Array(256 * 4);
      for (let n = 0; n < (size - 2) / 5; n++) {
        const entry = start + 2 + n * 5, slot = buffer[entry] * 4;
        const [r, g, b] = toRgb(buffer[entry + 1], buffer[entry + 2], buffer[entry + 3]);
        table.set([r, g, b, buffer[entry + 4]], slot);
      }
      palettes.set(id, table);
    } else if (type === SEGMENT_OBJECT) {
      const objectId = buffer.readUInt16BE(start), flags = buffer[start + 3];
      const length = (buffer[start + 4] << 16) | (buffer[start + 5] << 8) | buffer[start + 6];
      const chunk = buffer.subarray(start + 7, start + 7 + length);
      if (flags & 0x80) pending = { objectId, chunks: [chunk] };
      else if (pending) pending.chunks.push(chunk);
      if (pending && (flags & 0x40)) {
        const data = Buffer.concat(pending.chunks);
        const width = data.readUInt16BE(0), height = data.readUInt16BE(2);
        objects.set(pending.objectId, { width, height, pixels: decodeRun(data.subarray(4), width, height) });
        pending = null;
      }
    } else if (type === SEGMENT_END && presentation) {
      // Objects and windows are overwritten by the next display set: snapshot now.
      const items = presentation.items.map(item => ({
        ...item,
        object: objects.get(item.objectId) ? { ...objects.get(item.objectId), pixels: objects.get(item.objectId).pixels.slice() } : null,
        window: windows.get(item.windowId) ? { ...windows.get(item.windowId) } : null,
      }));
      sets.push({ pts, items, palette: (palettes.get(presentation.paletteId) ?? new Uint8Array(256 * 4)).slice() });
      presentation = null;
    }
    at = end;
  }
  return sets;
}

// The bitmap of one display set, cropped to what it paints, as a coverage image:
// background white, ink darkening with the palette alpha so the recogniser sees a
// picture rather than a screen of film.
export function coverage(set) {
  const placed = set.items.filter(item => item.object).map(item => ({
    object: item.object,
    left: item.crop ? item.crop.x : item.window ? item.window.x : item.x,
    top: item.crop ? item.crop.y : item.window ? item.window.y : item.y,
    offsetX: item.crop ? item.crop.x : 0,
    offsetY: item.crop ? item.crop.y : 0,
    width: item.crop ? item.crop.width : item.object.width,
    height: item.crop ? item.crop.height : item.object.height,
  }));
  if (!placed.length) return null;
  const left = Math.min(...placed.map(part => part.left)), top = Math.min(...placed.map(part => part.top));
  const right = Math.max(...placed.map(part => part.left + part.width));
  const bottom = Math.max(...placed.map(part => part.top + part.height));
  const width = right - left, height = bottom - top;
  if (width < 16 || height < 8) return null;
  const gray = Buffer.alloc(width * height, 255);
  for (const part of placed) {
    for (let y = 0; y < part.height; y++) {
      for (let x = 0; x < part.width; x++) {
        const pixel = part.object.pixels[(part.offsetY + y) * part.object.width + part.offsetX + x];
        if (pixel === TRANSPARENT || pixel === UNTOUCHED) continue;
        const alpha = set.palette[pixel * 4 + 3];
        if (alpha) gray[(part.top - top + y) * width + (part.left - left + x)] = 255 - alpha;
      }
    }
  }
  return { width, height, gray };
}

const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

function resize({ width, height, gray }, nextWidth, nextHeight) {
  const out = Buffer.alloc(nextWidth * nextHeight);
  for (let y = 0; y < nextHeight; y++) {
    const source = Math.min(height - 1, Math.floor((y + 0.5) * height / nextHeight));
    for (let x = 0; x < nextWidth; x++) {
      out[y * nextWidth + x] = gray[source * width + Math.min(width - 1, Math.floor((x + 0.5) * width / nextWidth))];
    }
  }
  return { width: nextWidth, height: nextHeight, gray: out };
}

function tensor({ width, height, gray }, recogniser) {
  const data = new Float32Array(3 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x] / 255;
      for (let channel = 0; channel < 3; channel++) {
        // Blue-green-red order, the order the models were trained on.
        const plane = 2 - channel;
        data[(plane * height + y) * width + x] = recogniser
          ? (value - 0.5) / 0.5 : (value - IMAGENET.mean[channel]) / IMAGENET.std[channel];
      }
    }
  }
  return data;
}

function components(mask, width, height) {
  const label = new Int32Array(width * height).fill(-1);
  const boxes = [], stack = [];
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, size = 0;
    const id = boxes.length;
    label[start] = id; stack.push(start);
    while (stack.length) {
      const point = stack.pop(), x = point % width, y = (point / width) | 0;
      size++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && label[next] < 0) { label[next] = id; stack.push(next); }
      }
    }
    boxes.push({ x0, y0, x1, y1, size });
  }
  return boxes;
}

let sessions = null;

export async function loadSessions() {
  if (!sessions) {
    const [det, rec, charset] = await Promise.all([
      ort.InferenceSession.create(DET_MODEL, { intraOpNumThreads: 2 }),
      ort.InferenceSession.create(REC_MODEL, { intraOpNumThreads: 2 }),
      readFile(CHARSET, 'utf8'),
    ]);
    // Class 0 is the CTC blank and the last class is the word separator, which the
    // published dictionary does not carry: the model has one class more than the file.
    sessions = { det, rec, characters: ['<blank>', ...JSON.parse(charset), ' '] };
  }
  return sessions;
}

// Text boxes of a coverage image: the detector scores a thin text line on its tight
// box, so the box that gets measured is not the one that gets cropped.
async function detectText(sessions, image, { limit = 960, threshold = 0.2, boxThreshold = 0.4, unclip = 1.4 } = {}) {
  const scale = Math.min(1, limit / Math.max(image.width, image.height));
  const width = Math.max(32, Math.round(image.width * scale / 32) * 32);
  const height = Math.max(32, Math.round(image.height * scale / 32) * 32);
  const input = resize(image, width, height);
  const output = await sessions.det.run({ x: new ort.Tensor('float32', tensor(input), [1, 3, height, width]) });
  const probabilities = output[sessions.det.outputNames[0]].data;
  const [rows, columns] = [output[sessions.det.outputNames[0]].dims[2], output[sessions.det.outputNames[0]].dims[3]];
  const mask = new Uint8Array(rows * columns);
  for (let at = 0; at < rows * columns; at++) mask[at] = probabilities[at] > threshold ? 1 : 0;
  const boxes = [];
  for (const box of components(mask, columns, rows)) {
    const boxWidth = box.x1 - box.x0 + 1, boxHeight = box.y1 - box.y0 + 1;
    if (box.size < 8 || boxHeight < 4) continue;
    let sum = 0;
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) sum += probabilities[y * columns + x];
    if (sum / (boxWidth * boxHeight) < boxThreshold) continue;
    const margin = (box.size * unclip) / Math.max(1, 2 * (boxWidth + boxHeight));
    boxes.push({ x0: Math.max(0, box.x0 - margin), y0: Math.max(0, box.y0 - margin),
      x1: Math.min(columns - 1, box.x1 + margin), y1: Math.min(rows - 1, box.y1 + margin),
      scaleX: image.width / columns, scaleY: image.height / rows });
  }
  return boxes.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
}

async function recogniseLine(sessions, image, box) {
  const left = Math.max(0, Math.floor(box.x0 * box.scaleX)), top = Math.max(0, Math.floor(box.y0 * box.scaleY));
  const width = Math.min(image.width - left, Math.ceil((box.x1 - box.x0) * box.scaleX));
  const height = Math.min(image.height - top, Math.ceil((box.y1 - box.y0) * box.scaleY));
  if (width < 4 || height < 4) return '';
  const crop = { width, height, gray: Buffer.alloc(width * height) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) crop.gray[y * width + x] = image.gray[(top + y) * image.width + left + x];
  }
  const lineHeight = 48;
  const lineWidth = Math.max(16, Math.ceil((width * lineHeight / height) / 8) * 8);
  const input = resize(crop, lineWidth, lineHeight);
  const output = await sessions.rec.run({ x: new ort.Tensor('float32', tensor(input, true), [1, 3, lineHeight, lineWidth]) });
  const logits = output[sessions.rec.outputNames[0]];
  const [, steps, classes] = logits.dims;
  let text = '', previous = -1;
  for (let step = 0; step < steps; step++) {
    let best = 0, bestScore = -Infinity;
    for (let id = 0; id < classes; id++) {
      const score = logits.data[step * classes + id];
      if (score > bestScore) { bestScore = score; best = id; }
    }
    if (best !== previous && best !== 0) text += sessions.characters[best] ?? '';
    previous = best;
  }
  return text.trim();
}

async function recogniseImage(sessions, image) {
  const lines = [];
  for (const box of await detectText(sessions, image)) lines.push(await recogniseLine(sessions, image, box));
  return lines.filter(Boolean).join('\n').trim();
}

// A display set carrying text opens a cue; the next display set closes it, and the
// same image repeated (a fade) extends the cue instead of starting a new one.
export function cuesFromDisplaySets(displaySets, duration) {
  const cues = [];
  let open = null;
  const close = end => {
    if (open && end > open.start) cues.push({ start: open.start, end, text: open.text });
    open = null;
  };
  for (const { time, text } of displaySets) {
    if (text && open && text === open.text) continue;
    if (text) { close(time); open = { start: time, text }; }
    else close(time);
  }
  if (open) close(Number.isFinite(duration) && duration > open.start ? duration : open.start + 2);
  return cues;
}

export async function ocrSubtitleTrack(source, ordinal, { temporaryDirectory, duration, onProgress } = {}) {
  const path = `${temporaryDirectory ?? '/tmp'}/pgs-${ordinal}-${process.pid}.sup`;
  try {
    await new Promise((resolve, reject) => {
      // -copyts keeps the stream's own timestamps: the sup muxer rebases them to zero
      // otherwise, which would move every cue to the start of the film.
      execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-copyts', '-i', source,
        '-map', `0:s:${ordinal}`, '-c:s', 'copy', '-copyts', path], (error, stdout, stderr) =>
        error ? reject(new Error(stderr?.trim() || error.message)) : resolve());
    });
    const sets = parseDisplaySets(await readFile(path));
    const shots = sets.map(set => ({ time: set.pts / 90000, image: coverage(set) }))
      .filter(shot => shot.image);
    const sessions = await loadSessions();
    const recognised = [];
    let done = 0;
    for (const shot of shots) {
      recognised.push({ time: shot.time, text: await recogniseImage(sessions, shot.image) });
      onProgress?.(++done, shots.length);
    }
    return { cues: cuesFromDisplaySets(recognised, duration), displaySets: sets.length, images: shots.length };
  } finally {
    await rm(path, { force: true });
  }
}
