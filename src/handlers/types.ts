import type { Entry } from "../journal.js";

export interface Handler {
  // Capture the state the action is about to change. Runs before the tool is called.
  before?: (args: any) => Promise<unknown>;
  // Reverse the action, using the snapshot and/or the tool's result.
  undo?: (entry: Entry) => Promise<void>;
  // Instead of running immediately, hold the call this many ms. Undo during the hold = it never happened.
  holdMs?: number;
  // Actions that can't be reversed are still journaled, and flagged.
  irreversible?: string;
}

// Pull a JSON object out of an MCP tool result (tools usually return it as text content).
export function resultJson(entry: Entry): any {
  const r: any = entry.result;
  const text = r?.content?.find?.((c: any) => c.type === "text")?.text;
  if (!text) return r;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
