// The deployed gateway process with the product route configured (B5, B6, B8, #57, #58): settings all-or-none, and a started
// process that serves a product call on the project's own key from the DynamoDB key table (sealed with the configured KMS key),
// holds and settles it on the product meter's own tables AND the agent meter's company row (one combined cap), and serves an eval
// stage from the shared stage table. Off unless configured: without the settings every product path is 404.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { randomBytes, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_ENV, GATEWAY_LEARNING_ENV, GATEWAY_PRODUCT_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { EVAL_AUTHORITY_AUDIENCE, EVAL_AUTHORITY_PATH, storedApproverOf } from "../../packages/model-gateway/src/eval-authority.js";
import { EVAL_CAP_AUDIENCE, EVAL_CAP_PATH } from "../../packages/model-gateway/src/eval-cap.js";
import { COMPANY_INSTRUCTIONS_AUDIENCE, COMPANY_INSTRUCTIONS_PATH } from "../../packages/model-gateway/src/company-instructions.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { DynamoProductKeyTable } from "../../packages/model-gateway/src/dynamo-product-keys.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { ProductKeyStore } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, kmsProductKeyService, localProductKeyService, ProductKeySealer, type KmsLike } from "../../packages/model-gateway/src/product-seal.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { caps, claims, jwk, keys, kid, mint, now, scope as agentScope } from "./model-gateway-fixture.js";
import { geminiAnswer, geminiBody, geminiKey, maintainer, pid, productScope, streamPath } from "./model-gateway-product-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000";
const VERTEX_ROLE = "arn:aws:iam::123456789012:role/rovara-cloud-staging-gateway-VertexFederationRole-ABC";
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const PRODUCT = { keys: "gw-product-keys", meter: "gw-pmeter", ledger: "gw-pledger", markers: "gw-pmarkers", stages: "gw-stages" };
const LEARNING = { meter: "gw-lmeter", ledger: "gw-lledger", markers: "gw-lmarkers" };
const BASE = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: PRODUCT.keys, [GATEWAY_ENV.productKeysKey]: KEY_ARN, [GATEWAY_ENV.productMeterTable]: PRODUCT.meter,
  [GATEWAY_ENV.productLedgerTable]: PRODUCT.ledger, [GATEWAY_ENV.productMarkersTable]: PRODUCT.markers, [GATEWAY_ENV.evalStagesTable]: PRODUCT.stages,
};
const MAC_KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-0000000000aa";
const LEARNING_ENV = { [GATEWAY_ENV.learningMeterTable]: LEARNING.meter, [GATEWAY_ENV.learningLedgerTable]: LEARNING.ledger, [GATEWAY_ENV.learningMarkersTable]: LEARNING.markers };

/** A KMS that wraps data keys with an in-memory key, bound to the encryption context, and names the key it was given. */
function fakeKms(): KmsLike & { keyIds: string[] } {
  const local = localProductKeyService(randomBytes(32)); const keyIds: string[] = [];
  return {
    keyIds,
    async generateDataKey(input) { keyIds.push(input.KeyId); const made = await local.generateDataKey(input.EncryptionContext); return { Plaintext: made.plaintext, CiphertextBlob: made.wrapped }; },
    async decrypt(input) { keyIds.push(input.KeyId); return { Plaintext: await local.unwrapDataKey(input.CiphertextBlob, input.EncryptionContext) }; },
  };
}
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("close"); return this; }
  destroy() { this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
function request(server: RunningGateway["server"], url: string, body: unknown, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": mint(), ...headers } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("deployed product settings: off unless configured, all or none", () => {
  it("reads the product, learning and Vertex settings only together, refusing a partial set by the missing name", () => {
    expect(readGatewayConfig(BASE)).not.toHaveProperty("product");
    const config = readGatewayConfig({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE }) as ServeConfig;
    expect(config.product).toEqual({ keysTable: PRODUCT.keys, keysKeyArn: KEY_ARN, meter: PRODUCT.meter, ledger: PRODUCT.ledger, markers: PRODUCT.markers, stages: PRODUCT.stages, vertexFederationRoleArn: VERTEX_ROLE });
    expect(config.learning).toEqual(LEARNING);
    const refusedBy = (env: Record<string, string | undefined>) => { try { readGatewayConfig(env); return undefined; } catch (e) { return e instanceof GatewayConfigError ? e.variable : "other"; } };
    for (const name of GATEWAY_PRODUCT_ENV) expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [name]: undefined })).toBe(name);
    for (const name of GATEWAY_LEARNING_ENV) expect(refusedBy({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [name]: undefined })).toBe(name);
    expect(refusedBy({ ...BASE, ...LEARNING_ENV })).toBe(GATEWAY_ENV.productKeysTable);
    expect(refusedBy({ ...BASE, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE })).toBe(GATEWAY_ENV.productKeysTable);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.productKeysKey]: "alias/product" })).toBe(GATEWAY_ENV.productKeysKey);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.vertexFederationRole]: "arn:aws:iam::123456789012:role/*" })).toBe(GATEWAY_ENV.vertexFederationRole);
    // PRODUCT-VERTEX-CLOUD-CONNECT: the MAC key that verifies Cloud's calls, only with the product route AND Vertex.
    expect((readGatewayConfig({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE, [GATEWAY_ENV.productMacKey]: MAC_KEY_ARN }) as ServeConfig).product?.macKeyArn).toBe(MAC_KEY_ARN);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.productMacKey]: MAC_KEY_ARN })).toBe(GATEWAY_ENV.productMacKey);
    expect(refusedBy({ ...BASE, [GATEWAY_ENV.productMacKey]: MAC_KEY_ARN })).toBe(GATEWAY_ENV.productKeysTable);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE, [GATEWAY_ENV.productMacKey]: "alias/mac" })).toBe(GATEWAY_ENV.productMacKey);
    // No two settings may name the same table (two meters on one table would share rows).
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, [GATEWAY_ENV.productMeterTable]: TABLES.meter })).toBe(GATEWAY_ENV.productMeterTable);
    expect(refusedBy({ ...BASE, ...PRODUCT_ENV, ...LEARNING_ENV, [GATEWAY_ENV.learningMeterTable]: PRODUCT.meter })).toBe(GATEWAY_ENV.learningMeterTable);
  });
});

describe("deployed product route (started process)", () => {
  async function started(options: { product: boolean; env?: Record<string, string>; verifyMac?: () => Promise<boolean>; companyCaps?: boolean }) {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(PRODUCT), ...Object.values(LEARNING)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const kms = Object.assign(fakeKms(), options.verifyMac === undefined ? {} : { verifyMac: options.verifyMac });
    const key = geminiKey();
    // Cloud's settings route connected the project's key (same table, same KMS key).
    const writer = new ProductKeyStore({ table: new DynamoProductKeyTable(db, PRODUCT.keys), sealer: new ProductKeySealer(kmsProductKeyService(kms, KEY_ARN)), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => now });
    await writer.connect({ iss: claims.iss, cid: claims.cid, owner: pid, requestId: randomUUID(), expectedRevision: 0, actor: maintainer, sourceId: "src_gem", provider: "gemini", key });
    const sent: ProviderRequest[] = [];
    const config = { ...(readGatewayConfig({ ...BASE, ...(options.product ? { ...PRODUCT_ENV, ...LEARNING_ENV } : {}), ...options.env }) as ServeConfig), port: 0 };
    const gateway = await startServe(config, {
      db, kms, now: () => now, listen: false, log: () => undefined, ...(options.companyCaps === true ? {} : { caps: new FixedCapsSource(caps) }),
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), keys: { keyFor: async () => "fixture-provider-key" },
      geminiTransport: async (r) => { sent.push(r); return { status: 200, body: geminiAnswer() }; },
    });
    running.push(gateway);
    return { wire, db, kms, key, sent, gateway };
  }

  it("serves a product call on the project's own key, held and settled on the product tables and the one combined company row", async () => {
    const t = await started({ product: true });
    const res = await request(t.gateway.server, streamPath, geminiBody);
    expect(res.statusCode).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.key).toBe(t.key);
    expect(t.kms.keyIds.every((id) => id === KEY_ARN)).toBe(true);
    // The settle runs in the call's finally, after the answer ended: a drain waits for it.
    await t.gateway.drain();
    const product = new DynamoMeter({ db: t.db, tables: { meter: PRODUCT.meter, ledger: PRODUCT.ledger, markers: PRODUCT.markers }, now: () => now, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } });
    const projectRow = (await product.read(productScope)).find((r) => r.item === "project")!;
    expect(projectRow.reservedMicros).toBe(0); expect(projectRow.spentMicros).toBeGreaterThan(0);
    const agent = new DynamoMeter({ db: t.db, tables: TABLES, now: () => now });
    expect((await agent.read(agentScope)).find((r) => r.item === "company")).toMatchObject({ reservedMicros: 0, spentMicros: projectRow.spentMicros });
    // The product rows are on the product tables only; the agent meter table holds just the combined company row.
    expect(t.wire.items(PRODUCT.meter).length).toBeGreaterThan(0);
    expect(t.wire.items(TABLES.meter).filter((row) => String(row.sk).startsWith("ROW#")).map((row) => row.sk)).toEqual([`ROW#${JSON.stringify(["company", new Date(now).toISOString().slice(0, 7)])}`]);
  });

  it("is off without the settings: every product path is 404 and nothing is read from the key table", async () => {
    const t = await started({ product: false });
    const before = t.wire.calls.filter((c) => c.table === PRODUCT.keys).length;
    expect((await request(t.gateway.server, streamPath, geminiBody)).statusCode).toBe(404);
    expect((await request(t.gateway.server, "/v1/product/eval/hold", {})).statusCode).toBe(404);
    expect((await request(t.gateway.server, "/v1/learning/messages", {})).statusCode).toBe(404);
    expect(t.wire.calls.filter((c) => c.table === PRODUCT.keys).length).toBe(before);
    expect(t.sent).toHaveLength(0);
  });

  it("DEC 253k: serves Code's eval authority from the stored approval and the key connection, only with the product route", async () => {
    const authority = (server: RunningGateway["server"], company: string = claims.cid) => {
      const at = now / 1000;
      const input = [{ alg: "RS256", typ: "rovara-service+jwt", kid }, { iss: claims.iss, aud: EVAL_AUTHORITY_AUDIENCE, jti: randomUUID(), iat: at, nbf: at - 30, exp: at + 60, cid: company }].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
      const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ company, project: pid, approver: { personId: "person-1", provider: "rovara-sign-in" } }))]), { method: "POST", url: EVAL_AUTHORITY_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
      const res = new FakeResponse();
      const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
      server.emit("request", req, res);
      return done;
    };
    const t = await started({ product: true });
    // No approval yet: the fixed not found.
    const none = await authority(t.gateway.server);
    expect([none.statusCode, JSON.parse(none.text())]).toEqual([404, { error: { type: "not_found", message: "not found" } }]);
    // Cloud's settings route records the approval (same table): now 200, and another company's token learns nothing.
    const writer = new ProductKeyStore({ table: new DynamoProductKeyTable(t.db, PRODUCT.keys), sealer: new ProductKeySealer(kmsProductKeyService(t.kms, KEY_ARN)), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => now });
    await writer.setEvalApproval({ iss: claims.iss, cid: claims.cid, owner: pid, requestId: randomUUID(), expectedRevision: (await writer.view(claims.iss, claims.cid, pid)).revision, actor: { id: storedApproverOf({ personId: "person-1", provider: "rovara-sign-in" }).personId, role: "project_maintainer" }, approval: { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 400, maxCostMicros: 4_000_000 }, provider: "rovara-code" });
    const yes = await authority(t.gateway.server);
    expect(yes.statusCode).toBe(200);
    expect(JSON.parse(yes.text())).toEqual({ company: claims.cid, project: pid, principal: { companyId: claims.cid, personId: "person-1", displayName: "", roles: ["maintainer"], provider: "rovara-sign-in" }, provider: "customer", connected: true });
    expect((await authority(t.gateway.server, `org_${"b".repeat(20)}`)).statusCode).toBe(404);
    // A task token (the product route's own auth) never opens it.
    expect((await request(t.gateway.server, EVAL_AUTHORITY_PATH, {})).statusCode).toBe(401);
    expect(t.sent).toHaveLength(0);
    // Without the product route the path is the gateway's 404.
    const off = await started({ product: false });
    const before = off.wire.calls.filter((c) => c.table === PRODUCT.keys).length;
    expect((await authority(off.gateway.server)).statusCode).toBe(404);
    expect(off.wire.calls.filter((c) => c.table === PRODUCT.keys).length).toBe(before);
  });

  it("DEC 253q: serves Code's eval monthly cap from Cloud's company budget (the Companies table), with or without the product route", async () => {
    const capCall = (server: RunningGateway["server"], company: string = claims.cid, project: string = pid) => {
      const at = now / 1000;
      const input = [{ alg: "RS256", typ: "rovara-service+jwt", kid }, { iss: claims.iss, aud: EVAL_CAP_AUDIENCE, jti: randomUUID(), iat: at, nbf: at - 30, exp: at + 60, cid: company }].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
      const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ company, project }))]), { method: "POST", url: EVAL_CAP_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
      const res = new FakeResponse();
      const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
      server.emit("request", req, res);
      return done;
    };
    for (const product of [true, false]) {
      const t = await started({ product, companyCaps: true });
      // No settings row: no source, the fixed not found.
      const none = await capCall(t.gateway.server);
      expect([none.statusCode, JSON.parse(none.text())]).toEqual([404, { error: { type: "not_found", message: "not found" } }]);
      // The row Cloud's company backend writes: min(company, project).
      await t.db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 1, settings: { featureGates: {}, budgets: { companyMonthlyUsdMicros: 30_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: 12_000_000, taskUsdMicros: null } } });
      const yes = await capCall(t.gateway.server);
      // L4-T3 (additive): with the product route (eval stages bound) the answer also says whether the project's own key is connected (a key is connected in this world); without it, the three members it always had.
      expect([yes.statusCode, JSON.parse(yes.text())]).toEqual([200, { company: claims.cid, project: pid, monthlyCapMicros: 12_000_000, ...(product ? { connected: true } : {}) }]);
      expect((await capCall(t.gateway.server, `org_${"b".repeat(20)}`)).statusCode).toBe(404);
      // A task token (x-api-key) never opens it.
      expect((await request(t.gateway.server, EVAL_CAP_PATH, { company: claims.cid, project: pid })).statusCode).toBe(401);
      expect(t.sent).toHaveLength(0);
    }
  });

  it("L4-HW3c: serves the asking company's approved rules to Code's hosted broker from the Companies table (SETTINGS only), with or without the product route", async () => {
    const rulesCall = (server: RunningGateway["server"], company: string = claims.cid, tokenCompany: string = company) => {
      const at = now / 1000;
      const input = [{ alg: "RS256", typ: "rovara-service+jwt", kid }, { iss: claims.iss, aud: COMPANY_INSTRUCTIONS_AUDIENCE, jti: randomUUID(), iat: at, nbf: at - 30, exp: at + 60, cid: tokenCompany }].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
      const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ company }))]), { method: "POST", url: COMPANY_INSTRUCTIONS_PATH, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
      const res = new FakeResponse();
      const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
      server.emit("request", req, res);
      return done;
    };
    const other = `org_${"b".repeat(20)}`;
    for (const product of [true, false]) {
      const t = await started({ product, companyCaps: true });
      // No settings row: a plain 200 with no rules.
      const none = await rulesCall(t.gateway.server);
      expect([none.statusCode, JSON.parse(none.text())]).toEqual([200, { company: claims.cid, version: "0", rules: [] }]);
      const settings = (instructions: { text: string; priority: string }[]) => ({ featureGates: {}, instructions, budgets: { companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } });
      await t.db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 4, settings: settings([{ text: "OWN-RULE", priority: "required" }]) });
      await t.db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "PENDING", companyId: claims.cid, version: 1, settings: settings([{ text: "DRAFT-RULE", priority: "required" }]) });
      await t.db.put(TABLES.companies, { pk: `COMPANY#${other}`, sk: "SETTINGS", companyId: other, version: 2, settings: settings([{ text: "OTHER-RULE", priority: "required" }]) });
      const yes = await rulesCall(t.gateway.server);
      expect([yes.statusCode, JSON.parse(yes.text())]).toEqual([200, { company: claims.cid, version: "4", rules: [{ text: "OWN-RULE", priority: "required" }] }]);
      expect(yes.text()).not.toContain("DRAFT-RULE");
      expect(yes.text()).not.toContain("OTHER-RULE");
      // This company's token naming the other company's id is the fixed not found.
      expect((await rulesCall(t.gateway.server, other, claims.cid)).statusCode).toBe(404);
      // A task token (x-api-key) never opens it.
      expect((await request(t.gateway.server, COMPANY_INSTRUCTIONS_PATH, { company: claims.cid })).statusCode).toBe(401);
      expect(t.sent).toHaveLength(0);
    }
  });

  it("serves Cloud's Vertex check only with Vertex, the MAC key and a KMS that verifies; an unsigned call is refused before any probe", async () => {
    const refused = Object.assign(new Error("kms request refused"), { name: "KMSInvalidMacException" });
    const verifyMac = async () => { throw refused; };
    const on = await started({ product: true, env: { [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE, [GATEWAY_ENV.productMacKey]: MAC_KEY_ARN }, verifyMac });
    const signed = { "x-rovara-call-at": String(now), "x-rovara-call-mac": Buffer.alloc(32).toString("base64url") };
    const r = await request(on.gateway.server, "/v1/service/vertex-check", { iss: claims.iss, cid: claims.cid, credential: {} }, signed);
    expect(r.statusCode).toBe(401);
    expect(r.text()).toBe(JSON.stringify({ error: { type: "unauthorized", message: "the service call is not signed" } }));
    // Without the MAC key the path is not served: it is just another unknown gateway path.
    const off = await started({ product: true, env: { [GATEWAY_ENV.vertexFederationRole]: VERTEX_ROLE }, verifyMac });
    expect((await request(off.gateway.server, "/v1/service/vertex-check", {}, signed)).statusCode).toBe(404);
  });

  it("mounts the eval stage controls on the shared stage table: a hold without an approval holds nothing", async () => {
    const t = await started({ product: true });
    const grant = { company: claims.cid, project: pid, selection: "s", role: "maintainer", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 1, maxCostMicros: 1 };
    const res = await request(t.gateway.server, "/v1/product/eval/hold", { grant, calls: 1, costMicros: 1 });
    expect(res.statusCode).toBe(422);
    expect(t.wire.items(PRODUCT.stages)).toEqual([]);
  });
});
