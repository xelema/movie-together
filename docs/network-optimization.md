# Optimisation Réseau & Liaisons Long-Haul (Streaming Mondial Sans Compression)

Ce document décrit l'architecture, les mécanismes d'optimisation et la méthodologie de mesure permettant à des participants situés à l'autre bout du monde (ex. France ↔ Corée du Sud, ~260-350 ms RTT) ou disposant d'une connexion instable de regarder des films en haute fidélité (flux vidéo original non réencodé, 4K/1080p) parfaitement synchronisés avec leurs amis.

---

## 1. Contraintes Physiques & Problématique

Pour streamer un flux vidéo original sans compression (débit de 15 à 40 Mbit/s) sur des distances intercontinentales :
- **RTT physique incompressible** : 240 à 320 ms entre l'Europe et l'Asie de l'Est (temps de propagation dans la fibre optique et transit par les dorsales internationales). En mobilité 4G/5G ou Wi-Fi avec gigue, les RTT observés atteignent régulièrement 350 à 500 ms.
- **Bandwidth-Delay Product (BDP)** :
  $$\text{BDP} = \text{Débit} \times \text{RTT}$$
  Pour un flux 4K à 25 Mbit/s avec 280 ms de RTT, le volume de données simultanément en vol dans le réseau est d'environ **875 Ko**. Pour saturer un lien à 100 Mbit/s, il s'élève à **3,5 Mo**.
- **Plafond TCP par défaut** : Si les tampons TCP (`rmem`, `wmem`) de l'hôte ou du conteneur sont restreints (ex. 208 Ko par défaut Linux), le débit effectif plafonne mécaniquement à $\approx 5{,}9\text{ Mbit/s}$, provoquant des ruptures de lecture incessantes.
- **Slow-Start TCP après inactivité** : En streaming HLS, le lecteur télécharge un segment, attend quelques secondes que la réserve s'écoule, puis télécharge le suivant. Si `tcp_slow_start_after_idle = 1`, la fenêtre de congestion s'effondre à chaque pause, forçant une lente remontée en débit à chaque segment sur un lien à 250 ms.

---

## 2. Optimisations Appliquées

### A. Pile Réseau Noyau & Hôte (`deploy/99-movie-together-network.conf` & `compose.yaml`)
- **Algorithme de congestion BBR + fq** : Maintient un débit maximal y compris avec 1 à 3 % de perte de paquets sans effondrement de fenêtre (contrairement à CUBIC/Reno).
- **Dimensionnement BDP** : Tampons `net.core.rmem_max` et `wmem_max` portés à 16 Mo, avec `net.ipv4.tcp_rmem` et `tcp_wmem` configurés jusqu'à 16 Mo.
- **Maintien de la fenêtre (`tcp_slow_start_after_idle = 0`)** : La fenêtre de congestion reste ouverte entre les segments vidéo successifs, évitant le redémarrage à zéro.
- **Contrôle du bufferbloat (`tcp_notsent_lowat = 131072`)** : Réduit la file d'attente locale dans la socket pour que les paquets WebSocket de synchronisation et audio ne subissent pas la latence induite par les segments vidéo en cours d'envoi.

### B. Tolérance d'Horloge & Handshake Immédiat (`public/sync-player.js`)
- **Élargissement du seuil de calibration d'horloge** : `Clock.ready` accepte des RTT jusqu'à 1 200 ms (au lieu du plafond historique de 500 ms qui bloquait systématiquement les utilisateurs lointains ou mobiles).
- **Acquittement instantané du départ (`ackStartsAt`)** : Dès qu'un départ commun (`startsAt`) est planifié par le serveur, le client émet immédiatement son rapport d'acquittement au lieu d'attendre l'échéance du timer périodique (gain de 0 à 200 ms de marge sur le round-trip).
- **Socket Keep-Alive & TCP_NODELAY** : Activés sur le flux des segments HTTP dans Express (`req.socket.setKeepAlive(true, 1000)`).
- **Caddy Reverse Proxy (`deploy/Caddyfile`)** : `flush_interval -1` pour une transmission immédiate des paquets HTTP sans rétention locale dans le reverse proxy.

### C. Moteur HLS & Gestion Mémoire (`public/backends.js` & `public/sync-player.js`)
- **Déplafonnement dynamique du buffer MSE (`maxBufferSize`)** : Calculé sur l'objectif de réserve cible (`bufferSeconds = 60s`) et le débit réel du film avec un plancher minimal de **128 Mo** (au lieu de 60 Mo qui limitait la réserve à seulement ~18s sur les flux 4K).
- **Streaming fMP4 progressif (`progressive: true`)** : Permet au démultipxeur Hls.js de consommer les segments via l'API `ReadableStream` au fil de l'eau dès les premiers octets reçus.
- **Timeouts et résilience réseau** : `fragLoadingTimeOut` étendu à 30 000 ms avec 4 tentatives exponentielles.

---

## 3. Résultats des Benchmarks Comparatifs

Mesures réalisées avec le banc automatisé (`scripts/run-all-benchmarks.mjs`), testant un flux vidéo 4K réel (VP9 3840x1608 @ 16.6 Mbps, segments fMP4 de ~8 Mo) sous conditions réseau simulées :

### A. Tolérance de Synchronisation Horloge (WebSocket Ping/Pong)

| RTT Simulé | Baseline (Avant) | Step 1 (Kernel BDP) | Step 2 (Clock Sync) | Step 3 (HLS Buffer) | Final (Tout Combiné) |
|:---|:---:|:---:|:---:|:---:|:---:|
| **100 ms** | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré |
| **250 ms** | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré |
| **350 ms** | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré |
| **480 ms** | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré | ✅ Calibré |
| **520 ms** | ❌ **Bloqué (>500ms)** | ❌ **Bloqué (>500ms)** | ✅ **Calibré** | ✅ **Calibré** | ✅ **Calibré** |
| **650 ms** | ❌ **Bloqué (>500ms)** | ❌ **Bloqué (>500ms)** | ✅ **Calibré** | ✅ **Calibré** | ✅ **Calibré** |
| **900 ms** | ❌ **Bloqué (>500ms)** | ❌ **Bloqué (>500ms)** | ✅ **Calibré** | ✅ **Calibré** | ✅ **Calibré** |

*Gain* : 100 % de succès sur les liaisons à très forte latence. Les spectateurs en Corée ou en 4G/5G avec gigue ne restent plus jamais bloqués dans l'état `waiting: not-ready (clock)`.

### B. Performances E2E de Lecture & Débit Utile

#### 1. Profil Séoul Fibre Transcontinental (260 ms RTT, 40 Mbps, 0.2% perte)
- **PC Desktop (Chromium)** :
  - Goodput : **30.99 Mbps** (sature 78% de la capacité théorique malgré 260 ms de latence).
  - TTFP (Temps avant 1er buffer prêt) : **5.27 s** (vs 5.46 s initial).
  - Réserve de buffer maximale : **25.08 s**.
  - Stalls / Freezes : **0**.
- **Apple iPad Pro (WebKit)** :
  - Goodput : **30.95 Mbps**.
  - TTFP : **5.82 s** (vs 5.99 s initial).
  - Réserve de buffer maximale : **24.99 s**.
  - Stalls / Freezes : **0**.

#### 2. Profil Séoul Mobile 4G/5G Congestionné (340 ms RTT, 18 Mbps, 1.5% perte)
- **PC Desktop (Chromium)** :
  - Goodput : **14.70 Mbps** (sature 82% du lien mobile 18 Mbps).
  - TTFP : **8.44 s**.
  - Réserve de buffer maximale : **12.33 s**.
  - Stalls / Freezes : **0**.
- **Apple iPad Pro (WebKit)** :
  - Goodput : **14.53 Mbps**.
  - TTFP : **8.98 s**.
  - Réserve de buffer maximale : **12.24 s**.
  - Stalls / Freezes : **0**.

#### 3. Profil Liaison Dégradée (220 ms RTT, 8 Mbps, 3% perte de paquets)
- **Baseline (Avant)** : La réserve ne dépassait pas 4 secondes et le lecteur **n'atteignait jamais l'état prêt** dans la fenêtre d'observation (`TTFP: Échec > 15s`).
- **Final (Après optimisations)** :
  - Goodput : **7.31 Mbps** (sature 91% de la bande passante disponible).
  - TTFP : **14.25 s** (prêt à jouer atteint !).
  - Réserve de buffer maximale : **9.00 s** (plus que doublée).
  - Stalls / Freezes : **0**.

---

## 4. Outils de Mesure Disponibles

Pour reproduire ou auditer les performances réseau à tout moment :
- `node scripts/benchmark-network.mjs <seoul-fiber|seoul-mobile|poor-connection> <pc|ipad>` : Exécute une mesure ciblée sur un profil et un appareil avec rapport JSON détaillé.
- `node scripts/run-all-benchmarks.mjs <nom_du_run>` : Exécute la suite complète (tolérance RTT, profils Séoul et dégradé sur PC et iPad) et sauvegarde les résultats dans `test-results/benchmarks/<nom_du_run>.json`.
- `node scripts/compare-benchmarks.mjs` : Affiche le tableau comparatif markdown entre les différents runs archivés.
