// Append-only journal of every write action an agent takes through yard.
// Each line is an event; the current state of an entry is all its events folded together.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Status = "pending" | "held" | "done" | "failed" | "undone" | "undo_failed" | "released" | "dropped";

export interface Entry {
  id: string;          // unique action id
  run: string;         // one agent session
  step: number;        // order within the run
  server: string;      // e.g. "stripe"
  tool: string;        // e.g. "create_customer"
  args: unknown;
  snapshot?: unknown;  // state captured before the action
  result?: unknown;    // what the tool returned
  status: Status;
  reversible: boolean;
  note?: string;
  ts: string;
}

const dir = process.env.YARD_HOME ?? join(homedir(), ".yard");
const file = join(dir, "journal.jsonl");

export function record(event: Partial<Entry> & { id: string }): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n");
}

export function entries(): Entry[] {
  if (!existsSync(file)) return [];
  const byId = new Map<string, Entry>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    byId.set(ev.id, { ...(byId.get(ev.id) ?? {}), ...ev });
  }
  return [...byId.values()];
}

export function get(id: string): Entry | undefined {
  return entries().find((e) => e.id === id);
}

export function runs(): { run: string; actions: number; first: string; last: string }[] {
  const grouped = new Map<string, Entry[]>();
  for (const e of entries()) grouped.set(e.run, [...(grouped.get(e.run) ?? []), e]);
  return [...grouped.entries()].map(([run, es]) => ({
    run,
    actions: es.length,
    first: es[0].ts,
    last: es[es.length - 1].ts,
  }));
}

// Every tool call yard sees, reads included, so "yard log" can show exactly what passed through.
export function logCall(run: string, server: string, tool: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "calls.log"), `${new Date().toISOString()}  ${run}  ${server}.${tool}\n`);
}

export const callLogPath = join(dir, "calls.log");

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
