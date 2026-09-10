# Lecture et couleur

La préparation copie les images compressées avec `-c copy`. Aucun encodeur vidéo,
filtre de pixels, redimensionnement ou calcul de tone mapping ne tourne sur le
serveur. L'original envoyé reste intact.

## Origine des écarts

Un lecteur HTML natif laisse le navigateur, son décodeur et le système convertir
HDR vers l'écran. Leurs courbes diffèrent. Modifier MaxCLL ou la luminance de
mastering à 203 cd/m² rapproche certaines images, mais ne définit pas une
conversion commune et fausse les caractéristiques de la source.

L'import vidéo WebGL présente aussi des différences. Sur la machine Windows
testée, Firefox applique BT.709 à une texture HEVC déclarée BT.2020 ; Chrome
respecte BT.2020. Le seul drapeau `UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE`
ne corrige donc pas toute la chaîne.

## Rendu commun

1. FFmpeg copie les paquets sans les modifier et écrit BT.709/sRGB dans la boîte
   `colr` de la piste. Le flux codé n'est pas touché : sa VUI décrit toujours la
   source. Les navigateurs testés lisent la boîte du conteneur, qui prime sur la
   VUI d'après ISO/IEC 14496-12. La plage complète ou limitée reste celle de la source.
2. `rendition.color` conserve les caractéristiques couleur originales. Ce
   transport doit être lu avec le lecteur de l'application : ce n'est pas une
   conversion SDR exportable.
3. L'élément vidéo décode et synchronise normalement. WebGL importe ses images
   avec la conversion automatique désactivée, reconstitue la matrice originale,
   applique PQ ou HLG et transforme les primaires en Rec.709.
4. Une courbe BT.2390 commune ramène le HDR à un blanc SDR de référence de 203 nits.
   HLG utilise le moniteur de référence de 1 000 nits et le gamma système 1,2. Les
   couleurs hors gamut sont rapprochées de leur luminance. Les sources SDR
   utilisent BT.1886, ou sRGB lorsque déclaré.
5. Le résultat sRGB est affiché dans un canvas. Les commandes Plyr, l'audio et
   l'horloge utilisent toujours la vidéo. Les sous-titres textuels sont placés
   au-dessus du canvas à partir des cues du lecteur.

Il n'y a aucun réglage par nom de navigateur, filtre CSS de luminosité, encodeur
WebCodecs ni nouvelle dépendance. `requestVideoFrameCallback` cadence le rendu.
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

## Vérification et portée

`npm run test:colors` fabrique uniquement des mires de test courtes, les prépare
en HLS, puis mesure les pixels dans Chrome et Firefox. Les captures et mesures
sont écrites dans `test-results/colors`. Sous Windows, les navigateurs sont ouverts
avec fenêtre : le Firefox sans fenêtre ne décode pas le HEVC testé.

Mesures obtenues sur la machine Windows de développement, Chrome 141 et le
Firefox fourni par Playwright (Chrome 152, Firefox 155) :

| Mire | Écart moyen | p99 | Maximum |
| --- | --- | --- | --- |
| HDR10 (PQ, BT.2020) | 0,190 | 1 | 1 |
| HLG (BT.2020) | 0,190 | 1 | 1 |
| SDR BT.709 | 0,104 | 1 | 5 |
| SDR BT.601 | 0,225 | 2 | 5 |

Les valeurs sont en niveaux sur 255 par canal. L'écart résiduel vient de l'arrondi
YUV vers RGB des décodeurs, avant le shader. Sur un extrait réel du film en HEVC
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

Une ancienne préparation doit être actualisée pour utiliser ce rendu.
`HDR_PEAK_NITS` n'est plus utilisé. Les versions sans `rendition.color` conservent
leur ancien chemin de lecture pendant la migration.

## Son et préparation

AAC-LC intégré mono/stéréo 44,1/48 kHz est copié. Le reste de l'audio est converti
en une seule passe AAC-LC stéréo 48 kHz à 256 kbit/s. Les fichiers audio externes
sont ajustés à la durée du film. Aucune analyse sonore intégrale ni seconde passe.

Le coût vidéo reste celui d'une lecture et d'une écriture du fichier avec analyse
des en-têtes. Le temps dépend du débit disque et de la taille ; aucun décodage
vidéo intégral n'est ajouté. Une conversion audio peut encore prendre du temps.
Voir [les tests sur appareils](validation.md).
