#!/usr/bin/env bash
# Deploie le projet sur les VM distantes : archive locale construite une fois,
# copie scp, build Docker et redemarrage des services, en parallele sur chaque
# hote. A lancer depuis Git Bash apres une modification :
#
#   bash deploy/deploy.sh
#
# Hotes : variable SSH_HOST (liste separee par des espaces), sinon lus dans
# .env via PROD_SSH_HOST (Amsterdam) et SEOUL_SSH_HOST (Seoul).
#
# Options via variables d'environnement :
#   SSH_HOST    un ou plusieurs hotes (defaut : .env PROD_SSH_HOST + SEOUL_SSH_HOST)
#   SSH_KEY     cle privee            (defaut : .env PROD_SSH_KEY, sinon ~/.ssh/id_rsa)
#   REMOTE_DIR  dossier sur la VM     (defaut : movie-together, relatif au home)
#   PUSH_ENV    fichier local envoye comme .env distant (un seul hote a la fois)
#
# Exemples :
#   SSH_HOST=ubuntu@203.0.113.10 bash deploy/deploy.sh
#   PUSH_ENV=.env.production SSH_HOST=ubuntu@192.0.2.10 bash deploy/deploy.sh
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

env_var() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }

# SSH_HOST explicite est pris tel quel ; sinon la liste par defaut vient de .env.
if [[ -z ${SSH_HOST:-} ]]; then
  SSH_HOST=$(env_var SSH_HOST .env.production)
  SSH_HOST=${SSH_HOST:-$(env_var PROD_SSH_HOST .env)}
  SEOUL_HOST=$(env_var SEOUL_SSH_HOST .env)
  [[ -n $SEOUL_HOST ]] && SSH_HOST="${SSH_HOST:+$SSH_HOST }$SEOUL_HOST"
fi
[[ -n ${SSH_HOST// /} ]] || { echo "SSH_HOST requis : SSH_HOST=ubuntu@192.0.2.10 bash deploy/deploy.sh" >&2; exit 1; }
SSH_KEY=${SSH_KEY:-$(env_var PROD_SSH_KEY .env)}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_rsa}
SSH_KEY=${SSH_KEY/#\~/$HOME}
REMOTE_DIR=${REMOTE_DIR:-movie-together}
PUSH_ENV=${PUSH_ENV:-}

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

[[ -f $SSH_KEY ]] || { echo "Cle SSH introuvable : $SSH_KEY" >&2; exit 1; }
if [[ -n $PUSH_ENV && ! -f $PUSH_ENV ]]; then
  echo "Fichier PUSH_ENV introuvable : $PUSH_ENV" >&2
  exit 1
fi

read -ra HOSTS <<< "$SSH_HOST"
if [[ -n $PUSH_ENV && ${#HOSTS[@]} -gt 1 ]]; then
  echo "PUSH_ENV ecrirait le meme .env partout (DOMAIN compris) : vise un seul hote via SSH_HOST." >&2
  exit 1
fi

echo ">> Construction de l'archive"
TARBALL=$(mktemp)
trap 'rm -f "$TARBALL"' EXIT
tar -czf "$TARBALL" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./dist' \
  --exclude='./e2e' \
  --exclude='./test' \
  --exclude='./test-results' \
  --exclude='./playwright-report' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='*.log' \
  --exclude='./comparison.png' \
  --exclude='./private-notes.txt' \
  .

deploy_one() {
  local host=$1
  echo ">> Connexion a $host"
  ssh "${SSH_OPTS[@]}" "$host" 'echo connecte'

  if [[ -n $PUSH_ENV ]]; then
    echo ">> Envoi de $PUSH_ENV comme .env distant"
    scp "${SSH_OPTS[@]}" "$PUSH_ENV" "$host:/tmp/movie-night.env"
    ssh "${SSH_OPTS[@]}" "$host" \
      "mkdir -p \"$REMOTE_DIR\" 2>/dev/null || sudo mkdir -p \"$REMOTE_DIR\";" \
      "install -m 600 /tmp/movie-night.env \"$REMOTE_DIR/.env\" 2>/dev/null || sudo install -m 600 /tmp/movie-night.env \"$REMOTE_DIR/.env\""
  fi

  echo ">> Envoi du projet vers $host"
  cat "$TARBALL" | ssh "${SSH_OPTS[@]}" "$host" "mkdir -p \"$REMOTE_DIR\" 2>/dev/null || sudo mkdir -p \"$REMOTE_DIR\"; cat > /tmp/movie-night-deploy.tgz"

  echo ">> Extraction et reconstruction sur $host"
  ssh "${SSH_OPTS[@]}" "$host" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
case $1 in /*) APP_DIR=$1 ;; *) APP_DIR=$HOME/$1 ;; esac

# Refuse de vider un dossier sensible si REMOTE_DIR est mal configure.
case $APP_DIR in "$HOME"|"/"|"") echo "REMOTE_DIR invalide : $APP_DIR" >&2; exit 1 ;; esac

# Certains fichiers distants peuvent appartenir a root (ex. .env cree via sudo).
FSUDO=
if [[ -d $APP_DIR && ! -w $APP_DIR ]] || [[ -f $APP_DIR/.env && ! -r $APP_DIR/.env ]]; then
  FSUDO=sudo
fi

if ! $FSUDO test -f "$APP_DIR/.env"; then
  echo "ERREUR : $APP_DIR/.env absent sur le serveur." >&2
  echo "Cree-le avec DOMAIN, ADMIN_PASSWORD et MEDIA_DIR (modele : .env.example)," >&2
  echo "ou relance avec PUSH_ENV=fichier bash deploy/deploy.sh pour l'envoyer." >&2
  exit 1
fi

TMP_DIR=$($FSUDO mktemp -d)
$FSUDO tar -xzf /tmp/movie-night-deploy.tgz -C "$TMP_DIR"
rm -f /tmp/movie-night-deploy.tgz
$FSUDO cp -a "$APP_DIR/.env" "$TMP_DIR/.env"
$FSUDO chmod 600 "$TMP_DIR/.env"

$FSUDO find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
$FSUDO cp -a "$TMP_DIR"/. "$APP_DIR"/
$FSUDO rm -rf "$TMP_DIR"

cd "$APP_DIR"
# Reglages reseau hote : BBR tient mieux les liens transcontinentaux et
# ip_forward protege le NAT Docker d'un sysctl --system qui le remettrait a 0.
# Best-effort, le conteneur proxy a deja BBR via compose.yaml.
if sudo -n true 2>/dev/null; then
  sudo install -m644 deploy/99-movie-together-network.conf /etc/sysctl.d/ &&
    sudo sysctl -p /etc/sysctl.d/99-movie-together-network.conf ||
    echo "Attention : sysctl hote non applique." >&2
else
  echo "Attention : pas de sudo, sysctl hote (BBR, ip_forward) non applique." >&2
fi
if docker info >/dev/null 2>&1; then DSUDO=; else DSUDO=sudo; fi
$DSUDO docker compose config --quiet
$DSUDO docker compose up -d --build --wait --wait-timeout 300
$DSUDO docker compose ps
REMOTE
}

if ((${#HOSTS[@]} == 1)); then
  deploy_one "${HOSTS[0]}"
else
  pids=()
  for host in "${HOSTS[@]}"; do
    (set -o pipefail; deploy_one "$host" 2>&1 | sed -u "s/^/[${host##*@}] /") &
    pids+=($!)
  done
  fail=0
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
  ((fail == 0)) || { echo ">> Au moins un deploiement a echoue." >&2; exit 1; }
fi

echo ">> Deploiement termine. Les rooms en cours ont ete fermees par le redemarrage."
