# Movie Night

Bibliothèque privée de films et séances synchronisées en petits groupes.

## État

Étape 1 : noyau de coordination des rooms, sans serveur ni lecteur pour le moment.
Exécuter les tests avec Node.js 22 ou supérieur : `npm test`.

## Principes

- Le serveur possède la position de référence et ordonne les commandes.
- Chaque participant peut mettre en pause. Audio et sous-titres restent individuels.
- Une reprise attend la réserve de tous les participants et programme un départ futur commun.
- Une réserve faible, un lecteur bloqué ou des rapports absents suspendent le groupe.
- Chaque pause ou déplacement invalide les rapports précédents via une génération (`epoch`).
- Un départ de participant met la séance en pause jusqu'à une reprise explicite.
- Aucun réencodage audio ou vidéo : refuser les pistes incompatibles, autoriser le remuxage sans perte.
- Films attendus : 5 à 15 Go. Un administrateur et des invités sans compte.

L'absence totale de décalage ou d'interruption n'est pas garantie sur Internet.
La précision réelle devra être mesurée sur PC, iOS et Android. Un débit durablement
inférieur au débit du film nécessite une attente supplémentaire ou une autre source.

## Étapes suivantes

1. Transport WebSocket, estimation du décalage des horloges, acquittements de
   préparation et de démarrage, reconnexion et correction de dérive du lecteur.
2. Import analysé par FFprobe, préparation HLS avec FFmpeg, pistes audio séparées
   et sous-titres WebVTT, selon les formats et la politique de conversion retenus.
3. Lecteur web : HLS natif sur Safari et lecteur compatible ailleurs, choix des
   langues, rapports sur la plage tamponnée contiguë et pause préventive.
4. Administration authentifiée, uploads reprenables, bibliothèque et invitations
   révocables avec limitation des essais de codes.
5. Déploiement Google Cloud et vérification avec deux appareils physiques.

## Contraintes du futur adaptateur réseau

Le moteur est volontairement indépendant du transport. L'adaptateur devra appeler
`tick()` régulièrement, diffuser chaque changement et authentifier les membres.
Il devra convertir les horloges serveur/client, mesurer la latence, choisir une
marge de départ adaptée et bloquer la reprise si un acquittement manque.
Le délai et les seuils du noyau sont provisoires. Le lecteur devra signaler ses
blocages, ses changements de pistes et ses déplacements, et arrêter localement
la lecture s'il perd la connexion de coordination. `load()` est réservé au serveur.

## Hébergement envisagé

Application conteneurisée, stockage privé des médias dans Cloud Storage et import
dans un processus distinct. Le choix Compute Engine ou Cloud Run reste à fixer.
Avec Cloud Run, les WebSockets ont une durée limitée et l'affinité est indicative :
il faut prévoir reconnexion et coordination partagée avant plusieurs instances.

Références : [HLS Apple](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/)
et [WebSockets Cloud Run](https://docs.cloud.google.com/run/docs/triggering/websockets).
