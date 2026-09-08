#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

command -v docker >/dev/null || { echo 'Installer Docker Engine et le plugin Compose (voir docs/quickstart.md).' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null

if [[ ! -e .env ]]; then
  domain=${1:-}
  if [[ ${#domain} -gt 253 || ! $domain =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; then
    echo 'Premier lancement : bash deploy/start.sh films.example.com (domaine sans https://).' >&2
    exit 1
  fi
  secret=$(openssl rand -hex 24)
  (umask 077; set -o noclobber; printf 'DOMAIN=%s\nADMIN_PASSWORD=%s\nMIN_BUFFER_SECONDS=20\nLOW_BUFFER_SECONDS=5\nENCODE_THREADS=2\n' "$domain" "$secret" > .env)
  unset secret
fi

args=(-f compose.yaml)
if [[ ${BBR:-0} == 1 ]]; then args+=(-f compose.bbr.yaml); fi
docker compose "${args[@]}" config --quiet
docker compose "${args[@]}" up -d --build --wait --wait-timeout 180
docker compose "${args[@]}" ps
echo 'Services lancés. Ouvrir https://VOTRE_DOMAINE/admin. Le mot de passe est dans .env.'
echo 'Si HTTPS ne répond pas, vérifier DNS et pare-feu, puis docker compose logs --tail=50 proxy.'
