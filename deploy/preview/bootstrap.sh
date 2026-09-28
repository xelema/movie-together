#!/usr/bin/env bash
# Installe ou met a jour la stack permanente des previews.
#
#   sudo bash deploy/preview/bootstrap.sh              # production : certificat wildcard DuckDNS
#   sudo bash deploy/preview/bootstrap.sh --local      # verification locale : certificat interne
#   sudo bash deploy/preview/bootstrap.sh --ensure     # ne touche a rien si la stack tourne deja avec un token
#   sudo bash deploy/preview/bootstrap.sh --rebuild    # reconstruit l'image Caddy (nouvelle version du module)
#
# DUCKDNS_TOKEN est lu dans l'environnement (le workflow de preview le fournit depuis
# les secrets GitHub). Sans token, la stack demarre avec un certificat interne : la
# chaine peut etre verifiee, mais aucune PR n'est utilisable depuis un navigateur.
set -euo pipefail

MODE=${PREVIEW_BOOTSTRAP_MODE:-install}
REBUILD=
for argument in "$@"; do
  case $argument in
    --local) MODE=local ;;
    --ensure) MODE=ensure ;;
    --rebuild) REBUILD=1 ;;
    *) echo "option inconnue : $argument" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != 0 ]; then
  echo "lancer avec sudo" >&2
  exit 2
fi

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
STATE_ROOT=${PREVIEW_DIR:-/home/ubuntu/previews}
DOMAIN=${PREVIEW_DOMAIN:-movie-together.duckdns.org}
PORT=${PREVIEW_PORT:-8443}
CADDY_IMAGE=caddy-duckdns:2.11

labels=$(printf '%s' "$DOMAIN" | tr -cd '.' | wc -c)
if [ "$labels" != 2 ]; then
  echo "PREVIEW_DOMAIN doit comporter exactement trois labels (ex. movie-together.duckdns.org) : $DOMAIN" >&2
  exit 2
fi

log() { printf '>> %s\n' "$*"; }

# Le reseau est partage par le proxy et par les previews : il est declare externe dans
# compose.yaml, donc c'est ici qu'il est cree.
if ! docker network inspect previews >/dev/null 2>&1; then
  docker network create previews >/dev/null
  log "reseau docker previews cree"
fi

# --ensure : le workflow de preview appelle cette branche a chaque PR. Si la stack
# tourne deja avec un token DuckDNS, il n'y a rien a faire.
if [ "$MODE" = ensure ]; then
  running=$(docker ps --quiet --filter name=previews-proxy)
  if [ -n "$running" ]; then
    current=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$running" |
      sed -n 's/^DUCKDNS_TOKEN=//p' | head -1)
    if [ -n "$current" ]; then
      log "stack de preview deja en service avec un token DuckDNS"
      exit 0
    fi
    log "stack de preview sans token DuckDNS : recreation"
  fi
fi

log "installation dans $STATE_ROOT"
install -d -m 755 "$STATE_ROOT"
install -m 644 "$ROOT/deploy/preview/Dockerfile" "$STATE_ROOT/Dockerfile"
install -m 644 "$ROOT/deploy/preview/compose.yaml" "$STATE_ROOT/compose.yaml"
install -m 644 "$ROOT/deploy/preview/Caddyfile" "$STATE_ROOT/Caddyfile.dns"
install -m 644 "$ROOT/deploy/preview/Caddyfile.local" "$STATE_ROOT/Caddyfile.internal"

# Le token n'est ecrit ni dans le Caddyfile ni dans l'historique du shell : il passe
# par l'environnement du conteneur (et par ce .env, en 600, qui permet a compose de
# recreer la stack sans qu'on ait a le ressaisir).
umask 077
: > "$STATE_ROOT/.env"
{
  printf 'PREVIEW_DOMAIN=%s\n' "$DOMAIN"
  printf 'PREVIEW_PORT=%s\n' "$PORT"
  if [ -n "${DUCKDNS_TOKEN:-}" ]; then
    printf 'DUCKDNS_TOKEN=%s\n' "$DUCKDNS_TOKEN"
  fi
} >> "$STATE_ROOT/.env"

if [ "$MODE" != local ] && [ -n "${DUCKDNS_TOKEN:-}" ]; then
  install -m 644 "$STATE_ROOT/Caddyfile.dns" "$STATE_ROOT/Caddyfile"
  log "certificat wildcard via DuckDNS (DNS-01)"
else
  install -m 644 "$STATE_ROOT/Caddyfile.internal" "$STATE_ROOT/Caddyfile"
  echo "AVERTISSEMENT : pas de DUCKDNS_TOKEN, certificat interne — previews utilisables" >&2
  echo "seulement pour verifier la chaine en local (voir docs/cd.md)." >&2
fi

if [ -n "$REBUILD" ] || ! docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
  log "construction de $CADDY_IMAGE (module duckdns)"
  docker build --tag "$CADDY_IMAGE" "$STATE_ROOT"
fi

cd "$STATE_ROOT"
docker compose --project-name previews up --detach --remove-orphans --wait --wait-timeout 120
docker compose --project-name previews ps
log "proxy des previews : *.${DOMAIN}:${PORT}"
