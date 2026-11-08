// Sits between an agent and one MCP server (stdio). Passes everything through,
// and journals, snapshots or holds each write action on the way.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { get, newId, record } from "./journal.js";
import { handlerFor } from "./handlers/index.js";

export function startProxy(server: string, command: string, args: string[]): void {
  const run = process.env.YARD_RUN ?? newId("run");
  let step = 0;
  let activeHolds = 0;
  let clientClosed = false;

  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const pending = new Map<string | number, { entryId: string; swallow?: boolean }>();

  const toClient = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const toServer = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  const maybeExit = () => { if (clientClosed && activeHolds === 0) child.stdin.end(); };

  process.stderr.write(`[yard] watching ${server} · run ${run}\n`);

  createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { child.stdin.write(line + "\n"); return; }

    if (msg.method !== "tools/call") return toServer(msg);

    const tool: string = msg.params?.name;
    const toolArgs = msg.params?.arguments ?? {};
    const handler = handlerFor(server, tool, toolArgs);
    if (!handler) return toServer(msg);

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
        toServer({ ...msg, id: fwdId });
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
    toServer(msg);
  });

  process.stdin.on("end", () => { clientClosed = true; maybeExit(); });

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (p) {
      pending.delete(msg.id);
      if (msg.error) record({ id: p.entryId, status: "failed", note: msg.error.message });
      else if (!p.swallow) record({ id: p.entryId, status: "done", result: msg.result });
      if (p.swallow) return;
    }
    toClient(msg);
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}
