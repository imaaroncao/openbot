# Self-hosted fork: sourced by selfhost/desktop/build-dmg.sh and the Linux host build. Sends GitHub
# release downloads (github.com/<owner>/<repo>/releases/download/...) through the GitHub API, because
# that path of github.com can fail for hours with HTTP 504 while the API works:
#   - Electron (ELECTRON_MIRROR) and the electron-builder tools (ELECTRON_BUILDER_BINARIES_MIRROR)
#   - Bun scripts: runtimes, cua-driver (BUN_OPTIONS preload that changes their fetch URLs)
# Every download keeps its checksum check. The proxy stops when the calling shell exits.
#
#   source selfhost/scripts/github-release-proxy.sh && start_github_release_proxy

start_github_release_proxy() {
  local dir port_file port=""
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  port_file="$(mktemp)"
  node "$dir/github-release-proxy.mjs" 0 "$port_file" >&2 &
  GITHUB_RELEASE_PROXY_PID=$!
  trap 'kill "$GITHUB_RELEASE_PROXY_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do
    port="$(cat "$port_file")"
    [[ -n "$port" ]] && break
    sleep 0.2
  done
  rm -f "$port_file"
  [[ -n "$port" ]] || { echo "The GitHub release proxy did not start." >&2; return 1; }
  export GITHUB_RELEASE_PROXY="http://127.0.0.1:$port"
  export ELECTRON_MIRROR="$GITHUB_RELEASE_PROXY/electron/electron/releases/download/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="$GITHUB_RELEASE_PROXY/electron-userland/electron-builder-binaries/releases/download/"
  export BUN_OPTIONS="--preload=$dir/github-release-fetch.mjs"
}
