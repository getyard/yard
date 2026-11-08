import { stripeHandlers } from "./stripe.js";
import { emailHoldPatterns, gmailHandler } from "./gmail.js";
import { isWriteSql, postgresHandler } from "./postgres.js";
import type { Handler } from "./types.js";

// Decide how yard treats one tool call. Returns null for reads, which pass straight through.
export function handlerFor(server: string, tool: string, args: any): Handler | null {
  const s = server.toLowerCase();
  if (s.includes("stripe")) {
    if (stripeHandlers[tool]) return stripeHandlers[tool];
    if (/^(create|update|cancel|delete|finalize)_/.test(tool)) return { irreversible: `no undo handler for stripe.${tool} yet` };
    return null;
  }
  if (s.includes("gmail") || s.includes("mail") || s.includes("outlook")) {
    return emailHoldPatterns.some((p) => tool.toLowerCase().includes(p)) ? gmailHandler : null;
  }
  if (s.includes("postgres") || s.includes("pg")) {
    return isWriteSql(args?.sql ?? args?.query) ? postgresHandler : null;
  }
  // Unknown server: journal anything that looks like a write so the run history is complete.
  if (/(create|update|delete|send|write|remove|set)/i.test(tool)) return { irreversible: `unknown server "${server}"` };
  return null;
}
