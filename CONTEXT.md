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
  la seance en `buffering`. Defauts 8 s / 3 s, surenchirissables par
  `MIN_BUFFER_SECONDS` / `LOW_BUFFER_SECONDS` puis par la page admin
  (`PATCH /api/settings`, persiste dans `data/settings.json`). Le serveur
  les publie dans `welcome` et dans chaque `state`, donc un changement a
  chaud s'applique aux seances ouvertes et aux clients connectes.
- **Freeze** : la seance fige sa position et repasse en `paused` ou `buffering`.
  Tout rapport anterieur est invalide : la preparation recommence a zero.

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
  La bascule ne touche jamais le buffer media.
- **Choix de piste** : reglage strictement local a un participant (« pour vous
  »). Il ne doit pas changer la position ni la phase de la seance.
