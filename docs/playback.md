# Lecture et couleur

La préparation copie les images compressées avec `-c copy`. Aucun encodeur vidéo,
filtre de pixels, redimensionnement ou calcul de tone mapping ne tourne sur le
serveur. L'original envoyé reste intact.

## Origine des écarts

Un lecteur HTML natif laisse le navigateur, son décodeur et le système convertir
HDR vers l'écran. Leurs courbes diffèrent. Modifier MaxCLL ou la luminance de
mastering à 203 cd/m² rapproche certaines images, mais ne définit pas une
conversion commune et fausse les caractéristiques de la source.

L'import vidéo WebGL présente aussi des différences. La matrice utilisée par le
décodeur vient de la VUI du flux quand elle est renseignée, la boîte `colr` du
conteneur ne servant que de repli. Le drapeau
`UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE` garde les valeurs décodées sans
conversion supplémentaire vers l'espace de travail.

## Rendu commun

1. FFmpeg copie les paquets sans les modifier et écrit la couleur de la source
   dans la boîte `colr` de la piste. Le flux codé n'est pas touché : sa VUI
   décrit déjà la même chose. Les mesures de la sonde couleur montrent que la
   VUI prime sur le conteneur quand elle est renseignée ; recopier la même
   matrice dans la boîte garantit que le décodeur l'utilise dans les deux cas.
2. `rendition.color` conserve les caractéristiques couleur originales. Le fichier
   reste lisible nativement, mais le rendu de référence reste celui du lecteur
   de l'application.
3. Pour une source HDR, l'élément vidéo décode et synchronise normalement, avec
   la matrice de la source. Sur un écran HDR (`dynamic-range: high`, confirmé
   par les champs HDR de MediaCapabilities), la lecture native présente déjà le
   PQ/HLG : l'équivalent du passthrough de mpv, sans coût GPU, et le shader ne
   se crée pas. Ailleurs, WebGL importe les images avec la conversion
   automatique désactivée, applique PQ ou HLG et transforme les primaires en
   Rec.709. Une source SDR garde la lecture native : tous les navigateurs y
   appliquent déjà la même conversion, le shader ne ferait que coûter du GPU.
4. Le shader HDR reproduit le pipeline de mpv `vo=gpu-next` : linéarisation,
   spline de tone mapping, mappage perceptuel du gamut, sortie gamma 2,2 vers
   la cible calibrée sur l'écran de référence (75 nits) avec dither. Le pic
   d'entrée est statique, pris sur la source comme mpv `--hdr-compute-peak=no` :
   luminance de mastering, MaxCLL à défaut, sinon le maximum du transfert
   (10 000 nits en PQ, 1 000 en HLG).
5. Le résultat sRGB est affiché dans un canvas. Les commandes Plyr, l'audio et
   l'horloge utilisent toujours la vidéo. Les sous-titres textuels sont placés
   au-dessus du canvas à partir des cues du lecteur.

Il n'y a aucun réglage par nom de navigateur, filtre CSS de luminosité, encodeur
WebCodecs ni nouvelle dépendance. `requestVideoFrameCallback` cadence le rendu.
Le choix natif/shader se rejoue quand la fenêtre change d'écran, et le paramètre
d'URL `#hdr=shader` force le shader si une présentation HDR native décevait.
Une défaillance WebGL interrompt la lecture et affiche une erreur au lieu de
montrer silencieusement le transport avec de mauvaises couleurs.

Aucun filtre de bitstream n'est utilisé. Sur un fichier HEVC Main 10 Dolby Vision
profil 8 réel, tout filtre modifiant les paquets casse le décodage : `hevc_metadata`,
mais aussi `filter_units` qui ne fait que retirer des unités NAL sans importance pour
le décodeur. Le flux sort alors avec `alignment_bit_equal_to_one=0` puis
`Error constructing the frame RPS`, ce qui donne une image verte ou pas d'image du
tout. Une passe CBS sans modification est propre, l'écriture ne l'est pas. La
préparation décode donc les premières secondes de chaque version avant de la servir
et refuse une version illisible.

Comme le bitstream n'est plus touché, les messages SEI de mastering HDR et le RPU
Dolby Vision restent présents. Les mesures montrent qu'ils ne changent pas le rendu :
le chemin WebGL n'utilise pas ces métadonnées.

Référence : [paramètres d'import WebGL](https://registry.khronos.org/webgl/specs/latest/1.0/#PIXEL_STORAGE_PARAMETERS).
WebGL utilise ici le décodeur de l'élément vidéo sans dépendre de la disponibilité
de `VideoDecoder` pour HEVC.

## Géométrie des sous-titres natifs

WebVTT place une réplique sur la dernière ligne de l'image — sous la barre de
contrôle, rognée par le bas du cadre — tant que rien ne la déplace :
`positionSubtitles` la remonte à 84 % de la hauteur peinte avec
`snapToLines = false`, `line` et `lineAlign = 'end'`. Cette écriture n'était
faite que pour les cues **actives**, sur `cuechange`, et Firefox peint une
réplique qui vient d'être activée avant que le gestionnaire d'événement ne pose
la géométrie : le sous-titre apparaissait donc une ou deux images plus bas (et
d'autant plus visible qu'il passe derrière la barre de contrôle). Chrome peint
dans l'autre ordre, le défaut n'y est pas visible.

Mesure dans une salle réelle sur cette machine (film de test de 60 s, 28
répliques, sous-titres français) : avant correctif, les 28 répliques recevaient
leur géométrie **après** leur propre début (avance mesurée −0,02 s) et 5 images
échantillonnées montraient une réplique affichée à la position par défaut ;
après correctif, 0 dans les deux cas, chaque cue portant la géométrie dès son
entrée dans la piste (2 à 8 s d'avance sur son début sur ce film).

La géométrie voyage donc avec la cue : `adoptSubtitleTrack` enveloppe `addCue`
de chaque piste de texte (hls.js ajoute les cues par fragment, bien avant leur
activation) et la passe complète de `positionSubtitles` réaligne toute la liste
quand `line` bouge (barre de contrôle, redimensionnement, plein écran, rotation).

## Vérification et portée

`npm run test:colors` fabrique uniquement des mires de test courtes, les prépare
en HLS, puis mesure les pixels dans Chrome et Firefox. Chaque mire est aussi
comparée au rendu attendu, calculé depuis ses codes connus par un modèle
indépendant, pas seulement d'un navigateur à l'autre. Les captures et mesures
sont écrites dans `test-results/colors`. Sous Windows, les navigateurs sont ouverts
avec fenêtre : le Firefox sans fenêtre ne décode pas le HEVC testé.

Mesures obtenues sur la machine Windows de développement (Chrome 152, Firefox 155) :

| Mire | Écart moyen | p99 | Maximum |
| --- | --- | --- | --- |
| HDR10 (PQ, BT.2020) | 0,683 | 2 | 3 |
| HLG (BT.2020) | 0,683 | 2 | 3 |
| SDR BT.709 | 0,461 | 6 | 50 |
| SDR BT.601 | 0,180 | 3 | 53 |

Les valeurs sont en niveaux sur 255 par canal. L'écart résiduel vient de l'arrondi
YUV vers RGB des décodeurs, avant le shader. Le maximum se concentre sur les
patchs saturés à la limite de saturation de la texture 8 bits. Sur un extrait réel du film en HEVC
4K HDR10 Dolby Vision profil 8, l'écart moyen mesuré au même horodatage est de
0,428 sur 255 pour un maximum de 3. Ces mesures concernent cette machine et ce
chemin de décodage.

Les images compressées conservent leur profondeur. L'import de texture utilisé
ici passe toutefois par RGBA 8 bits : il ne garantit pas un intermédiaire 10 bits
ni l'absence de banding sur tous les dégradés. Des couleurs très saturées peuvent
subir un écrêtage dans la conversion YUV/RGB du décodeur avant le shader.
Les différences physiques entre écrans ne sont pas mesurées par un test de pixels.

Le HEVC en plage complète demande une vérification particulière : Firefox Windows
peut ignorer cette plage lors de l'import WebGL. Safari/iOS, Android et les écrans
HDR physiques doivent encore être vérifiés ; les dimensions mobiles émulées et
Playwright WebKit sous Windows ne constituent pas ces essais. Dolby Vision sans
base HDR10/HLG/SDR compatible n'est pas interprété comme du HDR10.

Sur certains appareils Android, `texImage2D` ne reçoit jamais les pixels de la
vidéo et la texture garde une couleur sentinelle uniforme (violet sous Firefox,
bug Mozilla 1884282) alors que l'élément vidéo affiche l'image correctement.
Le rendu sonde quelques pixels de la frame dessinée : si elle est parfaitement
uniforme, le canvas est masqué et l'élément vidéo natif reprend le relais jusqu'à
ce que l'import redevienne valide. Pour un film HDR ce repli affiche la vidéo en
SDR tel quel plutôt qu'en violet.

Une ancienne préparation doit être actualisée pour utiliser ce rendu.
`HDR_PEAK_NITS` n'est plus utilisé. Les versions sans `rendition.color` conservent
leur ancien chemin de lecture pendant la migration.

## Lecture native : la courbe vidéo de Firefox sous Windows

Firefox Windows applique à la vidéo une courbe de contraste fixe, absente de
Chromium. Mesurée sur un dégradé de gris de 256 niveaux encodé en H.264 BT.709
et lu par un élément vidéo nu, sans code de l'application :

| Niveau d'entrée | 16 | 32 | 64 | 96 | 128 | 160 | 176 | 208 | 240 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium | 16 | 31 | 64 | 95 | 128 | 159 | 176 | 208 | 223 |
| Firefox | 5 | 21 | 56 | 90 | 125 | 158 | 176 | 211 | 244 |

Les ombres perdent jusqu'à onze niveaux, le point de pivot se situe vers 176 et
les hautes lumières remontent légèrement : l'image paraît plus sombre et plus
contrastée. La courbe ressort à l'identique d'une capture de l'élément vidéo
composé à l'écran, pas seulement d'une extraction `drawImage` vers un canvas 2D.
C'est bien ce que voit le spectateur, pas un artefact de mesure.

La courbe reste identique, au niveau près, dans toutes les variations testées :

- flux tagué BT.709, VUI `unspecified` ou sans aucune indication couleur ;
- boîte `colr` présente ou absente, VUI forcée dans l'extradata par
  `h264_metadata`, SPS en bande retirés du flux ;
- H.264 ou VP9, profil Baseline, Main ou High ;
- décodage matériel désactivé ;
- `gfx.color_management.mode` à 0 ou 1, `gfx.color_management.native_srgb`
  vrai ou faux.

Le même dégradé affiché en `<img>` sort identique dans les deux navigateurs :
seule la présentation vidéo est concernée, pas la gestion de couleur globale de
la page. Sur un extrait réel, Chromium colle à la référence FFmpeg à environ un
niveau près alors que Firefox rend la même frame environ huit niveaux plus
sombre en moyenne. C'est un comportement connu de Firefox sous Windows
([bug Mozilla 1834680](https://bugzilla.mozilla.org/show_bug.cgi?id=1834680) et
rapports apparentés), situé dans la conversion des images décodées vers
l'espace d'affichage.

Conséquence : la lecture native d'un film SDR ne rend pas la même image sous
Firefox et sous Chromium, quelles que soient les métadonnées du fichier. Cette
déformation est causée par la promotion du plan vidéo en superposition matérielle
DirectComposition (D3D11 VideoProcessorBlt). Lorsqu'un élément avec composition
complexe (tel que l'overlay webcam avec `backdrop-filter`) est affiché par-dessus,
Firefox rétrograde la vidéo vers WebRender, rétablissant ainsi les couleurs neutres.
Côté application, forcer un filtre d'identité (`filter: contrast(100%)`) sur Gecko
cible WebRender et neutralise cette dérive de contraste en permanence, assurant
une parité colorimétrique constante que la webcam soit active ou non.
La courbe exacte peut dépendre de la machine, pilote GPU et profil d'écran ; elle
reste à vérifier sur un autre poste.

## Plein écran : la transition de luminosité de Chromium

À l'entrée du plein écran, Chromium présente la vidéo plus claire pendant
environ une seconde avant de retrouver le rendu normal. Sur la machine de
référence, une capture directe de l'écran montre la luminance moyenne doubler à
la transition puis décroître sur ~1,3 s. Le défaut se reproduit sur un élément
`<video>` nu servi par hls.js, sans aucun code de l'application, avec la même
signature. La vidéo bascule alors entre chemins de présentation (plan composité
et overlay) dont les conversions couleur diffèrent, une transition connue côté
Chromium. mpv ne la montre pas, sa surface de rendu ne change pas de chemin.
Aucun levier n'existe côté application : la page ne contrôle pas la
présentation plein écran du navigateur. La mesure venant de l'écran virtuel de
la session distante, elle reste à confirmer sur un écran physique.

Sur Android, une invite de permission (caméra, micro) s'ouvre en plein écran au
prix du plein écran lui-même : Chrome en sort de lui-même, sans passer par
l'API de la page, et le document continue de nommer `#screen` comme élément
plein écran alors que le navigateur l'a lâché. Pire, toute demande d'entrée qui
suit reste sans réponse — la promesse ne se résout jamais, sans erreur
(régression Chromium 496907116, Android). Le lecteur décide donc depuis une
transition observée — un viewport qui rétrécit sans `fullscreenchange` vaut
sortie —, ne retient jamais le bouton derrière une promesse qui ne se résout
pas (`enter-pending` au journal, l'appui suivant retente) et ne rentre jamais
sans geste : c'est l'appui qui suit l'invite qui ramène le plein écran. La
source du mal est traitée en amont, dans `public/media-permission.js` : une
invite ne s'ouvre jamais pendant que la page est en plein écran (voir
`docs/webcam.md`).

## Son et préparation

AAC-LC intégré mono/stéréo 44,1/48 kHz est copié. Le reste de l'audio est converti
en une seule passe AAC-LC stéréo 48 kHz à 256 kbit/s.
Aucune analyse sonore intégrale ni seconde passe.

Le coût vidéo reste celui d'une lecture et d'une écriture du fichier avec analyse
des en-têtes. Le temps dépend du débit disque et de la taille ; aucun décodage
vidéo intégral n'est ajouté. Une conversion audio peut encore prendre du temps.
Voir [les tests sur appareils](validation.md).

## Gain de lecture

Le volume d'un `<video>` plafonne à 100 % : passé la pleine échelle, un film déjà
normalisé n'a plus de marge, et c'est le plafond du lecteur qui limite l'écoute.
`public/audio-boost.js` intercale donc un gain Web Audio sur l'élément, monté au
premier geste (un `AudioContext` né hors appui démarre suspendu, et iOS ne le
relance jamais seul). Le curseur du lecteur garde son échelle 0..1 et son maximum
vaut 1,5× la bande son d'origine — mesuré 1,5× en régime ordinaire, soit +3,5 dB.
Un limiteur 1 dB sous la saturation retient ce qui dépasse : la crête qui entre à
1,4 sort sous 1. Le limiteur du Web Audio n'est pas transparent sous son seuil —
sa courbe normalisée ajoute 1,067×, mesuré sur les trois moteurs — donc l'étage de
gain porte 1,5×/1,067, et c'est le rapport net que mesure l'e2e.

Le gain est refusé là où le moteur confisque le volume de l'élément. Une fois le
film routé, WebKit n'applique plus `volume` ni `muted` dans le graphe : sur macOS
et iOS, curseur et bouton muet n'auraient plus d'effet, et son lecteur HLS natif ne
se route déjà pas de façon fiable. Safari et iOS gardent donc le son de l'élément,
à son plafond. `e2e/audio-boost.spec.js` tient la mesure des deux côtés : le
rapport de gain sur une crête pleine échelle et sur le régime ordinaire, la sonde
de volume par moteur, et le refus du gain sur WebKit.

## Fluidité et budget mobile

Optimisations du 12 septembre 2026, applicables aussi aux ordinateurs :

| Chemin | Modification | Effet attendu |
| --- | --- | --- |
| Rendu couleur | Canvas limité aux pixels physiques affichés, ratio du film conservé, recalcul au redimensionnement et en plein écran | Moins de fragments à traiter lorsque la source dépasse l'écran |
| GPU | Vérification synchrone des erreurs au démarrage, au redimensionnement, après erreur et toutes les deux secondes | Évite un aller-retour bloquant à chaque image, conserve la détection des erreurs |
| Shader HDR | Constantes PQ de la source et de l'écran calculées une fois au chargement | Retire quatre puissances du calcul par pixel, sous réserve des optimisations propres au pilote |
| Présentation | Soumission GPU explicite avec `flush()` | Envoie le travail sans attendre son achèvement |
| Images inutiles | Pas de dessin dans un onglet masqué ni de nouvelle copie à horodatage inchangé dans la boucle de secours | Moins de travail et de consommation au repos |
| Interface | Les textes, attributs et participants sont reconstruits seulement quand les valeurs affichées changent | Moins de mutations DOM pendant le film |
| WebSocket | Les rapports ordinaires utilisent la diffusion de 200 ms déjà existante | En régime stable, environ 5 états par seconde reçus au lieu de 15 à deux participants ou 45 à huit |
| HLS | Cible minimale de 30 s, plafond cible de 60 s, budget de 60 Mio, historique de 10 s | Réduit la pression mémoire par rapport aux anciennes cibles 120 à 180 s et 120 Mio |

Le budget HLS en octets n'est pas une limite mémoire stricte. Hls.js le combine
avec la durée et le débit, et un segment entier peut dépasser la cible.
La réserve plus courte tolère moins longtemps une interruption réseau prolongée.
Les seuils de synchronisation restent ceux du moteur : 8 s au départ et 3 s
pendant la lecture par défaut, 20 s et 5 s en production.
Les transitions de lecture et les pauses sont toujours transmises immédiatement.

Exemple de coût graphique, sans prétendre mesurer les FPS : un film 3840 × 2160
affiché sur 400 pixels CSS de large avec un ratio de pixels de 2 utilise un
canvas 800 × 450. Cela représente environ 96 % de fragments en moins. Le
décodage et l'import de texture restent à la résolution source. Le filtrage
linéaire intervient désormais avant le traitement couleur lorsque le canvas est
réduit. Les formules de conversion restent les mêmes, mais les pixels aux
contours ne sont donc pas nécessairement identiques à une réduction après rendu.

Ces choix suivent les [recommandations WebGL de MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).
`requestVideoFrameCallback` reste utilisé pour suivre les images présentées.
Cette API fonctionne sur le thread principal et ne garantit pas une livraison
à chaque image : voir [son contrat](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).

### Autres leviers examinés

| Piste | Décision et limite |
| --- | --- |
| Worker Hls.js | Déjà activé, avec les permissions CSP nécessaires et la bibliothèque servie localement |
| Adaptation automatique du débit ou de la résolution | Hls.js la propose déjà, mais il faut plusieurs versions vidéo. Le flux unique actuel ne peut pas devenir un 1080p moins lourd avec un réglage du lecteur |
| Versions mobiles 1080p ou 720p | Réduiraient aussi le décodage, l'import GPU et le débit. Demandent une source alternative ou un réencodage, exclu par la règle actuelle de copie vidéo exacte |
| Lecture native sans canvas | Évite l'import GPU et le shader. Le fichier porte les vraies métadonnées couleur, donc la lecture native affiche des couleurs correctes, mais sans le tone mapping de référence ni le rendu commun entre navigateurs (voir la courbe vidéo de Firefox plus haut) |
| Shaka Player | Prend en charge HLS et DASH, mais utilise aussi le lecteur du navigateur. Son remplacement ne supprime pas notre shader ni le coût du décodage du même fichier |
| Media Capabilities | Peut indiquer `supported`, `smooth` et `powerEfficient` pour une configuration. Utile pour choisir entre plusieurs sources, sans garantir la fluidité du canvas ajouté après décodage |
| OffscreenCanvas, WebCodecs, WebGPU | Déplacement ou remplacement du rendu à envisager si les optimisations simples ne suffisent pas. La gestion des images, leur transfert et la disponibilité du décodeur HEVC demanderaient un autre pipeline |
| Table de conversion couleur pré calculée | Pourrait réduire les calculs du shader, au prix d'interpolation, de mémoire et de nouveaux tests HDR. Aucun gain garanti face au coût de l'import vidéo |
| Cache et serveur | Les segments privés sont déjà réutilisables après contrôle d'accès et validation ETag. Aucun changement de confidentialité pour gagner une requête |
| Préchargement massif ou téléchargement parallèle personnalisé | Augmente mémoire, concurrence réseau et complexité. Le chargement et les reprises restent confiés à Hls.js |
| Variation de vitesse ou interpolation d'images | Non ajoutées : l'audio doit rester à vitesse normale et les images d'origine doivent être conservées |

Références : [configuration Hls.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md),
[Shaka Player](https://shaka-project.github.io/shaka-player/docs/api/tutorial-welcome.html),
[Media Capabilities](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API).

Les tests automatiques couvrent la taille du canvas, les vérifications GPU,
la stabilité du DOM, la diffusion des états, les pauses communes, les pistes,
le plein écran et les mires couleur. Les 29 tests unitaires et d'intégration,
les scénarios Chromium et Firefox sous Windows, WebKit sous Ubuntu 24.04 via
WSL, et les quatre mires Chrome/Firefox ont réussi. Le scénario Linux a utilisé
Node 22, FFmpeg système et la commande Playwright `test --project=webkit`.
Ils ne mesurent pas le gain de FPS sur le Xiaomi 15T Pro. Android réel et Safari
sur appareils Apple restent à valider.

Le plein écran natif iOS n'est couvert que par les tests unitaires : ils rejouent
sa séquence d'événements (`webkitbeginfullscreen`, `webkitpresentationmodechanged`,
`resize` de la fenêtre pour la rotation) et vérifient que la taille des
sous-titres se recalcule depuis `screen`. Aucun iPhone ni iPad réel n'a confirmé
ce comportement.

## Timestamps des segments

À la segmentation HLS (`-hls_segment_type fmp4`), ffmpeg ramène le `cto` du
premier échantillon d'un fragment sur la plus petite PTS du fragment. Quand le
fragment démarre sur une keyframe suivie d'images leading (open GOP : la
keyframe est présentée après elles), deux échantillons du fragment portent
alors exactement la même PTS. Chrome/MSE rejette l'`appendBuffer` entier en
silence — aucune erreur, aucun quota — et la lecture gèle définitivement à cet
endroit. Aucune option de muxing testée n'évite ce clamp.

Après le packaging, `prepareMovie` scanne donc les tables `trun` de chaque
segment (`src/hls-pts.js`, en-têtes seulement) et décale le `cto` de
l'échantillon en collision d'une milliseconde — `round(timescale/1000)` ticks,
le timescale étant lu dans le `mdhd` de l'init. Seul ce champ de 4 octets est
réécrit, en place et atomiquement ; un second passage ne change rien.

Pour vérifier ou réparer une bibliothèque déjà préparée :

    node scripts/repair-hls-pts.mjs --check data/movies   # lecture seule, exit 1 si doublon
    node scripts/repair-hls-pts.mjs --fix --journal rep.jsonl data/movies

Une réparation réécrit les octets en place : la génération ne change pas.
L'ETag servi par `/media` porte taille et mtime du fichier (`no-cache` +
revalidation à chaque requête), donc toute réparation rétroactive invalide
automatiquement les clients — à la prochaine revalidation ils reçoivent un
200 et le segment corrigé. Republier avec une nouvelle génération
(re-préparation) reste le moyen de forcer un re-téléchargement complet.
