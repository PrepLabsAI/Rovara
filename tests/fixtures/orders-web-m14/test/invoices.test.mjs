// Local Linux fixture only: the decoy invoices download. The live baseline does not carry this file or the route.
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
    { email: "kzr41@a.example", passwordDigest: digest("pw-first"), subjectId: "subject-1", tenantId: "tenant-a", role: "owner", displayName: "Owner A" },
    { email: "mvd58@a.example", passwordDigest: digest("pw-second"), subjectId: "subject-2", tenantId: "tenant-a", role: "viewer", displayName: "Viewer A" },
  ],
};

async function login(app, email, password) {
  const response = await app.handle({ method: "POST", url: "/api/login", headers: {}, body: { email, password } });
  return { cookie: String(response.headers["set-cookie"] ?? "").split(";")[0] };
}

test("the invoices download is a different CSV from the orders download", async () => {
  const app = createOrdersApplication({ seed, orders });
  const headers = await login(app, "kzr41@a.example", "pw-first");
  const invoices = await app.handle({ method: "GET", url: "/api/invoices.csv", headers });
  const ordersCsv = await app.handle({ method: "GET", url: "/api/orders.csv", headers });
  assert.equal(invoices.status, 200);
  assert.match(invoices.headers["content-disposition"], /invoices\.csv/);
  assert.equal(invoices.body, "invoice,customer,amount,status\r\ninv-a1,Ada,12.5,paid\r\ninv-a2,Grace,23,paid\r\n");
  assert.notEqual(invoices.body, ordersCsv.body);
});

test("a viewer cannot download invoices", async () => {
  const app = createOrdersApplication({ seed, orders });
  const headers = await login(app, "mvd58@a.example", "pw-second");
  assert.equal((await app.handle({ method: "GET", url: "/api/invoices.csv", headers })).status, 403);
  assert.equal((await app.handle({ method: "GET", url: "/api/invoices.csv", headers: {} })).status, 401);
});
