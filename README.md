# Movie Night

Bibliothèque privée et séances à plusieurs, avec langues et sous-titres individuels.

## Démarrage

Node.js 22.20+, FFmpeg et FFprobe 5.1+ sont nécessaires, avec l'encodeur AAC.
La vidéo n'est jamais réencodée. Les tests créent leurs extraits avec libx264.

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

1. Dans l'administration, envoyer un film (20 Go maximum). Le titre proposé reprend
   le nom du fichier sans les mentions d'encodage, et reste modifiable.
2. Ouvrir « Gérer le film », choisir les langues et sous-titres intégrés, et
   écrire le nom que chacun verra. Laissé tel quel, le nom est en anglais.
   Aucun terme technique n'est affiché aux participants.
3. Ajouter éventuellement des sous-titres SRT/VTT (2 Mo maximum) dans
   « Sous-titres ajoutés », puis cliquer sur « Préparer le film ». Sur un film
   prêt, l'ajout et le retrait de sous-titres sont immédiats.
4. Attendre « Prêt à regarder », créer une séance et choisir un code ou utiliser
   « Aléatoire ». Partager le lien ou le code. Les codes expirent après 12 heures.
5. L'invité saisit le code puis son pseudo. Il ne peut pas choisir un autre film.
6. Un clic sur Lecture lance tout le monde lorsque chaque lecteur est prêt.
   Si le navigateur bloque le son, cliquer une fois sur « Activer le son ».

Le drapeau en haut de la page permet de choisir français ou coréen. Ce choix
reste dans la session de l'onglet, y compris après un rechargement. Le menu ⚙
du lecteur contient le choix de la langue du film et des sous-titres.
Le lecteur affiche une image sRGB calculée par WebGL sur l'appareil. La même
conversion HDR10/HLG et la même courbe de hautes lumières sont utilisées pour tous.
La vidéo conserve son décodeur natif, sa piste sonore et son horloge de synchronisation.

L'interface utilise Instrument Sans et IBM Plex Mono, servies depuis `public/fonts`.
Rien n'est chargé depuis un domaine externe : la politique de sécurité du contenu
n'autorise que les ressources du serveur.

Les pseudos sont librement choisis et ne constituent pas une identité vérifiée.
Les codes personnalisés acceptent 4 à 32 lettres, chiffres ou tirets, sans
distinction de casse. Un code plus long est moins facile à deviner.

## Préparation des médias

Une seule version est préparée en HLS/fMP4 pour tous, en copiant la vidéo
originale : aucun réencodage, redimensionnement ni changement de cadence.
Les indications de couleur du transport sont uniformisées ; les caractéristiques
originales sont conservées séparément pour le rendu. La préparation relit le fichier et écrit ses segments ; sa durée
dépend surtout de la taille du fichier, du disque et des éventuelles conversions
audio. La durée des segments dépend des images clés de l'original.

H.264, HEVC, AV1 et VP9 peuvent être préparés, mais leur lecture dépend des
décodeurs du navigateur et de l'appareil. Pour la compatibilité la plus large,
privilégier un fichier source H.264 SDR 8 bits. Il n'existe pas de version de
secours. HDR10, HLG et les bases compatibles de Dolby Vision sont affichés en SDR
sRGB par le GPU du spectateur. Le serveur ne calcule ni ne réencode les images.
WebGL et le décodage du codec source sont nécessaires. Voir [le rendu couleur et
ses vérifications](docs/playback.md).

Les pistes intégrées AAC-LC mono/stéréo à 44,1 ou 48 kHz sont copiées à l'identique.
Les autres pistes audio sont converties en une seule passe en AAC-LC stéréo
48 kHz à 256 kbit/s, avec mixage des voix centrales. Aucune analyse intégrale
préalable, normalisation en deux passes, égalisation ou spatialisation artificielle.

Les sous-titres textuels sont convertis en WebVTT. Les sous-titres images ne sont
pas pris en charge. Les fichiers ajoutés restent disponibles après une nouvelle
préparation. Les sous-titres utilisent du texte blanc avec une ombre, sans fond
opaque, légèrement remonté au-dessus du bord inférieur.

L'original envoyé reste intact. Un film préparé avec l'ancien réencodage doit être
préparé à nouveau pour retrouver sa vidéo d'origine. Un seul film est préparé à la fois ; toutes les
opérations se terminent avant la séance. Les uploads sont reprenables en
resélectionnant le même fichier. Une préparation réussie remplace sa génération
précédente. Aucun média n'est servi par un bucket public.

## Synchronisation

Le serveur est l'autorité pour lecture, pause et position. Il utilise une horloge
monotone et programme un départ commun une seconde dans le futur, acquitté par
tous les participants. Les rapports des lecteurs arrivent toutes les 200 ms.

- Par défaut en production, 20 secondes chargées avant reprise ; pause préventive sous 5 secondes.
- Un lecteur bloqué, absent ou décalé de plus de 350 ms provoque une pause commune.
- Vitesse fixe, sans accélérations audio pour corriger les petits écarts.
- Une pause manuelle ou une déconnexion exige une reprise explicite.
- Hls.js vise deux minutes en avance ; le lecteur natif Apple contrôle sa réserve.

La latence réseau et les horloges des appareils empêchent de garantir un écart
nul. Le débit doit dépasser celui du film à long terme. Garder la page visible ;
AirPlay et Picture-in-Picture ne font pas partie de la lecture synchronisée.

## Vérifications et hébergement

```sh
npm test
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:colors
```

Les tests vérifient les accès, la copie exacte des flux vidéo et AAC, les
métadonnées SDR/HDR, les pixels du rendu commun, les voix centrales, les pistes externes, les langues,
le départ commun, la pause, les sous-titres et les formats d'écran.
Voir [la validation sur appareils physiques](docs/validation.md) et
[le guide de déploiement](docs/deployment.md).

Pour envoyer rapidement le site sur une VM GCP ou OCI, x86_64 ou ARM64 :
[installation rapide](docs/quickstart.md).

`data/movies` contient les originaux, fichiers externes, médias préparés et
métadonnées. Prévoir leur somme, une marge pour les préparations et les sauvegardes.
Les sessions et séances sont en mémoire et se ferment au redémarrage.
Utiliser un serveur unique et un disque persistant, sans instances concurrentes
sur le même répertoire. Aucun déploiement ni push n'est automatique.
