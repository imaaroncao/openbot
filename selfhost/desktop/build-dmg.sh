#!/usr/bin/env bash
# Self-hosted fork: builds a signed and notarized OpenBot DMG for this Mac's architecture.
#
#   selfhost/desktop/build-dmg.sh            # sign + notarize (values from selfhost/selfhost.env)
#   selfhost/desktop/build-dmg.sh --no-notarize
#   selfhost/desktop/build-dmg.sh --unsigned # local test build, no Apple account needed
#
# Output: dist/OpenBot-<version>-<arch>.dmg (and the .app under dist/mac*/).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/selfhost/selfhost.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE: copy selfhost/selfhost.env.example and edit it." >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

NOTARIZE=1
SIGN=1
for argument in "$@"; do
  case "$argument" in
    --no-notarize) NOTARIZE=0 ;;
    --unsigned) SIGN=0; NOTARIZE=0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

# Node 24 and Bun from package.json.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null 2>&1 || nvm install 24 >/dev/null
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node 24+ is required"); process.exit(1) }'

ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH=x64
echo "▸ OpenBot self-hosted DMG ($ARCH)"
echo "  account service : ${SELFHOST_AUTH_API_URL:-<none>}"
echo "  signal          : ${SELFHOST_SIGNAL_URL:-<none>}"
echo "  bundle id       : ${DESKTOP_BUNDLE_ID}"

# 1. The default servers, baked into Resources/self-host.json.
mkdir -p selfhost/.build
SELFHOST_AUTH_API_URL="${SELFHOST_AUTH_API_URL:-}" SELFHOST_SIGNAL_URL="${SELFHOST_SIGNAL_URL:-}" \
SELFHOST_GITHUB_CLIENT_ID="${SELFHOST_GITHUB_CLIENT_ID:-}" SELFHOST_GITHUB_APP_SLUG="${SELFHOST_GITHUB_APP_SLUG:-}" node -e '
  const api = process.env.SELFHOST_AUTH_API_URL, signal = process.env.SELFHOST_SIGNAL_URL;
  const example = (value) => !value || /(^|\.)example\.com$/u.test(new URL(value).hostname);
  const config = example(api) || example(signal) ? {} : { authApiUrl: new URL(api).origin, signalUrl: signal };
  if (!config.authApiUrl) console.log("  (no server baked in: set it later in OpenBot → 自托管服务器…)");
  // Your own GitHub App (selfhost/scripts/create-github-app.sh); without it, no GitHub connection.
  const githubClientId = process.env.SELFHOST_GITHUB_CLIENT_ID, githubAppSlug = process.env.SELFHOST_GITHUB_APP_SLUG;
  if (githubClientId && githubAppSlug) Object.assign(config, { githubClientId, githubAppSlug });
  console.log(`  github app      : ${githubAppSlug || "<none: no GitHub connection>"}`);
  require("node:fs").writeFileSync("selfhost/.build/self-host.json", JSON.stringify(config, null, 2) + "\n");
'

# 2. Dependencies and native runtimes, as upstream's dist:mac does.
# GitHub release downloads go through the GitHub API (see the script for why).
# shellcheck disable=SC1091
source selfhost/scripts/github-release-proxy.sh && start_github_release_proxy
[[ -d node_modules ]] || bun install --frozen-lockfile
bun run voice:prepare-runtime
bun run prepare:remote-desktop-runtime
bun run verify:remote-desktop-runtime
bun run prepare:cua-driver
bun run build

# 3. Package, sign and notarize.
BUILDER_ARGS=(
  --mac dmg zip "--$ARCH" --publish never
  --config selfhost/desktop/electron-builder.selfhost.yml
  "-c.appId=$DESKTOP_BUNDLE_ID"
  "-c.mac.extendInfo.ElectronTeamID=$APPLE_TEAM_ID"
)
if [[ "$SIGN" == 1 ]]; then
  IDENTITY="${MAC_SIGN_IDENTITY#Developer ID Application: }"
  security find-identity -v -p codesigning | grep -Fq "Developer ID Application: $IDENTITY" ||
    { echo "Signing identity not found: Developer ID Application: $IDENTITY" >&2; exit 1; }
  BUILDER_ARGS+=("-c.mac.identity=$IDENTITY")
else
  BUILDER_ARGS+=("-c.mac.identity=null")
fi
if [[ "$NOTARIZE" == 1 ]]; then
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE
  # electron-builder passes a keychain path with a profile, and `notarytool store-credentials`
  # keeps profiles in the data protection keychain, where that path does not reach. So the API key
  # comes first; a profile works only when it was stored with `--keychain <login.keychain-db>`.
  if [[ -n "${ASC_KEY_PATH:-}" && -f "$ASC_KEY_PATH" ]]; then
    export APPLE_API_KEY="$ASC_KEY_PATH" APPLE_API_KEY_ID="$ASC_KEY_ID" APPLE_API_ISSUER="$ASC_ISSUER_ID"
    echo "  notarize with App Store Connect key $ASC_KEY_ID"
  elif [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]] &&
    xcrun notarytool history --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" \
      --keychain "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
    export APPLE_KEYCHAIN_PROFILE="$NOTARY_KEYCHAIN_PROFILE"
    export APPLE_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
    echo "  notarize with keychain profile $NOTARY_KEYCHAIN_PROFILE"
  else
    echo "No notarization credentials: set ASC_KEY_* (or a login-keychain NOTARY_KEYCHAIN_PROFILE) in selfhost.env" >&2
    exit 1
  fi
else
  BUILDER_ARGS+=("-c.mac.notarize=false")
fi
bun x electron-builder "${BUILDER_ARGS[@]}"

# 4. Check the result.
APP="$(find dist -maxdepth 2 -name OpenBot.app -type d -newer selfhost/.build/self-host.json | head -1)"
VERSION="$(node -p 'require("./package.json").version')"
DMG="dist/OpenBot-$VERSION-$ARCH.dmg"
[[ -d "$APP" && -f "$DMG" ]] || { echo "Build output not found" >&2; exit 1; }
echo "▸ Verify $APP"
plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist"
test ! -f "$APP/Contents/Resources/app-update.yml" || { echo "app-update.yml must not exist" >&2; exit 1; }
cat "$APP/Contents/Resources/self-host.json"
if [[ "$SIGN" == 1 ]]; then
  codesign --verify --deep --strict --verbose=1 "$APP"
  codesign -dv "$APP" 2>&1 | grep -E "^(Authority=Developer ID|TeamIdentifier)"
fi
if [[ "$NOTARIZE" == 1 ]]; then
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  xcrun stapler staple "$DMG" >/dev/null 2>&1 || true
fi
shasum -a 256 "$DMG"
echo "✓ $DMG"
