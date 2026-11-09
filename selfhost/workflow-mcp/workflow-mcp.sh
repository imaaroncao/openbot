#!/usr/bin/env bash
# Self-hosted fork: the workflow MCP server of OpenBot (see selfhost/README.md). An MCP client, such as
# Claude Code on this Mac, builds and runs the workflows of the VPS host or of this Mac through it.
#
#   selfhost/workflow-mcp/workflow-mcp.sh setup root@<VPS>   one time: key, token, VPS side
#   selfhost/workflow-mcp/workflow-mcp.sh command            the MCP client command line for the VPS
#   selfhost/workflow-mcp/workflow-mcp.sh setup-local        one time: the token of OpenBot on this Mac
#   selfhost/workflow-mcp/workflow-mcp.sh command-local      the MCP client command line for this Mac
#
# setup-local makes ~/.config/openbot/workflow-mcp-local with a token and connect.sh. OpenBot on this Mac
# reads the token when it starts, and then serves on 127.0.0.1:47778.
#
# setup makes the SSH key in ~/.config/openbot/workflow-mcp, a VPS user `openbotmcp` whose key runs only
# /opt/openbot-host/workflow-mcp/connect.sh, a token that only that user reads, and its SHA-256 in
# /opt/openbot-host/.env (WORKFLOW_MCP_TOKEN_SHA256), which the host container gets. The container keeps
# only the hash, so the agents in it cannot use the server. The host container must start again with
# an image that has src/main/self-host/workflow-mcp.ts. Safe to run again: it keeps the key and token.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.config/openbot/workflow-mcp"
LOCAL="$HOME/.config/openbot/workflow-mcp-local"

command_line() {
  [[ -f "$CONFIG/vps" ]] || { echo "Run: $0 setup root@<VPS>" >&2; exit 1; }
  printf '%q ' ssh -T -i "$CONFIG/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$CONFIG/known_hosts" "$(cat "$CONFIG/vps")"
  echo
}

local_command_line() {
  [[ -f "$LOCAL/token" ]] || { echo "Run: $0 setup-local" >&2; exit 1; }
  printf '%q ' "$LOCAL/connect.sh" 127.0.0.1:47778 "$LOCAL/token"
  echo
}

case "${1:-}" in
setup)
  TARGET="${2:-}"
  [[ "$TARGET" == *@* ]] || { echo "usage: $0 setup root@<VPS>" >&2; exit 2; }
  mkdir -p "$CONFIG" && chmod 700 "$CONFIG"
  [[ -f "$CONFIG/id_ed25519" ]] || ssh-keygen -q -t ed25519 -N "" -C "openbot-workflow-mcp" -f "$CONFIG/id_ed25519"
  echo "openbotmcp@${TARGET#*@}" > "$CONFIG/vps"
  echo "▸ VPS: user openbotmcp, connect.sh, token, WORKFLOW_MCP_TOKEN_SHA256"
  { echo "PUBKEY=$(cut -d' ' -f1-2 "$CONFIG/id_ed25519.pub")"; echo "---"; cat "$HERE/connect.sh"; } |
    ssh "$TARGET" 'bash -c '\''
      set -euo pipefail
      read -r line; PUBKEY="${line#PUBKEY=}"; read -r _
      DIR=/opt/openbot-host/workflow-mcp
      # A shell, so that sshd can run the key command; the key runs nothing else (restrict, command=).
      id openbotmcp >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/openbotmcp --shell /bin/bash openbotmcp
      install -d -m 750 -o root -g openbotmcp "$DIR"
      cat > "$DIR/connect.sh"
      chown root:openbotmcp "$DIR/connect.sh" && chmod 750 "$DIR/connect.sh"
      [ -s "$DIR/token" ] || (umask 077 && openssl rand -hex 32 > "$DIR/token")
      chown openbotmcp:openbotmcp "$DIR/token" && chmod 600 "$DIR/token"
      install -d -m 700 -o openbotmcp -g openbotmcp /var/lib/openbotmcp/.ssh
      printf "restrict,command=\"%s\" %s\n" "$DIR/connect.sh" "$PUBKEY" > /var/lib/openbotmcp/.ssh/authorized_keys
      chown openbotmcp:openbotmcp /var/lib/openbotmcp/.ssh/authorized_keys
      chmod 600 /var/lib/openbotmcp/.ssh/authorized_keys
      HASH="$(printf "%s" "$(cat "$DIR/token")" | sha256sum | cut -d" " -f1)"
      ENV=/opt/openbot-host/.env
      touch "$ENV"
      sed -i "/^WORKFLOW_MCP_TOKEN_SHA256=/d" "$ENV"
      echo "WORKFLOW_MCP_TOKEN_SHA256=$HASH" >> "$ENV"
      echo "  ok"
    '\'''
  echo "✓ Setup done. The host container serves the tools after it starts again with a new image:"
  echo "    selfhost/server/scripts/build-linux-host.sh $TARGET"
  echo "    ssh $TARGET 'cd /opt/openbot-host && docker compose up -d'"
  echo "  Then add the server to Claude Code:"
  echo "    claude mcp add --scope user openbot-vps-workflows -- $(command_line)"
  ;;
command)
  command_line
  ;;
setup-local)
  [[ "$(uname)" == Darwin ]] || { echo "setup-local is for OpenBot on a Mac." >&2; exit 2; }
  mkdir -p "$LOCAL" && chmod 700 "$LOCAL"
  [[ -s "$LOCAL/token" ]] || (umask 077 && openssl rand -hex 32 > "$LOCAL/token")
  chmod 600 "$LOCAL/token"
  install -m 700 "$HERE/connect.sh" "$LOCAL/connect.sh"
  echo "✓ Setup done. Quit and open OpenBot on this Mac again: it reads the token when it starts."
  echo "  Then add the server to Claude Code:"
  echo "    claude mcp add --scope user openbot-mac-workflows -- $(local_command_line)"
  ;;
command-local)
  local_command_line
  ;;
*)
  echo "usage: $0 setup root@<VPS> | command | setup-local | command-local" >&2; exit 2
  ;;
esac
