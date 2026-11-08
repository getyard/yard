// Checks the stripe_api_write undo logic against a mocked Stripe REST API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.YARD_HOME = mkdtempSync(join(tmpdir(), "yard-"));
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
const { stripeApiHandler } = await import("../dist/handlers/stripe-api.js");

const now = () => Math.floor(Date.now() / 1000);

// Fake Stripe: records every request, answers from a table of objects.
let calls = [];
let objects = {};
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname.replace("/v1/", "");
  const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
  calls.push({ method: init.method, path, body, account: init.headers["Stripe-Account"] });
  const id = path.split("/").at(-1) === "expire" ? path.split("/").at(-2) : path.split("/").at(-1);
  const obj = objects[id];
  if (init.method === "GET" && !obj) return { ok: false, json: async () => ({ error: { message: `No such object: '${id}'` } }) };
  if (init.method === "DELETE") return { ok: true, json: async () => ({ id, deleted: true }) };
  return { ok: true, json: async () => obj ?? { id } };
};
const reset = (objs = {}) => { calls = []; objects = objs; };
const toolResult = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });
const entry = (args, snapshot, obj) => ({ args, snapshot, result: toolResult(obj), ts: new Date().toISOString(), firstTs: new Date().toISOString() });
const writes = () => calls.filter((c) => c.method !== "GET");

test("create customer -> undo deletes it", async () => {
  reset({ cus_VaZQqBXv9QPE3D: { id: "cus_VaZQqBXv9QPE3D", object: "customer", created: now() } });
  const args = { stripe_api_operation_id: "PostCustomers", parameters: { name: "Yard Test", email: "test@getyard.dev" } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.deepEqual(snap, {});
  await h.undo(entry(args, snap, { id: "cus_VaZQqBXv9QPE3D", object: "customer", name: "[redacted]" }));
  assert.deepEqual(writes(), [{ method: "DELETE", path: "customers/cus_VaZQqBXv9QPE3D", body: undefined, account: undefined }]);
});

test("create product -> undo archives it (works with any operation id format)", async () => {
  reset({ prod_ZQKU5JPxgAFb: { id: "prod_ZQKU5JPxgAFb", object: "product", created: now() } });
  const args = { stripe_api_operation_id: "products.create", parameters: { name: "Yard Pro" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, await h.before(args), { id: "prod_ZQKU5JPxgAFb", object: "product" }));
  assert.deepEqual(writes(), [{ method: "POST", path: "products/prod_ZQKU5JPxgAFb", body: { active: "false" }, account: undefined }]);
});

test("create price for an existing product -> undo archives the price only", async () => {
  reset({
    prod_ZQKU5JPxgAFb: { id: "prod_ZQKU5JPxgAFb", object: "product", created: now() - 86400 },
    price_1UZOHwGwQijk1VjqTiKccujW: { id: "price_1UZOHwGwQijk1VjqTiKccujW", object: "price", created: now() },
  });
  const args = { stripe_api_operation_id: "PostPrices", parameters: { product: "prod_ZQKU5JPxgAFb", unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.ok(snap.prod_ZQKU5JPxgAFb, "the referenced product is snapshotted");
  await h.undo(entry(args, snap, { id: "price_1UZOHwGwQijk1VjqTiKccujW", object: "price" }));
  assert.deepEqual(writes(), [{ method: "POST", path: "prices/price_1UZOHwGwQijk1VjqTiKccujW", body: { active: "false" }, account: undefined }]);
});

test("update customer -> undo restores exactly the changed fields", async () => {
  reset({ cus_A1234567: { id: "cus_A1234567", object: "customer", email: "old@x.co", name: "Old", metadata: { keep: "1" }, created: now() - 86400 } });
  const args = { stripe_api_operation_id: "PostCustomersCustomer", parameters: { customer: "cus_A1234567", email: "new@x.co", metadata: { tier: "pro" } } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.ok(snap.cus_A1234567, "snapshot taken before the write");
  await h.undo(entry(args, snap, { id: "cus_A1234567", object: "customer" }));
  assert.deepEqual(writes(), [{ method: "POST", path: "customers/cus_A1234567", body: { email: "old@x.co", "metadata[tier]": "" }, account: undefined }]);
});

test("update with grouped parameters ({ path, body }) -> still snapshots and restores", async () => {
  reset({ cus_A1234567: { id: "cus_A1234567", object: "customer", email: "old@x.co", created: now() - 86400 } });
  const args = { stripe_api_operation_id: "PostCustomersCustomer", parameters: { path: { customer: "cus_A1234567" }, body: { email: "new@x.co" } } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  assert.ok(snap.cus_A1234567);
  await h.undo(entry(args, snap, { id: "cus_A1234567", object: "customer" }));
  assert.deepEqual(writes(), [{ method: "POST", path: "customers/cus_A1234567", body: { email: "old@x.co" }, account: undefined }]);
});

test("SAFETY: an existing customer is never deleted, even if yard missed its snapshot", async () => {
  reset({ cus_OLD12345: { id: "cus_OLD12345", object: "customer", created: now() - 30 * 86400 } });
  const args = { stripe_api_operation_id: "PostCustomersCustomer", parameters: { weird_shape: { deep: { deeper: { deepest: { too_deep: "cus_OLD12345" } } } }, email: "x@y.z" } };
  const h = stripeApiHandler(args);
  // Simulate a write whose target yard couldn't find in the parameters: no snapshot.
  await assert.rejects(h.undo(entry(args, {}, { id: "cus_OLD12345", object: "customer" })), /no snapshot of cus_OLD12345|existed before this action/);
  assert.deepEqual(writes(), [], "nothing was written to Stripe");
});

test("SAFETY: an old customer returned by a write that didn't name it is still never deleted", async () => {
  reset({ cus_OLD12345: { id: "cus_OLD12345", object: "customer", created: now() - 30 * 86400 } });
  const args = { stripe_api_operation_id: "PostSomething", parameters: { email: "x@y.z" } };
  const h = stripeApiHandler(args);
  await assert.rejects(h.undo(entry(args, {}, { id: "cus_OLD12345", object: "customer" })), /existed before this action/);
  assert.deepEqual(writes(), []);
});

test("SAFETY: undoing only a later update never deletes an object an earlier step created", async () => {
  reset({ cus_NEW12345: { id: "cus_NEW12345", object: "customer", created: now() } });
  const args = { stripe_api_operation_id: "PostCustomersCustomer", parameters: { body: { email: "x@y.z" }, path: { customer: "cus_NEW12345" } } };
  const h = stripeApiHandler(args);
  await assert.rejects(h.undo(entry(args, {}, { id: "cus_NEW12345", object: "customer" })), /no snapshot of cus_NEW12345/);
  assert.deepEqual(writes(), []);
});

test("response without JSON -> object type comes from the id prefix", async () => {
  reset({ cus_TEXT1234: { id: "cus_TEXT1234", object: "customer", created: now() } });
  const args = { stripe_api_operation_id: "PostCustomers", parameters: { name: "x" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, {}, "Successfully created customer cus_TEXT1234"));
  assert.deepEqual(writes(), [{ method: "DELETE", path: "customers/cus_TEXT1234", body: undefined, account: undefined }]);
});

test("already deleted -> undo is a no-op, not an error", async () => {
  reset();
  const args = { stripe_api_operation_id: "PostCustomers", parameters: { name: "x" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, {}, { id: "cus_GONE1234", object: "customer" }));
  assert.deepEqual(writes(), []);
});

test("create invoice for an existing customer -> undo deletes the draft, leaves the customer alone", async () => {
  reset({ cus_A1234567: { id: "cus_A1234567", object: "customer", created: now() - 86400 }, in_B1234567: { id: "in_B1234567", object: "invoice", status: "draft", created: now() } });
  const args = { stripe_api_operation_id: "PostInvoices", parameters: { customer: "cus_A1234567" } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  await h.undo(entry(args, snap, { id: "in_B1234567", object: "invoice", status: "draft" }));
  assert.deepEqual(writes(), [{ method: "DELETE", path: "invoices/in_B1234567", body: undefined, account: undefined }]);
});

test("subscription item change -> undo restores old items and removes added ones", async () => {
  const before = { id: "sub_C1234567", object: "subscription", created: now() - 86400, items: { data: [{ id: "si_old", price: { id: "price_basic" }, quantity: 1 }] } };
  reset({ sub_C1234567: before });
  const args = { stripe_api_operation_id: "PostSubscriptionsSubscriptionExposedId", parameters: { subscription_exposed_id: "sub_C1234567", items: [{ price: "price_pro" }] } };
  const h = stripeApiHandler(args);
  const snap = await h.before(args);
  objects.sub_C1234567 = { ...before, items: { data: [{ id: "si_old", price: { id: "price_basic" } }, { id: "si_new", price: { id: "price_pro" } }] } };
  await h.undo(entry(args, snap, { id: "sub_C1234567", object: "subscription" }));
  assert.deepEqual(writes().at(-1).body, {
    "items[0][id]": "si_old", "items[0][price]": "price_basic", "items[0][quantity]": "1",
    "items[1][id]": "si_new", "items[1][deleted]": "true", proration_behavior: "none",
  });
});

test("connected account calls carry the Stripe-Account header", async () => {
  reset({ cus_Z1234567: { id: "cus_Z1234567", object: "customer", created: now() } });
  const args = { stripe_api_operation_id: "PostCustomers", stripe_context: "acct_123456789", parameters: { name: "x" } };
  const h = stripeApiHandler(args);
  await h.undo(entry(args, {}, { id: "cus_Z1234567", object: "customer" }));
  assert.equal(writes().at(-1).account, "acct_123456789");
});

test("irreversible operations are held, money moves are left to Stripe's own confirmation", () => {
  for (const op of ["DeleteCustomersCustomer", "PostInvoicesInvoiceFinalize", "PostInvoicesInvoiceVoid", "DeleteSubscriptionsSubscriptionExposedId", "PostInvoicesInvoicePay", "PostCheckoutSessionsSessionExpire"]) {
    assert.ok(stripeApiHandler({ stripe_api_operation_id: op }).holdMs, `${op} should be held`);
  }
  for (const op of ["PostRefunds", "PostPayouts", "PostTransfers"]) {
    assert.ok(stripeApiHandler({ stripe_api_operation_id: op }).irreversible, `${op} should be journal-only`);
  }
  for (const op of ["PostCustomers", "PostCustomersCustomer", "PostProducts", "PostPrices", "PostPaymentLinks"]) {
    assert.ok(!stripeApiHandler({ stripe_api_operation_id: op }).holdMs, `${op} should not be held`);
  }
});

test("undo explains itself when it can't act", async () => {
  reset();
  const args = { stripe_api_operation_id: "PostSomethingNew", parameters: {} };
  const h = stripeApiHandler(args);
  await assert.rejects(h.undo(entry(args, {}, { id: "xyz_1234567890", object: "brand_new_thing" })), /no undo for creating a brand_new_thing/);
  await assert.rejects(h.undo({ args, snapshot: {}, result: toolResult("ok"), ts: new Date().toISOString() }), /couldn't find which Stripe object/);
});
