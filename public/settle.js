// Une promesse du navigateur peut ne jamais se résoudre : sur Android, une
// demande de plein écran lancée après une invite de permission reste en attente
// pour toujours — aucune erreur, aucune entrée (régression Chromium 496907116).
// Tout appelant doit donc rendre la main dans une borne et lire le résultat
// observé, jamais attendre sans fin : « ok », le nom de l'erreur, ou « pending ».
export function settle(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      () => { clearTimeout(timer); return 'ok'; },
      error => { clearTimeout(timer); return error?.name ?? 'error'; },
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve('pending'), ms);
    }),
  ]);
}

// Un appel d'API qui jette au lieu de rendre une promesse se lit comme un
// refus : l'appelant n'a qu'un seul chemin à traiter.
export function attempt(call) {
  try { return call(); } catch (error) { return Promise.reject(error); }
}
