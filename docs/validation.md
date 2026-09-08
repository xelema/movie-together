# Validation

Les tests automatisés utilisent deux contextes Chromium avec un film synthétique.
Ils vérifient les invitations, les droits admin/invité, les fichiers audio et
sous-titres externes, les pseudos, la langue persistante, le départ commun,
la pause, le déplacement, le plein écran et la coupure réseau.

Les captures couvrent téléphone (390 px), tablette (820 px) et bureau (1440 px).
Ces dimensions ne remplacent pas les essais sur de vrais appareils.

## À vérifier sur appareils physiques

- Windows : Chrome et Firefox.
- iPad : Safari, autorisation du son, plein écran et sous-titres.
- Android : Chrome, commandes tactiles et reprise après verrouillage.

Avec une URL HTTPS commune et un film représentatif : lire dix minutes à deux,
changer de langue et de sous-titres, déplacer la position dans les deux sens,
couper puis rétablir une connexion. Comparer les images et les voix réellement
entendues. Vérifier que la personne en attente apparaît et que la séance
ne reprend que lorsque chacun est prêt.

Ne pas annoncer de validation matérielle avant ces essais. La mesure de position
du lecteur ne mesure pas le délai physique de l'écran ou des haut-parleurs.
