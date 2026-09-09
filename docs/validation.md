# Validation

Les tests automatisés utilisent deux contextes par moteur avec un film synthétique.
Les projets couvrent Chromium, Firefox et WebKit. Sous Windows, le WebKit fourni
par Playwright n'expose ici ni HLS natif ni MSE : ce scénario y est explicitement
ignoré et doit être exécuté sur macOS/Linux. Un succès Chromium ou Firefox ne
constitue pas une validation Safari/iOS.
Ils vérifient les invitations, les droits admin/invité, les fichiers audio et
sous-titres externes, les pseudos, la langue persistante, le départ commun,
la pause, le déplacement, le plein écran, l'autorisation du son dans l'overlay
et la coupure réseau. Les tests FFmpeg comparent les empreintes des flux vidéo
et AAC avant/après préparation, les métadonnées HDR10/HLG, les niveaux SDR
pleine plage, le mixage des voix centrales et les silences. Les tests navigateur
vérifient l'absence de curseurs d'image et de filtres sur la vidéo ou ses ancêtres,
y compris lorsque le menu des pistes est ouvert.

Ces tests de lecture utilisent une source SDR. Les contrôles de métadonnées et
d'empreintes HDR ne prouvent pas que deux navigateurs affichent les mêmes couleurs.
Un diagnostic séparé sur un extrait HEVC/PQ du film local a permis de le lire dans
Chrome 152 et Firefox 155 avec fenêtre sous Windows ; le Firefox automatisé sans
fenêtre ne décodait pas cet extrait. Le rendu sombre de Chrome est observé,
mais l'identité perceptuelle entre navigateurs n'est pas résolue.

Les captures couvrent téléphone (390 px), tablette (820 px) et bureau (1440 px).
Ces dimensions ne remplacent pas les essais sur de vrais appareils.

## À vérifier sur appareils physiques

- Windows : Chrome et Firefox.
- macOS : Safari, Chrome et Firefox, écrans SDR et HDR.
- iPad : Safari, autorisation du son, plein écran et sous-titres.
- Android : Chrome, commandes tactiles et reprise après verrouillage.

Avec une URL HTTPS commune et un film représentatif : lire dix minutes à deux,
changer de langue et de sous-titres, déplacer la position dans les deux sens,
couper puis rétablir une connexion. Comparer les images et les voix réellement
entendues. Vérifier que la personne en attente apparaît et que la séance
ne reprend que lorsque chacun est prêt.

Comparer également une scène sombre, un visage et des hautes lumières sur une
source SDR, au casque et sur les haut-parleurs d'un téléphone. Vérifier le
passage entre une voix calme et une scène forte, les sous-titres en plein écran,
la navigation au clavier et les zones tactiles.
Vérifier séparément les fichiers HDR10, HLG et Dolby Vision sur les appareils
qui les prennent en charge : aucune conversion SDR n'est effectuée par le serveur.
Un test de pixels synthétiques ne valide pas le rendu perceptuel d'un film entier.

Ne pas annoncer de validation matérielle avant ces essais. La mesure de position
du lecteur ne mesure pas le délai physique de l'écran ou des haut-parleurs.
