#!/usr/bin/env bash
# Self-hosted fork: creates YOUR GitHub App for the built-in GitHub connection, in place of the
# vendor's "OpenBotGit" (whose webhook goes to signal.openbot.run and whose private key the vendor
# holds). Your app is private to your account, its webhook goes to your Signal, and its private key
# goes only to your account service.
#
#   selfhost/scripts/create-github-app.sh "OpenBot <your name>" [--org <organization>]
#
# GitHub opens in the browser: click "Create GitHub App". Then, in the app's settings:
#   1. General > Identifying and authorizing users: select "Enable Device Flow", and save.
#   2. Optional features: opt out of "User-to-server token expiration" (optional).
# The script writes (never prints) the values into:
#   selfhost/server/.env    GITHUB_APP_CLIENT_ID GITHUB_APP_SLUG GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET
#   selfhost/selfhost.env   SELFHOST_GITHUB_CLIENT_ID SELFHOST_GITHUB_APP_SLUG
# GitHub's copy stays in ~/.config/openbot/github-app-<slug>.json (mode 0600). Then deploy the
# server and the host again, and build the desktop app again (see selfhost/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
NAME="${1:-}"
[[ -n "$NAME" && "$NAME" != --* ]] || { echo "usage: $0 \"OpenBot <your name>\" [--org <organization>]" >&2; exit 2; }
shift
SERVER_ENV="$ROOT/selfhost/server/.env"
APP_ENV="$ROOT/selfhost/selfhost.env"
[[ -f "$SERVER_ENV" && -f "$APP_ENV" ]] || { echo "Missing $SERVER_ENV or $APP_ENV." >&2; exit 1; }
SIGNAL_DOMAIN="$(sed -n 's/^SIGNAL_DOMAIN=//p' "$SERVER_ENV" | tail -1)"
[[ -n "$SIGNAL_DOMAIN" ]] || { echo "SIGNAL_DOMAIN is not set in $SERVER_ENV." >&2; exit 1; }
REPO_URL="$(git remote get-url origin | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')"

MANIFEST="$ROOT/selfhost/.build/github-app-manifest.json"
mkdir -p "$(dirname "$MANIFEST")"
NAME="$NAME" REPO_URL="$REPO_URL" SIGNAL_DOMAIN="$SIGNAL_DOMAIN" node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("scripts/github-app/manifest.json", "utf8"));
  Object.assign(manifest, {
    name: process.env.NAME,
    url: process.env.REPO_URL,
    description: "Gives my OpenBot agents my repositories, issues and pull requests. Self-hosted: events go to my own server.",
    public: false,
    hook_attributes: { url: `https://${process.env.SIGNAL_DOMAIN}/v1/github/events`, active: true },
  });
  fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n");
' "$MANIFEST"
echo "▸ Manifest: $NAME, webhook https://$SIGNAL_DOMAIN/v1/github/events, private app"

MARK="$(mktemp)"
OPENBOT_GITHUB_APP_MANIFEST="$MANIFEST" bun scripts/create-github-app.ts "$@"
SECRETS="$(find "$HOME/.config/openbot" -maxdepth 1 -name 'github-app-*.json' -newer "$MARK" 2>/dev/null | head -1)"
rm -f "$MARK"
[[ -n "$SECRETS" ]] || { echo "No new app secrets in ~/.config/openbot: the app was not created." >&2; exit 1; }

node - "$SECRETS" "$SERVER_ENV" "$APP_ENV" <<'NODE'
const fs = require("node:fs");
const [secretsPath, serverEnv, appEnv] = process.argv.slice(2);
const app = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
/** Replaces `NAME=...` lines or appends them; values in double quotes, newlines as \n. */
function setValues(path, values) {
  let lines = fs.readFileSync(path, "utf8").split("\n");
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
    const index = lines.findIndex((entry) => entry.startsWith(`${name}=`));
    if (index === -1) lines.splice(lines.length && lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
    else lines[index] = line;
  }
  fs.writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}
if (!app.webhookSecret || app.webhookSecret.length < 32) throw new Error("GitHub gave no webhook secret of 32 bytes or more.");
setValues(serverEnv, {
  GITHUB_APP_CLIENT_ID: app.clientId,
  GITHUB_APP_SLUG: app.slug,
  GITHUB_APP_PRIVATE_KEY: app.privateKey,
  GITHUB_WEBHOOK_SECRET: app.webhookSecret,
});
setValues(appEnv, { SELFHOST_GITHUB_CLIENT_ID: app.clientId, SELFHOST_GITHUB_APP_SLUG: app.slug });
console.log(`✓ GitHub App ${app.slug} (Client ID ${app.clientId}) written to selfhost/server/.env and selfhost/selfhost.env`);
NODE
echo "Next: tick \"Enable Device Flow\" in the app settings, then deploy (selfhost/README.md)."
