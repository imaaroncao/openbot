#!/usr/bin/env bash
# Self-hosted fork: the standard input and output of the workflow MCP server (see selfhost/README.md).
#
#   connect.sh [host:port] [token file]
#
# The defaults are for the VPS: workflow-mcp.sh setup installs this as /opt/openbot-host/workflow-mcp/connect.sh,
# and the SSH key of the user openbotmcp runs only this, with no arguments. On a Mac, setup-local copies
# it to ~/.config/openbot/workflow-mcp-local and the MCP client gives 127.0.0.1:47778 and that token file.
# It sends the token and then passes the MCP messages both ways. It works with the bash 3.2 of macOS.
ADDRESS="${1:-172.31.250.10:47778}"
TOKEN_FILE="${2:-/opt/openbot-host/workflow-mcp/token}"
{ exec 3<>"/dev/tcp/${ADDRESS%:*}/${ADDRESS##*:}"; } 2>/dev/null || {
  echo "OpenBot does not answer on $ADDRESS: is it running, with its workflow MCP token? See selfhost/README.md." >&2
  exit 1
}
printf '%s\n' "$(cat "$TOKEN_FILE")" >&3
# A background job without job control reads /dev/null, so the input goes through descriptor 4.
exec 4<&0
cat <&3 &
reader=$!
cat <&4 >&3 &
writer=$!
# bash 3.2 has no `wait -n`: stop when one direction ends.
while kill -0 "$reader" 2>/dev/null && kill -0 "$writer" 2>/dev/null; do sleep 1; done
kill "$reader" "$writer" 2>/dev/null
exit 0
