import test from 'node:test';
import assert from 'node:assert/strict';
import { codecStatus, missingImageDetail, summarizeChecks } from '../scripts/color-capability.js';

test('a fixture runs only on a positive MSE answer', () => {
  const mime = 'video/mp4; codecs="hvc1.2.4.L93.B0"';
  assert.deepEqual(codecStatus({ mime, mse: true, canPlayType: 'probably' }), { status: 'run' });
  // canPlayType alone never authorizes a run: playback goes through MSE.
  for (const canPlayType of ['', 'probably']) {
    const skip = codecStatus({ mime, mse: false, canPlayType });
    assert.equal(skip.status, 'skip');
    assert.equal(skip.reason, 'codec-unavailable');
    assert.match(skip.detail, /hvc1/);
  }
  assert.match(codecStatus(undefined).detail, /unknown codec/);
});

test('skips are partial coverage by default, failures in strict mode', () => {
  const checks = [
    { browser: 'Chrome', fixture: 'HDR10', status: 'pass' },
    { browser: 'Firefox', fixture: 'HDR10', status: 'skip', reason: 'codec-unavailable' },
  ];
  const partial = summarizeChecks(checks);
  assert.equal(partial.ok, true);
  assert.deepEqual([partial.passed, partial.skipped, partial.failed], [1, 1, 0]);
  // The skip is listed, never silent: the summary names what did not run.
  assert.deepEqual(partial.missingCoverage, ['Firefox/HDR10']);
  assert.equal(summarizeChecks(checks, { strict: true }).ok, false);
});

test('real failures fail in both modes and are reported', () => {
  const summary = summarizeChecks([
    { browser: 'Chrome', fixture: 'SDR709', status: 'pass' },
    { browser: 'Chrome', fixture: 'SDR601', status: 'fail', error: 'render deviates' },
  ]);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures, ['Chrome/SDR601: render deviates']);
});

test('a suite where nothing ran is not a pass', () => {
  const onlySkips = summarizeChecks([{ browser: 'Firefox', fixture: 'HDR10', status: 'skip' }]);
  assert.equal(onlySkips.ok, false);
  assert.equal(summarizeChecks([]).ok, false);
  assert.equal(summarizeChecks([{ browser: 'Chrome', fixture: 'HDR10', status: 'pass' }], { strict: true }).ok, true);
});

test('the comparison skip names every browser that produced no image', () => {
  assert.equal(missingImageDetail({ Chrome: null, Firefox: [1] }), 'Chrome produced no image');
  assert.equal(missingImageDetail({ Chrome: [1], Firefox: null }), 'Firefox produced no image');
  assert.equal(missingImageDetail({ Chrome: null, Firefox: null }), 'Chrome and Firefox produced no image');
});
