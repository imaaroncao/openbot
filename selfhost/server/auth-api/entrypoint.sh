#!/bin/sh
# Self-hosted fork: starts the account service in the container (or on a computer, for a check).
#   AUTH_API_BUNDLE   bundle folder (default /app/bundle)
#   AUTH_API_DATA     D1/R2 data folder (default /data)
#   AUTH_API_PUBLIC_ORIGIN  https://api.example.com: the origin that the Worker sees in request.url
set -eu

BUNDLE="${AUTH_API_BUNDLE:-/app/bundle}"
DATA="${AUTH_API_DATA:-/data}"
CONFIG="$BUNDLE/server/wrangler.json"
PORT="${AUTH_API_PORT:-8787}"
WRANGLER="${WRANGLER:-wrangler}"

[ -n "${AUTH_API_PUBLIC_ORIGIN:-}" ] || { echo "AUTH_API_PUBLIC_ORIGIN is required" >&2; exit 1; }
for name in EMAIL_SMTP_PASSWORD REMOTE_TICKET_PRIVATE_JWK REMOTE_TICKET_PUBLIC_JWKS REMOTE_AUTH_WEBHOOK_SECRET; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || { echo "$name is required (selfhost/server/scripts/init-secrets.sh)" >&2; exit 1; }
done

# Runtime values for the Worker. `.dev.vars` overrides the vars in wrangler.json.
VARS_FILE="$BUNDLE/server/.dev.vars"
umask 077
: > "$VARS_FILE"
for name in \
  AUTH_EXPOSE_DEVELOPMENT_CODE EMAIL_SMTP_HOST EMAIL_SMTP_PORT EMAIL_SMTP_USERNAME EMAIL_SMTP_PASSWORD \
  EMAIL_FROM EMAIL_LICENSE_FROM SKILLS_ADMIN_TOKEN SITE_OPERATIONS_ADMIN_TOKEN SERVER_CLAIMS_ADMIN_TOKEN \
  SITE_REPORT_HASH_SECRET COMPANY_SIGN_IN_SECRET REMOTE_TICKET_PRIVATE_JWK REMOTE_TICKET_PUBLIC_JWKS \
  REMOTE_TICKET_KEY_ID REMOTE_SIGNAL_URL REMOTE_AUTH_WEBHOOK_URL REMOTE_AUTH_WEBHOOK_SECRET \
  HOSTED_SERVERS_ENABLED LICENSE_TRIAL_END APNS_PRIVATE_KEY APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC \
  FCM_SERVICE_ACCOUNT GITHUB_APP_CLIENT_ID GITHUB_APP_PRIVATE_KEY; do
  eval "value=\${$name+set}"
  [ "$value" = "set" ] || continue
  eval "value=\${$name}"
  # dotenv quoting: single quotes keep a JSON value as it is; a PEM key keeps its lines as \n.
  printf '%s=%s\n' "$name" "$(printf '%s' "$value" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const quoted = s.includes("\n") || s.includes("\x27") ? `"${s.replace(/\r?\n/g, "\\n")}"` : `\x27${s}\x27`;
      process.stdout.write(quoted);
    });')" >> "$VARS_FILE"
done
# The vendor's analytics: never, whatever the .env says.
printf 'OPENPANEL_CLIENT_ID=""\nOPENPANEL_CLIENT_SECRET=""\n' >> "$VARS_FILE"

mkdir -p "$DATA"
echo "▸ D1 migrations"
"$WRANGLER" d1 migrations apply DB --local --persist-to "$DATA" --config "$CONFIG"

# The Worker's crons (outbox retries, cleanup). Local dev does not run them, so call them here.
(
  sleep 60
  while :; do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*" || true
    sleep 300
  done
) &

UPSTREAM_HOST="$(printf '%s' "$AUTH_API_PUBLIC_ORIGIN" | sed -E 's#^https?://##; s#/.*$##')"
echo "▸ account service on :$PORT as $AUTH_API_PUBLIC_ORIGIN"
exec "$WRANGLER" dev --local --config "$CONFIG" --persist-to "$DATA" \
  --ip 0.0.0.0 --port "$PORT" --local-upstream "$UPSTREAM_HOST" --upstream-protocol https \
  --test-scheduled --show-interactive-dev-session=false --log-level "${AUTH_API_LOG_LEVEL:-info}"
