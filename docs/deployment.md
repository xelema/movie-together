# Déployer sur une VM Linux

Pour un premier déploiement par archive, suivre l'[installation rapide](quickstart.md).

Les instructions Docker s'appliquent aussi à un VPS aux Pays-Bas. Les étapes de
création de VM et de disque ci-dessous prennent Google Cloud comme exemple.

## Architecture

Une VM Compute Engine Linux héberge Caddy, l'application et FFmpeg. Un disque
persistant dédié contient les films. Le serveur reste unique : les rooms sont
en mémoire. Les [WebSockets Cloud Run](https://docs.cloud.google.com/run/docs/triggering/websockets)
ont une durée limitée et l'affinité ne garantit pas une instance commune : ne pas
déployer cette version sur plusieurs instances Cloud Run sans adapter la coordination.

## Préparation

Dans le projet Google Cloud choisi par le propriétaire :

1. Créer une VM Debian 12 proche des participants. Deux vCPU et 4 Go de RAM sont
   un point de départ à mesurer pour servir des films déjà préparés. La préparation des fichiers se termine avant la lecture.
2. Réserver une IP externe et faire pointer un sous-domaine dessus.
3. Attacher un disque persistant pour les films, sans suppression automatique avec
   la VM. Additionner originaux, copie vidéo segmentée et audios, plus une
   marge pour les préparations et sauvegardes (voir le README).
4. Monter ce disque à `/mnt/movie-data` et configurer son montage persistant dans
   `/etc/fstab` suivant le [guide Google Cloud](https://docs.cloud.google.com/compute/docs/disks/add-persistent-disk).
   Ne jamais formater un disque contenant déjà des données.
5. Installer Docker Engine et Compose avec le [guide Debian officiel](https://docs.docker.com/engine/install/debian/).
6. Autoriser TCP 80 et 443, ainsi que UDP 443 pour HTTP/3 pour cette VM. Limiter SSH à l'administration ou utiliser
   IAP. Ne pas exposer publiquement le port applicatif 3000.

Prévoir VM, disque, IP, sauvegardes et trafic sortant dans le budget. Deux lectures
de 15 Go représentent environ 30 Go transférés. Configurer une alerte de budget.
Aucun service payant n'est créé automatiquement par ce dépôt.

## Lancement

Placer le dépôt sur la VM puis, depuis sa racine :

```sh
cp .env.example .env
chmod 600 .env
```

Éditer `.env` avec un secret aléatoire d'au moins 16 caractères, le domaine seul
(sans protocole ni slash final) et le chemin du disque :

```dotenv
ADMIN_PASSWORD=remplacer-par-un-secret-aleatoire-long
DOMAIN=films.example.com
MEDIA_DIR=/mnt/movie-data
MIN_BUFFER_SECONDS=20
LOW_BUFFER_SECONDS=5
ENCODE_THREADS=2
```

Le conteneur utilise UID/GID 1000. Après vérification du montage et de son contenu :

```sh
sudo chown 1000:1000 /mnt/movie-data
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 app
```

Compose définit `APP_ORIGIN` à `https://DOMAIN`. Caddy obtient et renouvelle le
certificat si le domaine résout vers la VM et que les ports sont accessibles ; il
relaie les WebSockets. Aucun encodage HTTP des médias n'est configuré. Ne jamais
mettre le mot de passe dans un commit ou un journal partagé.

Valider un petit film puis un original de taille habituelle avec la
[matrice de validation](validation.md).

## Exploitation

### Lecture depuis la Corée du Sud

Le lecteur HLS.js garde 30 à 60 secondes d'avance dans un budget de 60 Mio.
Safari natif gère lui-même cette réserve.
Les segments peuvent être réutilisés depuis le cache privé du navigateur après
vérification des droits auprès du serveur ; les listes de lecture ne sont pas
conservées. Cela évite de retransférer les mêmes données lors d'un retour en arrière.
Chaque spectateur reçoit la même vidéo d'origine, segmentée avant la séance.

Pour une installation existante, ces seuils se règlent depuis la page admin
(Réglages, section Synchronisation) et s'appliquent aux séances en cours.
Les variables `.env` (`MIN_BUFFER_SECONDS`, `LOW_BUFFER_SECONDS`,
`ENCODE_THREADS`) restent les défauts de déploiement tant qu'aucun réglage
n'a été sauvegardé. Le démarrage et la reprise attendent ainsi vingt secondes
d'avance chez chacun (ou la durée restante), et la pause commune intervient
sous cinq secondes. Le chargement initial est plus long, mais laisse une
meilleure marge.

Compose publie aussi UDP 443 : l'autoriser dans le pare-feu Linux et chez
l'hébergeur pour [HTTP/3 de Caddy](https://caddyserver.com/docs/modules/http).
HTTP/2 reste disponible lorsque le réseau ne laisse pas passer UDP.

### BBR optionnel sur le VPS

[BBR](https://github.com/google/bbr/blob/master/Documentation/bbr-quick-start.md)
peut améliorer le débit TCP sur certains trajets à forte latence. Il ne garantit
pas un gain et ce réglage Linux ne configure pas le transport QUIC d'HTTP/3.
Sur le VPS Linux, vérifier sa disponibilité avant toute installation :

```sh
sudo modprobe tcp_bbr
sysctl net.ipv4.tcp_available_congestion_control
sysctl net.core.default_qdisc net.ipv4.tcp_congestion_control
```

Si `bbr` apparaît, noter les anciennes valeurs puis installer le fichier dédié :

```sh
sudo install -m 644 deploy/99-movie-together-network.conf /etc/sysctl.d/99-movie-together-network.conf
sudo sysctl -p /etc/sysctl.d/99-movie-together-network.conf
docker compose -f compose.yaml -f compose.bbr.yaml up -d
docker compose exec proxy sysctl net.ipv4.tcp_congestion_control
```

Le fichier Compose complémentaire applique BBR dans l'espace réseau du proxy
Docker, qui termine les connexions des spectateurs. Garder les deux `-f` pour
les prochains déploiements. Le résultat dans le proxy doit être `bbr`.
`default_qdisc` concerne les interfaces nouvellement créées ; vérifier les
interfaces existantes avec `tc qdisc show`, sans remplacer leur configuration
aveuglément. Aucun noyau personnalisé n'est nécessaire.

Pour revenir en arrière, retirer le fichier sysctl dédié, rétablir les deux
valeurs notées avec `sudo sysctl -w`, puis recréer le proxy avec Compose seul.

Mesurer ensuite depuis la connexion coréenne avec un film représentatif. Un
film conserve son débit vidéo d'origine, avec des pointes : prévoir une marge
et additionner les débits pour plusieurs personnes. Par exemple, 15 Go en deux
heures représentent environ 17 Mbit/s par spectateur avant marge.
Si le débit reste insuffisant, envisager un hébergement des médias plus proche
ou un CDN vidéo avec accès privé signé. Un proxy inverse sur la même VM ne
raccourcit pas le trajet international. Aucun CDN ni relais payant n'est créé.

- Planifier des snapshots du disque et vérifier une restauration. Éviter les imports
  pendant la sauvegarde ou arrêter temporairement l'application pour sa cohérence.
  Voir les [snapshots Google Cloud](https://docs.cloud.google.com/compute/docs/disks/create-snapshots).
- Sauvegarder `.env` séparément dans un emplacement privé. Sessions et rooms en cours
  disparaissent au redémarrage.
- Mettre à jour avec `docker compose up -d --build` après récupération du code.
  Prévenir les participants : cela ferme les rooms.
- Depuis un poste Windows, `bash deploy/deploy.sh` (ou `npm run deploy`) envoie
  le code par SSH vers la VM puis reconstruit et redémarre les conteneurs. Le
  `.env` du serveur est conservé, sauf `GEMINI_API_KEY` et `GOOGLE_API_KEY`
  propagées depuis le `.env` local à chaque déploiement. Au premier
  déploiement, créer le `.env` sur la
  VM ou lancer `PUSH_ENV=fichier bash deploy/deploy.sh` pour l'envoyer. Les
  variables `SSH_KEY`, `REMOTE_DIR` et `BBR=1` sont décrites en tête du script.
  `SSH_HOST` est obligatoire : passer la variable ou la noter dans
  `.env.production`.
- Surveiller disque et journaux. Supprimer les uploads abandonnés dans l'admin.
  Une préparation réussie supprime les générations précédentes.
- Ne pas utiliser `docker compose down -v` pour une mise à jour : cette commande
  supprime les volumes, dont les certificats et les médias avec le volume par défaut.

Projet, domaine et accès Google Cloud restent nécessaires pour le déploiement réel.
La configuration fournie ne provisionne ni ne publie automatiquement.

## Autre VPS, notamment Oracle

Le même Compose peut fonctionner sur un VPS Linux x86-64 ou ARM64 avec Docker,
un disque persistant et les ports 80/443 accessibles. Les règles réseau du
fournisseur et le pare-feu de la VM doivent tous deux autoriser ces ports.
Limiter `ENCODE_THREADS` sur une petite instance et préparer un extrait avant un
long film pour mesurer le temps et l'espace nécessaires. La préparation des fichiers est distincte de leur lecture.

Pour une offre gratuite, vérifier les quotas, la disponibilité et les règles
de récupération des instances au moment de créer la VM. Les tests locaux ne valident pas les performances d’un VPS ARM.
