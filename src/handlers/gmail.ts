// A delivered email can't be recalled. So yard holds every send for a window;
// undo during the window means the email is never sent.
import type { Handler } from "./types.js";

const HOLD = Number(process.env.YARD_EMAIL_HOLD_MS ?? 60_000);

// Matched by substring so it works across Gmail/Outlook MCP servers with different tool names.
export const emailHoldPatterns = ["send", "reply", "forward"];

export const gmailHandler: Handler = { holdMs: HOLD };
