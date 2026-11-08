import { stripeHandlers } from "./stripe.js";
import { emailHoldPatterns, gmailHandler } from "./gmail.js";
import { isWriteSql, postgresHandler } from "./postgres.js";
import { stripeApiHandler } from "./stripe-api.js";
import type { Handler } from "./types.js";

// Tools that only read. Everything else is treated as a write and journaled, never skipped.
const READ = /(^|_)(list|get|retrieve|read|search|fetch|details|describe|find|query_docs)(_|$)/i;

// Decide how yard treats one tool call. Returns null for reads, which pass straight through.
export function handlerFor(server: string, tool: string, args: any): Handler | null {
  const s = server.toLowerCase();
  if (s.includes("stripe")) {
    if (stripeHandlers[tool]) return stripeHandlers[tool];
    if (/api_write|api_request|execute/.test(tool)) return stripeApiHandler(args);
    if (READ.test(tool)) return null;
    return { irreversible: `no undo handler for stripe.${tool} yet` };
  }
  if (s.includes("gmail") || s.includes("mail") || s.includes("outlook")) {
    return emailHoldPatterns.some((p) => tool.toLowerCase().includes(p)) ? gmailHandler : null;
  }
  if (s.includes("postgres") || s.includes("pg")) {
    return isWriteSql(args?.sql ?? args?.query) ? postgresHandler : null;
  }
  // Unknown server: journal every non-read so the run history is never silently incomplete.
  if (READ.test(tool)) return null;
  return { irreversible: `no undo handler for ${server}.${tool} yet` };
}
