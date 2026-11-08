#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { callLogPath, entries, record, runs, type Entry } from "./journal.js";
import { handlerFor } from "./handlers/index.js";
import { resultJson } from "./handlers/types.js";
import { startProxy } from "./proxy.js";
import { commandUpstream, httpUpstream } from "./upstream.js";

const [cmd, ...rest] = process.argv.slice(2);
const dash = rest.indexOf("--");
const opts = dash === -1 ? rest : rest.slice(0, dash);
const flag = (name: string) => {
  const i = opts.indexOf(`--${name}`);
  return i === -1 ? undefined : opts[i + 1];
};
const flags = (name: string) => opts.flatMap((v, i) => (v === `--${name}` && opts[i + 1] ? [opts[i + 1]] : []));

const icons: Record<string, string> = {
  done: "✓", pending: "…", held: "⏸", released: "→", failed: "✗", undone: "↺", undo_failed: "!", dropped: "⊘",
};

// "last" means the most recent run, so nobody has to copy run ids.
const resolveRun = (run?: string) => (run === "last" || run === undefined ? runs().at(-1)?.run : run);

// What a write actually did, e.g. "PostCustomers → cus_123".
function describe(e: Entry): string {
  const a: any = e.args ?? {};
  const op = a.stripe_api_operation_id ?? a.operation_id ?? a.operation;
  const id = e.result ? resultJson(e)?.id : undefined;
  return [op, id ? `→ ${id}` : ""].filter(Boolean).join(" ");
}

function label(e: Entry): string {
  if (e.status === "held") return "can cancel";
  if (e.status === "dropped") return "never ran";
  if (e.status === "failed") return "nothing changed";
  if (e.status === "undone") return "reversed";
  return e.reversible ? "reversible" : "irreversible";
}

async function main() {
  switch (cmd) {
    case "proxy": {
      const url = flag("url");
      if (url) {
        const headers: Record<string, string> = {};
        for (const h of flags("header")) {
          const i = h.indexOf(":");
          if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
        }
        const bearerEnv = flag("bearer-env");
        const token = bearerEnv
          ? process.env[bearerEnv]
          : /stripe\.com/.test(url) ? (process.env.STRIPE_AGENT_KEY ?? process.env.STRIPE_SECRET_KEY) : undefined;
        if (bearerEnv && !token) throw new Error(`${bearerEnv} is not set`);
        if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
        startProxy(flag("name") ?? new URL(url).hostname, httpUpstream(url, headers));
        return;
      }
      if (dash === -1) throw new Error("usage: yard proxy --name <server> --url <https://...>  |  yard proxy --name <server> -- <command> [args...]");
      const [command, ...args] = rest.slice(dash + 1);
      startProxy(flag("name") ?? command, commandUpstream(command, args));
      return;
    }

    case "runs": {
      const all = runs();
      if (!all.length) return console.log("No agent runs recorded yet. (yard log shows every call yard has seen.)");
      for (const r of all) console.log(`${r.run}  ${r.actions} actions  ${r.first.slice(0, 19)} → ${r.last.slice(11, 19)}`);
      return;
    }

    case "log": {
      if (!existsSync(callLogPath)) return console.log("yard hasn't seen any tool calls yet.");
      const lines = readFileSync(callLogPath, "utf8").trim().split("\n");
      console.log(lines.slice(-Number(rest[0] ?? 20)).join("\n"));
      return;
    }

    case "show": {
      const run = resolveRun(rest[0]);
      if (!run) return console.log("No agent runs recorded yet.");
      console.log(run);
      for (const e of entries().filter((e) => e.run === run).sort((a, b) => a.step - b.step)) {
        const what = describe(e);
        console.log(`${String(e.step).padStart(3)}  ${icons[e.status] ?? "?"} ${e.server}.${e.tool}${what ? `  ${what}` : ""}  [${e.status}, ${label(e)}]${e.note ? `  ${e.note}` : ""}`);
      }
      return;
    }

    case "inspect": {
      // Exactly what yard recorded for one step: the arguments and the server's response.
      const run = resolveRun(rest[0]);
      const step = Number(rest[1]);
      const e = entries().find((x) => x.run === run && x.step === step);
      if (!e) return console.log(`No step ${rest[1]} in ${run}. usage: yard inspect <run|last> <step>`);
      console.log(JSON.stringify({ step: e.step, tool: `${e.server}.${e.tool}`, status: e.status, note: e.note, args: e.args, result: e.result, snapshotted: Object.keys((e.snapshot as object) ?? {}) }, null, 2));
      return;
    }

    case "undo": {
      const run = resolveRun(rest[0]);
      if (!rest[0] || !run) throw new Error("usage: yard undo <run|last> [--from <step>] [--yes]");
      const from = Number(flag("from") ?? 1);
      const execute = rest.includes("--yes");
      const targets = entries()
        .filter((e) => e.run === run && e.step >= from)
        .sort((a, b) => b.step - a.step); // newest first

      if (!targets.length) return console.log(`Nothing to undo in ${run} from step ${from}.`);

      // Catch a missing or placeholder Stripe key before touching anything.
      if (execute && targets.some((e) => /stripe/i.test(e.server) && ["done", "undo_failed"].includes(e.status))) {
        const key = process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY ?? process.env.STRIPE_AGENT_KEY;
        if (!key) throw new Error("undo needs your Stripe key in this terminal: export STRIPE_SECRET_KEY=sk_test_... (your real key)");
        if (/YOUR_KEY|NEW_KEY|\.\.\.|[<>]/.test(key) || key.length < 20) {
          throw new Error("STRIPE_SECRET_KEY is still placeholder text. Export your real sk_test_ key from dashboard.stripe.com/test/apikeys");
        }
      }
      console.log(execute ? `Undoing ${run} from step ${from}:` : `Preview, nothing changed yet (add --yes to run):`);

      for (const e of targets) {
        const label = `step ${e.step} ${e.server}.${e.tool}${describe(e) ? ` ${describe(e)}` : ""}`;
        if (["undone", "failed", "dropped"].includes(e.status)) { console.log(`  skip    ${label} (${e.status})`); continue; }
        if (e.status === "held") {
          if (execute) record({ id: e.id, status: "undone", note: "cancelled during hold" });
          console.log(`  cancel  ${label}: never runs`);
          continue;
        }
        const handler = handlerFor(e.server, e.tool, e.args);
        if (!["done", "undo_failed"].includes(e.status) || !handler?.undo || !e.reversible) {
          console.log(`  manual  ${label}: can't be reversed automatically${e.note ? ` (${e.note})` : ""}`);
          continue;
        }
        if (!execute) { console.log(`  revert  ${label}`); continue; }
        try {
          await handler.undo(e);
          record({ id: e.id, status: "undone" });
          console.log(`  ↺ done  ${label}`);
        } catch (err) {
          record({ id: e.id, status: "undo_failed", note: (err as Error).message });
          console.log(`  ! fail  ${label}: ${(err as Error).message}`);
        }
      }
      return;
    }

    default:
      console.log(`yard: undo for everything your agents touch

  yard proxy --name <server> --url <https://...>     wrap a hosted MCP server
  yard proxy --name <server> -- <cmd...>             wrap a local MCP server
  yard runs                                          list agent runs
  yard show <run|last>                               list actions in a run
  yard undo <run|last> [--from N] [--yes]            preview, then reverse a run
  yard inspect <run|last> <step>                     what yard recorded for one step
  yard log [n]                                       last n tool calls yard saw`);
  }
}

main().catch((err) => { console.error(`yard: ${err.message}`); process.exit(1); });
