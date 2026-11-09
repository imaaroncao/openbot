#!/usr/bin/env bash
# Self-hosted fork: the workflow MCP server of the OpenBot host on the VPS (see selfhost/README.md).
# An MCP client, such as Claude Code on this Mac, builds and runs the host's workflows through it.
#
#   selfhost/workflow-mcp/workflow-mcp.sh setup root@<VPS>   one time: key, token, VPS side
#   selfhost/workflow-mcp/workflow-mcp.sh command            the command line for an MCP client
#
# setup makes the SSH key in ~/.config/openbot/workflow-mcp, a VPS user `openbotmcp` whose key runs only
# /opt/openbot-host/workflow-mcp/connect.sh, a token that only that user reads, and its SHA-256 in
# /opt/openbot-host/.env (WORKFLOW_MCP_TOKEN_SHA256), which the host container gets. The container keeps
# only the hash, so the agents in it cannot use the server. The host container must start again with
# an image that has src/main/self-host/workflow-mcp.ts. Safe to run again: it keeps the key and token.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.config/openbot/workflow-mcp"

command_line() {
  [[ -f "$CONFIG/vps" ]] || { echo "Run: $0 setup root@<VPS>" >&2; exit 1; }
  printf '%q ' ssh -T -i "$CONFIG/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$CONFIG/known_hosts" "$(cat "$CONFIG/vps")"
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
  echo "    claude mcp add --scope user openbot-workflows -- $(command_line)"
  ;;
command)
  command_line
  ;;
*)
  echo "usage: $0 setup root@<VPS> | command" >&2; exit 2
  ;;
esac
