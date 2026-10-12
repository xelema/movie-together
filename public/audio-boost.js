// Le volume d'un <video> plafonne à 100 % (0 dBFS) : l'échelle de l'élément ne
// peut pas monter plus haut, et un film déjà normalisé n'a plus une seule crête
// de marge. Un étage de gain Web Audio branché sur l'élément rouvre cette marge
// sans retoucher un octet des fichiers : le volume du lecteur garde son échelle
// 0..1 et son maximum vaut BOOST_GAIN, soit 1,5× la bande son d'origine.
// Un limiteur juste sous la saturation empêche une crête normalisée de se
// transformer en écrêtage une fois ce gain appliqué : seuls les quelques
// décibels du dessus sont retenus, la bande son ordinaire monte telle quelle.
export const BOOST_GAIN = 1.5;
export const BOOST_CEILING_DB = -1;
// Le limiteur du Web Audio n'est pas transparent sous son seuil : la courbe
// normalisée que partagent les trois moteurs (mesurée par e2e/audio-boost.spec.js)
// ajoute ce facteur. L'étage de gain porte le reste, pour que le film gagne
// réellement 1,5× plutôt que 1,6×.
export const BOOST_MAKEUP = 1.067;
// Gestes qui portent l'activation. Un AudioContext né hors appui démarre
// suspendu, et iOS ne le relance jamais seul : le graphe serait monté pour un
// film muet. Aucun geste n'est requis pour l'écoute elle-même, seulement pour
// créer le contexte.
export const BOOST_GESTURES = ['pointerdown', 'touchstart', 'keydown'];

// Le routage ne se contente pas d'ajouter du gain : il confisque le volume de
// l'élément. WebKit ne le fait pas passer dans le graphe — curseur et bouton muet
// sans effet une fois le film routé (mesuré sur les trois moteurs), et son
// lecteur HLS natif ne se route déjà pas de façon fiable. Un appareil Apple garde
// donc le son intact, à son plafond, plutôt qu'un film qu'on ne pourrait plus
// baisser. Le jour où WebKit se conforme, la liste se vide et le gain revient.
export const supportsAudioBoost = (nav = globalThis.navigator) => !/^Apple/.test(nav?.vendor ?? '');

// Le graphe naît au premier geste et vit ensuite aussi longtemps que l'élément :
// il n'y a pas de retour en arrière possible une fois la source média créée,
// donc rien qui puisse échouer n'est tenté après. `armed` dit si le film passe
// réellement par le gain ; un appareil sans gain garde le son de l'élément à son
// plafond, jamais un silence.
export function attachAudioBoost(media, {
  gain = BOOST_GAIN, makeup = BOOST_MAKEUP, ceilingDb = BOOST_CEILING_DB, gestures = BOOST_GESTURES,
  target = globalThis.document, supported = supportsAudioBoost(), create = () => new AudioContext(),
} = {}) {
  let graph = null;
  const resume = () => { if (graph?.context.state === 'suspended') graph.context.resume().catch(() => {}); };
  const arm = () => {
    if (!supported) return null;
    if (graph) { resume(); return graph; }
    let context = null;
    try {
      context = create();
      const stage = context.createGain();
      stage.gain.value = gain / makeup;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = ceilingDb;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      stage.connect(limiter);
      limiter.connect(context.destination);
      // Après cette ligne l'élément ne joue plus que par le graphe : tout ce qui
      // peut jeter est déjà monté et branché.
      const source = context.createMediaElementSource(media);
      graph = { context, source, stage, limiter };
      source.connect(stage);
    } catch (error) {
      // Un contexte sans source média n'a rien pris à l'élément : le refermer
      // évite un contexte orphelin, et le son reste celui du <video>.
      if (!graph && context) context.close().catch(() => {});
      console.warn(`[audio] gain indisponible, volume de l'élément conservé : ${error.message}`);
      return null;
    }
    resume();
    return graph;
  };
  const gesture = () => arm();
  for (const type of gestures) target?.addEventListener(type, gesture, { capture: true, passive: true });
  // Un contexte suspendu en cours de séance (mise en arrière-plan) se relance au
  // geste suivant : les écouteurs de geste restent en place après l'armement.
  media.addEventListener('play', resume);
  return {
    get supported() { return supported; },
    get armed() { return Boolean(graph); },
    get graph() { return graph; },
    arm, resume,
    stop() {
      for (const type of gestures) target?.removeEventListener(type, gesture, { capture: true });
      media.removeEventListener('play', resume);
    },
  };
}
