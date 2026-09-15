// Résume la télémétrie d'une séance instrumentée en français.
//   node scripts/telemetry-report.js data/telemetry/<fichier.ndjson|dossier>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const arg = process.argv[2];
if (!arg) { console.error('usage: node scripts/telemetry-report.js <fichier.ndjson|dossier>'); process.exit(2); }
const files = statSync(arg).isDirectory()
  ? readdirSync(arg).filter(name => name.endsWith('.ndjson')).map(name => path.join(arg, name))
  : [arg];

const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined;
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] : undefined;
const fmt = value => value === undefined || value === null ? 'n/a' : typeof value === 'number' ? +value.toFixed(2) : value;

for (const file of files) {
  const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (!events.length) continue;
  const ticks = events.filter(e => e.type === 'tick');
  const caps = events.find(e => e.type === 'caps');
  const first = events[0].t, last = events.at(-1).t;
  const span = ((last - first) / 60000).toFixed(1);

  console.log(`\n===== ${path.basename(file)} =====`);
  if (caps) {
    console.log(`participant : ${caps.name ?? '?'} · ${caps.ua?.match(/\(([^)]*)\)/)?.[1] ?? caps.ua}`);
    console.log(`écran : ${caps.screen?.join('x')} @${caps.dpr}x · gamut ${caps.gamut} · dynamic-range ${caps.range} · GPU ${caps.gpu ?? '?'}`);
    console.log(`codecs : h264=${caps.codecs?.h264} hevc=${caps.codecs?.hevc} mse(h264=${caps.codecs?.h264mse},hevc=${caps.codecs?.hevcmse}) hls-natif=${caps.codecs?.hls}`);
    if (caps.rendition?.color) console.log(`film : ${caps.rendition.codec} ${caps.rendition.w}x${caps.rendition.h} · ${caps.rendition.color.transfer}/${caps.rendition.color.primaries} ${caps.rendition.color.bitDepth}b · peak ${caps.rendition.color.peakNits} nits`);
  }
  console.log(`session : ${new Date(first).toISOString()} → ${span} min · ${events.length} événements`);

  const playing = ticks.filter(t => t.phase === 'playing');
  const ahead = playing.map(t => t.ahead).filter(Number.isFinite);
  const drift = playing.map(t => Math.abs(t.pos - t.target)).filter(Number.isFinite);
  const rtts = ticks.map(t => t.rtt).filter(Number.isFinite);
  console.log(`lecture : ${playing.length}/${ticks.length} ticks en 'playing' · buffer devant min ${fmt(Math.min(...ahead))} s / médian ${fmt(median(ahead))} s / max ${fmt(Math.max(...ahead))} s`);
  console.log(`dérive : médiane ${fmt(median(drift))} s · p95 ${fmt(p95(drift))} s · max ${fmt(Math.max(...drift))} s`);
  console.log(`horloge : rtt min ${fmt(Math.min(...rtts))} ms / max ${fmt(Math.max(...rtts))} ms`);
  const lastTick = ticks.at(-1);
  if (lastTick?.frames) console.log(`frames : ${lastTick.frames} rendues, ${lastTick.dropped} perdues (${(100 * lastTick.dropped / lastTick.frames).toFixed(1)} %)`);

  const stalls = events.filter(e => ['video-waiting', 'video-stalled'].includes(e.type)).length;
  const seeks = events.filter(e => e.type === 'video-seeked').length;
  const reconnects = events.filter(e => e.type === 'ws' && e.to === 0).length;
  const phases = events.filter(e => e.type === 'phase').map(e => `${e.from}->${e.to}`);
  console.log(`stalls : ${stalls} · seeks : ${seeks} · reconnexions ws : ${reconnects} · phases : ${phases.join(', ') || 'stable'}`);

  const errors = events.filter(e => ['video-error', 'js-error'].includes(e.type));
  for (const e of errors) console.log(`  erreur ${e.type} : ${e.msg ?? e.code}`);
  const rendererHidden = events.some(e => e.type === 'renderer-hidden' && e.uniform);
  const rendererBad = ticks.some(t => t.rend?.bad);
  const rendererOk = ticks.some(t => t.rend?.ok);
  console.log(`renderer couleur : ${rendererBad ? 'ÉCHEC' : rendererHidden ? 'import mort (repli natif)' : rendererOk ? 'ok' : 'non sollicité'}`);

  const segs = events.filter(e => e.type === 'seg' && e.b > 0);
  if (segs.length) {
    const bytes = segs.reduce((s, e) => s + e.b, 0), seconds = segs.reduce((s, e) => s + e.d, 0) / 1000;
    console.log(`segments : ${segs.length} · ${(bytes / 1024 ** 2).toFixed(1)} Mio · débit moyen ${(bytes * 8 / seconds / 1e6).toFixed(1)} Mb/s · plus lent ${Math.max(...segs.map(e => e.d))} ms`);
  }
  const failures = ticks.filter(t => t.fail).map(t => t.fail);
  if (failures.length) console.log(`échec affiché : ${failures.at(-1)}`);
}
