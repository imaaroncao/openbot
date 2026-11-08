#!/usr/bin/env bash
# Self-hosted fork: runs the whole server (compose.yaml: Caddy, account service, Signal, TURN) on a
# local Docker and checks it from end to end, before you deploy it or after an upstream merge:
#   1. HTTPS through Caddy: /health/live and /.well-known/jwks.json of the account service
#   2. sign-in, host registration, a host ticket and a client ticket for one session
#   3. a desktop host and a client meet through Signal and send data over WebRTC, once directly and
#      once forced through the TURN relay (scripts/team-webrtc-live-smoke.mjs, in Electron)
#
#   selfhost/server/scripts/local-e2e.sh [--down]
#
# Needs Docker (on a Mac: brew install colima docker docker-compose && colima start --network-address).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
cd "$DIR"
PROJECT=openbot-selfhost-test
ENV_FILE="$DIR/.env.local-test"
export SELFHOST_ENV_FILE=.env.local-test
COMPOSE=(docker compose -p "$PROJECT" -f compose.yaml -f compose.local-test.yaml --env-file "$ENV_FILE")

if [[ "${1:-}" == "--down" ]]; then
  "${COMPOSE[@]}" down
  exit 0
fi

# The address where this computer reaches the Docker host: colima's VM address, else localhost.
HOST_IP="${LOCAL_E2E_HOST_IP:-$(colima ls -j 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=s.trim().split("\n").map(JSON.parse);process.stdout.write(l.find(x=>x.status==="Running")?.address||"")}catch{}})' || true)}"
HOST_IP="${HOST_IP:-127.0.0.1}"
API_DOMAIN=api.openbot.test
SIGNAL_DOMAIN=signal.openbot.test

if [[ ! -f "$ENV_FILE" ]]; then
  sed -e "s/^API_DOMAIN=.*/API_DOMAIN=$API_DOMAIN/" -e "s/^SIGNAL_DOMAIN=.*/SIGNAL_DOMAIN=$SIGNAL_DOMAIN/" \
    -e "s/^TURN_DOMAIN=.*/TURN_DOMAIN=$HOST_IP/" -e "s/^TURN_PUBLIC_IP=.*/TURN_PUBLIC_IP=$HOST_IP/" \
    -e "s/^ACME_EMAIL=.*/ACME_EMAIL=e2e@example.test/" -e "s/^EMAIL_SMTP_PASSWORD=.*/EMAIL_SMTP_PASSWORD=unused/" \
    .env.example > "$ENV_FILE"
  # init-secrets.sh appends the keys to the .env next to it; point it at the test file.
  TMP="$(mktemp -d)"
  cp "$ENV_FILE" "$TMP/.env" && cp .env.example "$TMP/.env.example" && mkdir -p "$TMP/scripts"
  cp scripts/init-secrets.sh "$TMP/scripts/" && bash "$TMP/scripts/init-secrets.sh" >/dev/null
  cp "$TMP/.env" "$ENV_FILE" && rm -rf "$TMP"
  chmod 600 "$ENV_FILE"
fi
[[ -f auth-api/bundle/server/wrangler.json ]] || scripts/package-auth-api.sh

echo "▸ Start ($HOST_IP)"
mkdir -p data-local-test/auth-api data-local-test/caddy
{ cat "$ROOT/remote/coturn/turnserver.conf"; echo "relay-ip=$HOST_IP"; echo "allowed-peer-ip=192.168.0.0-192.168.255.255"; } > data-local-test/coturn.conf
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300 2>&1 | grep -vE "^\s*#|^$" | tail -15

CURL=(curl -fsS --cacert "$DIR/data-local-test/caddy/caddy/pki/authorities/local/root.crt"
  --resolve "$API_DOMAIN:443:$HOST_IP" --resolve "$SIGNAL_DOMAIN:443:$HOST_IP")
echo "▸ 1. HTTPS through Caddy"
for _ in $(seq 1 60); do
  [[ -f data-local-test/caddy/caddy/pki/authorities/local/root.crt ]] && "${CURL[@]}" "https://$API_DOMAIN/health/live" >/dev/null 2>&1 && break
  sleep 2
done
"${CURL[@]}" "https://$API_DOMAIN/health/live"; echo
"${CURL[@]}" "https://$API_DOMAIN/.well-known/jwks.json" | head -c 120; echo
for path in /cdn-cgi/handler/scheduled /__scheduled; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$DIR/data-local-test/caddy/caddy/pki/authorities/local/root.crt" \
    --resolve "$API_DOMAIN:443:$HOST_IP" "https://$API_DOMAIN$path?cron=*")"
  [[ "$code" == 404 ]] || { echo "✗ $path must not be reachable from outside (got $code)" >&2; exit 1; }
  echo "  $path from outside: 404 ✓"
done

echo "▸ 2. Account, host and session tickets"
TICKETS="$(docker run --rm --network "${PROJECT}_default" -v "$DIR/scripts:/e2e:ro" node:24-bookworm-slim \
  node /e2e/local-e2e-tickets.mjs http://auth-api:8787)"
SIGNAL_URL="$(sed -n 's/^OPENBOT_REMOTE_SIGNAL_URL=//p' <<<"$TICKETS")"
[[ "$SIGNAL_URL" == "wss://$SIGNAL_DOMAIN/v1/signal" ]] || { echo "✗ ticket names $SIGNAL_URL" >&2; exit 1; }

echo "▸ 3. WebRTC through Signal (direct, then TURN relay only)"
ELECTRON="$ROOT/node_modules/.bin/electron"
for policy in all relay; do
  # Each run needs fresh tickets: a ticket opens one connection.
  [[ "$policy" == all ]] || TICKETS="$(docker run --rm --network "${PROJECT}_default" -v "$DIR/scripts:/e2e:ro" \
    node:24-bookworm-slim node /e2e/local-e2e-tickets.mjs http://auth-api:8787 2>/dev/null)"
  env $(grep '^OPENBOT_' <<<"$TICKETS" | xargs) OPENBOT_REMOTE_SMOKE_ICE_POLICY="$policy" \
    OPENBOT_REMOTE_SMOKE_BYTES=$((4 * 1024 * 1024)) \
    "$ELECTRON" --no-proxy-server --host-resolver-rules="MAP $SIGNAL_DOMAIN $HOST_IP" --ignore-certificate-errors \
    "$ROOT/scripts/team-webrtc-live-smoke-app" 2>&1 | grep -E '"status"|^Error' | tee "$DIR/data-local-test/smoke-$policy.txt"
  grep -q '"status":"passed"' "$DIR/data-local-test/smoke-$policy.txt" || { echo "✗ WebRTC ($policy) failed" >&2; exit 1; }
done
echo "✓ local end-to-end check passed. Stop it with: selfhost/server/scripts/local-e2e.sh --down"
