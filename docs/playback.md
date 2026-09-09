# Lecture et préparation rapide

Recherches et choix du 9 septembre 2026. Une seule version vidéo, aucune
conversion vidéo à l'upload, à la préparation ou pendant la lecture. Langue et
sous-titres sont individuels. Aucun filtre d'image n'est appliqué par l'application.

## Outils existants

| Outil | Usage |
| --- | --- |
| [FFmpeg](https://ffmpeg.org/ffmpeg.html#Streamcopy) | Copie des paquets vidéo vers HLS/fMP4, sans décodage ni encodage vidéo. Conversion audio seulement si nécessaire. |
| [hls.js](https://github.com/video-dev/hls.js) | Lecture du même HLS sur les navigateurs MSE ; Safari utilise son lecteur HLS natif. |
| [Plyr](https://github.com/sampotts/plyr) | Commandes, progression, volume, plein écran et accessibilité du lecteur. |

Shaka Player et Video.js sont d'autres lecteurs, mais ne rendent pas tous les
codecs décodables sur tous les appareils. Les outils déjà installés et les
fonctions natives suffisent ici ; aucune bibliothèque supplémentaire.

## Image d'origine

La vidéo est copiée avec `-c copy` : définition, cadence, pixels et informations
couleur restent ceux du flux source. La préparation ne force pas un profil
Rec.709 sur une source non étiquetée et n'effectue aucune conversion HDR/SDR.
Le manifeste indique PQ ou HLG lorsque le fichier déclare cette courbe.

La propriété CSS `filter` reste absente du lecteur.
Les anciens curseurs CSS ont été retirés, ainsi que leur API et leur état partagé.
Même un réglage très faible peut modifier le circuit de composition du navigateur.
Mozilla explique que les effets CSS peuvent empêcher l'affichage par le
compositeur natif et imposer un circuit WebRender dont la gestion HDR diffère :
[explication de l'équipe graphique Mozilla, juillet 2026](https://mozillagfx.wordpress.com/2026/07/14/hdr-video-in-firefox-for-windows-tech-retrospective/).

## Luminance annoncée et rendu HDR vers SDR

Sur un écran SDR, les navigateurs ne convertissent pas le PQ de la même façon.
Chromium comprime toute la plage vers la luminance crête que le fichier déclare,
donc un film gradé à 1 000 cd/m² sort très sombre. Firefox ignore cette valeur et
applique une courbe fixe. Mesures du 10 septembre 2026 sur une mire PQ en paliers,
valeurs sRGB lues dans un canvas :

| Code 10 bits | Luminance | Firefox | Chromium |
| --- | --- | --- | --- |
| 448 | 49 cd/m² | 130 | 95 |
| 512 | 103 cd/m² | 170 | 128 |
| 576 | 210 cd/m² | 204 | 170 |

Chromium lit cette crête dans les messages SEI du flux HEVC, pas dans les boîtes
`mdcv` et `clli` du conteneur, qu'il ignore pour ce codec. Il lit en revanche ces
boîtes pour VP9 et AV1. Firefox ne lit ni l'un ni l'autre. La préparation écrit donc
une crête unique dans les SEI pour HEVC et dans le conteneur pour les autres codecs.

La valeur par défaut est 203 cd/m², le blanc de référence de la BT.2408. C'est aussi
le plancher de Chromium : en dessous de 203 il ne comprime plus rien et l'image ne
peut pas être plus claire. `HDR_PEAK_NITS` permet de remonter cette valeur, ce qui
rend du détail aux hautes lumières et assombrit le reste.

Aucune image codée n'est modifiée. Seuls les deux messages informatifs placés avant
la première tranche de chaque segment changent, et le test compare les empreintes
`framemd5` de la source et de la version préparée pour le vérifier. Le RPU Dolby
Vision, en unité NAL 62, n'est pas touché.

Résultat sur un extrait du film local, luminance moyenne d'une image, écran SDR :

| Navigateur | Avant | Après |
| --- | --- | --- |
| Chrome et Brave | 2,91 | 5,20 |
| Edge | 3,10 | 5,54 |
| Firefox | 5,38 | 5,39 |

## Pourquoi l'égalité parfaite n'est pas atteignable

L'écart restant ne vient plus du mappage HDR. Firefox convertit la vidéo autrement
que le décodeur de référence, même en SDR pur. Mire 8 bits H.264 BT.709 plage
limitée, sans aucun HDR, valeurs sRGB lues dans un canvas :

| Entrée | ffmpeg | Chromium | Firefox |
| --- | --- | --- | --- |
| 64 | 13 | 13 | 2 |
| 256 | 60 | 61 | 53 |
| 512 | 124 | 125 | 121 |
| 896 | 221 | 222 | 225 |

Chromium suit le décodeur de référence à une unité près. Firefox écrase les basses
lumières et remonte les hautes. `gfx.color_management.mode` à 0 ne change rien, la
transformation est dans son circuit vidéo. Rien dans le fichier, dans le conteneur
ni dans le CSS ne peut l'annuler, et un rendu maison en WebGL demanderait WebCodecs,
qui ne décode pas HEVC dans Firefox.

Autrement dit : Chromium est celui qui est juste, Firefox est celui qui plaît.
La préparation les rapproche à quelques pour cent, elle ne peut pas les confondre.

Sans conversion vidéo, la lecture HEVC, AV1, VP9 et HDR dépend des
décodeurs et de la gestion couleur de chaque appareil. Pour la portée la plus
large, privilégier des sources H.264 SDR 8 bits et AAC. Aucune version de secours.

## Son et délai

AAC-LC intégré mono/stéréo 44,1/48 kHz est copié sans perte supplémentaire.
Le reste est converti en une seule passe AAC-LC stéréo 48 kHz à 256 kbit/s.
Le mixage natif FFmpeg conserve les voix centrales et normalise les coefficients
de mélange pour limiter la surcharge ; ce n'est pas une normalisation LUFS.
Les pistes externes sont ajustées à la durée du film par troncature ou silence.
Il n'y a ni analyse préalable du film entier ni traitement audio dans le navigateur.
Voir [le rééchantillonnage et le mixage FFmpeg](https://ffmpeg.org/ffmpeg-resampler.html).

Il faut toujours transférer le fichier, puis lire et écrire ses segments sur le
disque. Une conversion audio longue sur un petit serveur peut encore prendre
du temps, surtout avec plusieurs langues ; aucun délai fixe n'est garanti.
La vidéo garde son débit et ses images clés : ni compression supplémentaire
pour une connexion lente, ni raccourcissement artificiel des longs segments.

L'overlay expose le chargement, les attentes et les erreurs. L'autorisation du
son reste accessible dans le lecteur. La vitesse est fixe ; Espace/K, les flèches,
M et F commandent le lecteur lorsqu'il a le focus. Voir [la validation](validation.md).
