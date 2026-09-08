# Déployer sur Google Cloud

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
   la VM. Additionner originaux, versions remuxées et audios, plus une
   marge pour les préparations et sauvegardes (voir le README).
4. Monter ce disque à `/mnt/movie-data` et configurer son montage persistant dans
   `/etc/fstab` suivant le [guide Google Cloud](https://docs.cloud.google.com/compute/docs/disks/add-persistent-disk).
   Ne jamais formater un disque contenant déjà des données.
5. Installer Docker Engine et Compose avec le [guide Debian officiel](https://docs.docker.com/engine/install/debian/).
6. Autoriser TCP 80 et 443 pour cette VM. Limiter SSH à l'administration ou utiliser
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
MIN_BUFFER_SECONDS=8
LOW_BUFFER_SECONDS=3
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

- Planifier des snapshots du disque et vérifier une restauration. Éviter les imports
  pendant la sauvegarde ou arrêter temporairement l'application pour sa cohérence.
  Voir les [snapshots Google Cloud](https://docs.cloud.google.com/compute/docs/disks/create-snapshots).
- Sauvegarder `.env` séparément dans un emplacement privé. Sessions et rooms en cours
  disparaissent au redémarrage.
- Mettre à jour avec `docker compose up -d --build` après récupération du code.
  Prévenir les participants : cela ferme les rooms.
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
