// Video remains the decoder and playback clock. Only presentation belongs to WebGL.
// NONE is essential: the texture contains nonlinear source values, not browser-tonemapped RGB.
// https://registry.khronos.org/webgl/specs/latest/1.0/#PIXEL_STORAGE_PARAMETERS
const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = vec2(position.x, -position.y) * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;

const fragment = `
precision highp float;
varying vec2 uv;
uniform sampler2D picture;
uniform vec2 coefficients;
uniform mat3 gamut;
uniform int transfer;
uniform vec3 shoulder;

float pqToNits(float v) {
  float p = pow(max(v, 0.), 1. / 78.84375);
  return 10000. * pow(max(p - .8359375, 0.) / max(18.8515625 - 18.6875 * p, .000001), 1. / .1593017578125);
}
float nitsToPq(float n) {
  float p = pow(max(n, 0.) / 10000., .1593017578125);
  return pow((.8359375 + 18.8515625 * p) / (1. + 18.6875 * p), 78.84375);
}
float hlgToLinear(float v) {
  return v <= .5 ? v * v / 3. : (exp((v - .55991073) / .17883277) + .28466892) / 12.;
}
float srgb(float v) {
  return v <= .0031308 ? 12.92 * v : 1.055 * pow(v, 1. / 2.4) - .055;
}
float inverseSrgb(float v) {
  return v <= .04045 ? v / 12.92 : pow((v + .055) / 1.055, 2.4);
}
// BT.2390 EETF, zero display black, 203 cd/m² SDR reference white.
// The Hermite shoulder preserves shadow exposure and rolls highlights into SDR.
float mapLuminance(float n) {
  float source = shoulder.x, target = shoulder.y, knee = shoulder.z;
  float x = min(nitsToPq(n) / source, 1.);
  if (x > knee) {
    float t = (x - knee) / (1. - knee);
    float t2 = t * t, t3 = t2 * t;
    x = (2. * t3 - 3. * t2 + 1.) * knee + (t3 - 2. * t2 + t) * (1. - knee) + (-2. * t3 + 3. * t2) * target;
  }
  return pqToNits(x * source) / 203.;
}
void main() {
  vec3 encoded = texture2D(picture, uv).rgb;
  // Invert the declared BT.709 transport matrix, then restore the source matrix.
  float y = dot(encoded, vec3(.2126, .7152, .0722));
  float cb = (encoded.b - y) / 1.8556, cr = (encoded.r - y) / 1.5748;
  float r = y + 2. * (1. - coefficients.x) * cr;
  float b = y + 2. * (1. - coefficients.y) * cb;
  vec3 rgb = max(vec3(r, (y - coefficients.x * r - coefficients.y * b) / (1. - coefficients.x - coefficients.y), b), 0.);
  if (transfer == 1) rgb = vec3(pqToNits(rgb.r), pqToNits(rgb.g), pqToNits(rgb.b));
  else if (transfer == 2) {
    rgb = vec3(hlgToLinear(rgb.r), hlgToLinear(rgb.g), hlgToLinear(rgb.b));
    // BT.2100 reference HLG display: 1000 nits and system gamma 1.2.
    rgb *= 1000. * pow(max(dot(rgb, vec3(.2627, .678, .0593)), 0.), .2);
  } else if (transfer == 3) rgb = vec3(inverseSrgb(rgb.r), inverseSrgb(rgb.g), inverseSrgb(rgb.b));
  else rgb = pow(rgb, vec3(2.4)); // SDR reference display (BT.1886).
  rgb = gamut * rgb;
  float luminance = max(dot(rgb, vec3(.2126, .7152, .0722)), 0.);
  if (transfer == 1 || transfer == 2) {
    rgb *= luminance > .000001 ? mapLuminance(luminance) / luminance : 0.;
    luminance = max(dot(rgb, vec3(.2126, .7152, .0722)), 0.);
  }
  // Bring out-of-gamut colours towards the same luminance instead of clipping channels.
  float low = min(rgb.r, min(rgb.g, rgb.b)), high = max(rgb.r, max(rgb.g, rgb.b));
  float saturation = 1.;
  if (low < 0.) saturation = min(saturation, luminance / (luminance - low));
  if (high > 1.) saturation = min(saturation, max(1. - luminance, 0.) / max(high - luminance, .000001));
  rgb = clamp(mix(vec3(luminance), rgb, saturation), 0., 1.);
  gl_FragColor = vec4(srgb(rgb.r), srgb(rgb.g), srgb(rgb.b), 1.);
}
`;

export function colorParameters(color) {
  const coefficients = { bt709: [.2126, .0722], bt2020nc: [.2627, .0593], smpte170m: [.299, .114], bt470bg: [.299, .114] }[color.matrix];
  // Column-major matrices, D65 white; source linear RGB -> linear Rec.709.
  const gamut = {
    bt709: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bt2020: [1.660491, -.124550, -.018151, -.587641, 1.132900, -.100579, -.072850, -.008349, 1.118730],
    smpte170m: [.939542, .017772, -.001622, .050181, .965793, -.004371, .010277, .016435, 1.005993],
    bt470bg: [1.044044, 0, 0, -.044044, 1, .011793, 0, 0, .988207],
    smpte432: [1.224940, -.042057, -.019638, -.224940, 1.042057, -.078636, 0, 0, 1.098274],
  }[color.primaries];
  const transfer = { bt709: 0, smpte170m: 0, bt2020_10: 0, bt2020_12: 0, smpte2084: 1, 'arib-std-b67': 2, 'iec61966-2-1': 3 }[color.transfer];
  if (color.version !== 1 || !coefficients || !gamut || transfer === undefined) throw new Error('Format couleur non pris en charge.');
  const peak = Math.max(203, Math.min(10000, Number(color.peakNits) || 1000));
  const pq = nits => {
    const p = (nits / 10000) ** .1593017578125;
    return ((.8359375 + 18.8515625 * p) / (1 + 18.6875 * p)) ** 78.84375;
  };
  const source = pq(peak), target = pq(203) / source;
  return { coefficients, gamut, transfer, shoulder: [source, target, 1.5 * target - .5] };
}

export class ColorRenderer {
  constructor(video, color, onFailure) {
    this.video = video; this.onFailure = onFailure; this.listeners = []; this.disposed = false;
    const parameters = colorParameters(color);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'color-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.captions = document.createElement('div'); this.captions.className = 'color-captions';
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl || !gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision) throw new Error('Le rendu des couleurs nécessite l’accélération graphique.');
    this.gl = gl;
    const shaders = [];
    try {
      const program = gl.createProgram(); this.program = program;
      for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type); shaders.push(shader); gl.shaderSource(shader, text); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2fv(gl.getUniformLocation(program, 'coefficients'), parameters.coefficients);
      gl.uniformMatrix3fv(gl.getUniformLocation(program, 'gamut'), false, parameters.gamut);
      gl.uniform1i(gl.getUniformLocation(program, 'transfer'), parameters.transfer);
      gl.uniform3fv(gl.getUniformLocation(program, 'shoulder'), parameters.shoulder);
      this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.disable(gl.DITHER);
      if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb';
      video.parentElement.append(this.canvas, this.captions);
      this.listen(this.canvas, 'webglcontextlost', event => { event.preventDefault(); this.failed = true; onFailure('Le rendu des couleurs a été interrompu. Rechargez la page.'); });
      this.listen(this.canvas, 'webglcontextrestored', () => onFailure('Le rendu des couleurs a été interrompu. Rechargez la page.'));
      for (const event of ['loadeddata', 'canplay', 'seeked', 'pause', 'resize']) this.listen(video, event, () => this.draw());
      this.resizeObserver = new ResizeObserver(([entry]) => {
        this.displayWidth = entry.contentRect.width; this.displayHeight = entry.contentRect.height; this.draw();
      });
      this.resizeObserver.observe(video);
      this.listen(window, 'resize', () => this.draw());
      this.listen(video.textTracks, 'change', () => this.updateCaptions());
      this.listen(video.textTracks, 'addtrack', event => this.watchTrack(event.track));
      for (const track of video.textTracks) this.watchTrack(track);
      const frame = () => {
        if (this.disposed || this.failed) return;
        this.draw(false);
        this.callback = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
      };
      frame();
    } catch (error) { this.dispose(); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }
  listen(target, event, handler) { target.addEventListener(event, handler); this.listeners.push(() => target.removeEventListener(event, handler)); }
  watchTrack(track) { this.listen(track, 'cuechange', () => this.updateCaptions()); this.updateCaptions(); }
  updateCaptions() {
    const cues = Array.from(this.video.textTracks).filter(track => track.mode === 'showing').flatMap(track => Array.from(track.activeCues ?? []));
    this.captions.replaceChildren(...cues.map(cue => {
      const line = document.createElement('div'); line.append(cue.getCueAsHTML()); return line;
    }));
    const line = cues[0]?.line;
    this.captions.style.bottom = `${typeof line === 'number' && !cues[0].snapToLines ? 100 - line : 16}%`;
  }
  draw(force = true) {
    const { video, gl, canvas } = this;
    if (this.disposed || this.failed || document.hidden || video.readyState < 2 || !video.videoWidth || video.seeking) return;
    if (!force && !video.requestVideoFrameCallback && this.lastTime === video.currentTime) return;
    try {
      // Match physical display pixels, including letterboxing, without upscaling the source.
      const ratio = window.devicePixelRatio || 1;
      const scale = Math.min(1, (this.displayWidth || video.videoWidth) * ratio / video.videoWidth,
        (this.displayHeight || video.videoHeight) * ratio / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
      const resized = canvas.width !== width || canvas.height !== height;
      if (resized) {
        const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (video.videoWidth > maximum || video.videoHeight > maximum) throw new Error('Définition vidéo non prise en charge par le rendu des couleurs.');
        canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.flush();
      // Keep error detection without a synchronous GPU round trip on every frame.
      const now = performance.now();
      if (!this.ready || resized || this.drawErrors || now - this.lastErrorCheck >= 2000) {
        this.lastErrorCheck = now;
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Le rendu des couleurs a été interrompu. Rechargez la page.');
      }
      this.lastTime = video.currentTime; this.drawErrors = 0;
      if (!this.ready) { this.ready = true; canvas.dataset.ready = 'true'; }
    } catch (error) {
      // Texture upload can fail while the first frame is still being presented; retry before giving up.
      if ((this.drawErrors = (this.drawErrors || 0) + 1) < 8) { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.draw(), 400); }
      else { this.failed = true; this.onFailure(error.message); }
    }
  }
  dispose() {
    this.disposed = true; clearTimeout(this.retryTimer); this.listeners.forEach(remove => remove());
    this.resizeObserver?.disconnect();
    if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.callback); else cancelAnimationFrame(this.callback);
    if (this.gl) {
      this.gl.deleteTexture(this.texture); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.canvas.remove(); this.captions.remove();
  }
}
