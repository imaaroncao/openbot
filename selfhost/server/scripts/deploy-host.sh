#!/usr/bin/env bash
# Self-hosted fork: starts the always-on OpenBot host on the VPS and signs it in to your account.
#
#   selfhost/server/scripts/deploy-host.sh root@203.0.113.10 you@example.com [server name]
#
# Needs: the server (scripts/deploy.sh) running, and the image from scripts/build-linux-host.sh.
# The sign-in uses a one-time server claim from your account service (SERVER_CLAIMS_ADMIN_TOKEN in
# selfhost/server/.env), so no email code is needed. The account of the email is made when it does
# not exist; sign in with the same email on the desktop and the phone to see this server.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
OWNER="${2:-}"
NAME="${3:-OpenBot VPS}"
[[ -n "$TARGET" && "$OWNER" == *@* ]] || { echo "usage: $0 user@host owner@email [server name]" >&2; exit 2; }
set -a
# shellcheck disable=SC1091
source "$DIR/.env"
set +a
SUDO=sudo
[[ "${TARGET%%@*}" == root ]] && SUDO=
SSH=(ssh -o ServerAliveInterval=30 "$TARGET")

echo "▸ Starting the host container"
scp -q "$DIR/host/compose.yaml" "$TARGET:/tmp/openbot-host-compose.yaml"
"${SSH[@]}" "set -e
  $SUDO mkdir -p /opt/openbot-host
  $SUDO mv /tmp/openbot-host-compose.yaml /opt/openbot-host/compose.yaml
  test -f /opt/openbot-host/seccomp.json || { echo 'Run scripts/build-linux-host.sh first.' >&2; exit 1; }
  printf 'API_DOMAIN=%s\nSIGNAL_DOMAIN=%s\nGITHUB_APP_CLIENT_ID=%s\nGITHUB_APP_SLUG=%s\n' \
    '$API_DOMAIN' '$SIGNAL_DOMAIN' '${GITHUB_APP_CLIENT_ID:-}' '${GITHUB_APP_SLUG:-}' | $SUDO tee /opt/openbot-host/.env >/dev/null
  cd /opt/openbot-host && $SUDO docker compose up -d
  for i in \$(seq 1 60); do
    $SUDO docker compose exec -T openbot openbot status >/dev/null 2>&1 && break
    sleep 3
  done
  $SUDO docker compose exec -T openbot openbot status | head -8"

if "${SSH[@]}" "cd /opt/openbot-host && $SUDO docker compose exec -T openbot openbot status" 2>/dev/null | grep -qi "signed in\|account:.*@"; then
  echo "✓ The host is already signed in."
  exit 0
fi

echo "▸ Signing the host in as $OWNER (one-time server claim)"
CLAIM="$(printf '{"email":"%s"}' "$OWNER" |
  curl --fail -sS -X POST "https://$API_DOMAIN/v2/admin/server-claims" \
    -H "Authorization: Bearer $SERVER_CLAIMS_ADMIN_TOKEN" -H 'content-type: application/json' --data-binary @- |
  sed -n 's/.*"claim":"\([A-Za-z0-9_-]*\)".*/\1/p')"
[[ -n "$CLAIM" ]] || { echo "No claim from https://$API_DOMAIN/v2/admin/server-claims" >&2; exit 1; }
# The claim goes through standard input, never a process argument.
printf '%s\n' "$CLAIM" | "${SSH[@]}" "cd /opt/openbot-host && $SUDO docker compose exec -T openbot openbot login --claim --name '$NAME'"
"${SSH[@]}" "cd /opt/openbot-host && $SUDO docker compose exec -T openbot openbot status | head -8"
echo "✓ Sign in with $OWNER on the desktop and the phone: the server '$NAME' is in your server list."
