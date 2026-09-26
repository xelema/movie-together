// Suits les logs du serveur et explique en français pourquoi un participant
// bloque la séance. Trois sources, tout le reste passe tel quel :
//   npm start | node scripts/watch-rooms.js     dev, sortie directe du serveur
//   node scripts/watch-rooms.js server.log      fichier sauvegardé, suit les ajouts
//   node scripts/watch-rooms.js --docker        docker compose logs -f app
import { spawn } from 'node:child_process';
import { createReadStream, watchFile, statSync } from 'node:fs';

const reasons = {
  'no-report': 'aucun rapport reçu : le client ne répond pas (onglet planté, JS cassé)',
  'stale-report': 'rapports arrêtés depuis plus de 3 s : onglet suspendu ou connexion mourante',
  'not-ready': 'le participant se déclare pas prêt, détail entre parenthèses',
  'low-buffer': 'buffer sous le seuil requis : débit réseau insuffisant ou film trop lourd',
  'misaligned': 'position écartée de la séance : seek impossible ou décodage bloqué',
};
const blockers = {
  activation: 'autoplay bloqué, il faut toucher la vidéo',
  clock: 'horloge non calibrée, latence > 1200 ms (VPN, réseau lointain)',
  hidden: 'onglet en arrière-plan ou écran éteint',
  silent: 'plus de messages du serveur (websocket à moitié morte, proxy)',
  offline: 'navigateur hors ligne',
  seeking: 'seek en cours (persistant = seek qui ne finit jamais)',
  data: 'pas assez de données décodées (débit ou décodeur)',
  drift: 'la lecture dérive de la position commune (décodage trop lent)',
  recovering: 'le lecteur recouvre après un stall',
  renderer: 'le rendu couleur WebGL pas prêt ou en échec',
  failure: 'erreur de lecture fatale affichée au participant',
  stalled: 'la vidéo s’est mise en attente pendant la lecture',
};

// Only member diagnostics get annotations; phase lines and pass-through noise
// are already self-explanatory.
function annotate(line) {
  const match = line.match(/\[room [^\]]+\] .+: waiting ([a-z-]+)(?: \(([^)]*)\))?/);
  console.log(line);
  if (!match) return;
  console.log(`    ${match[1]} : ${reasons[match[1]] ?? 'cause inconnue'}`);
  for (const name of match[2]?.split(', ') ?? []) {
    console.log(`    ${name} : ${blockers[name] ?? 'verrou inconnu'}`);
  }
}

function follow(input) {
  let rest = '';
  input.on('data', chunk => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) annotate(line.replace(/\r$/, ''));
  });
  input.on('end', () => { if (rest) annotate(rest); });
}

const arg = process.argv[2];
if (arg === '--docker') {
  const logs = spawn('docker', ['compose', 'logs', '-f', '--tail', '200', 'app'], { stdio: ['ignore', 'pipe', 'inherit'] });
  logs.on('error', () => console.error('docker introuvable.'));
  follow(logs.stdout);
} else if (arg) {
  let offset = 0;
  const pump = () => {
    const size = statSync(arg).size;
    if (size < offset) offset = 0;
    if (size > offset) { follow(createReadStream(arg, { start: offset })); offset = size; }
  };
  pump();
  watchFile(arg, { interval: 500 }, pump);
} else {
  follow(process.stdin);
}
