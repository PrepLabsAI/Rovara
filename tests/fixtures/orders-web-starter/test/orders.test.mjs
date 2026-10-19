import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOrdersApplication } from "../server.mjs";

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const orders = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/orders.json", import.meta.url)), "utf8"));
const seed = {
  accounts: [
    { email: "owner@a.test", passwordDigest: digest("owner-pass"), subjectId: "owner-a", tenantId: "tenant-a", role: "owner", displayName: "Owner A" },
    { email: "viewer@a.test", passwordDigest: digest("viewer-pass"), subjectId: "viewer-a", tenantId: "tenant-a", role: "viewer", displayName: "Viewer A" },
  ],
};

async function login(app, email, password) {
  const response = await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password } });
  const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0];
  return { response, headers: { cookie } };
}

test("health reports ready", async () => {
  const app = createOrdersApplication({ seed, orders });
  const response = await app.handle({ method: "GET", url: "/health", headers: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ready" });
});

test("owner can sign in and list tenant-a orders", async () => {
  const app = createOrdersApplication({ seed, orders });
  const { response, headers } = await login(app, "owner@a.test", "owner-pass");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { displayName: "Owner A", role: "owner" });
  const list = await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body).orders.map((order) => order.id), ["a1", "a2"]);
});

test("wrong password is refused", async () => {
  const app = createOrdersApplication({ seed, orders });
  const { response } = await login(app, "owner@a.test", "not-the-password");
  assert.equal(response.status, 401);
});

test("viewer cannot see other tenants", async () => {
  const app = createOrdersApplication({ seed, orders });
  const { headers } = await login(app, "viewer@a.test", "viewer-pass");
  const own = await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers });
  assert.equal(own.status, 200);
  const other = await app.handle({ method: "GET", url: "/api/tenants/tenant-b/orders", headers });
  assert.equal(other.status, 403);
  assert.ok(!other.body.includes("Lin"));
});

test("orders endpoints require a session", async () => {
  const app = createOrdersApplication({ seed, orders });
  const response = await app.handle({ method: "GET", url: "/api/tenants/tenant-a/orders", headers: {} });
  assert.equal(response.status, 401);
});
