#!/usr/bin/env bash
# Self-hosted fork: the standard input and output of the workflow MCP server (see selfhost/README.md).
# Installed by workflow-mcp.sh setup as /opt/openbot-host/workflow-mcp/connect.sh on the VPS: the SSH
# key of the user openbotmcp runs only this. It connects to the server in the OpenBot host container,
# sends the token, and then passes the MCP messages both ways.
{ exec 3<>/dev/tcp/172.31.250.10/47778; } 2>/dev/null || {
  echo "OpenBot on the VPS does not answer on 172.31.250.10:47778: is the host container up, with WORKFLOW_MCP_TOKEN_SHA256 in /opt/openbot-host/.env?" >&2
  exit 1
}
printf '%s\n' "$(cat /opt/openbot-host/workflow-mcp/token)" >&3
exec 4<&0
cat <&3 &
reader=$!
cat <&4 >&3 &
writer=$!
wait -n "$reader" "$writer"
kill "$reader" "$writer" 2>/dev/null
exit 0
