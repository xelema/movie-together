# Télémétrie et journaux de séance

Ce document décrit ce qui est enregistré pendant une séance, où, et ce qui ne
l'est jamais. Il fait autorité : le client (`public/telemetry.js`), le serveur
(`src/telemetry.js`, `src/app.js`, `src/sync/hub.js`) et les outils de lecture
(`scripts/telemetry-report.js`) suivent ce schéma.

## Portée

- La télémétrie est active dans **toutes les séances**, pas seulement les
  séances instrumentées (`probe`). Le drapeau `probe` ne change plus que la
  durée de vie de la séance (dix ans, survivante au redémarrage).
- Chaque ligne est un objet JSON, un par ligne (NDJSON), rangé sous
  `data/telemetry/` (volume Docker `movie-data` en production).
- La télémétrie est **lectrice seule** : elle ne change jamais la lecture, la
  synchronisation ni l'interface. Une panne d'observateur, de sérialisation ou
  de réseau ne doit jamais se propager au lecteur.
- Dérogation : `#telemetry=off` dans l'URL, ou `localStorage.movieTelemetry = 'off'`,
  désactive l'envoi pour ce navigateur (`on` le réactive).

## Fichiers

| Fichier | Source | Contenu |
| --- | --- | --- |
| `<code>-<member>.ndjson` | client | événements d'un participant sur une connexion |
| `<code>-server.ndjson` | serveur | événements de la séance vus du serveur |
| `server.ndjson` | serveur | requêtes `/media/*` sans séance propriétaire unique |

- `<code>` est le code d'invitation de la séance, `<member>` l'identifiant du
  participant (UUID attribué par le serveur à la connexion websocket). Un envoi
  pour un `<member>` que la séance n'a jamais vu (aucune websocket acceptée
  sous cet identifiant) est refusé 404, comme une room introuvable.
- Un même code réutilisé produit donc de nouveaux fichiers : le couple
  code + participant identifie une connexion, pas une personne.
- Rotation : un fichier qui atteint `telemetryFileMb` est renommé en
  `<base>.<n>.ndjson` (n = 1, 2, …) et l'écriture reprend dans un fichier neuf.
- Rétention : au démarrage et toutes les heures, les fichiers plus vieux que
  `telemetryDays` (mtime) sont supprimés, puis les plus anciens jusqu'à ce que
  le dossier repasse sous `telemetryMb`. La suppression est journalisée en une
  ligne `[telemetry] …` sur la sortie du serveur.

## Réglages

Catégorie `telemetry` de la page admin (`PATCH /api/settings`) :

| Clé | Défaut | Bornes | Rôle |
| --- | --- | --- | --- |
| `telemetryDays` | 7 | 1–365 | âge maximal d'un fichier avant suppression |
| `telemetryMb` | 512 | 16–16384 | taille maximale du dossier `data/telemetry` |
| `telemetryFileMb` | 16 | 1–256 | taille d'un fichier avant rotation |

## Enveloppe d'une ligne

Enveloppe écrite par le serveur (elle n'est jamais fabriquée par le client) :

```json
{"at": 1759000000000, "room": "avant-premiere", "member": "5f0c…", "sid": "b31…", "t": 1758999999980, "p": 42123.5, "type": "tick", "…": "…"}
```

- `at` : réception côté serveur, epoch en millisecondes.
- `room` : code d'invitation.
- `member` : identifiant du participant (absent des lignes serveur sans portée
  individuelle).
- `sid` : identifiant de session client, tiré au chargement de la page ; il
  regroupe les reconnexions d'un même onglet.
- `t` : `Date.now()` du client ; `p` : `performance.now()` du client, pour les
  deltas intra-session à la milliseconde.
- `type` : nature de l'événement (≤ 40 caractères).

## Transport

Le client envoie ses lignes par `POST /api/rooms/<id>/telemetry` avec
`{memberId, events}`. Le serveur répond `204` ; `400` pour une enveloppe
invalide, `404` pour un participant que la séance n'a jamais vu se connecter —
une page rechargée parle donc au nom d'un membre connu, jamais d'un fantôme.

Bornes, tenues des deux côtés :

| Borne | Valeur | Où |
| --- | --- | --- |
| événements par lot | 400 | client |
| octets par lot | 256 Kio | client |
| caractères par événement | 3800 | client |
| corps accepté par la route | 4 Mio | serveur |
| file d'attente du client | 2000, purge FIFO | client |

Un lot refusé est remis en file et repart au flush suivant ; une ligne qui
dépasserait 3800 caractères est comptée puis sautée, jamais fatale pour le lot.
Le corps de cette route est le seul de l'API au-dessus de 32 Ko : le lot doit
tenir dans la borne serveur, sinon le POST est refusé en `413` et la séance
entière reste sans journal.

## Événements du client

### Contexte

- `caps` — envoyé une fois à l'attachement : identité du poste et capacités.
  - `name` (pseudo affiché), `ua`, `uaBrands` (`navigator.userAgentData.brands`),
    `mobile`, `platform`, `lang`, `langs`, `tz` (IANA), `tzOffset`.
  - `screen` : `{w, h, aw, ah, depth, orientation}`, `dpr`, `viewport` `{w, h}`.
  - `cores` (`hardwareConcurrency`), `mem` (`deviceMemory`), `touch`, `battery`
    `{level, charging}`, `jsHeap` `{used, total, limit}` (`performance.memory`),
    `storage` `{quota, usage}` (`navigator.storage.estimate`).
  - `gpu` : `{vendor, renderer, version, glsl, maxTexture}` (renderer non masqué
    via `WEBGL_debug_renderer_info`), `webgl2`.
  - `canPlay` et `mse` : booléens par codec/format — `h264`, `hevc`, `hevc10`,
    `av1`, `vp9`, `aac`, `opus`, `ec3`, `ac3`, `flac`, `hls`.
  - `mediaCap` : `navigator.mediaCapabilities.decodingInfo` pour la config
    réelle du film sous `film` `{codec, w, h, bitrate, supported, smooth,
    powerEfficient}` puis par codec générique (`h264`, `hevc`, `av1`, `vp9`) :
    `{supported, smooth, powerEfficient}`.
  - `hlsjs` `{version, supported, mse}`, `nativeHls` (lecture HLS native).
  - `features` : `{wakeLock, pip, fullscreen, rvfc, playbackQuality, worklet,
    sab, webgpu, mediaSession}`.
  - `color` : `{gamut, range, forcedColors, reducedMotion}`.
  - `conn` : `{effectiveType, downlink, rtt, saveData, type}`.
  - `room` : `{probe, languages, minBuffer, lowBuffer, tickMs, startDelay,
    reportTimeout, mode}` (`mode` = `hlsjs` ou `native`).
  - `movie` : `{id, title, duration, bitrate, maxSegmentSeconds,
    maxSegmentBytes, bufferRisk, generation, audio, subtitles, renditions}` —
    `audio`/`subtitles` comptent les pistes, `renditions` liste chaque version
    `{id, codec, w, h, videoRange}`. De quoi confronter la taille des segments
    à ce que le poste sait tenir.
  - `session` : `{admin, enter, forceShader, hdr}` (`enter` = `invite`,
    `join`, `open`, `create`, `admin` ou `room`).
- `perms` — état asynchrone des permissions `camera`, `microphone`, `wake-lock`
  (`granted|denied|prompt|unsupported`).
- `session-start` — entrée dans la séance : `{code, probe, languages, movie,
  href}`.
- `session-end` — sortie ou démontage : `{reason, ms}` (durée de la séance).

### Battement et état local

- `tick` — toutes les secondes. Champs :
  - lecture : `pos`, `target`, `ahead`, `drift`, `phase`, `epoch`, `wantsPlay`,
    `rs`, `ns`, `paused`, `rate`, `seeking`, `dur`, `vw`, `vh`.
  - tampon : `ranges` (éléments, `video.buffered`), `se` (`video.seekable`),
    `buf` : par piste MSE décodée —
    `{video: [[début, fin]…], audio: […], audio2: […], sb: [{n, updating, mode,
    aws, awe, to}]}` lu sur `hls.mediaSource.sourceBuffers`.
  - images : `frames` et `dropped` (`getVideoPlaybackQuality().totalVideoFrames`
    / `droppedVideoFrames`), `corrupted`, `fps` (images réellement présentées
    par seconde de temps réel, mesurées par `requestVideoFrameCallback`),
    `pdelay` (durée de traitement médiane, ms).
  - horloge : `rtt`, `off`, `cok`, `samples`.
  - état du lecteur : `act`, `blk`, `rec`, `fail`, `back`, `bw`
    (`hls.bandwidthEstimate`), `ws` (`readyState`), `hid`, `on`, `focused`,
    `vol`, `muted`, `track` `{audio, subs}`, `ttracks` (modes des pistes texte).
  - rendu couleur : `rend` `{ok, bad, uni, w, h}`.
  - diagnostics : `mem` (tas JS utilisé), `queue` (événements en attente),
    `off2` (décalage d'horloge le plus récent).
- `state` — à chaque message `state` du serveur dont la signature change
  (phase, époque, listes d'attente) :
  `{phase, epoch, pos, startsAt, dur, members: [{id, name, self, waiting,
  reason, blockers, failure, buffered, needed, stall}]}`. C'est la vue serveur
  telle que le client l'a reçue, horodatée localement.
- `report` — à chaque rapport sortant dont la signature change (prêt, verrous,
  échec) : `{epoch, seq, pos, bufferedUntil, bufferedStart, ready, blockers,
  failure, ahead}`.
- `phase` — transition de phase observée côté client : `{from, to}`.
- `activation`, `activation-blocked`, `ws` (`{ev: connect|open|close|error,
  to, code, reason, retries, ms}`), `renderer-hidden` (`{uniform}`),
  `status` (`{msg}`), `visibility`, `fullscreen`, `focus`, `net`, `wakeLock`,
  `lifecycle` (`pagehide`, `freeze`, `resume`), `env` (resize/orientation/dpr/
  débit débattu une fois par seconde), `clock` (toutes les 5 s : `{rtt,
  rttMin, rttMed, off, samples, ready}`).

### Réseau et moteur de lecture

- `seg` — une entrée `resource` par requête `/media/*` : `{n, d, b, enc, dec,
  ttfb, start, proto, status, cached, kind, level, sn}` (`b` = octets reçus
  par le client, `ttfb` = temps jusqu'au premier octet, `kind` = `master|
  level|init|video|audio|subtitle`, `level` = indice du flux ffmpeg,
  `sn` = numéro de segment).
- `hls` — cycle de vie hls.js : `{ev, level?, sn?, start?, end?, bytes?, ms?,
  tracks?, levels?, track?, td?, total?, audio?, subtitles?}` pour
  `media-attached`, `manifest-parsed` (liste `levels` : débit, résolution,
  codecs, `td` = `targetDuration`), `level-loaded`, `level-switched`,
  `frag-loading`, `frag-loaded`, `frag-buffered`, `frag-changed`,
  `buffer-appended`, `buffer-flushing`, `buffer-flushed`, `buffer-eos`,
  `buffer-codecs`. Les événements `buffer-flushing`/`buffer-flushed` et
  `frag-buffered` portent les plages par piste avant/après (`tracks`) : c'est
  ce qui sépare un ajout refusé d'un fragment marqué puis sauté.
- `mediaError` — erreur hls.js (fatale ou non) : `{type, details, fatal, reason,
  errmsg, level, sn, start, end, bytes, ranges, sbranges, bufferLen}`.
- `video-<événement>` — `loadedmetadata`, `loadeddata`, `canplay`, `playing`,
  `play`, `pause`, `waiting`, `stalled`, `seeking`, `seeked`, `emptied`,
  `ratechange`, `durationchange`, `volumechange`, `ended` : `{pos, rs, ns,
  ranges, ahead, vw, vh, dur}`. `seeking` ajoute `from`, `to`, `delta`.
- `video-error` — `{code, name, msg, rs, ns}` de `video.error`.

### Sous-systèmes

- `rtc` — toutes les 5 s tant qu'une connexion est ouverte, depuis
  `pc.getStats()` : `{conn, ice, iceGather, signaling, pair: {local, remote,
  protocol, rtt, outBitrate}, in: {bytes, packets, lost, jitter, frames,
  framesDecoded, fps, w, h, freeze, freezeMs}, out: {bytes, packets, nack, pli,
  retransmitted, framesEncoded, fps, w, h, qlim}}`. `qlim`
  (`qualityLimitationReason`) nomme la contrainte réelle (débit, processeur,
  bande passante).
- `webcam` — `{state, err?, ms?}` sur `idle|starting|active|error`, plus
  `{conn, peers, negotiations, candidates, queued, restarts}` aux changements
  de signalisation.
- `voice` — `{state, err?, ms?}` sur `idle|starting|listening|processing|
  error`, plus les mesures de la prise : `{armMs, sr, frames, bytes, refused,
  seq, rev, heard, len, result, partialMs}`. **Aucun texte** : ni
  transcription, ni traduction (voir « Ce qui n'est jamais journalisé »).
- `renderer` — rendu couleur WebGL : `{ready, failed, w, h, visible, drawn,
  errors, importVerified, resumeGrace, ctx, reason}` ; à chaque changement et
  toutes les 5 s.
- `perf` — `longtask` (blocage du fil principal > 50 ms, plafonné à 200 par
  session puis compté), `api` (appel HTTP en échec : `{path, method, status,
  ms, err}`), `js-error` (`{msg, name, src, line, col, stack}`),
  `resource-error` (échec de chargement d'une ressource), `queue` (événements
  perdus : `{dropped, size}`).
- `action` — intention de l'utilisateur : `{act, value?, pos, phase, epoch}`
  pour `play`, `pause`, `seek`, `track-audio`, `track-subs`, `volume`, `mute`,
  `fullscreen`, `pip`, `hdr`, `settings`, `join`, `leave`, `nickname`,
  `invite`. Le plein écran porte en plus `recovery` et `detail` quand le
  lecteur a dû solder un état que le navigateur avait quitté sans le lui dire
  (`recovery` nomme l'intervention : `stale`, `exit-failed`, `enter-failed`,
  `fallback`).

## Événements du serveur (`<code>-server.ndjson`)

Une ligne par transition, jamais par battement (`tickMs` = 200 ms) :

- `create`, `remove`, `expire` — cycle de vie de la séance : `{probe, movie,
  voice, webcam, languages, minBuffer, lowBuffer, ttl}`.
- `movie`, `tune` — film chargé, seuils retunés.
- `connect` — `{name, admin, ua, ip, sockets, sessions, members}`.
- `refused` — refus de connexion nommé : `{reason, path, origin, ua, ip}` où
  `reason` vaut `origin`, `session`, `access`, `expired`, `sockets`,
  `capacity` ou `movie`. Un refus visant une room inexistante n'a pas de
  journal où écrire et reste muet.
- `disconnect` — `{ms, messages, frames, reason}`.
- `identify` — `{from, to}`.
- `report` — rapport accepté dont la signature change : `{epoch, seq, pos,
  bufferedUntil, bufferedStart, ready, blockers, failure}`.
- `report-rejected` — `{epoch, seq, error}` (époque périmée, séquence,
  position hors bornes…).
- `command` — `{cmd, pos, epoch, result}` où `result` vaut `applied`,
  `stale-epoch` ou `invalid`.
- `phase` — `{from, to, cause, pos, epoch, members}` avec la cause exacte :
  `join`, `leave`, `load`, `seek`, `play`, `pause`, `end`, `low-buffer`,
  `stale-report`, `no-report`, `not-ready`, `misaligned`, `no-ack`, `tune`.
- `member` — signature d'attente (une ligne par changement) : `{waiting,
  reason, blockers, failure, buffered, needed}`.
- `voice` — `{kind, utterance, seq, speaker, bytes, ms, error, retryAfter,
  calls}` sans aucun contenu de texte.
- `webcam` — `{kind, from, to, active}` (`status`, `signal`, `peer-joined`,
  `peer-left`).
- `limit` — fermeture par garde-fou : `{reason}` = `messages`, `frames`,
  `session` ou `backpressure`.
- `error` — commande invalide (`{error}`) ou erreur HTTP 5xx du serveur.
- `media` — une ligne par requête `/media/*` **si `LOG_MEDIA=1`** :
  `{file, status, bytes, ms, cache}`.

## Ce qui n'est jamais journalisé

- Le contenu de la parole : ni transcription source ni traduction, seulement
  des longueurs et des compteurs.
- Aucun secret : mot de passe, cookie de session, jeton, corps de requête.
- Aucun contenu de film, aucune image, aucune trame audio.

## Lecture

- `node scripts/telemetry-report.js <fichier.ndjson|dossier>` — synthèse d'une
  session : capacités du poste, phases, attentes, tampon, débits, dérive
  d'horloge, erreurs hls.js, journal des vidages et des ajouts, WebRTC, rendu
  couleur.
- `sudo docker exec movie-together-app-1 ls /data/telemetry` puis, depuis
  l'hôte, `/var/lib/docker/volumes/movie-together_movie-data/_data/telemetry`.
- `npm run logs` (`scripts/watch-rooms.js`) annote en clair les lignes
  `[room <tag>]` de la sortie du serveur.
