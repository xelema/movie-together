# Movie Night

Bibliothèque privée et séances à plusieurs, avec langues et sous-titres individuels.

## Démarrage

Node.js 22.20+, FFmpeg et FFprobe 5.1+ sont nécessaires.

```sh
npm ci
npm run setup
npm start
```

Accueil : <http://localhost:3000>. Administration : <http://localhost:3000/admin>.
Le mot de passe est dans `.env`, exclu de Git. `FFMPEG_PATH` et `FFPROBE_PATH`
permettent de choisir les exécutables. Le script de configuration reconnaît
FFmpeg et FFmpeg Full installés avec Chocolatey sous Windows.

## Utilisation

1. Dans l'administration, envoyer un film (20 Go maximum).
2. Ouvrir « Modifier le film », choisir les langues et sous-titres intégrés.
3. Ajouter éventuellement des fichiers audio externes (2 Go maximum) ou des
   sous-titres SRT/VTT (2 Mo maximum), puis cliquer sur « Préparer le film ».
4. Attendre « Prêt à regarder », créer une séance et choisir un code ou utiliser
   « Aléatoire ». Partager le lien ou le code. Les codes expirent après 12 heures.
5. L'invité saisit le code puis son pseudo. Il ne peut pas choisir un autre film.
6. Un clic sur Lecture lance tout le monde lorsque chaque lecteur est prêt.
   Si le navigateur bloque le son, cliquer une fois sur « Autoriser le son ».

Le drapeau en haut de la page permet de choisir français ou coréen. Ce choix
reste dans la session de l'onglet, y compris après un rechargement. Le menu ⚙
du lecteur contient le choix de la langue du film et des sous-titres.

Les pseudos sont librement choisis et ne constituent pas une identité vérifiée.
Les codes personnalisés acceptent 4 à 32 lettres, chiffres ou tirets, sans
distinction de casse. Un code plus long est moins facile à deviner.

## Préparation des médias

La vidéo est copiée en HLS/fMP4 sans réencodage ni changement de résolution.
H.264, HEVC, AV1 et VP9 sont acceptés, selon les capacités du navigateur utilisé.
H.264 8 bits et AAC stéréo offrent la compatibilité la plus large.

Les pistes AAC-LC mono/stéréo à 44,1 ou 48 kHz sont copiées ; les autres pistes
audio sont converties en AAC stéréo. Les fichiers audio externes commencent au
début du film, sont tronqués à sa durée ou complétés par du silence. Il faut
fournir un fichier correspondant au même montage du film ; aucun alignement
automatique des dialogues n'est effectué.

Les sous-titres textuels sont convertis en WebVTT. Les sous-titres images ne sont
pas pris en charge. Les fichiers ajoutés restent disponibles après une nouvelle
préparation. Les sous-titres utilisent du texte blanc avec une ombre, sans fond
opaque, légèrement remonté au-dessus du bord inférieur.

L'original envoyé reste intact. Un seul film est préparé à la fois ; toutes les
opérations se terminent avant la séance. Les uploads sont reprenables en
resélectionnant le même fichier. Une préparation réussie remplace sa génération
précédente. Aucun média n'est servi par un bucket public.

## Synchronisation

Le serveur est l'autorité pour lecture, pause et position. Il utilise une horloge
monotone et programme un départ commun une seconde dans le futur, acquitté par
tous les participants. Les rapports des lecteurs arrivent toutes les 200 ms.

- Au moins 8 secondes chargées avant reprise ; pause préventive sous 3 secondes.
- Un lecteur bloqué, absent ou décalé de plus de 350 ms provoque une pause commune.
- Vitesse fixe, sans accélérations audio pour corriger les petits écarts.
- Une pause manuelle ou une déconnexion exige une reprise explicite.
- Hls.js charge environ une minute en avance ; le lecteur natif Apple contrôle sa réserve.

La latence réseau et les horloges des appareils empêchent de garantir un écart
nul. Le débit doit dépasser celui du film à long terme. Garder la page visible ;
AirPlay et Picture-in-Picture ne font pas partie de la lecture synchronisée.

## Vérifications et hébergement

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

Les tests vérifient les accès, la copie vidéo, les pistes externes, les langues,
le départ commun, la pause, les sous-titres et les formats d'écran.
Voir [la validation sur appareils physiques](docs/validation.md) et
[le guide de déploiement](docs/deployment.md).

`data/movies` contient les originaux, fichiers externes, médias préparés et
métadonnées. Prévoir leur somme, une marge pour les préparations et les sauvegardes.
Les sessions et séances sont en mémoire et se ferment au redémarrage.
Utiliser un serveur unique et un disque persistant, sans instances concurrentes
sur le même répertoire. Aucun déploiement ni push n'est automatique.
