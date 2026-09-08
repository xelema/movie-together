# Installation rapide : GCP ou OCI, x86_64 ou ARM64

## 1. Préparer la VM

Choisir Ubuntu Server 24.04 LTS, x86_64 ou ARM64 (par exemple
[OCI Ampere A1](https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm)).
Deux cœurs et 4 Go de RAM constituent un point de départ à mesurer pour deux
spectateurs. Prévoir la place pour les originaux **et** les fichiers préparés.
Les images [Node](https://hub.docker.com/_/node/) et
[Caddy](https://hub.docker.com/_/caddy/) sont multiarchitecture : rien à changer
dans Dockerfile ou Compose. Ne pas transférer `node_modules` depuis Windows.

- Réserver une IP publique, puis pointer un domaine ou sous-domaine vers elle.
- Autoriser TCP 80/443 et UDP 443 dans le pare-feu cloud **et** celui de la VM.
- GCP : règle entrante VPC appliquée à cette VM. OCI : Security List ou NSG de
  son réseau, avec sous-réseau public et route vers l'Internet Gateway.
- Limiter SSH (TCP 22) à votre IP. Le port 3000 reste interne.
- Installer [Docker Engine et Compose pour Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
  Vérifier `sudo docker info` et `sudo docker compose version`.

## 2. Envoyer et démarrer

Depuis PowerShell sur le PC (adapter la clé, le compte et l'IP) :

```powershell
scp -i C:\chemin\cle.pem dist/movie-together.tar.gz ubuntu@IP_VM:~/
ssh -i C:\chemin\cle.pem ubuntu@IP_VM
```

Sur la VM :

```sh
mkdir -p ~/movie-together
tar -xzf ~/movie-together.tar.gz -C ~/movie-together
cd ~/movie-together
sudo bash deploy/start.sh films.example.com
```

Le script génère `.env` avec un mot de passe aléatoire, construit l'image pour
l'architecture de la VM et attend que l'application soit saine. Une configuration
existante n'est jamais écrasée. Caddy obtient le certificat HTTPS automatiquement ;
cela exige que le domaine et les ports soient déjà configurés.

Lire le mot de passe localement avec `sudo nano .env`, puis ouvrir
`https://films.example.com/admin`. Les invités utilisent l'adresse sans `/admin`.
Importer un petit film, le préparer et tester une séance depuis deux appareils.
Ni Node, ni FFmpeg ne sont à installer sur la VM : Docker les contient.

## Stockage et mises à jour

Par défaut les films sont dans un volume Docker persistant sur le disque de la VM.
Ne jamais utiliser `docker compose down -v` : cela supprime les volumes.
Garder le même dossier de projet lors des mises à jour pour retrouver ces volumes.
Sauvegarder les films et `.env` avant toute suppression ou remplacement de VM.

Pour utiliser un disque dédié, le monter d'abord, puis ajouter
`MEDIA_DIR=/mnt/movie-data` à `.env` **avant le premier import**. Le répertoire
doit être accessible en écriture à UID/GID 1000. Voir le
[guide complet](deployment.md) pour le montage et les permissions.
Changer ce chemin ne déplace pas automatiquement une bibliothèque existante.

Pour une mise à jour, envoyer la nouvelle archive, l'extraire dans le même dossier
puis exécuter `sudo bash deploy/start.sh`. Les films et le mot de passe sont conservés ;
le redémarrage ferme les séances en cours. L'archive ne contient ni `.env` ni films.

Si BBR a été activé suivant le [guide réseau](deployment.md#bbr-optionnel-sur-le-vps),
utiliser `sudo BBR=1 bash deploy/start.sh` pour chaque lancement/mise à jour.
Pour diagnostiquer : `sudo docker compose ps` et
`sudo docker compose logs --tail=50 app proxy`.

Pour recréer l'archive depuis un dépôt commité :

```sh
git archive --format=tar.gz --output=dist/movie-together.tar.gz HEAD
```

Créer le dossier `dist` au préalable. L'archive contient uniquement les fichiers
suivis par Git ; ne jamais commiter de secret ou de fichier de film.
