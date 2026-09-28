#!/usr/bin/env bash
# Demarre ou met a jour la preview d'une pull request.
#
#   sudo bash deploy/preview/up.sh <numero-de-pr> <image>
#
# La preview est servie sur https://pr-<numero>.$PREVIEW_DOMAIN:$PREVIEW_PORT par le
# proxy de deploy/preview/compose.yaml.
#
# Les films de production sont montes en overlayfs : la preview les voit en lecture
# seule (source, movie.json, segments deja encodes) et tout ce qu'elle ecrit
# (re-probe de movie.json, nouvel encodage, telemetrie) part dans une couche jetable
# de l'hote. Le volume de production n'est jamais modifie.
set -euo pipefail

PR=${1:-}
IMAGE=${2:-}
if [ -z "$PR" ] || [ -z "$IMAGE" ]; then
  echo "usage: sudo bash deploy/preview/up.sh <numero-de-pr> <image>" >&2
  exit 2
fi
case $PR in *[!0-9]*) echo "numero de PR invalide : $PR" >&2; exit 2 ;; esac
if [ "$(id -u)" != 0 ]; then
  echo "ce script monte un overlayfs : le lancer avec sudo" >&2
  exit 2
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image introuvable : $IMAGE (la construire avant de demarrer la preview)" >&2
  exit 2
}

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
STATE_ROOT=${PREVIEW_DIR:-/home/ubuntu/previews}
PROD_DATA_VOLUME=${PROD_DATA_VOLUME:-movie-together_movie-data}
DOMAIN=${PREVIEW_DOMAIN:-movie-together.duckdns.org}
PORT=${PREVIEW_PORT:-8443}
HOST="pr-$PR.$DOMAIN"
STATE="$STATE_ROOT/pr-$PR"
DATA="$STATE/data"

log() { printf '>> %s\n' "$*"; }

# --- mot de passe de la preview ------------------------------------------------
# Le secret PREVIEW_ADMIN_PASSWORD est prioritaire ; sinon on reprend celui de la
# derniere execution, sinon on en genere un. Il doit faire au moins 16 caracteres :
# le serveur refuse de demarrer en dessous.
admin=${PREVIEW_ADMIN_PASSWORD:-}
if [ -z "$admin" ] && [ -f "$STATE/metadata.json" ]; then
  admin=$(sed -n 's/.*"adminPassword": *"\([^"]*\)".*/\1/p' "$STATE/metadata.json" | head -1)
fi
if [ -z "$admin" ]; then
  admin=$(openssl rand -hex 16)
fi
if [ "${#admin}" -lt 16 ]; then
  echo "mot de passe de preview trop court : 16 caracteres minimum" >&2
  exit 2
fi

# --- etat de la preview --------------------------------------------------------
install -d -m 755 "$STATE_ROOT"
install -d -m 755 "$STATE"
# La couche superieure de l'overlay et les dossiers de donnees appartiennent a
# l'utilisateur du conteneur (node, uid 1000 dans l'image).
install -d -o 1000 -g 1000 -m 755 "$STATE/upper"
install -d -m 700 "$STATE/work"
install -d -o 1000 -g 1000 -m 755 "$DATA"
install -d -o 1000 -g 1000 -m 755 "$DATA/uploads" "$DATA/telemetry"

# --- films de production, en lecture seule -------------------------------------
lower="/var/lib/docker/volumes/$PROD_DATA_VOLUME/_data"
install -d -m 755 "$DATA/movies"
if ! mountpoint -q "$DATA/movies"; then
  [ -d "$lower/movies" ] || {
    echo "films de production introuvables : $lower/movies" >&2
    exit 1
  }
  mount -t overlay overlay \
    -o "lowerdir=$lower/movies,upperdir=$STATE/upper,workdir=$STATE/work" \
    "$DATA/movies"
  log "overlay monte sur $DATA/movies (ecritures isolees dans $STATE/upper)"
fi

# Les reglages de lecture de la production sont repris une fois, pour que la preview
# se comporte comme la prod ; les ajustements faits dans la preview sont conserves
# ensuite.
if [ ! -f "$DATA/settings.json" ] && [ -f "$lower/settings.json" ]; then
  install -m 644 -o 1000 -g 1000 "$lower/settings.json" "$DATA/settings.json"
fi

umask 077
cat > "$STATE/metadata.json" <<EOF
{
  "pr": $PR,
  "image": "$IMAGE",
  "host": "$HOST",
  "url": "https://$HOST:$PORT",
  "adminPassword": "$admin",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# La definition du service est copiee chez l'hote : le dossier de travail du runner
# est efface a chaque execution, pas l'etat de la stack.
install -m 644 "$ROOT/deploy/preview/compose.preview.yaml" "$STATE_ROOT/compose.preview.yaml"

cat > "$STATE/preview.env" <<EOF
PREVIEW_IMAGE=$IMAGE
PREVIEW_DATA=$DATA
PREVIEW_ORIGIN=https://$HOST:$PORT
PREVIEW_ADMIN_PASSWORD=$admin
PREVIEW_ALIAS=pr-$PR-app
MIN_BUFFER_SECONDS=${MIN_BUFFER_SECONDS:-20}
LOW_BUFFER_SECONDS=${LOW_BUFFER_SECONDS:-5}
EOF

log "preview $PR : $IMAGE"
docker compose \
  --project-name "pr-$PR" \
  --env-file "$STATE/preview.env" \
  --file "$STATE_ROOT/compose.preview.yaml" \
  up --detach --remove-orphans --wait --wait-timeout 180

docker ps --filter "label=com.docker.compose.project=pr-$PR" \
  --format '{{.Names}} {{.Image}} {{.Status}}'
log "preview accessible sur https://$HOST:$PORT (mot de passe dans $STATE/metadata.json)"
