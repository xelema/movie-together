// Résume la télémétrie d'une séance en français. Trois lectures selon l'entrée :
//   node scripts/telemetry-report.js data/telemetry/<participant>.ndjson
//   node scripts/telemetry-report.js data/telemetry/<code>-server.ndjson
//   node scripts/telemetry-report.js data/telemetry            (dossier : tout,
//   plus une chronologie fusionnée client + serveur quand les deux existent)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const arg = process.argv[2];
if (!arg) { console.error('usage: node scripts/telemetry-report.js <fichier.ndjson|dossier>'); process.exit(2); }
let isDirectory = false;
try { isDirectory = statSync(arg).isDirectory(); }
catch { console.error(`introuvable : ${arg}`); process.exit(2); }
const files = isDirectory
  ? readdirSync(arg).filter(name => name.endsWith('.ndjson')).sort().map(name => path.join(arg, name))
  : [arg];

const sorted = values => values.filter(Number.isFinite).sort((a, b) => a - b);
const median = values => { const list = sorted(values); return list.length ? list[Math.floor(list.length / 2)] : undefined; };
const p95 = values => { const list = sorted(values); return list.length ? list[Math.min(list.length - 1, Math.floor(list.length * .95))] : undefined; };
const fmt = value => Number.isFinite(value) ? +value.toFixed(2) : 'n/a';
const total = values => values.reduce((sum, value) => sum + value, 0);
const mio = bytes => `${(bytes / 1024 ** 2).toFixed(1)} Mio`;
const ranges = value => Array.isArray(value) ? value.map(pair => `[${fmt(pair[0])}, ${fmt(pair[1])}]`).join(' ') : 'n/a';
const ms = value => Number.isFinite(value) ? `${Math.round(value)} ms` : 'n/a';
const clockTime = value => new Date(value).toISOString().slice(11, 19);

const read = file => readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const of = (events, type) => events.filter(event => event.type === type);

// ---------------------------------------------------------------- participant

function clientReport(file, events) {
  const ticks = of(events, 'tick');
  const caps = of(events, 'caps').at(-1);
  const first = events[0].t ?? events[0].at, last = events.at(-1).t ?? events.at(-1).at;

  console.log(`\n===== ${path.basename(file)} =====`);
  if (caps) {
    const screen = caps.screen ? `${caps.screen.w}x${caps.screen.h}${caps.screen.depth ? ` @${caps.screen.depth}b` : ''}` : '?';
    console.log(`participant : ${caps.name ?? '?'} · ${caps.platform ?? '?'}${caps.mobile ? ' (mobile)' : ''} · ${caps.ua?.match(/\(([^)]*)\)/)?.[1] ?? caps.ua}`);
    console.log(`écran : ${screen} @${caps.dpr}x · fenêtre ${caps.viewport ? `${caps.viewport.w}x${caps.viewport.h}` : '?'} · gamut ${caps.color?.gamut ?? '?'} · dynamic-range ${caps.color?.range ?? '?'} · ${caps.tz ?? ''} · cœurs ${caps.cores ?? '?'}`);
    console.log(`GPU : ${caps.gpu?.renderer ?? '?'} · webgl2 ${caps.gpu?.webgl2 ?? '?'} · maxTexture ${caps.gpu?.maxTexture ?? '?'}`);
    const playable = caps.canPlay ?? {}, muxable = caps.mse ?? {};
    const yes = source => Object.entries(source).filter(([, value]) => value).map(([name]) => name).join(',') || 'aucun';
    console.log(`codecs : lecture directe ${yes(playable)} · MSE ${yes(muxable)} · hls natif ${caps.nativeHls} · hls.js ${caps.hlsjs?.version ?? '?'} (${caps.hlsjs?.supported ? 'supporté' : 'non supporté'})`);
    if (caps.mediaCap?.film) {
      const film = caps.mediaCap.film;
      console.log(`film : ${film.codec} ${film.w}x${film.h} @${((film.bitrate ?? 0) / 1e6).toFixed(1)} Mb/s — décodage ${film.supported ? 'oui' : 'NON'}${film.smooth === false ? ' · pas fluide' : ''}${film.powerEfficient ? ' · efficace' : ''}`);
      const refused = ['h264', 'hevc', 'av1', 'vp9'].filter(name => caps.mediaCap[name] && caps.mediaCap[name].supported === false);
      if (refused.length) console.log(`  codecs refusés par MediaCapabilities : ${refused.join(', ')}`);
    }
    if (caps.jsHeap) console.log(`mémoire JS : ${mio(caps.jsHeap.used ?? 0)} / ${mio(caps.jsHeap.limit ?? 0)} · réseau ${JSON.stringify(caps.conn ?? {})} · stockage ${mio(caps.storage?.quota ?? 0)}`);
    const features = Object.entries(caps.features ?? {}).filter(([, value]) => !value).map(([name]) => name);
    if (features.length) console.log(`API absentes : ${features.join(', ')}`);
    const rendition = caps.movie?.renditions?.[0];
    if (rendition) console.log(`rendition : ${rendition.id} ${rendition.codec} ${rendition.w}x${rendition.h}${rendition.videoRange ? ` · ${rendition.videoRange}` : ''}${caps.movie.renditions.length > 1 ? ` (+${caps.movie.renditions.length - 1})` : ''}`);
    if (caps.movie) console.log(`risque segments : max ${caps.movie.maxSegmentBytes ? (caps.movie.maxSegmentBytes / 1024 ** 2).toFixed(1) : '?'} Mio · gop ${caps.movie.maxSegmentSeconds ?? caps.movie.bufferRisk?.gopSeconds ?? '?'} s · ${caps.movie.bufferRisk?.level ?? 'non mesuré'}${Number.isFinite(caps.movie.bufferRisk?.p90SegmentMb) ? ` (p90 ${caps.movie.bufferRisk.p90SegmentMb} Mio)` : ''} · génération ${String(caps.movie.generation ?? '').slice(0, 8)}`);
    if (caps.room) console.log(`séance : probe=${caps.room.probe} · langues ${caps.room.languages} · démarrage ${caps.room.minBuffer} s · réserve ${caps.room.lowBuffer} s · délai rapport ${Number.isFinite(caps.room.reportTimeout) ? `${(caps.room.reportTimeout / 1000).toFixed(0)} s` : '?'} · mode ${caps.room.mode ?? '?'}`);
    if (caps.session) console.log(`entrée : ${caps.session.enter ?? '?'}${caps.session.admin ? ' · admin' : ''}${caps.session.hdr ? ` · hdr ${caps.session.hdr}` : ''}`);
  }
  console.log(`session : ${new Date(first).toISOString()} → ${((last - first) / 60000).toFixed(1)} min · ${events.length} événements${caps?.sid ? ` · sid ${caps.sid}` : ''}`);

  const playing = ticks.filter(tick => tick.phase === 'playing');
  const ahead = playing.map(tick => tick.ahead);
  const drift = playing.map(tick => Math.abs(tick.pos - tick.target));
  const rtts = ticks.map(tick => tick.rtt);
  const offsets = ticks.map(tick => tick.off);
  console.log(`lecture : ${playing.length}/${ticks.length} ticks en 'playing' · buffer devant min ${fmt(Math.min(...ahead))} s / médian ${fmt(median(ahead))} s / max ${fmt(Math.max(...ahead))} s`);
  console.log(`dérive : médiane ${fmt(median(drift))} s · p95 ${fmt(p95(drift))} s · max ${fmt(Math.max(...drift))} s`);
  console.log(`horloge : rtt min ${fmt(Math.min(...rtts))} / médian ${fmt(median(rtts))} / max ${fmt(Math.max(...rtts))} ms · décalage médian ${fmt(median(offsets))} ms · étalement ${fmt(Math.max(...offsets) - Math.min(...offsets))} ms`);

  const fps = ticks.map(tick => tick.fps);
  const lastTick = ticks.at(-1);
  if (fps.some(Number.isFinite)) console.log(`images : ${fmt(median(fps))} i/s réelles (médiane) · min ${fmt(Math.min(...sorted(fps)))} · ${lastTick?.dropped ?? '?'} perdues sur ${lastTick?.frames ?? '?'}${Number.isFinite(lastTick?.frames) && lastTick.frames ? ` (${(100 * lastTick.dropped / lastTick.frames).toFixed(1)} %)` : ''}`);

  // Un trou dans les plages décodées alors que la réserve fond est la signature
  // d'un ajout refusé, pas d'un manque de débit.
  const holed = ticks.filter(tick => (tick.ranges?.length ?? 0) > 1);
  const lowBuffer = caps?.room?.lowBuffer;
  const starved = playing.filter(tick => Number.isFinite(tick.ahead) && Number.isFinite(lowBuffer) && tick.ahead < lowBuffer);
  if (lastTick?.ranges) console.log(`tampon : plages finales ${ranges(lastTick.ranges)} · ${holed.length} ticks à plages multiples · ${starved.length} ticks en lecture sous la réserve`);
  if (lastTick?.buf) console.log(`tampon MSE par piste : ${JSON.stringify(lastTick.buf).slice(0, 400)}`);

  const stalls = of(events, 'video-waiting').length + of(events, 'video-stalled').length;
  const seeks = of(events, 'video-seeking');
  const reconnects = of(events, 'ws').filter(event => event.to === 0 || event.retries);
  const phases = of(events, 'phase').map(event => `${event.from}->${event.to}`);
  console.log(`stalls : ${stalls} · seeks : ${seeks.length} · reconnexions ws : ${reconnects.length} · phases : ${phases.join(', ') || 'stable'}`);
  if (seeks.length) console.log(`  seeks : ${seeks.slice(-6).map(event => `${fmt(event.from)}→${fmt(event.to)} (${fmt(event.delta)} s)`).join(' · ')}`);

  const hlsEvents = of(events, 'hls');
  if (hlsEvents.length) {
    const byName = {};
    for (const event of hlsEvents) byName[event.ev] = (byName[event.ev] ?? 0) + 1;
    console.log(`hls.js : ${Object.entries(byName).map(([name, n]) => `${name}×${n}`).join(' · ')}`);
    const frags = hlsEvents.filter(event => event.ev === 'frag-loaded' || event.ev === 'frag-buffered');
    if (frags.length) console.log(`fragments : ${frags.length} · chargement médian ${ms(median(frags.map(event => event.ms)))} · p95 ${ms(p95(frags.map(event => event.ms)))} · max ${ms(Math.max(...frags.map(event => event.ms ?? 0)))}`);
    for (const flush of hlsEvents.filter(event => event.ev === 'buffer-flushing').slice(-5)) console.log(`  vidage : ${JSON.stringify(flush.tracks ?? flush).slice(0, 240)}`);
  }
  const mediaErrors = of(events, 'mediaError');
  for (const error of mediaErrors.slice(-8)) {
    console.log(`  hls ${error.fatal ? 'FATAL' : 'non fatal'} ${error.details ?? error.type} sn=${error.sn ?? '?'} ${error.reason ?? ''} ${error.errmsg ? `« ${String(error.errmsg).slice(0, 120)} »` : ''}`);
  }
  if (mediaErrors.length) console.log(`erreurs hls.js : ${mediaErrors.length} (dont ${mediaErrors.filter(error => error.fatal).length} fatales)`);

  const segs = of(events, 'seg').filter(event => (event.b ?? 0) > 0);
  if (segs.length) {
    const bytes = total(segs.map(event => event.b));
    const aborted = segs.filter(event => event.status === 0 || (event.enc ?? event.b) < 4096);
    console.log(`segments : ${segs.length} · ${mio(bytes)} · requête médiane ${ms(median(segs.map(event => event.d)))} · p95 ${ms(p95(segs.map(event => event.d)))} · plus lente ${ms(Math.max(...segs.map(event => event.d ?? 0)))} · ttfb médian ${ms(median(segs.map(event => event.ttfb)))}`);
    const byKind = {};
    for (const seg of segs) byKind[seg.kind] = (byKind[seg.kind] ?? 0) + 1;
    console.log(`  par nature : ${Object.entries(byKind).map(([kind, n]) => `${kind}×${n}`).join(' · ')}${segs.some(seg => seg.cached) ? ' · certains servis par le cache' : ''}`);
    if (aborted.length) console.log(`  avortements client : ${aborted.length} (dont ${aborted.filter(event => event.n?.includes('init_')).length} init)`);
    const loaded = hlsEvents.filter(event => event.ev === 'frag-loaded' && Number.isFinite(event.bytes) && Number.isFinite(event.end) && Number.isFinite(event.start));
    const media = total(loaded.map(event => event.end - event.start));
    if (media > 0) console.log(`  débit média : ${((total(loaded.map(event => event.bytes)) * 8 / media) / 1e6).toFixed(1)} Mb/s (${mio(total(loaded.map(event => event.bytes)))} sur ${fmt(media)} s de film)`);
  }

  for (const rtc of of(events, 'rtc').slice(-2)) {
    console.log(`webrtc : ${rtc.conn}/${rtc.ice} · pair ${rtc.pair?.local}/${rtc.pair?.remote} ${rtc.pair?.protocol} rtt ${fmt(rtc.pair?.rtt)} ms · sortie ${fmt(rtc.out?.fps)} i/s ${mio(rtc.out?.bytes ?? 0)} · entrée ${fmt(rtc.in?.fps)} i/s ${mio(rtc.in?.bytes ?? 0)} perdues ${rtc.in?.lost ?? 0} gigue ${fmt(rtc.in?.jitter)} · limite ${rtc.out?.qlim} · gels ${rtc.in?.freeze ?? 0} (${fmt((rtc.in?.freezeMs ?? 0) / 1000)} s)`);
  }
  const webcam = of(events, 'webcam');
  if (webcam.length) console.log(`caméra : ${webcam.map(event => `${event.state ?? event.kind}${event.err ? `(${event.err})` : ''}`).join(' → ')}`);

  const voice = of(events, 'voice');
  if (voice.length) {
    console.log(`voix : ${voice.map(event => `${event.state}${event.err ? `(${event.err})` : ''}`).join(' → ')}`);
    const armed = voice.map(event => event.armMs);
    if (armed.some(Number.isFinite)) console.log(`  armement micro : médian ${ms(median(armed))} · max ${ms(Math.max(...sorted(armed)))} · trames refusées ${voice.filter(event => event.refused).length} · octets ${mio(total(voice.map(event => event.bytes ?? 0)))}`);
  }

  const renderer = of(events, 'renderer').at(-1) ?? ticks.at(-1)?.rend;
  const rendererHidden = of(events, 'renderer-hidden').some(event => event.uniform);
  if (renderer) console.log(`renderer couleur : ${renderer.failed ? 'ÉCHEC' : renderer.ready ? 'ok' : 'en attente'}${rendererHidden ? ' · import mort (repli natif)' : ''} · ${renderer.w}x${renderer.h} · ${renderer.drawn ?? '?'} images · ${renderer.errors ?? 0} erreurs`);

  const actions = of(events, 'action');
  if (actions.length) console.log(`actions : ${actions.map(event => `${event.act}${event.value !== undefined ? `=${event.value}` : ''}@${fmt(event.pos)}`).join(' · ')}`);

  const failures = ticks.filter(tick => tick.fail).map(tick => tick.fail);
  if (failures.length) console.log(`échec affiché : ${failures.at(-1)}`);
  for (const type of ['video-error', 'js-error', 'resource-error', 'api']) {
    for (const error of of(events, type).slice(-5)) console.log(`  ${type} : ${error.msg ?? `${error.status ?? ''} ${error.path ?? ''} ${error.name ?? ''}`}${error.stack ? ` (${String(error.stack).split('\n')[0]})` : ''}`);
  }
  const long = of(events, 'longtask');
  if (long.length) console.log(`blocages du fil principal : ${long.length} · pire ${ms(Math.max(...long.map(event => event.ms ?? event.d ?? 0)))}${long.some(event => event.capped) ? ' (comptage plafonné)' : ''}`);
  const drops = of(events, 'queue');
  if (drops.length) console.log(`événements perdus : ${total(drops.map(event => event.dropped ?? 0))} (${drops.length} vidages en retard)`);
}

// --------------------------------------------------------------------- serveur

function serverReport(file, events) {
  const first = events[0].at, last = events.at(-1).at;
  console.log(`\n===== ${path.basename(file)} =====`);
  const created = of(events, 'create').at(-1);
  if (created) console.log(`séance : ${new Date(first).toISOString()} → ${((last - first) / 60000).toFixed(1)} min · ${events.length} événements · probe=${created.probe} · langues ${created.languages} · film ${created.movie}`);
  console.log(`connexions : ${of(events, 'connect').length} · déconnexions ${of(events, 'disconnect').length} · refus ${of(events, 'refused').length} · fermetures par garde-fou ${of(events, 'limit').length}`);
  for (const refused of of(events, 'refused')) console.log(`  refus ${refused.reason} depuis ${refused.ip} (${String(refused.ua ?? '').slice(0, 60)})`);
  for (const limit of of(events, 'limit')) console.log(`  garde-fou ${limit.reason} — membre ${String(limit.member ?? '').slice(0, 8)}`);
  for (const disconnect of of(events, 'disconnect')) console.log(`  départ ${String(disconnect.member ?? '').slice(0, 8)} après ${((disconnect.ms ?? 0) / 1000).toFixed(0)} s · ${disconnect.messages} messages, ${disconnect.frames} trames · ${disconnect.reason}`);

  const phases = of(events, 'phase');
  const causes = {};
  for (const phase of phases) causes[phase.cause] = (causes[phase.cause] ?? 0) + 1;
  console.log(`phases : ${phases.length} · causes ${Object.entries(causes).map(([cause, n]) => `${cause}×${n}`).join(' · ') || 'aucune'}`);
  for (const phase of phases.slice(-12)) {
    const culprit = phase.members?.[0];
    console.log(`  ${clockTime(phase.at)} ${phase.from ?? 'new'} → ${phase.to} cause=${phase.cause}${culprit ? ` (${String(culprit.id).slice(0, 8)} ${culprit.reason} ${fmt(culprit.buffered)}/${fmt(culprit.needed)} s)` : ''}`);
  }
  const rejected = of(events, 'report-rejected');
  if (rejected.length) console.log(`rapports rejetés : ${rejected.length} (${[...new Set(rejected.map(event => event.error))].join(', ')})`);
  const commands = of(events, 'command');
  if (commands.length) console.log(`commandes : ${commands.map(event => `${event.cmd}:${event.result}`).join(' · ')}`);
  const voice = of(events, 'voice');
  if (voice.length) console.log(`voix : ${voice.map(event => `${event.kind}${event.error ? `(${event.error})` : ''}`).join(' → ')}`);
  const webcam = of(events, 'webcam');
  if (webcam.length) console.log(`caméra : statuts ${webcam.filter(event => event.kind === 'status').length} · signaux ${webcam.filter(event => event.kind === 'signal').length} · arrivées ${webcam.filter(event => event.kind === 'peer-joined').length} · départs ${webcam.filter(event => event.kind === 'peer-left').length}`);
  for (const error of of(events, 'error').slice(-5)) console.log(`  erreur : ${error.method ?? ''} ${error.path ?? ''} ${error.error}`);
  if (of(events, 'expire').length) console.log('séance expirée (balayage).');
}

// -------------------------------------------------- chronologie client + serveur

const TIMELINE = new Set(['phase', 'mediaError', 'video-error', 'js-error', 'resource-error', 'action',
  'connect', 'disconnect', 'refused', 'limit', 'command', 'report-rejected', 'expire', 'session-start', 'session-end', 'queue']);

// Met une action utilisateur en face d'une phase serveur : c'est le seul angle
// que ni le journal client ni le journal serveur ne donne à lui seul.
function timeline(events) {
  return events.filter(event => TIMELINE.has(event.type))
    .sort((a, b) => (a.at ?? a.t) - (b.at ?? b.t))
    .slice(-40)
    .map(event => {
      const who = event.member ? String(event.member).slice(0, 8) : 'serveur';
      const detail = event.type === 'phase' ? `${event.from ?? 'new'}→${event.to}${event.cause ? ` cause=${event.cause}` : ''}`
        : event.type === 'mediaError' ? `${event.details ?? ''} sn=${event.sn ?? ''}`
          : event.type === 'action' ? `${event.act}${event.value !== undefined ? `=${event.value}` : ''}@${fmt(event.pos)}`
            : event.type === 'command' ? `${event.cmd}:${event.result}`
              : event.type === 'refused' || event.type === 'disconnect' || event.type === 'limit' ? event.reason
                : event.msg ?? event.error ?? '';
      return `${clockTime(event.at ?? event.t)} ${who} ${event.type} ${String(detail).slice(0, 110)}`;
    });
}

const loaded = files.map(file => ({ file, events: read(file) })).filter(entry => entry.events.length);
for (const { file, events } of loaded) {
  if (path.basename(file, '.ndjson').endsWith('-server')) serverReport(file, events);
  else clientReport(file, events);
}

if (isDirectory) {
  const groups = new Map();
  for (const { file, events } of loaded) {
    const name = path.basename(file, '.ndjson');
    const code = name.endsWith('-server') ? name.slice(0, -'-server'.length) : name.replace(/-[a-f0-9-]{6,40}$/, '');
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(events);
  }
  for (const [code, group] of groups) {
    if (group.length < 2) continue;
    console.log(`\n----- chronologie ${code} (client + serveur) -----`);
    console.log(timeline(group.flat()).join('\n'));
  }
}
