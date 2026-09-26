import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const benchDir = path.resolve('test-results/benchmarks');
const files = ['baseline.json', 'step1-kernel-bdp.json', 'step2-clock-sync.json', 'step3-hls-deep-buffer.json', 'final-all-optimizations.json'];

const loaded = {};
for (const file of files) {
  try {
    const raw = readFileSync(path.join(benchDir, file), 'utf8');
    loaded[file.replace('.json', '')] = JSON.parse(raw);
  } catch (err) {
    console.warn(`Could not load ${file}: ${err.message}`);
  }
}

console.log('# Benchmark Comparatif - Optimisations Réseau Long-Haul (Corée du Sud & Mauvaise Connexion)\n');

// 1. Clock Tolerance comparison
console.log('## 1. Tolérance Horloge & Latence WebSocket (Clock Synchronization)');
console.log('| RTT Testé | Baseline | Step 1 (Kernel BDP) | Step 2 (Clock Sync) | Step 3 (HLS Buffer) | Final (Tout Combiné) |');
console.log('|:---|:---:|:---:|:---:|:---:|:---:|');
const rtts = [100, 250, 350, 480, 520, 650, 900];
for (const r of rtts) {
  const key = `rtt_${r}ms`;
  const getStatus = pass => {
    const s = loaded[pass]?.clockToleranceSuite?.[key];
    if (!s) return 'N/A';
    return s.clockReady ? '✅ Calibré' : '❌ Bloqué (>500ms)';
  };
  console.log(`| **${r} ms** | ${getStatus('baseline')} | ${getStatus('step1-kernel-bdp')} | ${getStatus('step2-clock-sync')} | ${getStatus('step3-hls-deep-buffer')} | ${getStatus('final-all-optimizations')} |`);
}

// 2. Scenario Comparison
console.log('\n## 2. Performances E2E : Débit, Réserve Buffer et Temps d\'Accès (TTFP)');
const scenarios = [
  { key: 'seoul-fiber_pc', title: 'Séoul Fibre (260ms RTT, 40 Mbps) - PC Desktop' },
  { key: 'seoul-fiber_ipad', title: 'Séoul Fibre (260ms RTT, 40 Mbps) - iPad Pro WebKit' },
  { key: 'seoul-mobile_pc', title: 'Séoul Mobile 4G/5G (340ms RTT, 18 Mbps) - PC Desktop' },
  { key: 'seoul-mobile_ipad', title: 'Séoul Mobile 4G/5G (340ms RTT, 18 Mbps) - iPad Pro WebKit' },
  { key: 'poor-connection_pc', title: 'Liaison Dégradée (220ms RTT, 8 Mbps, 3% perte) - PC' },
];

for (const sc of scenarios) {
  console.log(`\n### ${sc.title}`);
  console.log('| Étape | Débit Utile (Goodput) | TTFP (1er Buffer) | Réserve Max | P95 Téléchargement Segment | Stalls |');
  console.log('|:---|:---:|:---:|:---:|:---:|:---:|');

  for (const pass of ['baseline', 'step1-kernel-bdp', 'step2-clock-sync', 'step3-hls-deep-buffer', 'final-all-optimizations']) {
    const data = loaded[pass]?.scenarios?.[sc.key];
    if (!data) continue;
    const nameMap = {
      'baseline': '0. Baseline (Initial)',
      'step1-kernel-bdp': '1. Sysctl & BDP',
      'step2-clock-sync': '2. Clock Sync & Ack',
      'step3-hls-deep-buffer': '3. Hls.js Deep Buffer',
      'final-all-optimizations': '4. Final (Toutes Optims)',
    };
    console.log(`| ${nameMap[pass]} | **${data.goodputMbps} Mbps** | ${data.ttfpSeconds ? `${data.ttfpSeconds} s` : 'Échec (>15s)'} | **${data.maxBufferAheadSeconds} s** | ${data.segmentDurationP95Ms} ms | ${data.stallsCount} |`);
  }
}
