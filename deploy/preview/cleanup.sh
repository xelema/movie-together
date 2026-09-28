#!/usr/bin/env bash
# Supprime les previews orphelines.
#
#   sudo OPEN_PRS="12 14" bash deploy/preview/cleanup.sh
#
# OPEN_PRS est la liste des numeros de PR encore ouvertes (le workflow la calcule via
# gh). Tout projet Compose pr-<numero> qui n'y figure pas est supprime, et une preview
# qui n'a pas ete redeployee depuis PREVIEW_MAX_AGE_DAYS jours l'est aussi.
set -euo pipefail

STATE_ROOT=${PREVIEW_DIR:-/home/ubuntu/previews}
OPEN_PRS=${OPEN_PRS:-}
MAX_AGE_DAYS=${PREVIEW_MAX_AGE_DAYS:-14}
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
now=$(date -u +%s)

projects=$(docker ps --all --format '{{.Label "com.docker.compose.project"}}' |
  grep -E '^pr-[0-9]+$' | sort -u || true)

if [ -z "$projects" ]; then
  echo ">> aucune preview a examiner"
  exit 0
fi

for project in $projects; do
  pr=${project#pr-}
  case " $OPEN_PRS " in
    *" $pr "*)
      ;;
    *)
      echo ">> preview $pr : PR fermee ou introuvable, suppression"
      bash "$ROOT/deploy/preview/down.sh" "$pr"
      continue
      ;;
  esac

  updated=$(sed -n 's/.*"updatedAt": *"\([^"]*\)".*/\1/p' "$STATE_ROOT/pr-$pr/metadata.json" 2>/dev/null | head -1)
  if [ -z "$updated" ]; then
    continue
  fi
  age_days=$(( (now - $(date -u -d "$updated" +%s)) / 86400 ))
  if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
    echo ">> preview $pr : inchangee depuis $age_days jours, suppression"
    bash "$ROOT/deploy/preview/down.sh" "$pr"
  fi
done

docker system df --format '{{.Type}} {{.TotalCount}} {{.Size}}' 2>/dev/null || true
