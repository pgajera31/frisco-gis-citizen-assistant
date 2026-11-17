#!/usr/bin/env bash
# Call the MCP server over Streamable HTTP (start it first with: npm run start -w packages/mcp-server -- --http)
set -euo pipefail
URL="${MCP_URL:-http://127.0.0.1:8788/mcp}"
H=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")

echo "== initialize"
curl -sS "${H[@]}" "$URL" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
echo; echo "== tools/call get_speed_limit"
curl -sS "${H[@]}" -H "MCP-Protocol-Version: 2025-06-18" "$URL" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_speed_limit","arguments":{"street_name":"Preston Road"}}}' | head -c 1200
echo
