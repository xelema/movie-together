# Movie Night

Bibliothèque privée de films, uploads reprenables et séances synchronisées.
Un administrateur importe les films ; les invités rejoignent une room avec un
code ou un lien temporaire, sans compte. Jusqu'à huit connexions par room.

## Démarrage local

Prérequis : Node.js 22.20 ou supérieur, FFmpeg et FFprobe 5.1 ou supérieur dans le PATH.

```sh
npm ci
npm run setup
npm start
```

Ouvrir <http://localhost:3000>. Le mot de passe administrateur est dans `.env`,
créé par `npm run setup` et exclu de Git. Sur Windows, le script privilégie le
FFprobe de Chocolatey quand il est installé. `FFMPEG_PATH` et `FFPROBE_PATH`
permettent de choisir d'autres exécutables. Ne pas partager `.env`.

Pour un autre appareil, utiliser une URL HTTPS commune configurée dans `APP_ORIGIN`.
L'upload utilise les API cryptographiques disponibles sur localhost ou HTTPS.

## Utilisation

1. Se connecter à l'administration et envoyer un film (maximum 20 Go).
2. Ouvrir « Gérer le film et les pistes », sélectionner les audios et sous-titres
   embarqués puis lancer la préparation. L'original reste intact. Laisser cochée
   « Copie compatible SDR si nécessaire » pour les appareils différents.
   Attendre le statut « Prêt » avant de créer la room : la conversion peut être longue.
3. Facultativement, ajouter des sous-titres externes SRT/VTT et renommer le film.
4. Créer une room et transmettre le lien ou le code affiché à son invité.
5. Chaque participant renseigne son pseudo dans la séance et clique sur Lecture.
   Ce même bouton autorise le son et demande le départ commun, quand tous sont prêts.
6. Chacun peut mettre en pause ou déplacer la position commune. Audio et sous-titres
   et version vidéo sont individuels. Un changement de piste ou de version met le
   groupe en pause ; relancer ensuite.

Un upload interrompu reprend après sélection du même fichier. Une empreinte du début,
de la fin et des métadonnées évite les confusions courantes de fichiers homonymes ;
ce n'est pas une empreinte intégrale. Les blocs sont envoyés séquentiellement,
avec vérification de leur position par le serveur.

Les invitations expirent après 12 heures et peuvent être révoquées dans l'admin.
Elles donnent accès à la liste des films prêts ; les médias accessibles aux invités
sont ceux des rooms qu'ils ont rejointes. Chaque participant peut choisir un film
de la bibliothèque pour sa room. Modifier un film en cours de visionnage est bloqué.

## Formats et préparation avant lecture

L'import n'impose aucune limite de résolution, de niveau ou de HDR. FFmpeg doit
pouvoir lire la vidéo et sa durée. Les versions de lecture sont entièrement
préparées sur disque ; aucun encodage n'est lancé pendant une séance.

| Élément | Formats pris en charge |
| --- | --- |
| Vidéo originale | H.264, HEVC/H.265, AV1 ou VP9 copiés en HLS/fMP4, résolution et profondeur conservées, y compris 4K/HDR |
| Copie compatible | H.264 8 bits SDR, au plus 1920 × 1080 et 60 images/s, sans agrandissement ; autres codecs décodables acceptés via cette copie |
| Audio | AAC-LC mono/stéréo copié ; autres pistes décodables converties en AAC stéréo 192 kbit/s |
| Sous-titres embarqués | SubRip, WebVTT, mov_text, ASS/SSA textuels |
| Sous-titres externes | SRT ou VTT, maximum 2 Mo |

Le fichier envoyé reste intact. La vidéo originale de lecture est remuxée sans
réencodage ; sa lecture dépend des codecs et du HDR pris en charge par l'appareil.
La copie compatible est proposée par défaut et évitée si la vidéo est déjà H.264
8 bits SDR jusqu'à 1080p/niveau 4.2. Chaque participant choisit sa version, avec une
position commune corrigée du décalage temporel propre à chaque version préparée.
Les pistes audio préparées sont partagées entre les versions pour éviter leur duplication.
Les films muets sont acceptés ; sinon sélectionner au moins une piste audio.

Le HDR10 et HLG sont convertis en SDR par tone mapping (`zscale` et `tonemap`
requis dans FFmpeg). Dolby Vision avec base HDR10/HLG/SDR utilise cette base pour
la copie compatible. Le remuxage ne garantit pas la signalisation Dolby Vision :
un extrait DV 8.1 testé conserve son flux vidéo et son HDR10, mais perd l'annonce
Dolby Vision du conteneur. Pour Dolby Vision sans base compatible, notamment le
profil 5, la copie SDR exige FFmpeg avec `libplacebo`, Vulkan et un pilote fonctionnel.
Si ces composants manquent, la préparation échoue avec un message explicite ;
la distribution Windows FFmpeg Essentials ne les fournit pas tous.

Les sous-titres sont convertis en WebVTT ; la mise en forme avancée ASS/SSA peut
être perdue. Les sous-titres images PGS/VobSub et l'ajout d'audios provenant de
fichiers externes ne sont pas pris en charge.

## Synchronisation et buffer

Le serveur possède la position de référence et une horloge monotone. Les clients
estiment leur décalage d'horloge par WebSocket, en privilégiant les mesures les
moins retardées. Le départ est programmé une seconde dans le futur et doit être
acquitté par tous avant son échéance.

- Rapports du lecteur toutes les 200 ms ; réserve mesurée dans la plage contiguë
  contenant la position, sans compter les segments après un trou.
- Au moins 8 secondes de réserve chez chacun avant reprise, pause préventive sous
  3 secondes. Réglages : `MIN_BUFFER_SECONDS` / `LOW_BUFFER_SECONDS`.
- Hls.js tente de charger 60 secondes en avance. Safari utilise son lecteur HLS
  natif et décide de sa réserve ; les limites mémoire sont celles de l'appareil.
- Blocage, dérive supérieure à 350 ms ou rapports absents pendant 3 secondes :
  pause du groupe et nouvelle préparation.
- Lecture à vitesse fixe pour éviter les artefacts audio du changement de vitesse.
  Les petits écarts sont tolérés ; au-delà de 350 ms, pause et réalignement commun.
- Messages serveur absents pendant 1,5 seconde : pause locale de sécurité.
- Une pause manuelle ou une déconnexion exige une reprise explicite.

Les générations de position rejettent les rapports et déplacements retardés.
Une commande de pause reste toujours effective. Garder la page au premier plan.
Arrière-plan, AirPlay et Picture-in-Picture ne font pas partie du mode synchronisé.
Les contrôles sont fournis par Plyr, avec sélection individuelle des pistes et
versions sous la vidéo. La liste des participants affiche leurs pseudos (librement
choisis, sans vérification d'identité). Un indicateur nomme les personnes attendues
pendant la préparation du buffer. Les fichiers du lecteur sont servis localement.

**Un décalage nul et une absence totale d'interruption ne sont pas garantis.**
Les pauses se propagent avec la latence réseau. Le débit doit rester supérieur à
celui du film à long terme : 15 Go sur deux heures représentent environ 16,7 Mbit/s
en moyenne, avant marge pour les pointes. Le navigateur ne peut pas précharger
sans limite 15 Go. Des images clés très espacées donnent des segments plus longs ;
le remuxage ne peut pas créer de nouvelles images clés.

## Vérifications

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

Tests du moteur, horloges, trous de buffer, upload/reprise, accès privé, FFmpeg réel,
empreintes des flux avant/après remuxage, conversion 4K HDR vers SDR et audio AC3
vers AAC, sous-titres et deux navigateurs avec versions vidéo et audio
indépendants, pause, déplacement et coupure réseau. Les vidéos de test sont des mires
synthétiques. Ces essais ne remplacent pas une séance sur iPhone et Android physiques :
voir [docs/validation.md](docs/validation.md).

## Hébergement et données

[Guide Google Cloud](docs/deployment.md) : VM Compute Engine, Docker Compose, HTTPS
avec Caddy et disque persistant. Aucune base externe ni bucket public. Le processus
Node sert les segments sans compression HTTP.

`data/movies` conserve les originaux, les pistes et les métadonnées JSON écrites
par remplacement atomique ; `data/uploads` conserve les imports partiels. Prévoir
la taille des originaux + les vidéos remuxées + les copies compatibles + les audios
préparés, plus une marge de travail et de sauvegarde. Ce n'est donc pas un facteur
deux fixe. Une copie compatible plafonnée à 8 Mbit/s représente jusqu'à environ
7,2 Go pour deux heures, hors audio. Repréparer conserve l'ancienne génération
jusqu'à réussite et demande temporairement l'espace pour les deux générations.
Un seul import est traité à la fois, dans un sous-processus FFmpeg, avec progression
dans l'administration. `ENCODE_THREADS` limite les threads de décodage/encodage
vidéo (2 par défaut, au plus 8) ; préparer de la 4K HDR sur un petit serveur peut
prendre plusieurs heures. Cette limite ne plafonne pas toute l'activité CPU du processus.

Les sessions et rooms sont en mémoire : un redémarrage les ferme, mais conserve
films et uploads. Un import interrompu est signalé en échec. Ne pas lancer plusieurs
instances sur le même répertoire. Une future montée en charge pourra séparer stockage,
import et coordination ; cette version cible un petit groupe sur un serveur unique.

Références : [HLS Apple](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/),
[FFmpeg HLS](https://ffmpeg.org/ffmpeg-formats.html#hls),
[Hls.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md).
