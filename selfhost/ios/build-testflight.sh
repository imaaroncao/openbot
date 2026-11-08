#!/usr/bin/env bash
# Self-hosted fork: builds the iPhone app with your Apple team and uploads it to TestFlight.
#
#   selfhost/ios/build-testflight.sh              # prebuild, archive, sign, upload
#   selfhost/ios/build-testflight.sh --no-upload  # stop at a signed .ipa in selfhost/.build/ios
#
# Needs Xcode, CocoaPods, Node 24, Bun, and the App Store Connect API key in selfhost/selfhost.env.
# Signing is automatic: Xcode registers the capabilities (App Groups, Push, Live Activities), the
# profiles and, when needed, a distribution certificate, with the Apple ID signed in to Xcode, or
# with the API key (IOS_SIGNING_AUTH=api-key in selfhost.env).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/selfhost/selfhost.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE: copy selfhost/selfhost.env.example and edit it." >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
UPLOAD=1
[[ "${1:-}" == "--no-upload" ]] && UPLOAD=0

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null 2>&1 || nvm install 24 >/dev/null
fi
command -v pod >/dev/null || { echo "CocoaPods is missing: brew install cocoapods" >&2; exit 1; }
[[ -f "$ASC_KEY_PATH" ]] || { echo "ASC_KEY_PATH not found: $ASC_KEY_PATH" >&2; exit 1; }

OUT="$ROOT/selfhost/.build/ios"
mkdir -p "$OUT"
BUILD_NUMBER="${IOS_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
VERSION="$(node -p 'require("./apps/mobile/app.json").expo.version')"

# Values that apps/mobile/selfhost.config.js and the JavaScript bundle read.
export OPENBOT_IOS_BUNDLE_ID="$IOS_BUNDLE_ID"
export OPENBOT_APPLE_TEAM_ID="$APPLE_TEAM_ID"
export OPENBOT_IOS_APP_NAME="${IOS_APP_NAME:-OpenBot}"
export OPENBOT_IOS_BUILD_NUMBER="$BUILD_NUMBER"
export EXPO_PUBLIC_APP_ENV=production
export EXPO_PUBLIC_OPENBOT_APP_GROUP="group.$IOS_BUNDLE_ID"
if [[ -n "${SELFHOST_AUTH_API_URL:-}" && "$SELFHOST_AUTH_API_URL" != *example.com* ]]; then
  export EXPO_PUBLIC_OPENBOT_API_URL="$SELFHOST_AUTH_API_URL"
else
  unset EXPO_PUBLIC_OPENBOT_API_URL
  echo "  (no account service baked in: set it on the phone's sign-in screen, or scan the desktop QR code)"
fi
# Never the vendor's analytics, whatever the shell holds.
unset EXPO_PUBLIC_OPENPANEL_CLIENT_ID EXPO_PUBLIC_OPENPANEL_CLIENT_SECRET

echo "▸ OpenBot iOS $VERSION ($BUILD_NUMBER) · $IOS_BUNDLE_ID · team $APPLE_TEAM_ID"
echo "  account service: ${EXPO_PUBLIC_OPENBOT_API_URL:-<none>}"

# 1. Bundle IDs, and the App Store Connect app that the upload needs.
APP_READY=1
node selfhost/ios/asc.mjs prepare || { status=$?; [[ $status == 4 ]] && APP_READY=0 || exit $status; }

# 2. Native project.
[[ -d node_modules ]] || bun install --frozen-lockfile
(
  cd apps/mobile
  bunx expo prebuild --platform ios --clean
)
WORKSPACE="$(find apps/mobile/ios -maxdepth 1 -name '*.xcworkspace' | head -1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
[[ -n "$WORKSPACE" ]] || { echo "prebuild made no Xcode workspace" >&2; exit 1; }
node selfhost/ios/set-team.mjs "${WORKSPACE%.xcworkspace}.xcodeproj/project.pbxproj" "$APPLE_TEAM_ID"

# Who signs: the Apple ID signed in to Xcode (Settings → Accounts), or the API key. With some keys
# xcodebuild's provisioning answers "Authentication failed: … bearer token" although the same key
# works for the App Store Connect API, so the Xcode account is the default when there is one.
SIGNING="${IOS_SIGNING_AUTH:-}"
if [[ -z "$SIGNING" ]]; then
  if defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null | grep -q identifier; then
    SIGNING=xcode-account
  else
    SIGNING=api-key
  fi
fi
AUTH=(-allowProvisioningUpdates)
if [[ "$SIGNING" == api-key ]]; then
  AUTH+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
echo "  signing with: $SIGNING"

# A profile that Xcode made before the App ID had its App Group (for example after a failed run)
# stays cached, and the archive then fails with "doesn't match the entitlements file's value for
# com.apple.security.application-groups". Remove such profiles; Xcode makes new ones.
for directory in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
  [[ -d "$directory" ]] || continue
  for profile in "$directory"/*.mobileprovision; do
    [[ -f "$profile" ]] || continue
    decoded="$(security cms -D -i "$profile" 2>/dev/null)" || continue
    identifier="$(plutil -extract Entitlements.application-identifier raw - <<<"$decoded" 2>/dev/null)" || continue
    [[ "$identifier" == "$APPLE_TEAM_ID.$IOS_BUNDLE_ID" || "$identifier" == "$APPLE_TEAM_ID.$IOS_BUNDLE_ID".* ]] || continue
    if ! plutil -extract 'Entitlements.com\.apple\.security\.application-groups' json -o - - <<<"$decoded" 2>/dev/null |
      grep -qF "group.$IOS_BUNDLE_ID"; then
      echo "  removing stale profile for $identifier"
      rm -f "$profile"
    fi
  done
done

# 3. Archive.
ARCHIVE="$OUT/OpenBot-$VERSION-$BUILD_NUMBER.xcarchive"
rm -rf "$ARCHIVE"
echo "▸ Archive $SCHEME"
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  "${AUTH[@]}" archive | tee "$OUT/archive.log" | grep -E '^(\*\*|error:|.*error:|.*warning: .*signing)' || true
[[ -d "$ARCHIVE" ]] || { echo "Archive failed; see $OUT/archive.log" >&2; exit 1; }

# 4. Sign for App Store Connect; upload when the app record exists.
DESTINATION=export
if [[ "$UPLOAD" == 1 && "$APP_READY" == 1 ]]; then DESTINATION=upload; fi
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST
EXPORT_DIR="$OUT/export-$BUILD_NUMBER"
rm -rf "$EXPORT_DIR"
echo "▸ Export ($DESTINATION)"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" "${AUTH[@]}" 2>&1 | tee "$OUT/export.log" | tail -5

if [[ "$DESTINATION" == upload ]]; then
  grep -q "EXPORT SUCCEEDED\|Upload succeeded" "$OUT/export.log" || { echo "Upload failed; see $OUT/export.log" >&2; exit 1; }
  echo "✓ Uploaded $VERSION ($BUILD_NUMBER). TestFlight lists it after Apple processes it (5-30 min):"
  echo "  node selfhost/ios/asc.mjs builds"
else
  IPA="$(find "$EXPORT_DIR" -name '*.ipa' | head -1)"
  [[ -n "$IPA" ]] || { echo "Export failed; see $OUT/export.log" >&2; exit 1; }
  echo "✓ Signed $IPA"
  if [[ "$UPLOAD" == 1 ]]; then
    echo "  Not uploaded: create the App Store Connect app first (see above), then upload this IPA with"
    echo "  xcrun altool --upload-app -f '$IPA' -t ios --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER_ID"
    echo "  (altool reads the key from ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8)"
    exit 4
  fi
fi
