// A stand-in for mcp.stripe.com: a Streamable HTTP MCP server with Stripe's tool names.
// Rejects requests without the expected bearer token, like the real one.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.FAKE_TOKEN ?? "sk_test_fake";
const transports = new Map();

function mcpServer() {
  const server = new Server({ name: "fake-stripe", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["stripe_api_read", "stripe_api_write", "stripe_api_search"].map((name) => ({
      name, inputSchema: { type: "object", properties: { stripe_api_operation_id: { type: "string" }, parameters: { type: "object" } } },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const p = req.params.arguments?.parameters ?? {};
    const obj = req.params.name === "stripe_api_write"
      ? { id: "cus_FAKE123456", object: "customer", name: "[redacted]", email: "[redacted]", ...("customer" in p ? { id: p.customer } : {}) }
      : { object: "list", data: [] };
    return { content: [{ type: "text", text: JSON.stringify(obj) }] };
  });
  return server;
}

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : undefined;
  const sid = req.headers["mcp-session-id"];
  let transport = sid && transports.get(sid);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => transports.set(id, transport) });
    await mcpServer().connect(transport);
  }
  await transport.handleRequest(req, res, parsed);
}).listen(Number(process.env.PORT ?? 0), "127.0.0.1", function () {
  console.log(this.address().port);
});
