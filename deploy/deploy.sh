#!/usr/bin/env bash
# Deploie le projet sur la VM distante : archive locale, copie scp, build Docker
# et redemarrage des services. A lancer depuis Git Bash apres une modification :
#
#   bash deploy/deploy.sh
#
# Options via variables d'environnement :
#   SSH_HOST    hote distant          (defaut : ubuntu@144.21.40.251)
#   SSH_KEY     cle privee            (defaut : ~/.ssh/id_rsa)
#   REMOTE_DIR  dossier sur la VM     (defaut : movie-night, relatif au home)
#   PUSH_ENV    fichier local envoye comme .env distant, puis conserve
#   BBR=1       inclut compose.bbr.yaml
#
# Exemples :
#   PUSH_ENV=.env.production bash deploy/deploy.sh
#   BBR=1 bash deploy/deploy.sh
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

SSH_HOST=${SSH_HOST:-ubuntu@144.21.40.251}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_rsa}
REMOTE_DIR=${REMOTE_DIR:-movie-night}
PUSH_ENV=${PUSH_ENV:-}
BBR=${BBR:-0}

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

[[ -f $SSH_KEY ]] || { echo "Cle SSH introuvable : $SSH_KEY" >&2; exit 1; }
if [[ -n $PUSH_ENV && ! -f $PUSH_ENV ]]; then
  echo "Fichier PUSH_ENV introuvable : $PUSH_ENV" >&2
  exit 1
fi

echo ">> Connexion a $SSH_HOST"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" 'echo connecte'

if [[ -n $PUSH_ENV ]]; then
  echo ">> Envoi de $PUSH_ENV comme .env distant"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "mkdir -p ~/$REMOTE_DIR"
  scp "${SSH_OPTS[@]}" "$PUSH_ENV" "$SSH_HOST:$REMOTE_DIR/.env"
fi

ARCHIVE=$(mktemp --suffix=.tgz)
trap 'rm -f "$ARCHIVE"' EXIT

echo ">> Creation de l'archive du projet"
tar -czf "$ARCHIVE" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./dist' \
  --exclude='./e2e' \
  --exclude='./test' \
  --exclude='./test-results' \
  --exclude='./playwright-report' \
  --exclude='./.env' \
  --exclude='*.log' \
  --exclude='./comparison.png' \
  --exclude='./private-notes.txt' \
  .

echo ">> Envoi de l'archive"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "$SSH_HOST:/tmp/movie-night-deploy.tgz"

echo ">> Extraction et reconstruction sur la VM"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$BBR" <<'REMOTE'
set -euo pipefail
case $1 in /*) APP_DIR=$1 ;; *) APP_DIR=$HOME/$1 ;; esac
BBR=$2

# Refuse de vider un dossier sensible si REMOTE_DIR est mal configure.
case $APP_DIR in "$HOME"|"/"|"") echo "REMOTE_DIR invalide : $APP_DIR" >&2; exit 1 ;; esac

if [[ ! -f $APP_DIR/.env ]]; then
  echo "ERREUR : $APP_DIR/.env absent sur le serveur." >&2
  echo "Cree-le avec DOMAIN, ADMIN_PASSWORD et MEDIA_DIR (modele : .env.example)," >&2
  echo "ou relance avec PUSH_ENV=fichier bash deploy/deploy.sh pour l'envoyer." >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
tar -xzf /tmp/movie-night-deploy.tgz -C "$TMP_DIR"
rm -f /tmp/movie-night-deploy.tgz
cp -a "$APP_DIR/.env" "$TMP_DIR/.env"
chmod 600 "$TMP_DIR/.env"

find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
cp -a "$TMP_DIR"/. "$APP_DIR"/
rm -rf "$TMP_DIR"

cd "$APP_DIR"
if docker info >/dev/null 2>&1; then SUDO=; else SUDO=sudo; fi
args=(-f compose.yaml)
[[ $BBR == 1 ]] && args+=(-f compose.bbr.yaml)
$SUDO docker compose "${args[@]}" config --quiet
$SUDO docker compose "${args[@]}" up -d --build --wait --wait-timeout 300
$SUDO docker compose "${args[@]}" ps
REMOTE

echo ">> Deploiement termine. Les rooms en cours ont ete fermees par le redemarrage."
