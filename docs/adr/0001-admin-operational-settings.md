# Réglages opérationnels admin : overrides persistés, application aux nouvelles opérations

La page admin expose tous les réglages opérationnels non secrets et non
structurels via un registre central (`src/settings.js`). `data/settings.json`
ne stocke que les clés explicitement modifiées : les variables
d'environnement restent les défauts de déploiement et redeviennent actives
après un reset. Seuls `minBuffer`/`lowBuffer` sont dynamiques — repris par
les séances ouvertes, comme avant. Tout autre réglage s'applique aux
nouvelles opérations, car une séance en cours ne doit pas changer de
contrat de synchronisation à mi-parcours. Les cadences `tickMs`/`sweepMs`
ne sont relues qu'au démarrage : elles rythment des boucles globales et
les clients dérivent leur seuil de silence du `tickMs` annoncé dans le
welcome, les retimer à chaud exposerait les séances ouvertes à de faux
silences.

Conséquence assumée : une valeur écrite par l'admin survit à un changement
d'env tant qu'elle n'est pas réinitialisée, ce qui peut surprendre lors
d'un redéploiement.
