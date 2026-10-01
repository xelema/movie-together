// Une invite de permission ne doit jamais s'ouvrir pendant que la page est en
// plein écran : Chrome pour Android sort alors du plein écran par lui-même, et
// laisse le document dans un état où requestFullscreen() ne se résout plus
// jamais — aucune erreur, aucune entrée, seul un rechargement en sort
// (régression Chromium 496907116, Android, cassée entre Chrome 134 et 146).
//
// On sort donc du plein écran nous-mêmes, dans le geste et jusqu'à ce que le
// navigateur l'ait soldé, avant de demander l'appareil ; la rentrée est
// retentée juste après la réponse, sans jamais être attendue — hors activation
// elle est refusée, et une promesse qui ne se résout pas ne doit pas retenir
// celle qu'on rend au client.
import { attempt, settle } from './settle.js';

const EXIT_MS = 800, RETURN_MS = 1500;

// La régression est propre aux navigateurs Chromium sous Android : ailleurs,
// l'invite ne coûte pas le plein écran et sortir serait une gêne gratuite —
// sur ordinateur, la première activation de la caméra ferait tomber l'image
// plein écran sans raison.
const costlyPrompt = () => {
  const ua = globalThis.navigator?.userAgent ?? '';
  return /Android/i.test(ua) && /Chrome/i.test(ua);
};

// L'état observable décide, pas un délai : attendre « fullscreenchange » prouve
// que le navigateur a fini de sortir, un compte à rebours ne prouve rien. La
// borne est là pour ne jamais bloquer plus longtemps que nécessaire.
const once = (target, type, ms) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); target.removeEventListener(type, done); resolve(); };
  const timer = setTimeout(done, ms);
  target.addEventListener(type, done);
});

export function getUserMedia(name, constraints, onEvent = () => {}) {
  const element = typeof document !== 'undefined' ? document.fullscreenElement : null;
  if (!element || !costlyPrompt()) return navigator.mediaDevices.getUserMedia(constraints);
  return (async () => {
    const state = (await navigator.permissions?.query({ name }).catch(() => null))?.state;
    // Permission déjà accordée ou refusée : aucune invite ne s'ouvre, donc rien
    // à solder et aucune raison de quitter le plein écran.
    if (state !== 'prompt') return navigator.mediaDevices.getUserMedia(constraints);
    const exited = once(document, 'fullscreenchange', EXIT_MS);
    await Promise.race([attempt(() => document.exitFullscreen()).catch(() => {}), exited]);
    await exited;
    onEvent('permission-exit', name);
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } finally {
      // La rentrée n'est tentée que si l'élément est encore dans la page, n'est
      // jamais attendue, et se raconte : accordée, refusée, ou pendue — cette
      // dernière valeur est la signature de la régression.
      if (element.isConnected) {
        settle(attempt(() => element.requestFullscreen({ navigationUI: 'hide' })), RETURN_MS)
          .then(outcome => onEvent(outcome === 'ok' ? 'permission-return' : outcome === 'pending' ? 'permission-return-pending' : 'permission-return-denied',
            outcome === 'ok' ? name : outcome));
      }
    }
  })();
}
