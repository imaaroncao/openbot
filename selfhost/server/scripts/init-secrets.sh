#!/usr/bin/env bash
# Self-hosted fork: makes selfhost/server/.env with new keys and secrets. Run once; it refuses to
# replace secrets that exist, because hosts and phones trust the ticket key it makes.
#   selfhost/server/scripts/init-secrets.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$DIR/.env"
[[ -f "$ENV_FILE" ]] || cp "$DIR/.env.example" "$ENV_FILE"
if grep -q '^REMOTE_TICKET_PRIVATE_JWK=' "$ENV_FILE"; then
  echo "$ENV_FILE already has secrets; nothing changed." >&2
  exit 0
fi
node - >> "$ENV_FILE" <<'NODE'
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const kid = "self-hosted-1";
const meta = { kid, alg: "ES256", use: "sig" };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const secret = () => randomBytes(48).toString("base64url");
const lines = {
  REMOTE_TICKET_KEY_ID: kid,
  REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...meta }),
  REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), ...meta }] }),
  REMOTE_AUTH_WEBHOOK_SECRET: secret(),
  REMOTE_SESSION_SECRET: secret(),
  TURN_SHARED_SECRET: secret(),
  REMOTE_METRICS_TOKEN: secret(),
  SKILLS_ADMIN_TOKEN: secret(),
  SITE_REPORT_HASH_SECRET: secret(),
  SERVER_CLAIMS_ADMIN_TOKEN: secret(),
};
// Single quotes: Docker Compose reads the JSON values as they are.
for (const [name, value] of Object.entries(lines)) console.log(`${name}='${value}'`);
NODE
chmod 600 "$ENV_FILE"
echo "✓ $ENV_FILE — now edit the names, the public IP and the SMTP account at the top."
