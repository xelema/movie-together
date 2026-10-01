// Plein écran : Chrome pour Android peut quitter le plein écran de lui-même
// quand une invite de permission (caméra, micro) s'ouvre, sans passer par
// l'API de la page. Le document peut alors continuer à nommer #screen comme
// élément plein écran alors que l'élément est revenu dans la page : la sortie
// demandée est refusée (« Document not active ») et Blink ignore la rentrée
// pour l'élément qu'il croit déjà plein écran — le bouton semble mort.
// Ce module décide depuis l'élément peint, solde l'état menteur avant de
// rentrer et intercepte le contrôle Plyr, qui lirait l'API menteuse.

export function attachFullscreen({ screen, player, onEvent = () => {} }) {
  const fallbackClass = player.config?.classNames?.fullscreen?.fallback ?? 'plyr--fullscreen-fallback';
  const usingFallback = () => player.elements.container.classList.contains(fallbackClass);

  // L'élément peint vaut preuve, pas le nom que l'API déclare : un élément
  // que l'API dit plein écran revenu à sa place dans la page n'en est pas un.
  const painted = element => {
    const rect = element.getBoundingClientRect();
    return rect.left <= 1 && rect.top <= 1 && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1;
  };

  const active = () => usingFallback() || (document.fullscreenElement === screen && painted(screen));

  const toggle = async () => {
    // La surcouche CSS reste gérée à la manière de Plyr des deux côtés.
    if (usingFallback()) { onEvent('fallback'); player.fullscreen.toggleFallback(false); return; }
    if (active()) {
      try { await document.exitFullscreen(); }
      catch (error) { onEvent('exit-failed', error?.name ?? error); }
      return;
    }
    if (!screen.requestFullscreen) { onEvent('fallback'); player.fullscreen.toggleFallback(true); return; }
    // L'API peut encore nommer un élément que le navigateur a déjà quitté :
    // Blink ignore requestFullscreen pour l'élément qu'il croit plein écran,
    // l'état menteur est donc soldé d'abord. Refusée quand rien n'est plus
    // plein écran, la promesse est journalisée, jamais propagée — la demande
    // a quand même lieu, dans le même geste, tant que l'activation tient.
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); }
      catch (error) { onEvent('stale', error?.name ?? error); }
    }
    try { await screen.requestFullscreen({ navigationUI: 'hide' }); }
    catch (error) { onEvent('enter-failed', error?.name ?? error); }
  };

  const reconcile = () => {
    if (!document.fullscreenElement || painted(document.fullscreenElement)) return;
    // Soldé ici, l'état menteur rend au prochain appui une lecture vraie.
    // Jamais de rentrée de ce côté : sans geste, le navigateur la refuserait.
    Promise.resolve(document.exitFullscreen?.()).catch(error => onEvent('stale', error?.name ?? error));
  };

  // En capture sur la barre de contrôles, l'appui passe après les écouteurs de
  // la scène — un appui commencé sur l'image et dépensé par elle sur la
  // surcouche n'arrive donc jamais ici — et avant l'écouteur de Plyr sur le
  // bouton, que l'arrêt de propagation empêche de basculer une seconde fois.
  const onClick = event => {
    if (!event.target.closest?.('[data-plyr="fullscreen"]')) return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };
  const onVisibility = () => { if (!document.hidden) reconcile(); };
  const controls = player.elements?.controls;
  controls?.addEventListener('click', onClick, true);
  document.addEventListener('fullscreenchange', reconcile);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', reconcile);
  return {
    active, toggle, reconcile,
    dispose: () => {
      controls?.removeEventListener('click', onClick, true);
      document.removeEventListener('fullscreenchange', reconcile);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', reconcile);
    },
  };
}
