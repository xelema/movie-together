# Validation d'une séance

## Tests automatisés

- Moteur avec horloge contrôlée : préparation, pause, reprise, recherche, messages
  périmés, acquittements manquants, disparition d'un participant et fin du film.
- HTTP/WebSocket : droits admin/invité, origine, reprise d'upload, remuxage réel,
  empreintes des flux, accès aux segments, sous-titres et révocation d'invitation.
- Deux contextes Chromium : import par l'interface, invité dont les segments sont
  retardés, différence initiale inférieure à 250 ms, pause par l'invité, audio
  indépendant, versions originale/compatible différentes, déplacement et réseau coupé.
- Préparation réelle d'une mire HEVC 4K HDR et AC3 multicanal : vidéo originale
  inchangée, copie H.264 SDR et audio AAC stéréo partagé.

L'écart testé est une mesure locale ponctuelle, pas une garantie sur Internet.
Le diagnostic compare les positions des lecteurs à une horloge commune ; il ne
mesure pas la sortie physique de l'écran ou des haut-parleurs.

## Appareils physiques

| Appareil | Navigateur | Validation physique |
| --- | --- | --- |
| PC Windows / macOS | Chrome, Edge ou Firefox récent | À réaliser |
| iPhone / iPad | Safari récent, HLS natif | À réaliser |
| Android | Chrome récent | À réaliser |

Sur le serveur HTTPS, avec un film représentatif de 5 à 15 Go :

1. Ouvrir une room à deux, autoriser les lecteurs et attendre leur réserve.
2. Lire dix minutes et comparer les diagnostics. Filmer les deux écrans côte à côte
   si une mesure visuelle précise est nécessaire.
3. Alterner pause/reprise et déplacements de plusieurs minutes depuis chaque appareil.
4. Choisir VO/VF et sous-titres différents. Vérifier les voix réellement entendues,
   les phrases et leur alignement après plusieurs déplacements.
   Choisir aussi original sur un appareil et compatible sur l'autre, puis inverser.
   Sur Safari natif, vérifier particulièrement l'alignement après le changement
   de version : son origine temporelle n'est pas celle du lecteur Hls.js.
5. Réduire ou couper le débit d'un participant : vérifier pause locale, pause du
   groupe et reprise commune après retour du buffer.
6. Passer en arrière-plan, verrouiller le téléphone puis revenir : le groupe doit
   attendre. Une session fermée nécessite une nouvelle connexion.
7. Tester fin et changement de film, puis redémarrage du serveur.
8. Interrompre un upload volumineux puis reprendre avec le même fichier ; comparer
   si nécessaire son empreinte intégrale à celle de l'original stocké.

Ne pas annoncer de compatibilité matérielle validée avant ces essais. Une taille
d'écran mobile dans un navigateur de test ne reproduit pas les politiques Safari.
