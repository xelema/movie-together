# Context

Glossaire du domaine. Pas de details d'implementation ici, seulement le
vocabulaire partage.

## Visionnage synchronise

- **Seance** (room) : un groupe de participants qui regardent le meme film avec
  une position de lecture partagee. Identifiee par un code d'invitation.
- **Participant** (member) : un viewer connecte a la seance. Chacun choisit ses
  pistes independamment des autres.
- **Phase** : etat de la seance, partage par tous.
  - `paused` : arret explicite, la reprise demande une action d'un participant.
  - `buffering` : la seance veut jouer (`wantsPlay`) mais attend que tous les
    participants soient prets. Reprend automatiquement, sans action.
  - `playing` : lecture en cours, demarree a `startsAt`.
- **Epoch** : numero incremente a chaque pause ou seek. Invalide les rapports et
  commandes emis sur un etat obsolete, sauf `pause` qui reste toujours efficace.
- **Rapport** (report) : message periodique d'un participant donnant sa
  position, sa position bufferisee (`bufferedUntil`) et s'il est **pret**
  (ready : lecteur charge, horloge calibree, pas en seek, pas en erreur).
- **Attente** (waiting) : statut expose par participant. `reason` nomme la
  premiere condition qui bloque (`no-report`, `stale-report`, `not-ready`,
  `low-buffer`, `misaligned`) et `blockers` liste les verrous de disponibilite
  que le participant declare lui-meme (`activation`, `clock`, `data`, `drift`…).
  Ces diagnostics ne sont diffuses qu'aux clients administrateurs ; les invites
  ne recoivent que le booleen `waiting`.
- **Seuils de buffer** : `minBuffer` exige de chacun pour demarrer ou
  reprendre, `lowBuffer` en dessous duquel un participant fait repasser
  la seance en `buffering`. Ce sont les seuls reglages dynamiques : un
  changement admin est repris par les seances ouvertes et publie aux
  clients connectes dans `welcome` et chaque `state`.
- **Freeze** : la seance fige sa position et repasse en `paused` ou `buffering`.
  Tout rapport anterieur est invalide : la preparation recommence a zero.
- **Seance instrumentee** (probe) : une seance creee avec le drapeau `probe`.
  Elle n'expire pas et survit aux redemarrages du serveur tant que son film
  reste pret. Elle sert a verifier le fonctionnement sur un appareil reel.
- **Telemetrie** : flux d'evenements de diagnostic envoye par le client d'une
  seance instrumentee vers le serveur (capacites de l'appareil, buffer, images
  perdues, horloge, renderer couleur, segments telecharges). A la difference
  du rapport, qui alimente la machine a etats, la telemetrie est ecrite dans
  un journal et ne change rien a la seance.

## Reglages

- **Reglage operationnel** : parametre de fonctionnement modifiable depuis
  la page admin (`GET`/`PATCH /api/settings`, `POST /api/settings/reset`),
  persiste dans `data/settings.json` et recharge au demarrage. Chaque
  reglage a une categorie, des bornes et un defaut integre ; une variable
  d'environnement (`MIN_BUFFER_SECONDS`, `LOW_BUFFER_SECONDS`,
  `ENCODE_THREADS`) peut remplacer le defaut sans redeployer. Une valeur
  ecrite par l'admin l'emporte sur l'env jusqu'au reset.
- **Application** : seuls `minBuffer`/`lowBuffer` sont dynamiques (seances
  ouvertes comprises). Tout autre reglage ne vaut que pour les nouvelles
  operations : une seance garde ses seuils de depart et de rapport, une
  session sa duree, un envoi ses parametres de creation (taille de bloc
  comprise). Les cadences globales `tickMs`/`sweepMs` ne sont relues qu'au
  redemarrage : les clients calent leur seuil de silence sur le `tickMs`
  du welcome, retimer une boucle en cours les desynchroniserait.
- **Hors perimetre** : les reglages secrets ou structurels (port, origine
  publique, mot de passe, dossier de donnees, proxy, chemins ffmpeg)
  restent des variables d'environnement, hors de la page admin. Restent
  aussi fixes en dur par choix, comme constantes de protocole ou de
  securite : la taille maximale d'un message websocket (8 Kio), les
  fenetres des limites de debit (15 min pour le login, 1 min pour les
  invitations), le budget de messages par socket (40/s), le seuil de
  bufferedAmount (64 Kio) et la marge disque exigee a la creation d'un
  envoi (x2,2).

## Films

- **Film** : un fichier video de la bibliotheque, avec ses pistes.
- **Preparation** : la transformation d'un film en version servie aux seances.
  Etats :
  - `uploaded` : a preparer, les pistes n'ont pas encore ete choisies.
  - `probing`, `processing` : analyse ou preparation en cours.
  - `ready` : pret, la selection de pistes est figee dans la version servie.
    Re-preparer reconduit la meme selection.
  - `failed` : preparation echouee, a relancer.
  - `incompatible` : fichier illisible.
- **Piste integree** : piste audio ou de sous-titres presente dans le fichier
  source. Elle se choisit a la preparation et ne change plus ensuite.
- **Piste ajoutee** (external) : fichier de sous-titres fourni par
  l'administrateur. Peut s'ajouter ou se retirer meme sur un film pret.
- **Nom affiche** : nom de piste vu par les participants. Par defaut la langue,
  plus un qualifieur quand il faut distinguer deux pistes (forced, commentary,
  SDH, titre d'origine, layout audio, numero).

## Pistes

- **Piste audio** : langue du film, choisie par participant. Changer de piste
  audio vide le buffer de la nouvelle piste : le participant peut caler
  brievement.
- **Piste de sous-titres** : fichier texte, choisi par participant ou desactive.
  La bascule ne touche jamais le buffer media. Une seule piste de sous-titres
  est visible a la fois et la taille du texte suit la hauteur de l'image
  rendue, pas la fenetre.
- **Choix de piste** : reglage strictement local a un participant (« pour vous
  »). Il ne doit pas changer la position ni la phase de la seance.

## Traduction vocale

- **Prise de parole** (utterance) : une phrase courte prononcee par un
  participant, une seule active a la fois dans la seance. Le serveur lui
  attribue un identifiant et une sequence ; son cycle passe par des etats
  prives puis un resultat final ou un echec, sans rien persister.
- **Surtitre traduit** : la traduction finale d'une prise, diffusee a tous
  les participants en surimpression coloree avec le nom de l'orateur, puis
  effacee apres sa fenetre d'affichage. L'orateur recoit en plus son texte
  compris, visible de lui seul.
- **Sens de traduction** : fige a la demande de prise par la langue
  d'interface de l'orateur, francais vers coreen ou l'inverse. Il n'est ni
  detecte par le fournisseur ni modifiable en cours de prise.
- **Capacite de seance** : la traduction vocale se choisit a la creation de
  la seance, desactivee par defaut et figee ensuite. L'etat autoritaire
  annonce la paire de langues et la disponibilite du service.
