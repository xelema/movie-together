// Browser capability for check-colors.js. codecProbe and webglProbe run inside
// the page (Playwright serializes the function); codecStatus and
// summarizeChecks are pure and covered by test/color-capability.test.js.

// entries: { fixtureName: 'video/mp4; codecs="..."' }. MediaSource is what
// hls.js playback needs; canPlayType is kept for the report only, a positive
// answer there never implies the MSE path works.
export function codecProbe(entries) {
  const video = document.createElement('video');
  const support = {};
  for (const [name, mime] of Object.entries(entries)) {
    let mse = false, canPlayType = '';
    try { mse = window.MediaSource?.isTypeSupported(mime) === true; } catch { }
    try { canPlayType = video.canPlayType(mime); } catch { }
    support[name] = { mime, mse, canPlayType };
  }
  return support;
}

// The renderer refuses anything below WebGL2 with high-float fragment
// precision (the ColorRenderer constructor throws on less): probe exactly that.
export function webglProbe() {
  try {
    const gl = document.createElement('canvas')
      .getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    return { webgl2: !!gl && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0 };
  } catch { return { webgl2: false }; }
}

// Without a positive MSE answer the fixture cannot be exercised: the check is
// an explicit skip carrying the codec string, never a silent pass nor a
// playback attempt that ends in an opaque decoder error.
export function codecStatus(probe) {
  if (probe?.mse) return { status: 'run' };
  return { status: 'skip', reason: 'codec-unavailable',
    detail: `no MSE decoder for ${probe?.mime ?? 'unknown codec'} (canPlayType ${JSON.stringify(probe?.canPlayType ?? '')})` };
}

// checks: { browser, fixture, status: 'pass' | 'skip' | 'fail', ...context }.
// Default mode fails only on real failures; strict mode (COLOR_TEST_STRICT=1,
// for CI runners with codec coverage) fails on any skip, so missing HDR
// coverage can never look green.
export function summarizeChecks(checks, { strict = false } = {}) {
  const failed = checks.filter(check => check.status === 'fail');
  const skipped = checks.filter(check => check.status === 'skip');
  return {
    // A suite where every check skipped verified nothing: never a pass.
    ok: failed.length === 0 && skipped.length < checks.length && (!strict || skipped.length === 0),
    strict,
    passed: checks.length - failed.length - skipped.length,
    skipped: skipped.length,
    failed: failed.length,
    missingCoverage: skipped.map(check => `${check.browser}/${check.fixture}`),
    failures: failed.map(check => `${check.browser}/${check.fixture}: ${check.error}`),
  };
}
