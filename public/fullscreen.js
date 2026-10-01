// Plein écran : Chrome pour Android peut quitter le plein écran de lui-même
// quand une invite de permission (caméra, micro) s'ouvre, sans passer par
// l'API de la page — le document garde alors un élément plein écran que le
// navigateur a déjà lâché, et une demande d'entrée peut même ne plus jamais se
// résoudre (régression Chromium 496907116). Ce module décide donc depuis une
// transition observée plutôt que depuis l'API, ne retient jamais le bouton
// derrière une promesse qui ne se résout pas, et intercepte le contrôle avant
// Plyr, qui lirait l'API menteuse.
import { attempt, settle } from './settle.js';

const EXIT_MS = 800, STALE_MS = 400, ENTER_MS = 1500;

export function attachFullscreen({ screen, player, onEvent = () => {} }) {
  const fallbackClass = player.config?.classNames?.fullscreen?.fallback ?? 'plyr--fullscreen-fallback';
  const usingFallback = () => player.elements.container.classList.contains(fallbackClass);
  // `screen` nomme ici le conteneur du lecteur : l'écran physique se lit sur le
  // global, jamais sur le paramètre.
  const display = () => globalThis.screen ?? {};

  // L'élément peint vaut preuve de ce qui est à l'écran, pas le nom que l'API
  // déclare : un élément revenu dans la page n'est pas plein écran.
  const painted = element => {
    const rect = element.getBoundingClientRect();
    return rect.left <= 1 && rect.top <= 1 && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1;
  };
  // La fenêtre au moment où le plein écran a été accordé. C'est le repère
  // honnête : après la sortie faite par le navigateur, le CSS :fullscreen colle
  // encore l'élément à une fenêtre rétrécie et l'API nomme encore l'élément —
  // seul le rétrécissement du viewport dit que la barre du navigateur est
  // revenue. Là où aucun rétrécissement n'a lieu (environnement sans
  // gestionnaire de fenêtres, CI), le repère tient aussi.
  let grantedAt = null;
  const unchanged = () => !grantedAt || (innerWidth === grantedAt.w && innerHeight === grantedAt.h);
  // Les deux axes comptent : en paysage, la sortie ne reprend que la hauteur.
  const immersive = () => innerWidth >= (display().width ?? Infinity) - 1 && innerHeight >= (display().height ?? Infinity) - 1;

  const active = () => usingFallback() ||
    (document.fullscreenElement === screen && painted(screen) && (unchanged() || immersive()));

  // Le résultat d'une promesse du navigateur est journalisé, jamais attendu
  // sans borne : « pending » est l'aveu que le bouton doit rester utilisable.
  const watch = (promise, ms, reasons) => settle(promise, ms).then(outcome => {
    if (outcome === 'pending') onEvent(reasons.pending, String(ms));
    else if (outcome !== 'ok') onEvent(reasons.failed ?? reasons.pending, outcome);
    return outcome;
  });

  const toggle = async () => {
    // La surcouche CSS reste gérée à la manière de Plyr des deux côtés.
    if (usingFallback()) { onEvent('fallback'); player.fullscreen.toggleFallback(false); return; }
    if (active()) {
      await watch(attempt(() => document.exitFullscreen()), EXIT_MS, { pending: 'exit-pending', failed: 'exit-failed' });
      return;
    }
    if (!screen.requestFullscreen) { onEvent('fallback'); player.fullscreen.toggleFallback(true); return; }
    // L'API peut encore nommer un élément que le navigateur a lâché : Blink
    // ignore une demande pour l'élément qu'il croit déjà plein écran, l'état
    // menteur est donc soldé d'abord — brièvement, et sans jamais y rester.
    if (document.fullscreenElement) {
      const outcome = await settle(attempt(() => document.exitFullscreen()), STALE_MS);
      if (outcome !== 'ok') onEvent('stale', outcome);
    }
    // Une demande qui ne se résout pas ne retient pas le bouton : le veilleur
    // journalise « enter-pending » et l'appui suivant retente sur l'état relu.
    await watch(attempt(() => screen.requestFullscreen({ navigationUI: 'hide' })), ENTER_MS,
      { pending: 'enter-pending', failed: 'enter-failed' });
  };

  const reconcile = () => {
    if (!document.fullscreenElement || active()) return;
    // Le navigateur a lâché le plein écran sans le dire : l'état est journalisé
    // pour le diagnostic, et la lecture suivante est déjà vraie — c'est le
    // prochain appui, dans son geste, qui soldera l'élément menteur.
    onEvent('dropped', `${innerWidth}x${innerHeight}`);
  };

  // Le repère se prend là où le plein écran est accordé, et se lève quand il est
  // soldé : c'est lui qui distingue une sortie subie d'un état normal.
  const onChange = () => {
    grantedAt = document.fullscreenElement === screen ? { w: innerWidth, h: innerHeight } : null;
    reconcile();
  };

  // En capture sur le conteneur, et posé avant les écouteurs de la scène : un
  // appui que la scène dépenserait sur sa surcouche ne peut plus avaler le
  // contrôle, et l'arrêt de propagation empêche Plyr de basculer une seconde
  // fois sur une API menteuse.
  const onClick = event => {
    if (!event.target.closest?.('[data-plyr="fullscreen"]')) return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };
  const onVisible = () => { if (!document.hidden) reconcile(); };
  const container = player.elements?.container;
  container?.addEventListener('click', onClick, true);
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', reconcile);
  window.addEventListener('resize', reconcile);
  window.addEventListener('orientationchange', reconcile);
  return {
    active, toggle, reconcile,
    dispose: () => {
      container?.removeEventListener('click', onClick, true);
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('resize', reconcile);
      window.removeEventListener('orientationchange', reconcile);
    },
  };
}
