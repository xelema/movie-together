#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/deploy" "$work/bin"
cp "$root/deploy/start.sh" "$work/deploy/start.sh"
cat > "$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
EOF
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" CALLS="$work/calls"
if bash "$work/deploy/start.sh" 'https://bad.example' >/dev/null 2>&1; then exit 1; fi
test ! -e "$work/.env"
bash "$work/deploy/start.sh" films.example.com >/dev/null
grep -q '^DOMAIN=films.example.com$' "$work/.env"
grep -Eq '^ADMIN_PASSWORD=[a-f0-9]{48}$' "$work/.env"
before=$(sha256sum "$work/.env")
BBR=1 bash "$work/deploy/start.sh" >/dev/null
test "$before" = "$(sha256sum "$work/.env")"
grep -q 'compose -f compose.yaml -f compose.bbr.yaml up -d --build --wait' "$CALLS"
echo 'Deployment configuration and preservation checks passed.'
