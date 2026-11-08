#!/usr/bin/env bash
# Self-hosted fork: copies the server to the VPS and starts it with Docker Compose.
#
#   selfhost/server/scripts/deploy.sh root@203.0.113.10 [--install-docker] [--rebuild-auth-api]
#
# It sends only what the images need (the upstream Signal/TURN sources, the built account service
# and selfhost/server/.env), into /opt/openbot-selfhost on the VPS. The data in
# /opt/openbot-selfhost/selfhost/server/data stays across deploys.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SERVER_DIR="$ROOT/selfhost/server"
TARGET="${1:-}"
[[ -n "$TARGET" && "$TARGET" != --* ]] || { echo "usage: $0 user@host [--install-docker] [--rebuild-auth-api]" >&2; exit 2; }
shift
INSTALL_DOCKER=0
REBUILD=0
for argument in "$@"; do
  case "$argument" in
    --install-docker) INSTALL_DOCKER=1 ;;
    --rebuild-auth-api) REBUILD=1 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done
REMOTE_DIR="${OPENBOT_SELFHOST_REMOTE_DIR:-/opt/openbot-selfhost}"

[[ -f "$SERVER_DIR/.env" ]] || { echo "Run selfhost/server/scripts/init-secrets.sh and edit selfhost/server/.env first." >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source "$SERVER_DIR/.env"
set +a
for name in API_DOMAIN SIGNAL_DOMAIN TURN_PUBLIC_IP ACME_EMAIL EMAIL_SMTP_HOST EMAIL_SMTP_PASSWORD REMOTE_TICKET_PRIVATE_JWK; do
  value="${!name:-}"
  if [[ -z "$value" || "$value" == *example.com* || "$value" == 203.0.113.* ]]; then
    echo "Set $name in selfhost/server/.env (it is empty or still the example)." >&2
    exit 1
  fi
done

if [[ "$REBUILD" == 1 || ! -f "$SERVER_DIR/auth-api/bundle/server/wrangler.json" ]]; then
  "$SERVER_DIR/scripts/package-auth-api.sh"
fi
BUNDLE_COMMIT="$(cat "$SERVER_DIR/auth-api/bundle/source-commit")"
HEAD_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
[[ "$BUNDLE_COMMIT" == "$HEAD_COMMIT" ]] ||
  echo "⚠ The account service bundle is from $BUNDLE_COMMIT, the checkout is $HEAD_COMMIT. Use --rebuild-auth-api to rebuild it."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ARCHIVE="$STAGE/openbot-selfhost.tar.gz"
echo "▸ Packing"
(
  cd "$ROOT"
  # The files that remote/api/Dockerfile and remote/coturn/Dockerfile copy, plus the server kit.
  {
    git ls-files package.json bun.lock patches packages remote
    git ls-files 'apps/*/package.json'
    git ls-files selfhost/server
    find selfhost/server/auth-api/bundle -type f ! -name .dev.vars
    echo selfhost/server/.env
  } | sort -u > "$STAGE/files"
  COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -T "$STAGE/files"
)
echo "  $(du -h "$ARCHIVE" | cut -f1)"

SSH=(ssh -o ServerAliveInterval=30 "$TARGET")
# Oracle Cloud and most images sign in as a normal user (ubuntu); the server needs root.
SUDO=sudo
[[ "${TARGET%%@*}" == root ]] && SUDO=
if [[ "$INSTALL_DOCKER" == 1 ]]; then
  echo "▸ Installing Docker on $TARGET"
  "${SSH[@]}" "command -v docker >/dev/null || curl -fsSL https://get.docker.com | $SUDO sh"
fi
"${SSH[@]}" "$SUDO docker compose version >/dev/null" ||
  { echo "Docker Compose is missing on $TARGET; run again with --install-docker." >&2; exit 1; }

echo "▸ Uploading to $TARGET:$REMOTE_DIR"
"${SSH[@]}" "$SUDO mkdir -p '$REMOTE_DIR' && $SUDO chown \$(id -u):\$(id -g) '$REMOTE_DIR'"
scp -q "$ARCHIVE" "$TARGET:$REMOTE_DIR/openbot-selfhost.tar.gz"
"${SSH[@]}" "set -e
  cd '$REMOTE_DIR'
  rm -rf selfhost/server/auth-api/bundle
  tar -xzf openbot-selfhost.tar.gz && rm openbot-selfhost.tar.gz
  chmod 600 selfhost/server/.env
  mkdir -p selfhost/server/data/auth-api selfhost/server/data/caddy
  # The account service container runs as the image user node (UID 1000).
  $SUDO chown -R 1000:1000 selfhost/server/data/auth-api
  cd selfhost/server
  $SUDO env OPENBOT_SOURCE_COMMIT='$HEAD_COMMIT' docker compose --env-file .env up -d --build --remove-orphans
  $SUDO docker compose --env-file .env ps"

echo "▸ Waiting for https://$API_DOMAIN and https://$SIGNAL_DOMAIN"
for _ in $(seq 1 60); do
  if curl -fsS "https://$API_DOMAIN/health/live" >/dev/null 2>&1 &&
    curl -fsS "https://$API_DOMAIN/.well-known/jwks.json" >/dev/null 2>&1; then
    echo "✓ account service: https://$API_DOMAIN"
    echo "✓ Signal:          wss://$SIGNAL_DOMAIN/v1/signal"
    echo
    echo "Put these two lines in selfhost/selfhost.env and build the apps again, or enter them in"
    echo "OpenBot → 自托管服务器… (desktop) and on the phone's sign-in screen:"
    echo "  SELFHOST_AUTH_API_URL=https://$API_DOMAIN"
    echo "  SELFHOST_SIGNAL_URL=wss://$SIGNAL_DOMAIN/v1/signal"
    exit 0
  fi
  sleep 5
done
echo "The account service did not answer yet. See: ssh $TARGET 'cd $REMOTE_DIR/selfhost/server && docker compose logs --tail 80'" >&2
exit 1
