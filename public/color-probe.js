// Diagnostic couleur : fait passer des mires connues par le vrai chemin de lecture
// (MediaSource -> <video> -> texImage2D -> readPixels) et mesure ce que le décodeur
// a réellement produit. Chaque clip juxtapose l'élément vidéo natif et le canvas
// WebGL : une différence visible entre les deux isole l'import de texture.
import { clips } from './color-probe-data.js';
import { ColorRenderer } from './color-renderer.js';

const report = document.getElementById('report');
const line = text => { report.textContent += text + '\n'; };

const MATRICES = { bt709: [.2126, .0722], bt601: [.299, .114], bt2020nc: [.2627, .0593] };
// Ce que prepareMovie aurait mis dans rendition.color pour chaque clip.
const RENDITION = {
  'A-h264-vui-absente': { version: 1, transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', fullRange: false, bitDepth: 8, peakNits: 1000 },
  'B-h264-vui-709': { version: 1, transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', fullRange: false, bitDepth: 8, peakNits: 1000 },
  'C-hevc-vui-2020pq': { version: 1, transfer: 'smpte2084', primaries: 'bt2020', matrix: 'bt2020nc', fullRange: false, bitDepth: 10, peakNits: 1000 },
};

// Décodage YCbCr -> RGB attendu pour un modèle donné (matrice, plage, inversion Cb/Cr).
function decode([Y, Cb, Cr], { matrix, range, swap }, depth) {
  const s = depth === 10 ? 4 : 1, [kr, kb] = MATRICES[matrix];
  if (swap) [Cb, Cr] = [Cr, Cb];
  const y = range === 'full' ? Y * s / (256 * s - 1) : (Y - 16) / 219;
  const cb = (Cb - 128) / (range === 'full' ? 255 : 224), cr = (Cr - 128) / (range === 'full' ? 255 : 224);
  const r = y + 2 * (1 - kr) * cr, b = y + 2 * (1 - kb) * cb;
  const g = (y - kr * r - kb * b) / (1 - kr - kb);
  return [r, g, b].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

const MODELS = [];
for (const matrix of Object.keys(MATRICES)) for (const range of ['limited', 'full']) for (const swap of [false, true])
  MODELS.push({ name: `${matrix}/${range}${swap ? '/swap' : ''}`, matrix, range, swap });

function makeGL(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return { canvas };
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x,-p.y)*.5+.5;gl_Position=vec4(p,0,1);}'); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, 'precision mediump float;varying vec2 uv;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,uv);}'); gl.compileShader(fs);
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  return { canvas, gl };
}

function sample(gl, clip) {
  const pixels = new Uint8Array(clip.width * clip.height * 4);
  gl.readPixels(0, 0, clip.width, clip.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return clip.patches.map(patch => {
    const i = ((clip.height - 1 - (patch.y + 32)) * clip.width + patch.x + 64) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  });
}

async function loadClip(video, clip) {
  const bytes = Uint8Array.from(atob(clip.base64), c => c.charCodeAt(0));
  const mime = [clip.mime, ...(clip.fallbacks ?? [])].find(candidate => {
    try { return MediaSource.isTypeSupported(candidate); } catch { return false; }
  });
  if (!mime) throw new Error(`codec non pris en charge (${clip.mime})`);
  const loaded = new Promise((resolve, reject) => {
    video.onloadeddata = resolve; video.onerror = () => reject(new Error(`video error ${video.error?.code}`));
  });
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  await new Promise((resolve, reject) => {
    source.onsourceopen = () => {
      const buffer = source.addSourceBuffer(mime);
      buffer.onupdateend = () => { source.endOfStream(); resolve(); };
      buffer.onerror = () => reject(new Error('appendBuffer en échec'));
      buffer.appendBuffer(bytes);
    };
  });
  await loaded;
  try { await video.play(); await new Promise(r => setTimeout(r, 300)); video.pause(); }
  catch { video.currentTime = 0.05; await new Promise(r => { video.onseeked = r; }); }
}

async function runClip(clip) {
  const stage = document.createElement('section');
  stage.style.margin = '16px 0'; stage.style.border = '1px solid #888';
  const title = document.createElement('h2'); title.textContent = clip.name; title.style.fontSize = '14px';
  const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '8px';
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.controls = true; video.style.width = '42vw';
  const cell = document.createElement('div'); cell.style.position = 'relative'; cell.style.width = '42vw';
  cell.append(video); row.append(cell);
  stage.append(title, row); document.getElementById('probe').append(stage);
  await loadClip(video, clip);
  line(`decode ok: ${video.videoWidth}x${video.videoHeight}, readyState ${video.readyState}`);
  const { canvas, gl } = makeGL(clip.width, clip.height);
  if (!gl) { line('WebGL indisponible'); return; }
  canvas.style.width = '42vw'; canvas.style.imageRendering = 'pixelated'; row.append(canvas);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const err = gl.getError();
  if (err) line(`texImage2D gl.getError() = ${err}`);
  const measured = sample(gl, clip);
  let best = null;
  for (const model of MODELS) {
    const expected = clip.patches.map(p => decode(p.yuv, model, clip.bitDepth));
    const error = measured.reduce((sum, m, i) => sum + Math.abs(m[0] - expected[i][0]) + Math.abs(m[1] - expected[i][1]) + Math.abs(m[2] - expected[i][2]), 0) / clip.patches.length;
    if (!best || error < best.error) best = { model, error };
  }
  clip.patches.forEach((p, i) => line(`  patch ${i} yuv(${p.yuv}) attendu709=${decode(p.yuv, { matrix: 'bt709', range: 'limited', swap: false }, clip.bitDepth)} mesuré=${measured[i]}`));
  line(`verdict import: ${best.model.name} (écart moyen ${best.error.toFixed(1)}/255)${best.error > 15 ? ' — AUCUN MODÈLE NE COLLE' : ''}`);
  let failure;
  try {
    const renderer = new ColorRenderer(video, RENDITION[clip.name], message => { failure = message; });
    renderer.draw();
    const rendered = renderer.failed ? null : sample(renderer.gl, clip);
    line(`ColorRenderer: ready=${!!renderer.ready}${failure ? ` échec=${failure}` : ''}`);
    if (rendered) line(`  shader mesuré=${JSON.stringify(rendered)}`);
    renderer.dispose();
  } catch (error) { line(`ColorRenderer: exception ${error.message}`); }
}

report.textContent = '';
line(`${navigator.userAgent}`);
try {
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  if (gl && info) line(`GL_RENDERER: ${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`);
} catch { }
for (const clip of clips) {
  line(`\n=== ${clip.name} ===`);
  try { await Promise.race([runClip(clip), new Promise((_, reject) => setTimeout(() => reject(new Error('délai dépassé')), 12000))]); }
  catch (error) { line(error.message); }
}
line('\nTerminé. Copiez ce rapport ou envoyez une capture d’écran.');
