#!/usr/bin/env bash
# Self-hosted fork: builds the account service (apps/auth-api, a Cloudflare Worker) on this computer
# and stages it in selfhost/server/auth-api/bundle for the VPS, where workerd runs it with local
# D1 (SQLite) and R2 (files). The build needs ~6 GB of memory, which a small VPS does not have, so
# it runs here and only the result goes to the server.
#
#   selfhost/server/scripts/package-auth-api.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUNDLE="$ROOT/selfhost/server/auth-api/bundle"
cd "$ROOT"

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null 2>&1 || true
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  [[ -d node_modules ]] || bun install --frozen-lockfile
  # The `preview` environment of wrangler.jsonc has no routes, crons, service or email bindings:
  # the closest to a stand-alone Worker. The runtime values come from the server's .env.
  (cd apps/auth-api && CLOUDFLARE_ENV=preview bun run build)
fi

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
cp -R apps/auth-api/dist/client "$BUNDLE/client"
cp -R apps/auth-api/dist/server "$BUNDLE/server"
cp -R apps/auth-api/migrations "$BUNDLE/migrations"
node -p 'require("./package.json").workspaces.catalog.wrangler' > "$BUNDLE/wrangler-version"
git rev-parse --short HEAD > "$BUNDLE/source-commit" 2>/dev/null || echo unknown > "$BUNDLE/source-commit"

node - "$BUNDLE/server/wrangler.json" <<'EOF'
const fs = require("node:fs");
const path = process.argv[2];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
for (const key of ["configPath", "userConfigPath", "topLevelName", "definedEnvironments", "targetEnvironment"]) {
  delete config[key];
}
config.name = "openbot-selfhost-auth-api";
config.routes = [];
config.workers_dev = false;
config.preview_urls = false;
// Local dev runs no crons; the container calls /__scheduled on this timetable instead.
config.triggers = { crons: [] };
config.d1_databases = [
  { binding: "DB", database_name: "openbot-auth", database_id: "openbot-auth-selfhost", migrations_dir: "../migrations" },
];
config.r2_buckets = [
  { binding: "AVATARS", bucket_name: "openbot-avatars" },
  { binding: "SKILLS", bucket_name: "openbot-skills" },
  { binding: "SITES", bucket_name: "openbot-sites" },
];
config.services = [];
// A `secrets` declaration makes wrangler load only the names it lists from .dev.vars.
delete config.secrets;
config.send_email = [];
// Defaults; the container writes the real values from .env into .dev.vars, which wins.
config.vars = {
  AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
  SITE_PUBLISH_ENABLED: "false",
  SITE_COOKIE_ISOLATION_READY: "false",
  HOSTED_SERVERS_ENABLED: "false",
  REMOTE_TICKET_KEY_ID: "self-hosted-1",
  REMOTE_SIGNAL_HOMES: "",
  REMOTE_AUTH_WEBHOOK_URLS: "",
  SIGNAL_ENTRY_ZONE_ID: "",
  GITHUB_APP_CLIENT_ID: "",
};
config.observability = { enabled: false };
config.dev = { ...config.dev, ip: "0.0.0.0", port: 8787, local_protocol: "http", enable_containers: false };
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
EOF

# Nothing in the bundle may name the vendor's analytics endpoint as a default.
echo "▸ bundle: $(du -sh "$BUNDLE" | cut -f1) at $BUNDLE (commit $(cat "$BUNDLE/source-commit"))"
