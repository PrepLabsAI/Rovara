import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOrdersApplication } from "../server.mjs";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const orders = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/orders.json", import.meta.url)), "utf8"));
// Local parts are distinctive on purpose: a common word such as "owner" would be redacted out of ordinary page text.
const seed = {
  accounts: [
    { email: "kzr41@a.example", passwordDigest: digest("pw-first"), subjectId: "subject-1", tenantId: "tenant-a", role: "owner", displayName: "Owner A" },
    { email: "mvd58@a.example", passwordDigest: digest("pw-second"), subjectId: "subject-2", tenantId: "tenant-a", role: "viewer", displayName: "Viewer A" },
    { email: "jxp23@b.example", passwordDigest: digest("pw-third"), subjectId: "subject-3", tenantId: "tenant-b", role: "owner", displayName: "Owner B" },
  ],
};
const passwords = { "kzr41@a.example": "pw-first", "mvd58@a.example": "pw-second", "jxp23@b.example": "pw-third" };

// The inventory service as its contract describes it: a1 is in stock, a2 is unknown, b1 answers with a malformed status.
async function inventory(originRef, path) {
  const url = new URL(path, "http://inventory.invalid");
  if (originRef !== "inventory-v1") return { status: 599, body: {} };
  if (url.pathname === "/health") return { status: 200, body: { healthy: true } };
  if (url.pathname !== "/v1/stock") return { status: 599, body: {} };
  const orderId = url.searchParams.get("orderId");
  if (orderId === "a1") return { status: 200, body: { status: "in-stock" } };
  if (orderId === "a2") return { status: 404, body: { error: "unknown order" } };
  if (orderId === "b1") return { status: 200, body: { status: 7 } };
  return { status: 599, body: {} };
}
const application = () => createOrdersApplication({ seed, orders, fetchDependency: inventory });

async function login(app, email) {
  const response = await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password: passwords[email] } });
  const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0];
  return { response, headers: { cookie } };
}

test("health reports ready", async () => {
  const response = await application().handle({ method: "GET", url: "/health", headers: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ready" });
});

test("sign-in answers with the display name and role only, and /api/me never returns the email", async () => {
  const app = application();
  const { response, headers } = await login(app, "kzr41@a.example");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { displayName: "Owner A", role: "owner" });
  const me = await app.handle({ method: "GET", url: "/api/me", headers });
  assert.deepEqual(JSON.parse(me.body), { subjectId: "subject-1", tenantId: "tenant-a", role: "owner", displayName: "Owner A" });
  assert.ok(!me.body.includes("kzr41"));
});

test("wrong password is refused", async () => {
  const response = await application().handle({ method: "POST", url: "/api/login", headers: {}, body: { email: "kzr41@a.example", password: "wrong" } });
  assert.equal(response.status, 401);
});

test("an owner downloads their tenant's orders with the inventory column", async () => {
  const app = application();
  const { headers } = await login(app, "kzr41@a.example");
  const response = await app.handle({ method: "GET", url: "/api/orders.csv", headers });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^text\/csv/);
  assert.equal(response.body, "id,customer,total,state,inventory\r\na1,Ada,12.5,ready,in-stock\r\na2,Grace,23,ready,unavailable\r\n");
});

test("a viewer cannot download orders", async () => {
  const app = application();
  const { headers } = await login(app, "mvd58@a.example");
  assert.equal((await app.handle({ method: "GET", url: "/api/orders.csv", headers })).status, 403);
  assert.equal((await app.handle({ method: "GET", url: "/api/orders.csv", headers: {} })).status, 401);
});

test("each tenant only ever sees its own orders", async () => {
  const app = application();
  const { headers: viewer } = await login(app, "mvd58@a.example");
  assert.equal((await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers: viewer })).status, 403);
  const own = await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers: viewer });
  assert.deepEqual(JSON.parse(own.body).orders.map((order) => [order.id, order.inventory]), [["a1", "in-stock"], ["a2", "unavailable"]]);
  const { headers: other } = await login(app, "jxp23@b.example");
  const csv = await app.handle({ method: "GET", url: "/api/orders.csv", headers: other });
  assert.equal(csv.body, "id,customer,total,state,inventory\r\nb1,Lin,99,ready,unavailable\r\n");
  assert.ok(!csv.body.includes("Ada"));
});

test("the orders CSV neutralizes formulas and filters by date", async () => {
  const hostile = { state: orders.state, orders: [
    { id: "a1", tenantId: "tenant-a", customer: "=1+1", total: 1, state: "ready", placedOn: "2026-09-01" },
    { id: "a2", tenantId: "tenant-a", customer: "Grace", total: 2, state: "ready", placedOn: "2026-09-02" },
  ] };
  const app = createOrdersApplication({ seed, orders: hostile, fetchDependency: inventory });
  const { headers } = await login(app, "kzr41@a.example");
  const all = await app.handle({ method: "GET", url: "/api/orders.csv", headers });
  assert.ok(all.body.includes("a1,'=1+1,"));
  const day = await app.handle({ method: "GET", url: "/api/orders.csv?from=2026-09-02&to=2026-09-02", headers });
  assert.equal(day.body, "id,customer,total,state,inventory\r\na2,Grace,2,ready,unavailable\r\n");
  assert.equal((await app.handle({ method: "GET", url: "/api/orders.csv?from=yesterday", headers })).status, 400);
});

test("orders endpoints require a session", async () => {
  const response = await application().handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers: {} });
  assert.equal(response.status, 401);
});

test("the page is rendered for the signed-in account: an owner gets the download buttons and the inventory column, a viewer gets no button", async () => {
  const app = application();
  const { headers: owner } = await login(app, "kzr41@a.example");
  const ownerPage = (await app.handle({ method: "GET", url: "/", headers: owner })).body;
  // The owner's orders button is found by what it downloads, so this holds for the button before and after it is renamed.
  assert.match(ownerPage, /<button[^>]*data-download="\/api\/orders\.csv"/);
  assert.match(ownerPage, /<td>in-stock<\/td>/);
  assert.doesNotMatch(ownerPage, /order-row-b1|kzr41/);
  const { headers: viewer } = await login(app, "mvd58@a.example");
  const viewerPage = (await app.handle({ method: "GET", url: "/", headers: viewer })).body;
  assert.doesNotMatch(viewerPage, /data-download=/);
  assert.match(viewerPage, /data-testid="orders-table"/);
});
