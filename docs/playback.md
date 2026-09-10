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

1. FFmpeg copie les paquets et uniformise leurs indications de transport en
   BT.709/sRGB. La plage complète ou limitée reste celle de la source. Les messages
   de mastering HDR et RPU Dolby Vision sont retirés du transport HEVC compatible
   pour éviter une seconde interprétation HDR.
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

Références : [bitstream filters FFmpeg](https://ffmpeg.org/ffmpeg-bitstream-filters.html)
et [paramètres d'import WebGL](https://registry.khronos.org/webgl/specs/latest/1.0/#PIXEL_STORAGE_PARAMETERS).
WebGL utilise ici le décodeur de l'élément vidéo sans dépendre de la disponibilité
de `VideoDecoder` pour HEVC.

## Vérification et portée

`npm run test:colors` fabrique uniquement des mires de test courtes, les prépare
en HLS, puis mesure les pixels dans Chrome et Firefox. Les captures et mesures
sont écrites dans `test-results/colors`. Sous Windows, les navigateurs sont ouverts
avec fenêtre : le Firefox sans fenêtre ne décode pas le HEVC testé.

La première mesure locale sur une mire PQ a donné un écart nul entre Chrome et
Firefox. Sur l'extrait local du film, après réduction à 512 pixels de large,
l'écart moyen entre canaux est de 0,35 sur 255. Ces mesures concernent cette
machine et ce chemin de décodage ; le test reproductible complète ce diagnostic.

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
