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
- **Seuils de buffer** : `minBuffer` (8 s) exige de chacun pour demarrer ou
  reprendre, `lowBuffer` (3 s) en dessous duquel un participant fait repasser
  la seance en `buffering`.
- **Freeze** : la seance fige sa position et repasse en `paused` ou `buffering`.
  Tout rapport anterieur est invalide : la preparation recommence a zero.

## Pistes

- **Piste audio** : langue du film, choisie par participant. Changer de piste
  audio vide le buffer de la nouvelle piste : le participant peut caler
  brievement.
- **Piste de sous-titres** : fichier texte, choisi par participant ou desactive.
  La bascule ne touche jamais le buffer media.
- **Choix de piste** : reglage strictement local a un participant (« pour vous
  »). Il ne doit pas changer la position ni la phase de la seance.
