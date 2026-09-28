#!/usr/bin/env bash
# Supprime la preview d'une pull request : conteneur, couche overlay, images.
#
#   sudo bash deploy/preview/down.sh <numero-de-pr>
#
# Idempotent : sur une preview deja supprimee, il ne fait rien.
set -euo pipefail

PR=${1:-}
if [ -z "$PR" ]; then
  echo "usage: sudo bash deploy/preview/down.sh <numero-de-pr>" >&2
  exit 2
fi
case $PR in *[!0-9]*) echo "numero de PR invalide : $PR" >&2; exit 2 ;; esac

STATE_ROOT=${PREVIEW_DIR:-/home/ubuntu/previews}
STATE="$STATE_ROOT/pr-$PR"

log() { printf '>> %s\n' "$*"; }

containers=$(docker ps --all --quiet --filter "label=com.docker.compose.project=pr-$PR")
if [ -n "$containers" ]; then
  # shellcheck disable=SC2086
  docker rm --force $containers >/dev/null
  log "conteneur de la preview $PR supprime"
fi

if mountpoint -q "$STATE/data/movies"; then
  umount "$STATE/data/movies"
  log "overlay demonte"
fi

rm -rf "$STATE"

images=$(docker image ls --format '{{.Repository}}:{{.Tag}}' \
  --filter "reference=movie-together-app:pr-$PR-*")
if [ -n "$images" ]; then
  # shellcheck disable=SC2086
  docker image rm --force $images >/dev/null 2>&1 || true
  log "images de la preview $PR supprimees"
fi

log "preview $PR supprimee"
