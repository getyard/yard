#!/usr/bin/env bash
# yard in front of a hosted (HTTP) MCP server: auth header is sent, writes are journaled, reads pass through.
set -euo pipefail
cd "$(dirname "$0")/.."
export YARD_HOME=$(mktemp -d) YARD_RUN=run_http STRIPE_SECRET_KEY=sk_test_fake FAKE_TOKEN=sk_test_fake

PORT_FILE=$(mktemp)
node test/fake-http-server.mjs > "$PORT_FILE" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
URL="http://127.0.0.1:$(cat "$PORT_FILE")/mcp"

OUT=$({
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
  sleep 1
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stripe_api_read","arguments":{"stripe_api_operation_id":"GetCustomers","parameters":{}}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"stripe_api_write","arguments":{"stripe_api_operation_id":"PostCustomers","parameters":{"name":"Yard Test","email":"test@getyard.dev"}}}}'
  sleep 2
} | node dist/cli.js proxy --name stripe --url "$URL" --bearer-env STRIPE_SECRET_KEY 2>/dev/null)

echo "$OUT" | grep -q '"id":2' || { echo "FAIL: no tools/list response through the bridge"; exit 1; }
echo "$OUT" | grep -q 'stripe_api_write' || { echo "FAIL: tool list missing stripe_api_write"; exit 1; }
echo "$OUT" | grep -q '"id":4' || { echo "FAIL: write response didn't come back"; exit 1; }

echo "--- yard log"
node dist/cli.js log
echo "--- yard show"
SHOW=$(node dist/cli.js show run_http)
echo "$SHOW"
echo "$SHOW" | grep -q "stripe.stripe_api_write  \[done, reversible\]" || { echo "FAIL: write not journaled as reversible"; exit 1; }
echo "$SHOW" | grep -q "stripe_api_read" && { echo "FAIL: read should not be journaled"; exit 1; }
echo "--- undo preview"
node dist/cli.js undo run_http
echo "PASS"
