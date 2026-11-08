#!/usr/bin/env bash
# Self-hosted fork: the "My Mac" MCP tool of agents on the VPS (see selfhost/README.md).
# Installed by mac-bridge.sh setup as /data/mac-bridge/connect.sh in the host container. It connects
# the tool's standard input and output to the Mac bridge, which is open only while it is on.
{ exec 3<>/dev/tcp/172.31.250.1/2222; } 2>/dev/null || {
  echo "The Mac bridge is off. Turn it on in OpenBot on the Mac: OpenBot menu > 允许 VPS 上的 agent 操作这台 Mac." >&2
  exit 1
}
printf '%s\n' "$(cat /data/mac-bridge/token)" >&3
exec 4<&0
cat <&3 &
reader=$!
cat <&4 >&3 &
writer=$!
wait -n "$reader" "$writer"
kill "$reader" "$writer" 2>/dev/null
exit 0
