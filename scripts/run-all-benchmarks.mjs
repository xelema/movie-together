import { runBenchmarkScenario, PROFILES, DEVICES } from './benchmark-network.mjs';
import { Clock } from '../public/sync-player.js';
import { decide, readyBlockers } from '../public/sync-core.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve('test-results/benchmarks');
await mkdir(outDir, { recursive: true });

const passName = process.argv[2] || 'baseline';
console.log(`\n======================================================`);
console.log(`RUNNING BENCHMARK SUITE: ${passName.toUpperCase()}`);
console.log(`======================================================\n`);

const results = {
  pass: passName,
  timestamp: new Date().toISOString(),
  clockToleranceSuite: {},
  scenarios: {},
};

// 1. Clock & Protocol Latency Tolerance Suite
console.log('>>> 1. Testing Clock Synchronization & Tolerance at High RTTs...');
const testRtts = [100, 250, 350, 480, 520, 650, 900];
for (const rtt of testRtts) {
  const clock = new Clock();
  // Feed 5 samples around this RTT
  clock.sample(100, 100 + rtt, 1000 + rtt / 2);
  clock.sample(300, 300 + rtt + 10, 1200 + rtt / 2);
  clock.sample(500, 500 + rtt - 5, 1400 + rtt / 2);
  clock.sample(700, 700 + rtt + 5, 1600 + rtt / 2);

  const blockers = readyBlockers({
    state: { phase: 'playing', startsAt: 0 },
    failure: null,
    rendererReady: true,
    recovering: false,
    activated: true,
    clockReady: clock.ready,
    hidden: false,
    online: true,
    silent: false,
    seeking: false,
    readyState: 4,
    paused: false,
    position: 10,
    target: 10,
    serverNow: 1000,
  });

  results.clockToleranceSuite[`rtt_${rtt}ms`] = {
    rtt,
    bestRtt: clock.best?.rtt ?? null,
    clockReady: clock.ready,
    roomBlocked: blockers.includes('clock'),
    blockers,
  };
  console.log(`  - RTT ${rtt}ms: clockReady=${clock.ready}, roomBlocked=${blockers.includes('clock')}`);
}

// 2. Browser Playback & Network Scenarios across Profiles and Devices
console.log('\n>>> 2. Running E2E Media & Playback Scenarios across Devices...');

const scenariosToRun = [
  { profile: 'seoul-fiber', device: 'pc' },
  { profile: 'seoul-fiber', device: 'ipad' },
  { profile: 'seoul-mobile', device: 'pc' },
  { profile: 'seoul-mobile', device: 'ipad' },
  { profile: 'poor-connection', device: 'pc' },
];

for (const sc of scenariosToRun) {
  const label = `${sc.profile}_${sc.device}`;
  console.log(`\n  >> Running scenario [${label}] (Profile: ${PROFILES[sc.profile].name}, Device: ${DEVICES[sc.device].name})...`);
  try {
    const data = await runBenchmarkScenario({
      profileKey: sc.profile,
      deviceKey: sc.device,
      durationSeconds: 15,
    });
    results.scenarios[label] = data;
    console.log(`     ✓ Goodput: ${data.goodputMbps} Mbps | TTFP: ${data.ttfpSeconds ?? 'N/A'}s | Max Buffer: ${data.maxBufferAheadSeconds}s | P95 Seg: ${data.segmentDurationP95Ms}ms`);
  } catch (err) {
    console.error(`     ✗ Failed scenario ${label}:`, err.message);
    results.scenarios[label] = { error: err.message };
  }
}

const outputFile = path.join(outDir, `${passName}.json`);
await writeFile(outputFile, JSON.stringify(results, null, 2));
console.log(`\n======================================================`);
console.log(`Benchmark results saved to: ${outputFile}`);
console.log(`======================================================\n`);
