// Video remains the decoder and playback clock. Only presentation belongs to WebGL.
// NONE is essential: the texture contains nonlinear source values, not browser-tonemapped RGB.
// https://registry.khronos.org/webgl/specs/latest/1.0/#PIXEL_STORAGE_PARAMETERS
//
// Pipeline reproduisant mpv vo=gpu-next (profil high-quality) pour HDR -> SDR :
// linearisation, IPT, tone map spline a pivot dynamique (percentile 99.995 sur
// histogramme PQ, IIR, hysteresis de scene), contrast recovery 0.30, gamut map
// perceptual via LUT 3D ICh, sortie gamma 2.2 apres remap du point noir, dither
// blue noise 64x64. Reference : docs/research/mpv-pipeline.md, portee depuis
// libplacebo (tone_mapping.c, gamut_mapping.c, shaders/colorspace.c).

const vertex = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = vec2(position.x, -position.y) * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;

// Conversion vers des unites « blanc SDR » (1.0 = 203 cd/m²), partagee par les
// shaders de mesure et le shader principal.
const pq = `
float pqOetf(float x) { x = pow(max(x, 0.), .1593017578125); return pow((.8359375 + 18.8515625 * x) / (1. + 18.6875 * x), 78.84375); }
float pqEotf(float x) { x = pow(clamp(x, 0., 1.), 1. / 78.84375); return pow(max(x - .8359375, 0.) / max(18.8515625 - 18.6875 * x, 1e-10), 1. / .1593017578125); }
float hlgOetfInv(float v) { return v <= .5 ? v * v / 3. : (exp((v - .55991073) / .17883277) + .28466892) / 12.; }
vec3 linearize(vec3 v, int transfer) {
  if (transfer == 1) return vec3(pqEotf(v.r), pqEotf(v.g), pqEotf(v.b)) * (10000. / 203.);
  v = vec3(hlgOetfInv(v.r), hlgOetfInv(v.g), hlgOetfInv(v.b));
  return v * (1000. / 203.) * pow(max(dot(v, vec3(.2627, .678, .0593)), 0.), .2);
}
`;

// Mesure par frame : mpv histogramme la luminance PQ de l'image affichee,
// reduite a la taille fenetre par SON scaler en lumiere lineaire (passe de
// merge linearise, puis ortho separable : vertical pleine largeur puis
// horizontal, dscale=mitchell elargi par le ratio). Le percentile 99.995 tient
// en quelques dizaines de pixels : le moindre noyau plus brillant (catmull-rom
// mesurait ~0.031 PQ de trop) gonfle la queue. On reproduit les deux passes
// ortho sur la luma lineaire (le dot commute avec le filtrage), puis PQ +
// black_cutoff comme pl_shader_detect_peak.
const mitchellKernel = `
float mitchell(float x) {
  x = abs(x);
  if (x > 2.) return 0.;
  return x < 1. ? ((21. * x - 36.) * x * x + 16.) / 16. : (((-7. * x + 36.) * x - 60.) * x + 32.) / 16.;
}
`;
const statsVertFragment = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform int transfer;
uniform vec3 luma;
uniform float inv;
uniform int taps;
out float frag;
${pq}
${mitchellKernel}
void main() {
  float srcPos = gl_FragCoord.y * inv - .5;
  float fcoord = fract(srcPos);
  float center = float(taps) * .5 - 1. + fcoord;
  int base = int(floor(srcPos)) - (taps / 2 - 1), size = textureSize(picture, 0).y;
  float acc = 0., wsum = 0.;
  for (int i = 0; i < taps; i++) {
    float w = mitchell((float(i) - center) / inv);
    vec3 rgb = linearize(max(texelFetch(picture, ivec2(gl_FragCoord.x, clamp(base + i, 0, size - 1)), 0).rgb, vec3(0.)), transfer);
    acc += w * dot(rgb, luma);
    wsum += w;
  }
  frag = acc / wsum;
}
`;
const statsHorizFragment = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform float inv;
uniform int taps;
out vec4 frag;
${mitchellKernel}
void main() {
  float srcPos = gl_FragCoord.x * inv - .5;
  float fcoord = fract(srcPos);
  float center = float(taps) * .5 - 1. + fcoord;
  int base = int(floor(srcPos)) - (taps / 2 - 1), size = textureSize(picture, 0).x;
  float acc = 0., wsum = 0.;
  for (int i = 0; i < taps; i++) {
    float w = mitchell((float(i) - center) / inv);
    acc += w * texelFetch(picture, ivec2(clamp(base + i, 0, size - 1), gl_FragCoord.y), 0).r;
    wsum += w;
  }
  float y = acc / wsum, v = pow(clamp(y * .0203, 0., 1.), .1593017578125);
  float p = pow((.8359375 + 18.8515625 * v) / (1. + 18.6875 * v), 78.84375);
  p *= smoothstep(0., .01, p);
  float q = floor(p * 16383.);
  frag = vec4(floor(q / 256.) / 255., mod(q, 256.) / 255., 0., 1.);
}
`;

// Feature map pour le contrast recovery : I (IPT, encodee PQ) pleine
// resolution, sous-echantillonnee ensuite vers dst/3.5.
const featureFragment = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform int transfer;
uniform mat3 rgb2lms;
in vec2 uv;
out vec4 frag;
${pq}
void main() {
  vec3 rgb = linearize(max(texture(picture, uv).rgb, vec3(0.)), transfer);
  vec3 lms = rgb2lms * rgb;
  vec3 lp = vec3(pqOetf(lms.x * .0203), pqOetf(lms.y * .0203), pqOetf(lms.z * .0203));
  frag = vec4(.4 * lp.x + .4 * lp.y + .2 * lp.z, 0., 0., 1.);
}
`;

// Copie filtree : downsampling de la feature map et sortie directe pour les
// transferts non HDR (mpv fait early exit en SDR -> SDR).
const copyFragment = `#version 300 es
precision highp float;
uniform sampler2D picture;
in vec2 uv;
out vec4 frag;
void main() { frag = texture(picture, uv); }
`;

const mainFragment = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D picture;
uniform int transfer;
uniform mat3 rgb2lms;
uniform mat3 lms2rgb;
uniform sampler2D toneLut;
uniform float inputMin, inputRange, outputMin, outputMax;
uniform sampler2D featureMap;
uniform float recovery;
uniform sampler3D gamutLut;
uniform float gamutMin, gamutInvRange, gamutOn;
uniform float dstScale, dstOffset;
uniform sampler2D ditherLut;
in vec2 uv;
out vec4 frag;
${pq}
const mat3 LMS2IPT = mat3(0.4000, 4.4550, 0.8056, 0.4000, -4.8510, 0.3572, 0.2000, 0.3960, -1.1628);
const mat3 IPT2LMS = mat3(1.0, 1.0, 1.0, 0.0975689, -0.1138760, 0.0326151, 0.205226, 0.133217, -0.676887);

float toneMap(float x) {
  float fi = clamp((x - inputMin) / inputRange, 0., 1.) * 255.;
  float i0 = floor(fi), f = fi - i0;
  float a = texelFetch(toneLut, ivec2(int(i0), 0), 0).r;
  float b = texelFetch(toneLut, ivec2(min(int(i0) + 1, 255), 0), 0).r;
  return mix(a, b, f);
}

// Interpolation bicubique de la feature map basse resolution (4 taps
// bilineaires, meme poids que le shader libplacebo), puis
// mix(base, sharp + detail, 0.30).
vec3 recover(vec3 ipt, vec2 dims) {
  vec2 lpt = 1. / dims;
  vec2 fr = fract(uv * dims + .5);
  vec2 fr2 = fr * fr, inv = 1. - fr, inv2 = inv * inv;
  vec2 w0 = 1. / 6. * inv2 * inv;
  vec2 w1 = 2. / 3. - .5 * fr2 * (2. - fr);
  vec2 w2 = 2. / 3. - .5 * inv2 * (2. - inv);
  vec2 w3 = 1. / 6. * fr2 * fr;
  vec4 g = vec4(w0 + w1, w2 + w3);
  vec4 h = vec4(w1, w3) / g + inv.xyxy;
  h.xy -= 2.;
  vec4 p = uv.xyxy + lpt.xyxy * h;
  float l00 = texture(featureMap, p.xy).r;
  float l01 = texture(featureMap, p.xw).r;
  float l10 = texture(featureMap, p.zy).r;
  float l11 = texture(featureMap, p.zw).r;
  float lowres = clamp(mix(mix(l11, l10, g.y), mix(l01, l00, g.y), g.x), 0., 1.);
  float highres = clamp(ipt.x, 0., 1.);
  ipt.x = clamp(mix(toneMap(highres), toneMap(lowres) + highres - lowres, recovery), outputMin, outputMax);
  return ipt;
}

// LUT 3D ICh : I et C bornes, h cyclique (les noeuds 0 et 255 partagent la teinte).
vec3 gamutFetch(ivec3 c) {
  c.x = clamp(c.x, 0, 47); c.y = clamp(c.y, 0, 31);
  int h = c.z % 255; if (h < 0) h += 255;
  return texelFetch(gamutLut, ivec3(c.x, c.y, h), 0).rgb;
}
vec3 gamutSample(vec3 idx) {
  idx.xy = clamp(idx.xy, 0., 1.);
  vec3 f = idx * vec3(47., 31., 255.);
  ivec3 i0 = ivec3(floor(f));
  vec3 t = f - floor(f);
  vec3 c00 = mix(gamutFetch(i0), gamutFetch(i0 + ivec3(1, 0, 0)), t.x);
  vec3 c10 = mix(gamutFetch(i0 + ivec3(0, 1, 0)), gamutFetch(i0 + ivec3(1, 1, 0)), t.x);
  vec3 c01 = mix(gamutFetch(i0 + ivec3(0, 0, 1)), gamutFetch(i0 + ivec3(1, 0, 1)), t.x);
  vec3 c11 = mix(gamutFetch(i0 + ivec3(0, 1, 1)), gamutFetch(i0 + ivec3(1, 1, 1)), t.x);
  return mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
}

void main() {
  // The texture is already decoded with the source matrix: the VUI wins when the stream
  // is tagged, and the container repeats the same matrix for untagged streams.
  vec3 rgb = linearize(max(texture(picture, uv).rgb, vec3(0.)), transfer);
  vec3 lms = rgb2lms * rgb;
  vec3 ipt = LMS2IPT * vec3(pqOetf(lms.x * .0203), pqOetf(lms.y * .0203), pqOetf(lms.z * .0203));
  float iOrig = ipt.x;
  ipt.x = recovery > 0. ? recover(ipt, vec2(textureSize(featureMap, 0))).x : toneMap(ipt.x);
  // Hull rescale : evite la sursaturation quand I monte, desature quand il descend.
  vec2 hull = vec2(iOrig, ipt.x);
  hull = ((hull - 6.) * hull + 9.) * hull;
  ipt.yz *= min(iOrig / ipt.x, hull.y / hull.x);
  if (gamutOn > 0.) {
    vec3 idx = vec3((ipt.x - gamutMin) * gamutInvRange, 2. * length(ipt.yz), .15915494 * atan(ipt.z, ipt.y) + .5);
    ipt = gamutSample(idx);
  }
  lms = IPT2LMS * ipt;
  lms = vec3(pqEotf(lms.x), pqEotf(lms.y), pqEotf(lms.z)) * (10000. / 203.);
  rgb = lms2rgb * lms;
  // Sortie gamma 2.2 avec remap du point noir (delinearize GAMMA22,
  // csp_min/csp_max = noir et blanc de la cible exprimes en 1/203 nit).
  rgb = pow(max(rgb * dstScale + dstOffset, 0.), vec3(1. / 2.2));
  float bias = texelFetch(ditherLut, ivec2(gl_FragCoord.xy) & 63, 0).r;
  frag = vec4(floor(rgb * 255. + bias) / 255., 1.);
}
`;

// --- Ports libplacebo (CPU) -------------------------------------------------

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const nitsToPq = nits => {
  const p = Math.pow(Math.max(nits, 0) / 10000, .1593017578125);
  return Math.pow((.8359375 + 18.8515625 * p) / (1 + 18.6875 * p), 78.84375);
};
const pqDecode = v => {
  const p = Math.pow(Math.min(Math.max(v, 0), 1), 1 / 78.84375);
  return Math.pow(Math.max(p - .8359375, 0) / Math.max(18.8515625 - 18.6875 * p, 1e-10), 1 / .1593017578125);
};

// pl_tone_map_spline + st2094_pick_knee, entrees en unites PQ.
function splineLut(inputMin, inputMax, inputAvg, outputMin, outputMax) {
  const srcKnee = clamp(inputAvg > 0 ? inputAvg : mix(inputMin, inputMax, .4),
    mix(inputMin, inputMax, .1), mix(inputMin, inputMax, .8));
  const target = (srcKnee - inputMin) / (inputMax - inputMin);
  const adapted = mix(outputMin, outputMax, target);
  const tuning = 1 - sstep(.8, .4, target) * sstep(.1, .4, target);
  const dstKnee = clamp(mix(srcKnee, adapted, mix(.4, 1, tuning)),
    mix(outputMin, outputMax, .1), mix(outputMin, outputMax, .8));
  let slope = (dstKnee - outputMin) / (srcKnee - inputMin);
  const ratio = clamp(1.5 * (inputMax / outputMax - 1), .2, 1.2);
  slope = Math.pow(slope, (1 - .5) * ratio);
  const inMin = inputMin - srcKnee, inMax = inputMax - srcKnee;
  const outMin = outputMin - dstKnee, outMax = outputMax - dstKnee;
  const Pa = (outMin - slope * inMin) / (inMin * inMin), Pb = slope;
  const t2 = 2 * inMax * inMax;
  const Qa = (slope * inMax - outMax) / (inMax * t2), Qb = -3 * (slope * inMax - outMax) / t2, Qc = slope;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let x = inputMin + (inputMax - inputMin) * i / 255 - srcKnee;
    x = x > 0 ? ((Qa * x + Qb) * x + Qc) * x : (Pa * x + Pb) * x;
    lut[i] = clamp(x + dstKnee, outputMin, outputMax);
  }
  return lut;
}

// Matrices RGB <-> XYZ/LMS selon les primaires (pl_get_rgb2xyz_matrix,
// pl_ipt_rgb2lms : crosstalk 4 % * HPE * rgb2xyz, tout est en blanc D65 ici).
const PRIMARIES = {
  bt709: { red: [.64, .33], green: [.30, .60], blue: [.15, .06] },
  bt2020: { red: [.708, .292], green: [.17, .797], blue: [.131, .046] },
  smpte432: { red: [.68, .32], green: [.265, .69], blue: [.15, .06] },
  smpte170m: { red: [.63, .34], green: [.31, .595], blue: [.155, .07] },
  bt470bg: { red: [.64, .33], green: [.29, .60], blue: [.15, .06] },
};
function invert3(m) {
  const [a, b, c, d, e, f, g, h, k] = m;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const id = 1 / (a * A + b * B + c * C);
  return [A * id, (c * h - b * k) * id, (b * f - c * e) * id,
    B * id, (a * k - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id];
}
function mul3(a, b) {
  const out = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return out;
}
const mv3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const colMajor = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function rgb2xyz({ red, green, blue }) {
  const X = [red[0] / red[1], green[0] / green[1], blue[0] / blue[1]];
  const Z = [(1 - red[0] - red[1]) / red[1], (1 - green[0] - green[1]) / green[1], (1 - blue[0] - blue[1]) / blue[1]];
  const wx = .3127 / .329, wz = (1 - .3127 - .329) / .329;
  const inv = invert3([X[0], X[1], X[2], 1, 1, 1, Z[0], Z[1], Z[2]]);
  const S = [inv[0] * wx + inv[1] + inv[2] * wz, inv[3] * wx + inv[4] + inv[5] * wz, inv[6] * wx + inv[7] + inv[8] * wz];
  return [S[0] * X[0], S[1] * X[1], S[2] * X[2], S[0], S[1], S[2], S[0] * Z[0], S[1] * Z[1], S[2] * Z[2]];
}
function iptRgb2lms(primaries) {
  const c = .04;
  return mul3(mul3([1 - 2 * c, c, c, c, 1 - 2 * c, c, c, c, 1 - 2 * c],
    [.40024, .7076, -.08081, -.2263, 1.16532, .0457, 0, 0, .91822]), rgb2xyz(primaries));
}
const pqOetf = x => { x = Math.pow(Math.max(x, 0), .1593017578125); return Math.pow((.8359375 + 18.8515625 * x) / (1 + 18.6875 * x), 78.84375); };
const ipt2lms = v => [v[0] + .0975689 * v[1] + .205226 * v[2],
  v[0] - .113876 * v[1] + .133217 * v[2], v[0] + .0326151 * v[1] - .676887 * v[2]];
// Le code gamut travaille en unites nits/10000 : pqOetf prend la lumiere
// lineaire normalisee, pqDecode rend la meme unite.
const rgb2ipt = (rgb, rgb2lms) => { const l = mv3(rgb2lms, rgb).map(pqOetf); return [.4 * l[0] + .4 * l[1] + .2 * l[2], 4.455 * l[0] - 4.851 * l[1] + .396 * l[2], .8056 * l[0] + .3572 * l[1] - 1.1628 * l[2]]; };
const ipt2rgb = (ipt, lms2rgb) => mv3(lms2rgb, ipt2lms(ipt).map(pqDecode));

// pl_gamut_map_generate « perceptual » : pour chaque noeud ICh, pics de gamut
// src/dst a cette teinte, mapping bidirectionnel protege par smoothstep
// (deadzone 0.30, strength 0.80), puis softclip mobius par canal RGB (genou
// 0.70). Les pics ne dependent que de la teinte : precalcules par tranche de h.
function gamutLut({ srcRgb2lms, srcLms2rgb, dstRgb2lms, dstLms2rgb }, minLuma, maxLuma) {
  const [NI, NC, NH] = [48, 32, 256], maxDelta = 5e-5;
  const minRgb = pqDecode(minLuma) - 1e-6, maxRgb = pqDecode(maxLuma) + 1e-6;
  const ingamut = (ipt, lms2rgb) => {
    const lp = ipt2lms(ipt);
    if (lp.some(v => v < minLuma || v > maxLuma)) return false;
    return mv3(lms2rgb, lp.map(pqDecode)).every(v => v >= minRgb && v <= maxRgb);
  };
  const desat = (I, h, Cmin, Cmax, lms2rgb) => {
    if (I <= minLuma) return { I: minLuma, C: 0, h };
    if (I >= maxLuma) return { I: maxLuma, C: 0, h };
    const maxDI = I * maxDelta;
    let C = (Cmin + Cmax) / 2;
    while (Cmax - Cmin > maxDI) {
      if (ingamut([I, C * Math.cos(h), C * Math.sin(h)], lms2rgb)) Cmin = C; else Cmax = C;
      C = (Cmin + Cmax) / 2;
    }
    return { I, C, h };
  };
  const saturate = (h, lms2rgb) => {
    const phi = .6180339887498948, phi2 = .38196601125010515;
    let de = maxLuma - minLuma, lo = { I: minLuma, C: 0 }, hi = { C: 0 };
    let a = desat(minLuma + phi2 * de, h, 0, .5, lms2rgb), b = desat(minLuma + phi * de, h, 0, .5, lms2rgb);
    while (de > maxDelta) {
      de *= phi;
      if (a.C > b.C) { hi = b; b = a; a = desat(lo.I + phi2 * de, h, Math.max(lo.C - maxDelta, 0), .5, lms2rgb); }
      else { lo = a; a = b; b = desat(lo.I + phi * de, h, Math.max(hi.C - maxDelta, 0), .5, lms2rgb); }
    }
    return a.C > b.C ? a : b;
  };
  const softclip = (value, source, target) => {
    if (target <= 0) return 0;
    const peak = source / target, x = Math.min(value / target, peak), j = .7;
    if (x <= j || peak <= 1) return value;
    const a = -j * j * (peak - 1) / (j * j - 2 * j + peak);
    const b = (j * j - 2 * j * peak + peak) / Math.max(1e-6, peak - 1);
    return (b * b + 2 * b * j + j * j) / (b - a) * (x + a) / (x + b) * target;
  };
  const peaks = [];
  for (let ih = 0; ih < NH; ih++) {
    const h = mix(-Math.PI, Math.PI, ih / (NH - 1));
    peaks.push({ src: saturate(h, srcLms2rgb), dst: saturate(h, dstLms2rgb) });
  }
  const lut = new Float32Array(NI * NC * NH * 4);
  let o = 0;
  for (let ih = 0; ih < NH; ih++) for (let iC = 0; iC < NC; iC++) for (let iI = 0; iI < NI; iI++) {
    const h = mix(-Math.PI, Math.PI, ih / (NH - 1)), C = .5 * iC / (NC - 1), I = mix(minLuma, maxLuma, iI / (NI - 1));
    let ipt = [I, C * Math.cos(h), C * Math.sin(h)];
    const maxC = Math.max(peaks[ih].src.C, peaks[ih].dst.C);
    const k = sstep(.3, 1, C / Math.max(maxC, 1e-6)) * .8;
    if (k > 0) {
      const mapped = rgb2ipt(ipt2rgb(ipt, srcLms2rgb), dstRgb2lms);
      ipt = ipt.map((v, i) => mix(v, mapped[i], k));
    }
    const rgb = ipt2rgb(ipt, dstLms2rgb), maxRGB = Math.max(...rgb);
    ipt = rgb2ipt(rgb.map(v => Math.max(softclip(v, maxRGB, maxRgb), minRgb)), dstRgb2lms);
    lut[o++] = ipt[0]; lut[o++] = ipt[1]; lut[o++] = ipt[2]; lut[o++] = 0;
  }
  return lut;
}

// pl_generate_blue_noise (void-and-cluster), 64x64, biais dans [0, 1).
function blueNoise(size) {
  const sizeb = Math.log2(size), size2 = size * size;
  const radius = (size >> 1) - 1, gs = radius * 2 + 1, gs2 = gs * gs;
  const sigma = -Math.log(1.5 / gs2) / radius, gauss = new Float64Array(size2);
  const xy = (x, y) => (x & (size - 1)) | ((y & (size - 1)) << sizeb);
  for (let gy = 0; gy <= radius; gy++) for (let gx = 0; gx <= gy; gx++) {
    const v = Math.exp(-Math.hypot(gx - radius, gy - radius) * sigma) / gs2;
    gauss[xy(gx, gy)] = gauss[xy(gy, gx)] = gauss[xy(gx, gs - 1 - gy)] = gauss[xy(gy, gs - 1 - gx)] =
      gauss[xy(gs - 1 - gx, gy)] = gauss[xy(gs - 1 - gy, gx)] = gauss[xy(gs - 1 - gx, gs - 1 - gy)] = gauss[xy(gs - 1 - gy, gs - 1 - gx)] = v;
  }
  const acc = new Float64Array(size2), done = new Uint8Array(size2), order = new Uint32Array(size2);
  const middle = xy(radius, radius);
  const set = c => {
    if (done[c]) return; done[c] = 1;
    const offset = (middle + size2 - c) & (size2 - 1);
    for (let i = 0; i < size2; i++) acc[i] += gauss[(i + offset) & (size2 - 1)];
  };
  for (let c = 0; c < size2; c++) {
    let min = Infinity, pick = 0;
    for (let i = 0; i < size2; i++) if (!done[i] && acc[i] < min) { min = acc[i]; pick = i; }
    set(pick); order[pick] = c;
  }
  const lut = new Uint8Array(size2);
  for (let i = 0; i < size2; i++) lut[i] = Math.floor(order[i] * 255 / size2);
  return lut;
}

// Histogramme PQ 14 bits biaise (64 bins au dessus du milieu de gamme),
// percentile 99.995 + moyenne hors noirs, puis IIR 20 frames et hysteresis
// de changement de scene (update_peak_buf cote CPU).
const PQ_MAX = 16383;

// Cible SDR calibree sur le poste de reference : le gate mpv tourne avec
// --target-peak=75 (blanc SDR Windows mesure, cf. docs de capture #9) et le
// contraste infere 1000:1 donne un noir a 0.075 nit.
const TARGET_NITS = 75, TARGET_CONTRAST = 1000;
const TARGET_BLACK = TARGET_NITS / TARGET_CONTRAST;
// Agregation cote CPU calquee sur update_peak_buf : workgroups 16x16, les
// threads hors image repetent le bord, chaque WG contribue sa moyenne entiere
// (wg_sum/num) a part egale et retire ses pixels noirs de l'histogramme.
class PeakTracker {
  frames = 0; max = 0; avg = 0;
  update(data, w, h, paused = false) {
    const hist = new Uint32Array(64);
    let maxY = 0, wgSum = 0, wgActive = 0, wgCount = 0, blacks = 0;
    for (let gy = 0; gy * 16 < h; gy++) for (let gx = 0; gx * 16 < w; gx++) {
      let s = 0, black = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (Math.min(gy * 16 + y, h - 1) * w + Math.min(gx * 16 + x, w - 1)) * 4;
        const v = data[i] * 256 + data[i + 1];
        hist[clamp((v >> 7) - 64, 0, 63)]++;
        s += v; if (v > maxY) maxY = v; if (!v) black++;
      }
      blacks += black; wgCount++;
      const num = 256 - black;
      if (num) { wgSum += Math.floor(s / num); wgActive++; }
    }
    hist[0] -= blacks;
    let avg = 1e-6, max = 1e-6;
    if (wgActive) {
      avg = wgSum / wgActive / PQ_MAX;
      const total = hist.reduce((a, b) => a + b, 0), target = Math.ceil(.99995 * total);
      max = maxY / PQ_MAX;
      if (target < total) {
        let low = 0;
        for (let i = 0; i < 64; i++) {
          const next = low + hist[i];
          if (next < target) { low = next; continue; }
          const lo = ((i + 64) << 7) / PQ_MAX;
          const hi = next + 1 > total ? maxY / PQ_MAX : ((i + 65) << 7) / PQ_MAX;
          max = lo + (hi - lo) * (target - low) / (next + 1 - low);
          break;
        }
      }
    }
    if (!this.frames++) { this.max = max; this.avg = avg; return; }
    const bias = wgActive / wgCount;
    const steps = paused ? 250 : 1;
    for (let i = 0; i < steps; i++) {
      const eps = 1 / PQ_MAX;
      if (Math.abs(avg - this.avg) < eps) avg = this.avg;
      if (Math.abs(max - this.max) < eps) max = this.max;
      const coeff = 1 - Math.exp(-1 / 20);
      this.avg += coeff * (avg - this.avg); this.max += coeff * (max - this.max);
      const k = sstep(.01, .03, bias * Math.abs(avg - this.avg));
      this.avg = mix(this.avg, avg, k); this.max = mix(this.max, max, k);
      if (steps > 1 && Math.abs(avg - this.avg) < 1e-7 && Math.abs(max - this.max) < 1e-7) break;
    }
  }
}

// Briques pures du pipeline, réutilisées par le modèle de référence de
// scripts/check-colors.js (le décodage y reste remodélisé indépendamment).
export const pipeline = { splineLut, gamutLut, rgb2ipt, ipt2rgb, iptRgb2lms, invert3, nitsToPq, PRIMARIES, TARGET_NITS, TARGET_BLACK };

export function colorParameters(color) {
  const matrix = { bt709: 1, bt2020nc: 1, smpte170m: 1, bt470bg: 1 }[color.matrix];
  const primaries = PRIMARIES[color.primaries];
  const transfer = { bt709: 0, smpte170m: 0, bt2020_10: 0, bt2020_12: 0, smpte2084: 1, 'arib-std-b67': 2, 'iec61966-2-1': 3 }[color.transfer];
  if (color.version !== 1 || !matrix || !primaries || transfer === undefined) throw new Error('Format couleur non pris en charge.');
  const rgb2lms = iptRgb2lms(primaries), lms2rgb = invert3(rgb2lms);
  const dstRgb2lms = iptRgb2lms(PRIMARIES.bt709), dstLms2rgb = invert3(dstRgb2lms);
  return {
    transfer,
    luma: [rgb2xyz(primaries)[3], rgb2xyz(primaries)[4], rgb2xyz(primaries)[5]],
    rgb2lms, lms2rgb, dstRgb2lms, dstLms2rgb,
    sameGamut: color.primaries === 'bt709',
  };
}

// Le rendu WebGL ne sert qu'aux transferts HDR : en SDR tous les navigateurs
// affichent la meme chose et la video native suffit, ce qui epargne
// texImage2D 4K par frame aux GPU qui ne suivent pas.
export function colorNeedsRenderer(color) {
  if (color?.version !== 1) return true;
  return ['smpte2084', 'arib-std-b67'].includes(color.transfer);
}

export class ColorRenderer {
  constructor(video, color, onFailure) {
    this.video = video; this.onFailure = onFailure; this.listeners = []; this.disposed = false;
    const parameters = this.parameters = colorParameters(color);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'color-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.captions = document.createElement('div'); this.captions.className = 'color-captions';
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl || !gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision) throw new Error('Le rendu des couleurs nécessite l’accélération graphique.');
    this.gl = gl;
    const shaders = [];
    try {
      const build = frag => {
        const program = gl.createProgram();
        for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, frag]]) {
          const shader = gl.createShader(type); shaders.push(shader); gl.shaderSource(shader, text); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        return program;
      };
      const texture = (unit, filter = gl.NEAREST, target = gl.TEXTURE_2D) => {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex);
        gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        return tex;
      };
      const hdr = parameters.transfer === 1 || parameters.transfer === 2;
      this.programs = { copy: build(copyFragment) };
      if (hdr) Object.assign(this.programs, { statsV: build(statsVertFragment), statsH: build(statsHorizFragment), feature: build(featureFragment), main: build(mainFragment) });
      this.u = {};
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      for (const [name, program] of Object.entries(this.programs)) {
        gl.useProgram(program);
        const attribute = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
        this.u[name] = new Proxy({}, { get: (cache, key) => cache[key] ??= gl.getUniformLocation(program, key) });
      }
      this.peak = new PeakTracker();
      this.texture = texture(0, gl.LINEAR);
      if (hdr) {
        this.toneTex = texture(1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, new Float32Array(256));
        this.featureTex = texture(2, gl.LINEAR);
        this.featureLowTex = texture(3, gl.LINEAR);
        if (!parameters.sameGamut) {
          const min = this.gamutMin = nitsToPq(TARGET_BLACK);
          this.gamutInvRange = 1 / (nitsToPq(TARGET_NITS) - min);
          this.gamutTex = texture(4, gl.NEAREST, gl.TEXTURE_3D);
          gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, 48, 32, 256, 0, gl.RGBA, gl.FLOAT,
            gamutLut({ srcRgb2lms: parameters.rgb2lms, srcLms2rgb: parameters.lms2rgb, dstRgb2lms: parameters.dstRgb2lms, dstLms2rgb: parameters.dstLms2rgb }, min, nitsToPq(TARGET_NITS)));
        }
        this.ditherTex = texture(5);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 64, 0, gl.RED, gl.UNSIGNED_BYTE, blueNoise(64));
        this.lumaTex = texture(14);
        this.lumaFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumaFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lumaTex, 0);
        this.statsTex = texture(15);
        this.statsFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.statsTex, 0);
        this.featureFbo = gl.createFramebuffer(); this.featureLowFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // EXT_color_buffer_float est quasi universel en WebGL2 ; sans lui le
        // contrast recovery est saute et la mesure de pic reste figee (la LUT
        // garde ses bornes nominales).
        this.floatExt = !!gl.getExtension('EXT_color_buffer_float');
        this.recovery = this.floatExt ? .3 : 0;
        const u = this.u;
        gl.useProgram(this.programs.statsV);
        gl.uniform1i(u.statsV.picture, 0);
        gl.uniform1i(u.statsV.transfer, parameters.transfer);
        gl.uniform3fv(u.statsV.luma, parameters.luma);
        gl.useProgram(this.programs.statsH);
        gl.uniform1i(u.statsH.picture, 0);
        gl.useProgram(this.programs.feature);
        gl.uniform1i(u.feature.transfer, parameters.transfer);
        gl.uniformMatrix3fv(u.feature.rgb2lms, false, colMajor(parameters.rgb2lms));
        gl.useProgram(this.programs.main);
        gl.uniform1i(u.main.transfer, parameters.transfer);
        gl.uniformMatrix3fv(u.main.rgb2lms, false, colMajor(parameters.rgb2lms));
        gl.uniformMatrix3fv(u.main.lms2rgb, false, colMajor(parameters.dstLms2rgb));
        gl.uniform1i(u.main.toneLut, 1);
        gl.uniform1i(u.main.featureMap, 3);
        gl.uniform1i(u.main.gamutLut, 4);
        gl.uniform1i(u.main.ditherLut, 5);
        gl.uniform1f(u.main.gamutMin, this.gamutMin ?? 0);
        gl.uniform1f(u.main.gamutInvRange, this.gamutInvRange ?? 1);
        gl.uniform1f(u.main.gamutOn, this.gamutTex ? 1 : 0);
        // delinearize の黒点スケール: csp_min/csp_max は黒と白を 1/203 nit で表した値
        gl.uniform1f(u.main.dstScale, 203 / (TARGET_NITS - TARGET_BLACK));
        gl.uniform1f(u.main.dstOffset, -TARGET_BLACK / (TARGET_NITS - TARGET_BLACK));
      }
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
    // iPadOS expose parfois une piste HLS sous plusieurs TextTrack en mode showing :
    // sans déduplication la même cue serait dessinée une fois par doublon.
    const seen = new Set();
    const cues = Array.from(this.video.textTracks)
      .filter(track => track.mode === 'showing' && ['subtitles', 'captions'].includes(track.kind))
      .flatMap(track => Array.from(track.activeCues ?? []))
      .filter(cue => {
        const key = `${cue.startTime}-${cue.endTime}-${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    this.captions.replaceChildren(...cues.map(cue => {
      const line = document.createElement('div'); line.append(cue.getCueAsHTML()); return line;
    }));
    const line = cues[0]?.line;
    this.captions.style.bottom = `${typeof line === 'number' && !cues[0].snapToLines ? 100 - line : 16}%`;
  }
  // Mesure la frame affichee puis regenere la LUT de ton si les pics ont bouge
  // (pl_tone_map_params_infer : pic d'entree >= min(sortie, 100 nits), puis
  // sortie plafonnee a l'entree, pas d'inverse tone mapping chez mpv).
  updatePeak(width, height) {
    const { gl, u, video } = this;
    const sw = video.videoWidth, sh = video.videoHeight;
    if (this.floatExt && (this.statsW !== width || this.statsH !== height || this.statsSW !== sw)) {
      this.statsW = width; this.statsH = height; this.statsSW = sw;
      this.statsPixels = new Uint8Array(width * height * 4);
      this.statsPbo ??= gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statsPbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.statsPixels.byteLength, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (this.statsSync) { gl.deleteSync(this.statsSync); this.statsSync = null; }
      gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, this.statsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, this.lumaTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, sw, height, 0, gl.RED, gl.HALF_FLOAT, null);
    }
    if (this.floatExt) {
      // Le readPixels synchrone fige le CPU ~40 ms en 4K : en lecture on passe
      // par un PBO + fence et on recolte la frame precedente une fois signalée.
      if (this.statsSync && gl.clientWaitSync(this.statsSync, 0, 0) === gl.ALREADY_SIGNALED) {
        gl.deleteSync(this.statsSync); this.statsSync = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statsPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.statsPixels);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.peak.update(this.statsPixels, width, height, false);
      }
      // Comme mpv : passe verticale a pleine largeur source, puis horizontale.
      gl.useProgram(this.programs.statsV);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1f(u.statsV.inv, sh / height);
      gl.uniform1i(u.statsV.taps, 2 * Math.ceil(2 * Math.max(1, sh / height)));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumaFbo);
      gl.viewport(0, 0, sw, height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(this.programs.statsH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.lumaTex);
      gl.uniform1f(u.statsH.inv, sw / width);
      gl.uniform1i(u.statsH.taps, 2 * Math.ceil(2 * Math.max(1, sw / width)));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFbo);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // En pause la frame est statique et mpv converge vers ses stats mesurees a
      // chaque vsync ; la lecture synchrone y est donc exacte et sans cout.
      if (video.paused) {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.statsPixels);
        this.peak.update(this.statsPixels, width, height, true);
      } else {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statsPbo);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        if (this.statsSync) gl.deleteSync(this.statsSync);
        this.statsSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }
    const inMin = nitsToPq(1e-6);
    let outMin = nitsToPq(TARGET_BLACK), outMax = nitsToPq(TARGET_NITS);
    const inMax = Math.max(this.peak.max, Math.min(outMax, nitsToPq(100)));
    if (Math.abs(inMin - outMin) < 1e-6) outMin = inMin;
    if (Math.abs(inMax - outMax) < 1e-6) outMax = inMax;
    outMax = Math.min(outMax, inMax);
    const key = `${inMax.toFixed(6)}/${this.peak.avg.toFixed(6)}/${outMax.toFixed(6)}`;
    if (key !== this.toneKey) {
      this.toneKey = key;
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.toneTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.FLOAT, splineLut(inMin, inMax, this.peak.avg, outMin, outMax));
    }
    this.tone = { inMin, inRange: inMax - inMin, outMin, outMax };
  }
  render(width, height) {
    const { gl, u, parameters } = this;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.updatePeak(width, height);
    if (this.recovery > 0) {
      const lw = Math.max(1, Math.floor(width / 3.5)), lh = Math.max(1, Math.floor(height / 3.5));
      if (this.featureSize?.[0] !== width || this.featureSize?.[1] !== height) {
        this.featureSize = [width, height];
        for (const [tex, w, h] of [[this.featureTex, width, height], [this.featureLowTex, lw, lh]]) {
          gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.featureFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.featureTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.featureLowFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.featureLowTex, 0);
      }
      gl.useProgram(this.programs.feature);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.featureFbo);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(this.programs.copy);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.featureLowFbo);
      gl.viewport(0, 0, lw, lh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.featureTex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }
    gl.useProgram(this.programs.main);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    const { inMin, inRange, outMin, outMax } = this.tone;
    gl.uniform1f(u.main.inputMin, inMin); gl.uniform1f(u.main.inputRange, inRange);
    gl.uniform1f(u.main.outputMin, outMin); gl.uniform1f(u.main.outputMax, outMax);
    gl.uniform1f(u.main.recovery, this.recovery > 0 ? this.recovery : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
        canvas.width = width; canvas.height = height;
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      if (this.programs?.main) this.render(width, height);
      else { gl.viewport(0, 0, width, height); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
      gl.flush();
      // Keep error detection without a synchronous GPU round trip on every frame.
      const now = performance.now();
      if (!this.ready || resized || this.drawErrors || video.paused || now - this.lastErrorCheck >= 2000) {
        this.lastErrorCheck = now;
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Le rendu des couleurs a été interrompu. Rechargez la page.');
        // Sur certains appareils texImage2D ne reçoit jamais les pixels de la vidéo et la
        // texture garde une couleur sentinelle uniforme (violet sous Firefox Android,
        // bugzilla 1884282). On détecte la frame uniforme et la vidéo native reprend le relais.
        // Une frame en pause peut être légitimement unie : le test n'a de sens qu'en lecture.
        // La vidéo native affiche alors ses propres sous-titres : l'overlay se tait aussi.
        if (!video.paused) {
          // Un seul tirage uniforme peut etre une frame noire du film : on ne
          // bascule sur la video native qu'apres deux checks morts d'affilee,
          // sinon le canvas clignote sur les imports intermittents.
          this.deadStreak = this.deadImport() ? (this.deadStreak || 0) + 1 : 0;
          const dead = this.deadStreak >= 2;
          this.canvas.style.visibility = dead ? 'hidden' : '';
          this.captions.style.display = dead ? 'none' : '';
        }
      }
      this.lastTime = video.currentTime; this.drawErrors = 0;
      if (!this.ready) { this.ready = true; canvas.dataset.ready = 'true'; }
    } catch (error) {
      // Texture upload can fail while the first frame is still being presented; retry before giving up.
      if ((this.drawErrors = (this.drawErrors || 0) + 1) < 8) { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.draw(), 400); }
      else { this.failed = true; this.onFailure(error.message); }
    }
  }
  deadImport() {
    const { gl, canvas } = this, pixel = new Uint8Array(4);
    let reference;
    for (const [x, y] of [[.1, .1], [.3, .7], [.5, .5], [.7, .2], [.9, .8]]) {
      gl.readPixels(canvas.width * x | 0, canvas.height * y | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (!reference) reference = [...pixel];
      else if (pixel[0] !== reference[0] || pixel[1] !== reference[1] || pixel[2] !== reference[2]) return false;
    }
    return true;
  }
  dispose() {
    this.disposed = true; clearTimeout(this.retryTimer); this.listeners.forEach(remove => remove());
    this.resizeObserver?.disconnect();
    if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.callback); else cancelAnimationFrame(this.callback);
    if (this.gl) {
      for (const tex of [this.texture, this.toneTex, this.featureTex, this.featureLowTex, this.gamutTex, this.ditherTex, this.statsTex, this.lumaTex])
        if (tex) this.gl.deleteTexture(tex);
      for (const fbo of [this.statsFbo, this.lumaFbo, this.featureFbo, this.featureLowFbo]) if (fbo) this.gl.deleteFramebuffer(fbo);
      for (const program of Object.values(this.programs ?? {})) this.gl.deleteProgram(program);
      if (this.statsPbo) this.gl.deleteBuffer(this.statsPbo);
      if (this.statsSync) this.gl.deleteSync(this.statsSync);
      this.gl.deleteBuffer(this.buffer);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.canvas.remove(); this.captions.remove();
  }
}
