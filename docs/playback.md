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
3. L'élément vidéo décode et synchronise normalement, avec la matrice de la
   source. WebGL importe les images avec la conversion automatique désactivée,
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

## Son et préparation

AAC-LC intégré mono/stéréo 44,1/48 kHz est copié. Le reste de l'audio est converti
en une seule passe AAC-LC stéréo 48 kHz à 256 kbit/s.
Aucune analyse sonore intégrale ni seconde passe.

Le coût vidéo reste celui d'une lecture et d'une écriture du fichier avec analyse
des en-têtes. Le temps dépend du débit disque et de la taille ; aucun décodage
vidéo intégral n'est ajouté. Une conversion audio peut encore prendre du temps.
Voir [les tests sur appareils](validation.md).

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
| Lecture native sans canvas | Évite l'import GPU et le shader. Le fichier porte les vraies métadonnées couleur, donc la lecture native affiche des couleurs correctes, mais sans le tone mapping de référence ni le rendu commun entre navigateurs |
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
