// Undo for Stripe's generic MCP tools (stripe_api_write), where one tool can hit any endpoint.
// We read the method + path the agent called, and pick the reverse from the resource type.
import { resultJson, type Handler } from "./types.js";
import type { Entry } from "../journal.js";

export async function stripeRest(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, string>) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const p = path.startsWith("/v1") ? path : `/v1${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(`https://api.stripe.com${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  return json;
}

// Pull method and path out of the tool arguments, whatever the server calls them.
export function callOf(args: any): { method: string; path: string } | null {
  if (!args || typeof args !== "object") return null;
  const method = String(args.method ?? args.http_method ?? args.verb ?? "POST").toUpperCase();
  let path = args.path ?? args.endpoint ?? args.url ?? args.resource ?? args.operation;
  if (typeof path !== "string") return null;
  path = path.replace(/^https?:\/\/api\.stripe\.com/, "").split("?")[0];
  if (!path.startsWith("/")) path = "/" + path;
  if (!path.startsWith("/v1/")) path = "/v1" + path;
  return { method, path };
}

const createdId = (e: Entry) => {
  const r = resultJson(e);
  const id = r?.id ?? r?.data?.id ?? r?.object?.id;
  if (!id) throw new Error("couldn't find the created object's id in the tool result");
  return id as string;
};

// How each top-level resource is reversed after a create.
const reverseCreate: Record<string, (id: string) => Promise<unknown>> = {
  customers: (id) => stripeRest("DELETE", `/v1/customers/${id}`),
  products: (id) => stripeRest("POST", `/v1/products/${id}`, { active: "false" }),
  prices: (id) => stripeRest("POST", `/v1/prices/${id}`, { active: "false" }),
  payment_links: (id) => stripeRest("POST", `/v1/payment_links/${id}`, { active: "false" }),
  coupons: (id) => stripeRest("DELETE", `/v1/coupons/${id}`),
  invoiceitems: (id) => stripeRest("DELETE", `/v1/invoiceitems/${id}`),
  invoices: async (id) => {
    const inv = await stripeRest("GET", `/v1/invoices/${id}`);
    return inv.status === "draft" ? stripeRest("DELETE", `/v1/invoices/${id}`) : stripeRest("POST", `/v1/invoices/${id}/void`);
  },
};

// Fields we can safely write back when restoring an updated object.
const restorable = ["name", "email", "description", "active", "metadata", "cancel_at_period_end", "phone"];

function flatten(obj: any, prefix = "", out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (v !== null && v !== undefined) out[key] = String(v);
  }
  return out;
}

// Endpoints whose effects leave Stripe (money moves): hold them instead of pretending to undo.
const HOLD = /\/(refunds|payouts|transfers)$|\/(cancel|pay|send|finalize)$/;

export function stripeApiHandler(args: any): Handler {
  const call = callOf(args);
  if (!call) return { irreversible: "couldn't read which Stripe endpoint this write hit" };
  const parts = call.path.split("/").filter(Boolean); // ["v1","customers","cus_123"]
  const resource = parts[1];

  if (HOLD.test(call.path) || (call.method === "DELETE" && resource === "subscriptions")) return { holdMs: 120_000 };

  // Create: POST /v1/<resource>
  if (call.method === "POST" && parts.length === 2) {
    const reverse = reverseCreate[resource];
    if (!reverse) return { irreversible: `no undo for creating ${resource} yet` };
    return { undo: async (e) => { await reverse(createdId(e)); } };
  }

  // Update: POST /v1/<resource>/<id>  -> snapshot first, write the old values back
  if (call.method === "POST" && parts.length === 3) {
    const path = call.path;
    return {
      before: () => stripeRest("GET", path),
      undo: async (e) => {
        const before: any = e.snapshot;
        if (!before) throw new Error("no snapshot was captured before this update");
        const body: Record<string, string> = {};
        for (const f of restorable) if (f in before) Object.assign(body, flatten({ [f]: before[f] }));
        await stripeRest("POST", path, body);
      },
    };
  }

  if (call.method === "DELETE") return { irreversible: `deleting ${resource} can't be reversed in Stripe` };
  return { irreversible: `no undo for ${call.method} ${call.path} yet` };
}
