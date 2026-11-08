// Minimal stand-in for an MCP server: answers tools/call with a fake created object.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_LOG;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (log) appendFileSync(log, `${msg.params?.name}\n`);
  const result = msg.method === "tools/call"
    ? { content: [{ type: "text", text: JSON.stringify({ id: "cus_test123", object: "customer" }) }] }
    : { ok: true };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
