// Sits between an agent and one MCP server. Passes everything through,
// and journals, snapshots or holds each write action on the way.
import { createInterface } from "node:readline";
import { entries, get, logCall, newId, record } from "./journal.js";
import { handlerFor } from "./handlers/index.js";
import type { Upstream } from "./upstream.js";

export function startProxy(server: string, upstream: Upstream): void {
  const run = process.env.YARD_RUN ?? newId("run");
  let step = 0;
  let activeHolds = 0;
  let clientClosed = false;

  const pending = new Map<string | number, { entryId: string; swallow?: boolean }>();
  const toClient = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const maybeExit = () => { if (clientClosed && activeHolds === 0) upstream.close(); };

  process.stderr.write(`[yard] watching ${server} · run ${run}\n`);

  createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.method !== "tools/call") return upstream.send(msg);

    const tool: string = msg.params?.name;
    const toolArgs = msg.params?.arguments ?? {};
    logCall(run, server, tool);
    const handler = handlerFor(server, tool, toolArgs);
    if (!handler) return upstream.send(msg);

    const entryId = newId("act");
    const base = { id: entryId, run, step: ++step, server, tool, args: toolArgs };

    const holdMs = handler.holdMs ? Number(process.env.YARD_HOLD_MS ?? handler.holdMs) : 0;
    if (holdMs) {
      record({ ...base, status: "held", reversible: true, note: `held ${holdMs / 1000}s` });
      activeHolds++;
      toClient({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `Queued by yard: ${tool} runs in ${holdMs / 1000}s unless undone (run ${run}, step ${base.step}).` }] },
      });
      setTimeout(() => {
        activeHolds--;
        if (get(entryId)?.status === "undone") { maybeExit(); return; }
        const fwdId = `yard_${entryId}`;
        pending.set(fwdId, { entryId, swallow: true });
        record({ id: entryId, status: "released", reversible: false });
        upstream.send({ ...msg, id: fwdId });
        maybeExit();
      }, holdMs);
      return;
    }

    let snapshot: unknown;
    if (handler.before) {
      try { snapshot = await handler.before(toolArgs); }
      catch (err) { process.stderr.write(`[yard] snapshot failed for ${tool}: ${(err as Error).message}\n`); }
    }
    record({
      ...base,
      snapshot,
      status: "pending",
      reversible: Boolean(handler.undo) && !handler.irreversible,
      note: handler.irreversible,
    });
    pending.set(msg.id, { entryId });
    upstream.send(msg);
  });

  process.stdin.on("end", () => { clientClosed = true; maybeExit(); });

  upstream.onMessage((msg) => {
    const p = msg?.id !== undefined ? pending.get(msg.id) : undefined;
    if (p) {
      pending.delete(msg.id);
      if (msg.error) record({ id: p.entryId, status: "failed", note: msg.error.message });
      else if (msg.result?.isError) record({ id: p.entryId, status: "failed", result: msg.result, note: "tool returned an error" });
      else if (p.swallow) record({ id: p.entryId, result: msg.result });
      else record({ id: p.entryId, status: "done", result: msg.result });
      if (p.swallow) return;
    }
    toClient(msg);
  });

  // If the session ends while actions are held, they never run. Say so in the journal.
  const dropHolds = () => {
    for (const e of entries()) {
      if (e.run === run && e.status === "held") record({ id: e.id, status: "dropped", note: "session ended before release; never ran" });
    }
    process.exit(0);
  };
  process.on("SIGTERM", dropHolds);
  process.on("SIGINT", dropHolds);

  upstream.onClose((code) => process.exit(code ?? 0));
}
