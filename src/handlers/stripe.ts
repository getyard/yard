// Undo handlers for the official Stripe MCP server (@stripe/mcp).
// Each create gets a reverse; changes snapshot the object first so it can be restored.
import { resultJson, type Handler } from "./types.js";

async function stripe(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, string>) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  return json;
}

const idOf = (entry: any) => {
  const r = resultJson(entry);
  const id = r?.id;
  if (!id) throw new Error("couldn't find the created object's id in the tool result");
  return id as string;
};

export const stripeHandlers: Record<string, Handler> = {
  create_customer: {
    undo: async (e) => { await stripe("DELETE", `/customers/${idOf(e)}`); },
  },
  create_product: {
    undo: async (e) => { await stripe("POST", `/products/${idOf(e)}`, { active: "false" }); },
  },
  create_price: {
    undo: async (e) => { await stripe("POST", `/prices/${idOf(e)}`, { active: "false" }); },
  },
  create_payment_link: {
    undo: async (e) => { await stripe("POST", `/payment_links/${idOf(e)}`, { active: "false" }); },
  },
  create_invoice: {
    // Draft invoices can be deleted; finalized ones get voided.
    undo: async (e) => {
      const id = idOf(e);
      const inv = await stripe("GET", `/invoices/${id}`);
      if (inv.status === "draft") await stripe("DELETE", `/invoices/${id}`);
      else await stripe("POST", `/invoices/${id}/void`);
    },
  },
  update_subscription: {
    before: (args) => stripe("GET", `/subscriptions/${args.subscription ?? args.id}`),
    undo: async (e) => {
      const before: any = e.snapshot;
      const body: Record<string, string> = {
        cancel_at_period_end: String(before.cancel_at_period_end),
        proration_behavior: "none",
      };
      before.items.data.forEach((item: any, i: number) => {
        body[`items[${i}][id]`] = item.id;
        body[`items[${i}][price]`] = item.price.id;
        body[`items[${i}][quantity]`] = String(item.quantity ?? 1);
      });
      await stripe("POST", `/subscriptions/${before.id}`, body);
    },
  },
  // Hold refunds and cancellations instead of pretending they can be reversed.
  create_refund: { holdMs: 120_000 },
  cancel_subscription: { holdMs: 120_000 },
};
