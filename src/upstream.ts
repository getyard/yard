// The MCP server yard sits in front of: either a local command (stdio) or a hosted URL (Streamable HTTP).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface Upstream {
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: (code?: number) => void): void;
  close(): void;
}

export function commandUpstream(command: string, args: string[]): Upstream {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  let onMsg: (m: any) => void = () => {};
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { onMsg(JSON.parse(line)); } catch { /* ignore non-JSON output */ }
  });
  return {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { child.on("exit", (code) => cb(code ?? 0)); },
    close: () => child.stdin.end(),
  };
}

export function httpUpstream(url: string, headers: Record<string, string>): Upstream {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  let started: Promise<void> | null = null;
  let closeCb: (code?: number) => void = () => {};
  let onMsg: (m: any) => void = () => {};
  transport.onclose = () => closeCb(0);
  transport.onmessage = (m) => onMsg(m);
  transport.onerror = () => {}; // failures are reported per request below

  // When a request fails, answer the agent with an error instead of leaving it waiting.
  const explain = (err: any) => {
    const status = err?.code;
    if (status === 401 || status === 403) {
      return /stripe\.com/.test(url)
        ? `Stripe rejected the API key (${status}). Stripe MCP needs an agent API key (shown with the Agent badge in the Dashboard) or OAuth; other keys stop working in December 2026.`
        : `${new URL(url).hostname} rejected the credentials (${status}). Check the key or token passed to yard.`;
    }
    return `yard couldn't reach ${url}: ${err?.message ?? err}`;
  };

  return {
    send: (msg: any) => {
      started ??= transport.start();
      started
        .then(() => transport.send(msg))
        .catch((err) => {
          const message = explain(err);
          process.stderr.write(`[yard] ${message}\n`);
          if (msg?.id !== undefined) onMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message } });
        });
    },
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: () => { transport.close().catch(() => {}); },
  };
}
