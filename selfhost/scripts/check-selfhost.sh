#!/usr/bin/env bash
# Self-hosted fork: checks after a merge from upstream that
#   1. every hook of the fork is still in place (an upstream rewrite can drop one silently), and
#   2. no new reference to a vendor endpoint appeared that the fork does not know about yet.
# Exit 1 when a hook is missing. New vendor references are printed for review, with exit 3.
#   selfhost/scripts/check-selfhost.sh [--update-baseline]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BASELINE="selfhost/scripts/vendor-endpoints.baseline"
status=0

hook() { # file, fixed string, description
  if ! grep -qF -- "$2" "$1" 2>/dev/null; then
    echo "✗ missing hook: $3 ($1)"; status=1
  fi
}
first_import() {
  local first
  first="$(grep -m1 '^import ' "$1")"
  [[ "$first" == "$2" ]] || { echo "✗ $1 must start with: $2 (found: $first)"; status=1; }
}

first_import src/main/index.ts 'import "./self-host/bootstrap";'
first_import apps/mobile/src/app/_layout.tsx 'import "@/self-host/network-guard";'
hook src/main/application-services.ts 'vendorTelemetryEnabled &&' "desktop host analytics switch"
hook src/main/application-services.ts '"http://127.0.0.1:3100", // self-hosted fork' "no api.openbot.run fallback"
hook src/renderer/src/analytics.ts 'if (!vendorTelemetryEnabled) return false;' "desktop renderer analytics switch"
hook src/renderer/src/error-reports.ts 'if (!vendorTelemetryEnabled) return;' "desktop error reports switch"
hook packages/telemetry/src/transport.ts 'if (!vendorTelemetryEnabled) return true;' "OpenPanel transport switch"
hook apps/mobile/src/features/analytics/mobile-analytics.ts '!vendorTelemetryEnabled ||' "mobile analytics switch"
hook apps/mobile/src/features/analytics/failure-reports.ts '!vendorTelemetryEnabled ||' "mobile error reports switch"
hook apps/mobile/src/features/auth/api/mobile-auth.ts 'selfHostAccountApiUrl() ?? DISABLED_ACCOUNT_API_URL' "mobile email sign-in server"
hook apps/mobile/src/features/auth/screens/sign-in-screen.tsx '<SelfHostServerBadge' "mobile server field"
hook apps/mobile/app.config.js 'applySelfHost(' "mobile bundle IDs / no OTA"
hook apps/mobile/src/features/push-notifications/push-notifications-native.ios.ts 'EXPO_PUBLIC_OPENBOT_APP_GROUP' "mobile App Group (push)"
hook apps/mobile/src/features/share/model/share-extension.ts 'EXPO_PUBLIC_OPENBOT_APP_GROUP' "mobile App Group (share)"
hook src/main/main-window.ts 'openSelfHostServerWindow(' "desktop server menu item"
hook src/main/provider-use-settings-store.ts 'SELF_HOST_REMOVED_PROVIDERS' "removed providers always off (OpenCode)"
hook src/renderer/src/features/settings/stores/general-store.ts 'isSelfHostRemovedProvider(provider)' "Settings hides removed providers"
hook src/renderer/src/features/onboarding/onboarding-provider-rows.ts 'isSelfHostRemovedProvider(option.id)' "setup hides removed providers"
hook src/renderer/src/features/onboarding/FirstRunChoice.tsx 'isSelfHostRemovedProvider(FREE_PROVIDER)' "no free-models row"
hook apps/mobile/src/features/servers/model/provider-admin.ts 'isSelfHostRemovedProvider(provider)' "phone hides removed providers"
hook src/main/provider-runtime-releases.ts 'imaaroncao/openbot/main/provider-runtime-blocklist.json' "provider blocklist from the fork"
hook src/renderer/src/features/onboarding/FirstRunChoice.tsx '<Show when={vendorTelemetryEnabled}>' "no analytics opt-in (desktop setup)"
hook src/renderer/src/features/web-client/WebApp.tsx 'vendorTelemetryEnabled && !analyticsAgreed()' "no analytics opt-in (web sign-in)"
hook src/renderer/src/features/settings/SettingsGeneralTab.tsx '<Show when={vendorTelemetryEnabled}>' "no analytics switch (desktop settings)"
hook src/renderer/src/features/web-client/WebAccountSettings.tsx '<Show when={vendorTelemetryEnabled}>' "no analytics switch (web settings)"
hook apps/mobile/src/features/settings/screens/settings-screen.tsx '{vendorTelemetryEnabled ? (' "no Privacy analytics screen (phone)"
hook apps/mobile/src/features/support/model/logged-fetch.ts 'withRequestLog(guardVendorFetch(expoFetch))' "phone expo/fetch guard"
# `expo/fetch` is native and skips the global guard: only the guarded wrapper may import it.
for file in $(grep -rlE "from [\"']expo/fetch[\"']" apps/mobile/src packages 2>/dev/null | grep -v node_modules); do
  [[ "$file" == apps/mobile/src/features/support/model/logged-fetch.ts ]] && continue
  echo "✗ $file imports expo/fetch directly: use features/support/model/logged-fetch.ts (it blocks the vendor)"; status=1
done
hook src/main/github-connector-config.ts 'const GITHUB_APP_CLIENT_ID = "";' "no vendor GitHub App (OpenBotGit)"
hook src/main/self-host/bootstrap.ts 'readBundledGitHubApp(' "own GitHub App from self-host.json"
hook scripts/create-github-app.ts 'OPENBOT_GITHUB_APP_MANIFEST' "own GitHub App manifest"
hook src/backend/mcp-oauth-provider.ts 'selfHostClientMetadataUrl(process.env.OPENBOT_AUTH_API_URL)' "MCP client document on the own server"
hook "apps/auth-api/src/routes/oauth/mcp-client[.]json.ts" 'client_id: `${origin}/oauth/mcp-client.json`' "MCP client document names its own server"
hook packages/telemetry/src/self-host.ts 'export const vendorPromotionsEnabled: boolean = false;' "promotion switch off"
hook src/renderer/src/features/conversation/social-follow-prompt.tsx 'if (!vendorPromotionsEnabled) return;' "no 'Tell a friend' toast"
hook src/renderer/src/features/conversation/github-star-prompt.tsx 'if (!vendorPromotionsEnabled) return;' "no GitHub star toast"
hook src/renderer/src/features/sidebar/WorkspaceSidebar.tsx 'vendorPromotionsEnabled &&' "no mobile-app/community sidebar cards"
hook src/renderer/src/features/web-client/WebWorkspace.tsx 'vendorPromotionsEnabled && !communityCard.dismissed()' "no community card (web)"
hook src/main/application-services.ts 'registerMacBridgeDriver(() => cuaDriver.mcpServerConfig());' "Mac bridge gets the Computer Use driver"
hook src/main/main-window.ts 'setMacBridge(item.checked)' "Mac bridge menu switch"
hook src/main/application-services.ts 'startWorkflowMcp({ workflows: () => workflowRuntime' "workflow MCP server gets the workflows"
hook apps/auth-api/src/server/smtp-email-delivery.ts 'Cloudflare Email Service SMTP' "SMTP username may be api_token (Cloudflare)"

# A second `onBeforeRequest` on a session replaces the guard's listener.
others="$(grep -rn 'webRequest.onBeforeRequest' src/main src/backend --include='*.ts' | grep -v '\.test\.' | grep -v 'src/main/self-host/')"
if [[ -n "$others" ]]; then
  echo "✗ upstream registers its own webRequest.onBeforeRequest; it replaces the vendor guard on that session:"
  echo "$others"; status=1
fi

# Vendor references in the app sources, compared with the reviewed baseline.
current="$(grep -rnoE --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  'https?://[A-Za-z0-9.-]*openbot\.run[^"'"'"' `)]*|wss://[A-Za-z0-9.-]*openbot\.run[^"'"'"' `)]*|nightly-labs/openbot[A-Za-z0-9/._-]*|u\.expo\.dev[^"'"'"' ]*|openpanel' \
  src apps/mobile/src apps/mobile/app.json packages/contracts/src packages/team-client/src packages/telemetry/src electron-builder.yml 2>/dev/null |
  grep -vE '\.(test|spec|stories)\.|/preview/|/stories/' | sed -E 's/:[0-9]+:/: /' | sort -u)"
if [[ "${1:-}" == "--update-baseline" ]]; then
  printf '%s\n' "$current" > "$BASELINE"
  echo "✓ baseline updated: $(wc -l < "$BASELINE") references"
  exit $status
fi
added="$(comm -13 <(sort -u "$BASELINE") <(printf '%s\n' "$current"))"
if [[ -n "$added" ]]; then
  echo "⚠ new vendor references since the last review (the network guard blocks them at run time;"
  echo "  check each one, then run selfhost/scripts/check-selfhost.sh --update-baseline):"
  echo "$added" | sed 's/^/    /'
  [[ $status == 0 ]] && status=3
fi
[[ $status == 0 ]] && echo "✓ self-host hooks in place; no new vendor references"
exit $status
