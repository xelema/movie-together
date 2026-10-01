# Visio et caméra face-à-face

Movie Night propose une fonctionnalité optionnelle de caméra en face-à-face, pensée pour regarder un film à deux tout en partageant les réactions en direct.

## Principes de conception

1. **Priorité absolue au film** :
   - Le flux vidéo WebRTC est purement visuel (`audio: false`). Aucun son de microphone n'est capturé par ce canal afin de ne jamais dégrader ou parasiter la bande sonore du film, ni interférer avec la synchronisation NTP/drift.
   - Les commandes matérielles coupent immédiatement les pistes (`track.stop()`) dès que la caméra est désactivée ou la séance quittée (le voyant de la caméra s'éteint instantanément).

2. **Flux pair-à-pair direct (P2P)** :
   - Le serveur Movie Night fait uniquement office de relais de signalisation (échange des descriptions SDP `offer`/`answer` et des candidats ICE).
   - Les flux vidéo circulent directement entre les navigateurs des participants via WebRTC, sans consommer de bande passante vidéo sur le serveur.

3. **Orientation et géométrie vidéo** :
   - **Flux distant et retour local (effet miroir unifié)** : le flux distant (`#webcam-remote-video`) et le retour caméra local (`#webcam-self-preview`) partagent tous deux la même transformation en miroir (`transform: scaleX(-1)`). Les mouvements et l'orientation sont ainsi parfaitement symétriques et cohérents entre ce que l'on voit de soi-même et ce que l'autre voit.
   - **Overlay flottant** :
     - Déplaçable librement par glisser-déposer sur toute la surface de la scène vidéo (`cursor: grab`), borné aux dimensions de l'écran.
     - Redimensionnable via l'encoche discrète en bas à droite, avec verrouillage automatique du ratio 4:3 (de 140×105 px à 480×360 px) pour éviter toute déformation.
     - L'encoche s'estompe pendant la lecture du film lorsque les contrôles Plyr se masquent.
     - Parfaite compatibilité plein écran (`#screen:fullscreen`) avec cadrage `object-fit: cover` sans aucune bande noire de letterboxing.

Sur Chrome pour Android, l'invite de permission caméra fait quitter le plein
écran au navigateur sans passer par l'API de la page : le document peut alors
continuer à nommer `#screen` comme élément plein écran alors qu'il est revenu
dans la page. Le lecteur décide depuis l'élément peint plutôt que ce nom,
solde l'état resté avant de rentrer et ne rentre jamais sans geste — l'appui
qui suit l'invite ramène le plein écran.

## Règle de capacité : 2 participants maximum

Pour garantir une expérience optimale et sans surcharge réseau :
- Toute séance créée avec l'option caméra activée (`webcam: { enabled: true }`) est **strictement limitée à 2 participants simultanés**.
- Si un troisième participant tente de rejoindre la séance :
  - L'API HTTP `POST /api/join` renvoie un code d'erreur `409 Conflict` avec le message explicite : *« Séance complète (2 personnes maximum avec caméra). »* (traduit également en coréen).
  - L'upgrade WebSocket `/ws` rejette toute tentative de connexion surnuméraire avec `403 Forbidden`.
- Si l'un des deux participants quitte la séance, la place redevient automatiquement accessible.

## Évolutions futures (Roadmap)

Des pistes d'amélioration sont prévues pour les versions ultérieures :
- **Gestion sur second écran / Fenêtre détachée (Pop-out)** :
  - Possibilité de détacher le flux caméra de l'autre participant dans une fenêtre indépendante (via l'API Document Picture-in-Picture ou un onglet dédié).
  - Permet d'afficher le film en plein écran sur un écran principal (ou vidéoprojecteur/TV) tout en gardant la visio sur l'écran d'un ordinateur portable ou d'un second moniteur.
- **Support au-delà de 2 participants** :
  - Étude d'un maillage WebRTC pour les petits groupes (3 à 4 personnes).
  - Disposition adaptative en grille ou mosaïque dynamique sur le côté de l'écran.
