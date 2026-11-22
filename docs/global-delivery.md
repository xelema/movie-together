# Diffusion mondiale depuis un seul serveur

Recherche du 22 novembre 2026. Question posée : le serveur de Séoul est
arrêté pour raison de coût, seul Amsterdam reste. Comment un ami à Séoul,
y compris en 4G, peut-il regarder le même film qu'un ami à Paris sans
coupure, et plus largement comment ouvrir le service au monde entier ?

## En bref

- La synchronisation n'est pas le problème. Horloge filtrée au plus petit
  RTT, départ planifié et correction de vitesse à 4 % sont déjà en place et
  tiennent à 1 200 ms de RTT. Les produits du marché visent 100 à 500 ms.
- Le problème est le débit soutenu sur 9 000 km. Un film copié octet pour
  octet coûte 15 à 40 Mbit/s, sans version allégée possible.
- Le dernier kilomètre coréen n'est pas le goulot. La 4G/5G coréenne
  mesure 140 à 190 Mbit/s en médiane (Opensignal, décembre 2025). Le goulot
  est le trajet international, et sa capacité aux heures de soirée.
- Recommandation : garder Amsterdam comme origine unique et placer un CDN
  devant `/media` uniquement pour les spectateurs lointains (Bunny, environ
  4 $ par mois pour notre usage), avec copie des films en Asie (Tokyo). Côté
  client, une réserve hors MSE de plusieurs minutes absorbe le reste.
- Première étape gratuite : mesurer. Un ami à Séoul lance 10 minutes de film
  en 4G vers 21 h heure coréenne dans une séance instrumentée d'Amsterdam.
  La télémétrie des segments dit alors si le CDN est nécessaire.

## Feuille de route

| Étape | Contenu | Coût | Effort | Effet attendu à Séoul |
| --- | --- | --- | --- | --- |
| 0 | Séance instrumentée sur Amsterdam, 10 min en 4G à 21 h KST, rapport `telemetry-report.js` | 0 | 30 min | Débit réel par segment, coupures réelles |
| 1 (fait) | Réserve hors MSE : un `fLoader` garde jusqu'à 5 minutes de segments d'avance en mémoire (selon `deviceMemory`), voir plus bas | 0 | fait | Attente divisée par 2 sur une coupure de 75 s |
| 2 | CDN Bunny devant `/media` avec jeton par dossier, activé pour les spectateurs dont le RTT dépasse 150 ms | environ 4 $/mois | 1 jour | Départ et seeks 2 à 4 fois plus rapides, trajet international porté par le CDN |
| 3 | Copie du film préparé vers Bunny Storage (Francfort + Tokyo) | +0,60 $ par film et par mois | 1 jour | Plus aucun segment ne traverse la Corée-Europe pendant la séance |
| 4 | Plusieurs flux par segment (domaines `m1..m4`, HTTP/1.1) | 0 | 1 jour | +20 % seulement si le lien international est saturé, sinon rien |
| Plan B | Relais Vultr Séoul 5 à 6 $/mois, ou rendu 1080p réencodé | 5 à 6 $/mois | moyen à élevé | Si le CDN ne suffit pas ou si la 4G réelle est sous le débit du film |

## Réserve hors MSE

`public/reserve.js` remplace le chargeur de fragments de hls.js. Dès que
hls.js a reçu un segment, la réserve télécharge les suivants (vidéo et
piste audio choisie, dans l'ordre du film, deux à la fois pour ne jamais
laisser le lien inactif entre deux requêtes) et les garde en mémoire. Quand
hls.js les réclame, ils lui sont remis sans réseau, avec leurs vrais temps
de téléchargement.

| Règle | Valeur |
| --- | --- |
| Horizon | 300 s au-delà du dernier segment demandé par hls.js |
| Budget mémoire | 768 Mio si `deviceMemory` vaut 8, 384 Mio à 4 ou inconnu (Firefox, Safari), 96 Mio à 2, coupée en dessous |
| Priorité | Un segment que hls.js charge lui-même (départ, seek hors réserve) passe seul, la réserve attend |
| Seek | Ce qui sort de la nouvelle fenêtre est abandonné, un seek dans la réserve est immédiat |
| Erreur | Le segment est oublié, hls.js le recharge avec ses propres reprises, la réserve attend 5 s |
| Blocage | Un segment en cours que hls.js attend reçoit le même délai que hls.js, puis repasse au chargeur normal |
| Désactivation | `localStorage.movieReserve = 'off'` pour un navigateur |
| Hors champ | Safari en HLS natif (iPhone, iPad, Mac), qui gère seul son tampon |

Mesure avec `scripts/benchmark-network.mjs seoul-evening pc 165 20` : film
VP9 de 16,6 Mbit/s, trajet de 260 ms à 30 Mbit/s qui tombe à 4 Mbit/s
pendant 75 s (de la 60e à la 135e seconde), `minBuffer` de production
(20 s). Le banc partage désormais un seul lien entre requêtes simultanées,
pour que la réserve ne gagne rien gratuitement.

| Mesure | Sans réserve | Avec réserve |
| --- | --- | --- |
| Tampon de départ prêt | 15,5 s | 14,1 s |
| Gels de la séance après le départ | 2 | 1 |
| Temps passé à attendre après le départ | 38,3 s | 17,5 s |
| Position atteinte après 165 s | 107,6 s | 130,9 s |
| Avance maximale dans le tampon MSE | 38 s | 60 s |

La coupure coûte 57 s de film (75 s à un quart du débit nécessaire). Avec
44 s de bon réseau avant elle, la réserve n'avait pu en gagner que 35 : le
reste est de la physique. Plus la séance dure avant un creux, plus la
réserve l'absorbe entièrement.

## Banc d'essai longue distance

`scripts/longhaul-lab/` reproduit le trajet dans WSL avec trois espaces de
noms réseau (spectateur, point de présence, origine), `netem` pour le délai,
la perte et le débit, et un relais Node qui joue le CDN (cache vide ou
plein). Segments de 12 Mo, soit 4 s d'un film à 24 Mbit/s, 8 par mesure.
Débit utile en régime établi, en Mbit/s, moyenne de deux passages :

| Profil | CUBIC direct | BBR direct | BBR 4 flux | BBR 8 flux | CDN, cache vide | CDN, cache plein |
| --- | --- | --- | --- | --- | --- | --- |
| Paris (20 ms) | 183 | 183 | 177 | 179 | 183 | 189 |
| Séoul fibre (250 ms, 0,1 % de perte longue distance) | moins de 13 | 127 | 105 | 99 | 123 | 189 |
| Séoul 4G (60 Mbit/s, 0,5 % de perte radio) | moins de 13 | 47 | 43 | 42 | 48 | 54 |
| Séoul 4G dégradée (30 Mbit/s, 1,5 % de perte) | moins de 13 | 24 | 22 | 23 | 26 | 26 |
| Lien international saturé (100 Mbit/s partagés avec 6 flux CUBIC) | moins de 6 | 38 | 46 | 42 | 40 | 54 |

Temps du premier segment (départ, reprise, seek), en secondes :

| Profil | BBR direct | CDN, cache vide | CDN, cache plein |
| --- | --- | --- | --- |
| Séoul fibre | 3,0 | 3,6 | 0,5 |
| Séoul 4G | 4,2 | 3,7 | 1,9 |
| Séoul 4G dégradée | 5,5 | 5,1 | 3,7 |
| Lien saturé | 7,4 | 3,6 | 1,9 |

Ce que le banc montre :

- Sans BBR, aucun profil coréen ne tient un film de 30 Mbit/s. BBR est le
  réglage qui compte le plus, et il est déjà en production.
- Avec BBR et des pertes aléatoires, découper un segment en plusieurs flux
  n'apporte rien et coûte même 10 à 20 %. Le gain n'apparaît que lorsque
  notre flux partage un lien saturé avec d'autres (+20 %).
- Un CDN à cache vide ne change presque rien dans ce modèle, parce que le
  trajet simulé est propre. Dans la réalité, son intérêt est d'emprunter le
  réseau du CDN au lieu du transit international de l'opérateur coréen, ce
  que le banc ne sait pas simuler.
- Un CDN à cache plein (film copié en Asie) donne le meilleur débit et
  divise le temps de départ et de seek par 1,5 à 6. Un vrai CDN garde aussi
  des connexions chaudes vers l'origine, ce qui raccourcit le cache vide. C'est la seule piste qui
  rend un seek aussi vif à Séoul qu'à Paris.
- La 4G dégradée plafonne au débit radio : un film de 30 Mbit/s ne passe
  pas dans 30 Mbit/s, quelle que soit l'architecture. Seuls un débit de
  film plus bas ou une avance téléchargée bien avant la séance y répondent.

Limites : pas de gigue ni de variations de débit radio, pertes aléatoires
plutôt qu'en rafales, relais Node au lieu d'un vrai CDN, HTTP/1.1 sans TLS.

## Mesures sur le vrai réseau

Sondes en lecture seule, le 22 novembre 2026 vers 23 h, heure de Paris.

| Trajet | Mesure | Résultat |
| --- | --- | --- |
| Amsterdam vers VM Séoul (GCP) | ping, 10 paquets | 250,5 ms, gigue 0,1 ms, 0 % de perte |
| Amsterdam vers VM Séoul | 1 flux TCP (ssh, BBR côté Amsterdam), 300 Mo | 54 Mbit/s, plafonné par la fenêtre de canal ssh de 2 Mo |
| Amsterdam vers VM Séoul | 4 flux en parallèle, 600 Mo | 176 Mbit/s cumulés |
| VM Séoul vers Amsterdam | connexion TCP | 255 ms (1 RTT) |
| VM Séoul vers Amsterdam | premier octet HTTPS à froid | 770 ms (TCP, TLS 1.3, requête : 3 RTT) |
| VM Séoul vers Amsterdam | premier octet, connexion réutilisée | 255 ms (1 RTT par requête) |
| Poste Paris vers Amsterdam | connexion TCP / premier octet chaud | 31 ms / 87 ms |
| Amsterdam vers poste Paris | 1 flux ssh, 200 Mo | 436 Mbit/s |
| VM Séoul vers CDN | point de présence servi | Bunny `KR1`, CloudFront `ICN57`, Cloudflare `ICN` |

Limites : la VM Séoul est dans un datacenter Google, avec un transit
international bien meilleur que celui de KT, SK ou LG U+ en soirée. Ces
chiffres sont un plafond, pas l'expérience d'un téléphone. Aucune séance
réelle n'a laissé de télémétrie sur les deux serveurs (dossiers vides).

## Pistes étudiées

### Réseau et transport

| Piste | Gain attendu | Coût | Effort | Verdict |
| --- | --- | --- | --- | --- |
| BBR, fq, tampons 16 Mo, pas de slow start après pause | x10 à x100 face à CUBIC sur un trajet long avec pertes | 0 | fait | En place à Amsterdam, à garder |
| HTTP/3 (QUIC) | Négatif ici : quic-go n'a que NewReno, BBR ne s'y applique pas | 0 | fait | Rester en h1/h2 |
| BBRv3 | Meilleur partage et ECN | noyau hors arbre | élevé | Non, pas dans Linux ni Ubuntu |
| Plusieurs flux TCP par segment (requêtes Range) | Utile si un flux est bridé ou en concurrence (voir labo) | 0 | moyen | Demande plusieurs connexions : HTTP/2 multiplexe tout sur une seule |
| Cloudflare proxy + Argo | TCP coupé près du spectateur, jusqu'à x2 | 5 $ + 0,10 $/Go | faible | Non : la vidéo hors Stream/R2 viole les conditions, et la Corée est souvent routée vers LAX ou HKG |
| Relais VPS à Séoul (Vultr 5 à 6 $) | Équivalent à l'ancien serveur | 5 à 6 $/mois, 1 à 2 To | moyen | Plan B, c'est de nouveau un serveur à gérer |

### CDN devant Amsterdam

Charge de référence : 4 soirées par mois, 2 spectateurs en Asie, 15 Go par
film et par spectateur, soit 120 Go par mois vers la Corée.

| Option | Prix | Corée | Accès privé | Vidéo autorisée | Coût estimé |
| --- | --- | --- | --- | --- | --- |
| Bunny CDN | Asie 0,03 $/Go, Europe 0,01 $/Go, minimum 1 $ | POP Séoul, servi en Corée sur KT, SKB et LG U+ | Jeton signé par dossier : un jeton couvre playlist et segments | Oui | 3,60 $/mois |
| Bunny Storage (copie Tokyo) | 0,02 $/Go par région, trafic vers le CDN gratuit | Tokyo, Hong Kong, Singapour | Idem via le CDN | Oui | 0,60 $ par film de 15 Go gardé un mois sur 2 régions |
| AWS CloudFront | Plan Free 100 Go et 1 M requêtes, ou 1 To gratuit à l'usage, puis 0,12 $/Go | POP Séoul (ICN) | Cookies signés | Oui | 0 $ dans la franchise |
| Gcore | 1 To gratuit puis 0,01 €/Go | Non vérifié | Jeton sécurisé | Non vérifié | 0 $ |
| Cloudflare R2 + domaine | Stockage 0,015 $/Go, sortie gratuite | Routage coréen vers LAX ou HKG en offre gratuite | Jeton WAF ou Worker | Oui (hébergé sur R2) | environ 1,50 $, mais trajet coréen médiocre |
| Cloudflare Stream | 5 $ pour 1 000 min stockées + 1 $ pour 1 000 min vues | idem | Jetons | Oui | 6 $, mais réencode : perte du flux d'origine et du HDR |
| Google Cloud CDN | 0,09 $/Go Asie + remplissage | POP Séoul | URL signées | Oui | 11 $ |
| Fastly | 100 Go gratuits puis 0,28 $/Go en Corée | POP Séoul | VCL | Offre streaming à part | 5,60 $ |
| Oracle | Pas de CDN, offre gratuite limitée à la région d'origine | Région Chuncheon sans ARM gratuit | n/a | n/a | n/a |

### Côté navigateur

| Piste | Gain attendu | Effort | Verdict |
| --- | --- | --- | --- |
| Réserve hors MSE (préchargement des segments suivants en mémoire ou Cache Storage, servis par un `fLoader`) | Plusieurs minutes d'avance au lieu de 20 à 40 s : un creux de débit de soirée ne coupe plus le film | moyen | Oui, c'est le levier gratuit le plus fort |
| Attente de départ plus longue (`minBuffer`) | Moins de coupures en début de film | réglage | Déjà réglable dans l'admin |
| Réserve MSE plus grosse | Bloquée par les quotas MSE (environ 150 Mo vidéo sur Chrome, bien moins sur TV et mobile) | faible | Insuffisant seul |
| P2P WebRTC (p2p-media-loader) | Nul avec un seul spectateur à Séoul, Paris et Séoul sont aussi loin entre eux | moyen | Non |
| WebTransport pour la synchro | Négligeable, messages minuscules, demande HTTP/3 | élevé | Non |
| Version mobile réencodée 1080p | Rend la 4G triviale | élevé (2 cœurs ARM) | Contraire à la règle de copie exacte, dernier recours |

### Synchronisation

| Élément | État actuel | Référence du marché |
| --- | --- | --- |
| Horloge | Plus petit RTT sur 20 échantillons, fenêtre 20 s, accepté jusqu'à 1 200 ms | Jellyfin SyncPlay : plus petit RTT sur 8 |
| Départ | Heure serveur planifiée, acquittement immédiat | idem |
| Dérive | Vitesse 0,96 ou 1,04, pause au-delà de 2,5 s | Jellyfin dès 50 ms, Syncplay 1,5 s, Teleparty environ 500 ms |
| Erreur d'horloge attendue | moitié de l'asymétrie du trajet, moins de 100 ms en pratique | Social TV : quelques centaines de ms suffisent |

## Au-delà de la Corée

Le même schéma vaut pour n'importe quel pays : origine unique à Amsterdam
(10 To de sortie gratuits chez Oracle), CDN pour les spectateurs lointains.

| Région du spectateur | RTT vers Amsterdam (ordre de grandeur) | Prix Bunny | Film de 15 Go |
| --- | --- | --- | --- |
| Europe | 10 à 40 ms | direct, gratuit | 0 $ |
| Amérique du Nord | 80 à 160 ms | 0,01 $/Go | 0,15 $ |
| Asie, Océanie | 200 à 320 ms | 0,03 $/Go | 0,45 $ |
| Amérique du Sud | 180 à 250 ms | 0,045 $/Go | 0,68 $ |
| Afrique, Moyen-Orient | 60 à 200 ms | 0,06 $/Go | 0,90 $ |

Point d'attention : un CDN voit passer les fichiers. Les jetons empêchent
l'accès public, pas l'opérateur du CDN. Cloudflare reste exclu tant que la
vidéo doit venir d'une origine externe (conditions de service) et que les
opérateurs coréens sont routés hors de Corée en offre gratuite.

## Sources

- Bunny, prix CDN et stockage : https://bunny.net/pricing/cdn/ et https://bunny.net/pricing/storage/
- Bunny, jetons par dossier : https://bunny.net/docs/cdn/security/token-authentication/advanced
- CloudFront, plans et franchise : https://aws.amazon.com/cloudfront/pricing/
- Cloudflare, vidéo et conditions : https://www.cloudflare.com/service-specific-terms-application-services/
- Routage coréen des CDN, novembre 2026 : https://zerodraftlab.com/korea-edge-hosting-routing/
- Incident KT vers Seattle : https://community.cloudflare.com/t/kt-as4766-korea-traffic-routed-to-sea-with-packet-loss-and-very-slow-loading/967903
- quic-go sans BBR : https://quic-go.net/docs/quic/congestion-control/ et https://github.com/quic-go/quic-go/issues/4565
- BBRv3 hors du noyau principal : https://github.com/google/bbr/blob/v3/README.md
- hls.js, chargement parallèle refusé : https://github.com/video-dev/hls.js/issues/5284
- Quotas de stockage navigateur : https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Débits mobiles coréens : https://insights.opensignal.com/reports/2025/12/southkorea/mobile-network-experience
- Synchronisation, Jellyfin SyncPlay : https://openwatchparty.com/technical/jellyfin-syncplay-reference/
- Oracle, ressources gratuites : https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
