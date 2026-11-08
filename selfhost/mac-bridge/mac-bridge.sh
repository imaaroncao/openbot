#!/usr/bin/env bash
# Self-hosted fork: one-time setup of the Mac bridge (see selfhost/README.md). The switch is in
# OpenBot on the Mac: OpenBot menu > 允许 VPS 上的 agent 操作这台 Mac (src/main/self-host/mac-bridge.ts).
#
#   selfhost/mac-bridge/mac-bridge.sh setup root@<VPS>
#
# Makes the SSH key and the token in ~/.config/openbot/mac-bridge, a restricted VPS user that may only
# open 172.31.250.1:2222 (reachable only from the OpenBot host container), and the agent tool
# /data/mac-bridge/connect.sh in the host container. Safe to run again: it keeps the key and token.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HOME/.config/openbot/mac-bridge"

case "${1:-}" in
setup)
  TARGET="${2:-}"
  [[ "$TARGET" == *@* ]] || { echo "usage: $0 setup root@<VPS>" >&2; exit 2; }
  mkdir -p "$CONFIG" && chmod 700 "$CONFIG"
  [[ -f "$CONFIG/id_ed25519" ]] || ssh-keygen -q -t ed25519 -N "" -C "openbot-mac-bridge" -f "$CONFIG/id_ed25519"
  [[ -f "$CONFIG/token" ]] || (umask 077 && openssl rand -hex 32 > "$CONFIG/token")
  HOST="${TARGET#*@}"
  echo "macbridge@$HOST" > "$CONFIG/vps"
  echo "▸ VPS: restricted user macbridge, SSH rule, agent tool"
  # The key and the token go through standard input, never through process arguments.
  { echo "PUBKEY=$(cut -d' ' -f1-2 "$CONFIG/id_ed25519.pub")"; echo "TOKEN=$(cat "$CONFIG/token")"; echo "---"; cat "$HERE/connect.sh"; } |
    ssh "$TARGET" 'bash -c '\''
      set -euo pipefail
      read -r line; PUBKEY="${line#PUBKEY=}"; read -r line; TOKEN="${line#TOKEN=}"; read -r _
      CONNECT="$(cat)"
      id macbridge >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/macbridge --shell /usr/sbin/nologin macbridge
      install -d -m 700 -o macbridge -g macbridge /var/lib/macbridge/.ssh
      printf "restrict,port-forwarding,permitlisten=\"172.31.250.1:2222\" %s\n" "$PUBKEY" > /var/lib/macbridge/.ssh/authorized_keys
      chown macbridge:macbridge /var/lib/macbridge/.ssh/authorized_keys && chmod 600 /var/lib/macbridge/.ssh/authorized_keys
      printf "%s\n" "# OpenBot Mac bridge: macbridge may only open 172.31.250.1:2222 (see authorized_keys)." \
        "Match User macbridge" "  AllowTcpForwarding remote" "  GatewayPorts clientspecified" "  PermitTTY no" \
        "  X11Forwarding no" "  AllowAgentForwarding no" "  ForceCommand /usr/sbin/nologin" "Match all" \
        > /etc/ssh/sshd_config.d/60-openbot-mac-bridge.conf
      sshd -t
      # The rule applies to macbridge only; root keeps its settings.
      case "$(sshd -T -C user=macbridge,host=mac,addr=192.0.2.1)" in *"gatewayports clientspecified"*) ;; *) exit 1 ;; esac
      case "$(sshd -T -C user=root,host=mac,addr=192.0.2.1)" in *"gatewayports no"*) ;; *) exit 1 ;; esac
      systemctl reload ssh 2>/dev/null || systemctl restart ssh
      # A host firewall drops the container by default: let only the host container reach the bridge.
      if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
        ufw allow proto tcp from 172.31.250.10 to 172.31.250.1 port 2222 comment "OpenBot Mac bridge" >/dev/null
      fi
      V=$(docker volume inspect openbot-host_openbot-data -f "{{.Mountpoint}}")
      install -d -m 700 -o 1000 -g 1000 "$V/mac-bridge"
      (umask 077 && printf "%s\n" "$TOKEN" > "$V/mac-bridge/token")
      printf "%s\n" "$CONNECT" > "$V/mac-bridge/connect.sh"
      chown 1000:1000 "$V/mac-bridge/token" "$V/mac-bridge/connect.sh"
      chmod 600 "$V/mac-bridge/token"; chmod 700 "$V/mac-bridge/connect.sh"
      echo "  ok"
    '\'''
  echo "✓ Setup done. In OpenBot on the VPS server, add the MCP tool: command /data/mac-bridge/connect.sh."
  echo "  Turn the bridge on in OpenBot on this Mac: OpenBot menu > 允许 VPS 上的 agent 操作这台 Mac."
  ;;
*)
  echo "usage: $0 setup root@<VPS>" >&2; exit 2
  ;;
esac
