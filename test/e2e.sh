#!/usr/bin/env bash
# End-to-end check: create is journaled, a held refund is cancelled by undo and never reaches the server.
set -euo pipefail
cd "$(dirname "$0")/.."
export YARD_HOME=$(mktemp -d) YARD_RUN=run_test FAKE_LOG=$(mktemp)
export STRIPE_SECRET_KEY=sk_test_fake

# Run the proxy with a 2s hold so the test is quick.
{
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_customer","arguments":{"email":"a@b.co"}}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_refund","arguments":{"payment_intent":"pi_1"}}}'
  sleep 1
  node dist/cli.js undo run_test --from 2 --yes >&2
  sleep 3
} | YARD_HOLD_MS=2000 node dist/cli.js proxy --name stripe -- node test/fake-server.mjs

echo "--- journal"
node dist/cli.js show run_test
echo "--- server received"
cat "$FAKE_LOG"
grep -q create_refund "$FAKE_LOG" && { echo "FAIL: held refund reached the server"; exit 1; }
echo "PASS"
