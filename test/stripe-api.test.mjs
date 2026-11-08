// Checks the stripe_api_write undo logic against a mocked Stripe REST API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.YARD_HOME = mkdtempSync(join(tmpdir(), "yard-"));
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
const { stripeApiHandler } = await import("../dist/handlers/stripe-api.js");

// Fake Stripe: records every request, answers from a table of objects.
let calls = [];
let objects = {};
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname.replace("/v1/", "");
  const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
  calls.push({ method: init.method, path, body, account: init.headers["Stripe-Account"] });
  const id = path.split("/")[1];
  const obj = objects[id];
  if (init.method === "GET" && !obj) return { ok: false, json: async () => ({ error: { message: "No such object" } }) };
  return { ok: true, json: async () => obj ?? { id, deleted: init.method === "DELETE" } };
};
const reset = (objs = {}) => { calls = []; objects = objs; };
const toolResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const entry = (args, snapshot, obj) => ({ args, snapshot, result: toolResult(obj) });

test("create customer -> undo deletes it", async () => {
  reset();
  const args = { stripe_api_operation_id: "PostCustomers", parameters: { name: "Yard Test", email: "test@getyard.dev" } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.deepEqual(snap, {});
  await h.undo(entry(args, snap, { id: "cus_VaZ8N5lZrWHBVn", object: "customer", name: "[redacted]" }));
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: "customers/cus_VaZ8N5lZrWHBVn", body: undefined, account: undefined });
});

test("create product -> undo archives it (works with any operation id format)", async () => {
  reset();
  const args = { stripe_api_operation_id: "products.create", parameters: { name: "Yard Pro" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, await h.before(args), { id: "prod_VaZ89xpaSO44va", object: "product" }));
  assert.equal(calls.at(-1).path, "products/prod_VaZ89xpaSO44va");
  assert.deepEqual(calls.at(-1).body, { active: "false" });
});

test("update customer -> undo restores exactly the changed fields", async () => {
  reset({ cus_A1234567: { id: "cus_A1234567", object: "customer", email: "old@x.co", name: "Old", metadata: { keep: "1" } } });
  const args = { stripe_api_operation_id: "PostCustomersCustomer", parameters: { customer: "cus_A1234567", email: "new@x.co", metadata: { tier: "pro" } } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.ok(snap.cus_A1234567, "snapshot taken before the write");
  await h.undo(entry(args, snap, { id: "cus_A1234567", object: "customer" }));
  const last = calls.at(-1);
  assert.equal(last.method, "POST");
  assert.equal(last.path, "customers/cus_A1234567");
  assert.deepEqual(last.body, { email: "old@x.co", "metadata[tier]": "" });
});

test("create invoice for an existing customer -> undo deletes the draft, leaves the customer alone", async () => {
  reset({ cus_A1234567: { id: "cus_A1234567", object: "customer" }, in_B1234567: { id: "in_B1234567", object: "invoice", status: "draft" } });
  const args = { stripe_api_operation_id: "PostInvoices", parameters: { customer: "cus_A1234567" } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  await h.undo(entry(args, snap, { id: "in_B1234567", object: "invoice", status: "draft" }));
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: "invoices/in_B1234567", body: undefined, account: undefined });
  assert.ok(!calls.some((c) => c.method !== "GET" && c.path.startsWith("customers/")));
});

test("subscription item change -> undo restores old items and removes added ones", async () => {
  const before = { id: "sub_C1234567", object: "subscription", items: { data: [{ id: "si_old", price: { id: "price_basic" }, quantity: 1 }] } };
  reset({ sub_C1234567: before });
  const args = { stripe_api_operation_id: "PostSubscriptionsSubscriptionExposedId", parameters: { subscription_exposed_id: "sub_C1234567", items: [{ price: "price_pro" }] } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  objects.sub_C1234567 = { ...before, items: { data: [{ id: "si_old", price: { id: "price_basic" } }, { id: "si_new", price: { id: "price_pro" } }] } };
  await h.undo(entry(args, snap, { id: "sub_C1234567", object: "subscription" }));
  assert.deepEqual(calls.at(-1).body, {
    "items[0][id]": "si_old", "items[0][price]": "price_basic", "items[0][quantity]": "1",
    "items[1][id]": "si_new", "items[1][deleted]": "true", proration_behavior: "none",
  });
});

test("connected account calls carry the Stripe-Account header", async () => {
  reset();
  const args = { stripe_api_operation_id: "PostCustomers", stripe_context: "acct_123456789", parameters: { name: "x" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, {}, { id: "cus_Z1234567", object: "customer" }));
  assert.equal(calls.at(-1).account, "acct_123456789");
});

test("irreversible operations are held, money moves are left to Stripe's own confirmation", () => {
  for (const op of ["DeleteCustomersCustomer", "PostInvoicesInvoiceFinalize", "PostInvoicesInvoiceVoid", "DeleteSubscriptionsSubscriptionExposedId", "PostInvoicesInvoicePay", "PostCheckoutSessionsSessionExpire"]) {
    assert.ok(stripeApiHandler({ stripe_api_operation_id: op }).holdMs, `${op} should be held`);
  }
  for (const op of ["PostRefunds", "PostPayouts", "PostTransfers"]) {
    assert.ok(stripeApiHandler({ stripe_api_operation_id: op }).irreversible, `${op} should be journal-only`);
  }
});

test("undo explains itself when it can't act", async () => {
  reset();
  const args = { stripe_api_operation_id: "PostSomethingNew", parameters: {} };
  const h = stripeApiHandler(args);
  await assert.rejects(h.undo(entry(args, {}, { id: "xyz_1234567890", object: "brand_new_thing" })), /no undo for creating a brand_new_thing/);
  await assert.rejects(h.undo({ args, snapshot: {}, result: { content: [{ type: "text", text: "ok" }] } }), /couldn't find which Stripe object/);
});
