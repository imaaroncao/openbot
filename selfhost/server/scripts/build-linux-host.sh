#!/usr/bin/env bash
# Self-hosted fork: builds the Linux OpenBot of this fork on the VPS and makes its Docker image.
# The VPS then runs an always-on OpenBot host (agents, embedded browser and Computer Use on a
# virtual display), signed in to your own account service. See selfhost/README.md.
#
#   selfhost/server/scripts/build-linux-host.sh root@203.0.113.10 [git-ref]
#
# On the VPS it clones https://github.com/imaaroncao/openbot (the ref, default `selfhost`) into
# /opt/openbot-src, builds the x64 AppImage inside an ubuntu:24.04 container (nothing is installed
# on the VPS itself), and builds the image `openbot-selfhost-host:<commit>` from upstream's
# docker/Dockerfile. It also tags it `openbot-selfhost-host:latest`.
set -euo pipefail

TARGET="${1:-}"
REF="${2:-selfhost}"
[[ -n "$TARGET" ]] || { echo "usage: $0 user@host [git-ref]" >&2; exit 2; }
REPO="${OPENBOT_SELFHOST_REPO:-https://github.com/imaaroncao/openbot.git}"
SUDO=sudo
[[ "${TARGET%%@*}" == root ]] && SUDO=

TOOLS="$(cd "$(dirname "$0")/../../scripts" && pwd)"
ssh "$TARGET" "$SUDO mkdir -p /opt/openbot-host/tools && $SUDO chown \$(id -u) /opt/openbot-host/tools"
scp -q "$TOOLS/github-release-proxy.sh" "$TOOLS/github-release-proxy.mjs" "$TOOLS/github-release-fetch.mjs" \
  "$TARGET:/opt/openbot-host/tools/"

ssh -o ServerAliveInterval=30 "$TARGET" "SUDO='$SUDO' REPO='$REPO' REF='$REF' bash -s" <<'REMOTE'
set -euo pipefail
SRC=/opt/openbot-src
CTX=/opt/openbot-host/build

# The build needs ~6 GB of memory; a swap file keeps a small VPS from running out.
if ! $SUDO swapon --show | grep -q .; then
  echo "▸ Adding a 4 GB swap file"
  $SUDO fallocate -l 4G /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile && echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

echo "▸ Source: $REPO @ $REF"
if [ -d "$SRC/.git" ]; then
  $SUDO git -C "$SRC" fetch --quiet --depth 1 origin "$REF"
  $SUDO git -C "$SRC" checkout --quiet --force FETCH_HEAD
  $SUDO git -C "$SRC" clean -fdxq -e node_modules -e .openbot-build
else
  $SUDO git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC"
fi
COMMIT=$($SUDO git -C "$SRC" rev-parse --short HEAD)
echo "  commit $COMMIT"

echo "▸ Building the x64 AppImage in ubuntu:24.04 (about 20-40 minutes)"
$SUDO docker run --rm -v "$SRC:/src" -v /opt/openbot-host/tools:/tools:ro -w /src -e CI=1 ubuntu:24.04 bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  # npm, GitHub and other downloads sometimes fail for a minute (HTTP 504, reset); the upstream
  # scripts retry only for seconds, so every download step gets more attempts here.
  retry() { for attempt in 1 2 3 4 5; do "$@" && return 0; echo "  retry in 30 s ($attempt/5): $*"; sleep 30; done; return 1; }
  retry apt-get update -qq
  retry apt-get install -y -qq --no-install-recommends ca-certificates curl git unzip xz-utils file python3 build-essential >/dev/null
  NODE_MAJOR=24
  node_install() {
    NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import json,sys; print(next(r[\"version\"] for r in json.load(sys.stdin) if r[\"version\"].startswith(\"v$NODE_MAJOR.\")))") &&
      curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  }
  retry node_install
  # GitHub release downloads go through the GitHub API (see selfhost/scripts/github-release-proxy.sh);
  # Bun itself comes from npm.
  source /tools/github-release-proxy.sh && start_github_release_proxy
  BUN_VERSION=$(node -p "require(\"./package.json\").packageManager.split(\"@\")[1]")
  retry npm install --global --silent --no-fund --no-audit "bun@$BUN_VERSION"
  node -v && bun -v
  retry bun install --frozen-lockfile
  retry bun run voice:prepare-runtime
  retry bun scripts/prepare-remote-desktop-runtime.ts linux x64
  bun run verify:remote-desktop-runtime --linux
  retry bun scripts/install-cua-driver.ts linux x64
  # The server address comes from the container environment, so the package bakes none in.
  mkdir -p selfhost/.build && echo "{}" > selfhost/.build/self-host.json
  bun run build
  rm -f dist/*.AppImage
  bun x electron-builder --linux AppImage --x64 --publish never \
    --config selfhost/desktop/electron-builder.selfhost.yml \
    -c.appId=com.imaaroncao.openbot.desktop
'
APPIMAGE=$(ls -t "$SRC"/dist/*.AppImage | head -1)
echo "  $APPIMAGE ($(du -h "$APPIMAGE" | cut -f1))"

echo "▸ Building the host image"
$SUDO rm -rf "$CTX" && $SUDO mkdir -p "$CTX"
$SUDO cp "$APPIMAGE" "$CTX/OpenBot.AppImage"
$SUDO docker build --quiet -f "$SRC/docker/Dockerfile" \
  --build-arg VERSION="$(node -p 'require("/opt/openbot-src/package.json").version' 2>/dev/null || echo selfhost)" \
  --build-arg REVISION="$COMMIT" \
  -t "openbot-selfhost-host:$COMMIT" -t openbot-selfhost-host:latest "$CTX"
$SUDO cp "$SRC/docker/seccomp.json" /opt/openbot-host/seccomp.json
echo "✓ openbot-selfhost-host:$COMMIT"
REMOTE
