// Undo for Stripe's hosted MCP tool stripe_api_write.
// It takes { stripe_api_operation_id, parameters, stripe_context?, livemode? } and can hit any write endpoint,
// so yard doesn't rely on operation names. It works from what it can see:
//   before the call  -> snapshot every existing Stripe object referenced in the parameters
//   after the call   -> the response says which object was written; if yard snapshotted it,
//                       it was an update (restore the fields the agent changed), otherwise a create (reverse it)
//   can't be undone  -> deletes, cancels, voids, finalizes, payments: held so undo means "never happened"
import { resultJson, type Handler } from "./types.js";
import type { Entry } from "../journal.js";

const apiKey = () => process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY ?? process.env.STRIPE_AGENT_KEY;

export async function stripeRest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, string>,
  account?: string,
) {
  const key = apiKey();
  if (!key) throw new Error("set STRIPE_SECRET_KEY (or STRIPE_AGENT_KEY) so yard can call Stripe");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
  if (account?.startsWith("acct_")) headers["Stripe-Account"] = account;
  const res = await fetch(`https://api.stripe.com/v1/${path.replace(/^\/?(v1\/)?/, "")}`, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  return json;
}

// Where each kind of object lives in the REST API, by id prefix and by object type.
const BY_PREFIX: [string, string][] = [
  ["cus_", "customers"], ["prod_", "products"], ["price_", "prices"], ["plink_", "payment_links"],
  ["sub_", "subscriptions"], ["in_", "invoices"], ["ii_", "invoiceitems"], ["promo_", "promotion_codes"],
  ["we_", "webhook_endpoints"], ["cs_", "checkout/sessions"], ["bpc_", "billing_portal/configurations"],
  ["pmd_", "payment_method_domains"], ["dp_", "disputes"], ["clock_", "test_helpers/test_clocks"],
  ["taxreg_", "tax/registrations"],
];
const BY_TYPE: Record<string, string> = {
  customer: "customers", product: "products", price: "prices", payment_link: "payment_links",
  subscription: "subscriptions", invoice: "invoices", invoiceitem: "invoiceitems", promotion_code: "promotion_codes",
  webhook_endpoint: "webhook_endpoints", "checkout.session": "checkout/sessions", coupon: "coupons",
  "billing_portal.configuration": "billing_portal/configurations", payment_method_domain: "payment_method_domains",
  "test_helpers.test_clock": "test_helpers/test_clocks", "tax.registration": "tax/registrations",
};
const collectionFor = (id: string) => BY_PREFIX.find(([p]) => id.startsWith(p))?.[1];

// How to reverse a create, by object type.
const REVERSE_CREATE: Record<string, (id: string, acct?: string) => Promise<unknown>> = {
  customer: (id, a) => stripeRest("DELETE", `customers/${id}`, undefined, a),
  coupon: (id, a) => stripeRest("DELETE", `coupons/${id}`, undefined, a),
  invoiceitem: (id, a) => stripeRest("DELETE", `invoiceitems/${id}`, undefined, a),
  webhook_endpoint: (id, a) => stripeRest("DELETE", `webhook_endpoints/${id}`, undefined, a),
  "test_helpers.test_clock": (id, a) => stripeRest("DELETE", `test_helpers/test_clocks/${id}`, undefined, a),
  product: (id, a) => stripeRest("POST", `products/${id}`, { active: "false" }, a),
  price: (id, a) => stripeRest("POST", `prices/${id}`, { active: "false" }, a),
  payment_link: (id, a) => stripeRest("POST", `payment_links/${id}`, { active: "false" }, a),
  promotion_code: (id, a) => stripeRest("POST", `promotion_codes/${id}`, { active: "false" }, a),
  "billing_portal.configuration": (id, a) => stripeRest("POST", `billing_portal/configurations/${id}`, { active: "false" }, a),
  payment_method_domain: (id, a) => stripeRest("POST", `payment_method_domains/${id}`, { enabled: "false" }, a),
  "checkout.session": (id, a) => stripeRest("POST", `checkout/sessions/${id}/expire`, undefined, a),
  "tax.registration": (id, a) => stripeRest("POST", `tax/registrations/${id}`, { expires_at: "now" }, a),
  // Cancels it. Any first payment it already collected is not refunded.
  subscription: (id, a) => stripeRest("DELETE", `subscriptions/${id}`, undefined, a),
  invoice: async (id, a) => {
    const inv = await stripeRest("GET", `invoices/${id}`, undefined, a);
    if (inv.status === "draft") return stripeRest("DELETE", `invoices/${id}`, undefined, a);
    if (inv.status === "open") return stripeRest("POST", `invoices/${id}/void`, undefined, a);
    throw new Error(`invoice is already ${inv.status}; it can't be reversed`);
  },
};

// Operations Stripe itself can't take back. yard holds them instead.
const HOLD_OP = /(delete|\bdel\b|cancel|void|finalize|pay$|_pay|send|close|uncollectible|expire|reject|submit)/i;
// Money movement Stripe already gates behind a human confirmation in the Dashboard.
const STRIPE_CONFIRMS = /(refund|payout|transfer)/i;

const looksLikeId = (v: unknown): v is string => typeof v === "string" && /^[a-z]{2,8}_[A-Za-z0-9]{6,}/.test(v);

// Every Stripe object id mentioned at the top level of the parameters.
function referencedIds(params: any): string[] {
  return Object.values(params ?? {}).filter(looksLikeId).filter((id) => collectionFor(id));
}

function flatten(value: unknown, key: string, out: Record<string, string>) {
  if (value === null || value === undefined) { out[key] = ""; return; }
  if (Array.isArray(value)) {
    if (!value.length) { out[key] = ""; return; }
    value.forEach((v, i) => flatten(v, `${key}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, `${key}[${k}]`, out);
    return;
  }
  out[key] = String(value);
}

// Build the request that puts back exactly the fields the agent changed.
async function restoreBody(target: string, before: any, params: any, acct?: string): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const changed = Object.keys(params ?? {}).filter((k) => params[k] !== target && !["expand", "stripe_context"].includes(k));
  for (const k of changed) {
    if (k === "metadata" && params.metadata && typeof params.metadata === "object") {
      for (const mk of Object.keys(params.metadata)) body[`metadata[${mk}]`] = before.metadata?.[mk] ?? "";
      continue;
    }
    if (k === "items" && target.startsWith("sub_")) {
      // Put the old items back and remove any the agent added.
      const now = await stripeRest("GET", `subscriptions/${target}`, undefined, acct);
      const oldItems: any[] = before.items?.data ?? [];
      let i = 0;
      for (const item of oldItems) {
        body[`items[${i}][id]`] = item.id;
        body[`items[${i}][price]`] = item.price.id;
        body[`items[${i}][quantity]`] = String(item.quantity ?? 1);
        i++;
      }
      for (const item of now.items?.data ?? []) {
        if (!oldItems.some((o) => o.id === item.id)) {
          body[`items[${i}][id]`] = item.id;
          body[`items[${i}][deleted]`] = "true";
          i++;
        }
      }
      body.proration_behavior = "none";
      continue;
    }
    if (!(k in before)) continue; // not a field on the object (a flag like proration_behavior)
    flatten(before[k], k, body);
  }
  return body;
}

export function stripeApiHandler(args: any): Handler {
  const op = String(args?.stripe_api_operation_id ?? args?.operation_id ?? args?.operation ?? "");
  const params = args?.parameters ?? {};
  const acct: string | undefined = args?.stripe_context;

  if (STRIPE_CONFIRMS.test(op)) {
    return { irreversible: "money movement; Stripe asks a human to confirm these in the Dashboard" };
  }
  if (HOLD_OP.test(op)) return { holdMs: 120_000 };

  return {
    before: async () => {
      const snaps: Record<string, unknown> = {};
      for (const id of referencedIds(params)) {
        try { snaps[id] = await stripeRest("GET", `${collectionFor(id)}/${id}`, undefined, acct); }
        catch { /* not readable: fine, it may be a reference we don't need */ }
      }
      return snaps;
    },
    undo: async (entry: Entry) => {
      const r = resultJson(entry);
      const id: string | undefined = r?.id;
      if (!id) throw new Error("couldn't find which Stripe object this wrote in the response");
      if (r.deleted) throw new Error(`${id} was deleted; Stripe can't restore deleted objects`);

      const snaps = (entry.snapshot ?? {}) as Record<string, any>;
      if (snaps[id]) {
        const body = await restoreBody(id, snaps[id], params, acct);
        if (!Object.keys(body).length) return;
        const coll = collectionFor(id) ?? BY_TYPE[r.object];
        if (!coll) throw new Error(`don't know where ${id} lives in the API`);
        await stripeRest("POST", `${coll}/${id}`, body, acct);
        return;
      }

      const reverse = REVERSE_CREATE[r.object];
      if (!reverse) throw new Error(`no undo for creating a ${r.object ?? "this kind of object"} yet`);
      await reverse(id, acct);
    },
  };
}
