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

// Pull a JSON object out of an MCP tool result. Servers return it as structured content,
// as JSON text, or as text with JSON inside it.
export function resultJson(entry: Entry): any {
  const r: any = entry.result;
  if (r?.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const text: string | undefined = r?.content?.find?.((c: any) => c.type === "text")?.text;
  if (!text) return r;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  const id = text.match(/\b([a-z]{2,8}_[A-Za-z0-9]{8,})\b/)?.[1];
  return id ? { id, raw: text } : { raw: text };
}
