// The answers route and the nightly upkeep cap in the deployed process (startServe): the company's answers limit and each project's upkeep limit are read from
// the Companies table's own items (SPEND_LIMIT#ANSWERS#<company>, SPEND_LIMIT#UPKEEP#<project>), the answers meter is a DynamoMeter combined with the agent
// meter's tables (DEC 228c) on tables of its own, the key is the company's own, and the answers meter's holds, expiry and corrections run in the maintenance pass.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ANSWERS_PATH, ANSWERS_PAUSE_HEADER, ANSWERS_STEP } from "../../packages/model-gateway/src/answers-route.js";
import { GATEWAY_ANSWERS_ENV, GATEWAY_ENV, GATEWAY_LEARNING_ENV, GATEWAY_PRODUCT_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { DynamoPriceSnapshotStore } from "../../packages/model-gateway/src/dynamo-prices.js";
import type { PriceSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import type { ChargeReceiptV1 } from "../../packages/model-gateway/src/charge-receipt.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { UPKEEP_PAUSE_HEADER } from "../../packages/model-gateway/src/upkeep-cap.js";
import { answer, claims, jwk, kid, mint, now, requestBody } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const ANSWERS = { meter: "gwa-meter", ledger: "gwa-ledger", markers: "gwa-markers" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: "gwp-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
  [GATEWAY_ENV.productMeterTable]: "gwp-meter", [GATEWAY_ENV.productLedgerTable]: "gwp-ledger", [GATEWAY_ENV.productMarkersTable]: "gwp-markers", [GATEWAY_ENV.evalStagesTable]: "gwp-stages",
};
const ANSWERS_ENV = { [GATEWAY_ENV.answersMeterTable]: ANSWERS.meter, [GATEWAY_ENV.answersLedgerTable]: ANSWERS.ledger, [GATEWAY_ENV.answersMarkersTable]: ANSWERS.markers };
const jwksFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
}
function post(server: RunningGateway["server"], token: string, url = ANSWERS_PATH): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": token } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });
const settleAll = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const item = (kind: string, sort: string, id: string, micros: number, company = claims.cid) => ({ pk: `COMPANY#${company}`, sk: `${sort}${id}`, companyId: company, kind, id, monthlyUsdMicros: micros, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: "d".repeat(64) });

async function serve(options: { combined?: boolean; answersLimit?: number; upkeepLimit?: number } = {}) {
  const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(ANSWERS)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  await db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 1, settings: { featureGates: {}, budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
  if (options.answersLimit !== undefined) await db.put(TABLES.companies, item("answers_month", "SPEND_LIMIT#ANSWERS#", claims.cid, options.answersLimit));
  if (options.upkeepLimit !== undefined) await db.put(TABLES.companies, item("upkeep_month", "SPEND_LIMIT#UPKEEP#", claims.pid, options.upkeepLimit));
  const lines: Array<Record<string, unknown>> = [];
  const sent: ProviderRequest[] = [];
  const installKeyReads: number[] = [];
  const keys: LearningKeySource = { connected: async () => true, keyFor: async (_iss, cid) => `customer-${cid}` };
  const base = new DynamoMeter({ db, tables: ANSWERS, now: () => now, ...(options.combined === false ? {} : { combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } }) });
  const swept: number[] = [];
  const meter = Object.assign(base, { sweepOpenHolds: async (at: number, limit: number) => { swept.push(at); return DynamoMeter.prototype.sweepOpenHolds.call(base, at, limit); } });
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: (line) => lines.push(line),
    keys: { keyFor: async () => { installKeyReads.push(1); return "rovara-install-key"; } },
    transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
    answers: { keys, meter },
  });
  running.push(gateway);
  return { gateway, db, lines, sent, installKeyReads, swept, agent: new DynamoMeter({ db, tables: TABLES, now: () => now }), answers: base };
}
const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid };

describe("gateway config: the answers tables", () => {
  const withProduct = { ...ENV, ...PRODUCT_ENV };
  it("reads the three tables together, only with the product route's key store, each distinct from every other table", () => {
    expect((readGatewayConfig({ ...withProduct, ...ANSWERS_ENV }) as ServeConfig).answers).toEqual(ANSWERS);
    expect((readGatewayConfig(withProduct) as ServeConfig).answers).toBeUndefined();
    for (const name of GATEWAY_ANSWERS_ENV) expect(() => readGatewayConfig({ ...withProduct, ...ANSWERS_ENV, [name]: undefined }), name).toThrow(name);
    expect(() => readGatewayConfig({ ...ENV, ...ANSWERS_ENV })).toThrow(GATEWAY_ENV.productKeysTable);
    expect(() => readGatewayConfig({ ...withProduct, ...ANSWERS_ENV, [GATEWAY_ENV.answersMeterTable]: PRODUCT_ENV[GATEWAY_ENV.productMeterTable] })).toThrow();
    expect(() => readGatewayConfig({ ...withProduct, ...ANSWERS_ENV, [GATEWAY_ENV.answersMeterTable]: TABLES.meter })).toThrow();
    const learning = { [GATEWAY_ENV.learningMeterTable]: "gwl-meter", [GATEWAY_ENV.learningLedgerTable]: "gwl-ledger", [GATEWAY_ENV.learningMarkersTable]: "gwl-markers" };
    expect(() => readGatewayConfig({ ...withProduct, ...learning, ...ANSWERS_ENV, [GATEWAY_ENV.answersMarkersTable]: learning[GATEWAY_ENV.learningMarkersTable] })).toThrow();
    expect(GATEWAY_PRODUCT_ENV.length + GATEWAY_LEARNING_ENV.length).toBeGreaterThan(0);
  });
});

describe("gateway process: answers route", () => {
  it("serves an answers call on the company's own key under the default limit, counts it in the combined company total, and sweeps the answers meter", async () => {
    const s = await serve();
    const res = await post(s.gateway.server, mint({ stp: ANSWERS_STEP }));
    expect(res.statusCode).toBe(200);
    expect(s.sent.map((r) => r.key)).toEqual([`customer-${claims.cid}`]);
    expect(s.installKeyReads).toEqual([]);
    await settleAll();
    const spent = (await s.answers.read(scope)).find((r) => r.item === "company")!.spentMicros;
    expect(spent).toBeGreaterThan(0);
    expect((await s.agent.read(scope)).find((r) => r.item === "company")!.spentMicros).toBe(spent);
    await s.gateway.maintain();
    expect(s.swept).toEqual([now]);
    expect(s.lines.some((line) => line.event === "maintenance_failed")).toBe(false);
  });

  it("reads the company's own answers_month item: $0 pauses answers (no_budget), nothing sent", async () => {
    const s = await serve({ answersLimit: 0 });
    const res = await post(s.gateway.server, mint({ stp: ANSWERS_STEP }));
    expect(res.statusCode).toBe(422);
    expect(res.headers[ANSWERS_PAUSE_HEADER]).toBe("no_budget");
    expect(s.sent).toEqual([]);
  });

  it("a task token on the answers path is the fixed 401, and the agent path refuses an answers token", async () => {
    const s = await serve();
    expect((await post(s.gateway.server, mint())).statusCode).toBe(401);
    expect((await post(s.gateway.server, mint({ stp: ANSWERS_STEP }), "/v1/messages")).statusCode).toBe(401);
    expect(s.sent).toEqual([]);
  });

  it("a failing answers sweep is logged and never stops the agent pass", async () => {
    const s = await serve();
    (s.answers as unknown as { sweepOpenHolds: () => Promise<never> }).sweepOpenHolds = async () => { throw new Error("down"); };
    await s.gateway.maintain();
    expect(s.lines).toContainEqual({ event: "maintenance_failed", route: "answers" });
    expect(s.lines.filter((line) => line.event === "maintenance")).toHaveLength(1);
  });

  it("refuses to start with an answers meter that does not combine, or that shares the agent's tables", async () => {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(ANSWERS)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const keys: LearningKeySource = { connected: async () => true, keyFor: async () => "k-123456" };
    const sweep = { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) };
    const meterOf = (tables: typeof ANSWERS, combined?: { meter: string; markers: string }) => Object.assign(new DynamoMeter({ db, tables, now: () => now, ...(combined === undefined ? {} : { combinedCompany: combined }) }), sweep);
    const start = (deps: Record<string, unknown>) => startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, ...deps });
    const agent = { meter: TABLES.meter, markers: TABLES.markers };
    await expect(start({ answers: { keys, meter: meterOf(ANSWERS) } })).rejects.toThrow("answers meter must combine");
    await expect(start({ answers: { keys, meter: meterOf(ANSWERS, { meter: "someone-elses-meter", markers: TABLES.markers }) } })).rejects.toThrow("answers meter must combine");
    await expect(start({ answers: { keys, meter: meterOf({ ...ANSWERS, ledger: TABLES.ledger }, agent) } })).rejects.toThrow("answers meter must have tables of its own");
    running.push(await start({ answers: { keys, meter: meterOf(ANSWERS, agent) } }));
  });
});

describe("gateway process: the nightly upkeep cap", () => {
  const nightlyPost = (s: Awaited<ReturnType<typeof serve>>, changes: Record<string, unknown> = {}) => post(s.gateway.server, mint({ src: "nightly", ...changes }), "/v1/messages");
  it("a nightly call is held to the project's own upkeep_month item (strongly read from the Companies table), and the row counts in the project and company rows", async () => {
    const s = await serve({ upkeepLimit: 90_000_000 });
    expect((await nightlyPost(s)).statusCode).toBe(200);
    await settleAll();
    const rows = await s.agent.read(scope, { upkeep: true });
    const upkeep = rows.find((r) => r.item === "upkeep")!.spentMicros;
    expect(upkeep).toBeGreaterThan(0);
    for (const item of ["project", "company"]) expect(rows.find((r) => r.item === item)!.spentMicros, item).toBe(upkeep);
  });

  it("$0 pauses upkeep before the call: upkeep_paused with its reason header, nothing sent, and attended work still runs", async () => {
    const s = await serve({ upkeepLimit: 0 });
    const res = await nightlyPost(s);
    expect(res.statusCode).toBe(422);
    expect(res.headers[UPKEEP_PAUSE_HEADER]).toBe("no_budget");
    expect(s.sent).toEqual([]);
    expect(s.installKeyReads).toEqual([]);
    expect((await post(s.gateway.server, mint(), "/v1/messages")).statusCode).toBe(200);
  });

  it("with no item the default applies, and another project's item never applies to this one", async () => {
    const s = await serve();
    expect((await nightlyPost(s)).statusCode).toBe(200);
    const other = await serve({ upkeepLimit: 0 });
    expect((await nightlyPost(other, { pid: "api" })).statusCode).toBe(200);
  });
});

// DEC 254zzz312: the deployed factory bills no-source companies, except the configured exempt list, with exact signed prices and receipts.
describe("gateway process: answers on Rovara's AI", () => {
  const cidA = claims.cid;
  const cidB = `org_${"b".repeat(20)}`;
  const BEDROCK_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const sourceId = "arn:aws:iam::123456789012:role/fixture-serving@us-west-2";
  async function serveRovara(saved?: Record<string, string>, disabled = false) {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(ANSWERS)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const snapshot: PriceSnapshot = { version: 1, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [
      { provider: "bedrock", model: BEDROCK_ID, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000,
        cacheReadMicrosPerMTok: 1_000_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 1_000_000 },
    ] } } };
    expect(await new DynamoPriceSnapshotStore(db, TABLES.prices).save(snapshot, 0)).toBe(true);
    for (const cid of [cidA, cidB]) await db.put(TABLES.companies, { pk: `COMPANY#${cid}`, sk: "SETTINGS", companyId: cid, version: 1, settings: { featureGates: {}, budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    for (const [cid, source] of Object.entries(saved ?? {})) await db.put(TABLES.companies, { pk: `COMPANY#${cid}`, sk: "AGENT_AI", companyId: cid, source, version: 1 });
    const own: ProviderRequest[] = []; const bedrock: ProviderRequest[] = [];
    const env = { ...ENV, ...PRODUCT_ENV, ...ANSWERS_ENV, [GATEWAY_ENV.agentKeys]: "company", [GATEWAY_ENV.rovaraAiModels]: `${claims.mdl[0]}=${BEDROCK_ID}`, [GATEWAY_ENV.rovaraAiExempt]: cidA, [GATEWAY_ENV.rovaraAiSourceId]: sourceId, ...(disabled ? { [GATEWAY_ENV.agentModelsDisabled]: claims.mdl[0]! } : {}) };
    const keys: LearningKeySource = { connected: async () => false, keyFor: async () => undefined };
    const meter = new DynamoMeter({ db, tables: ANSWERS, now: () => now, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } });
    const gateway = await startServe({ ...(readGatewayConfig(env) as ServeConfig), port: 0 }, {
      db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "never" }, agentKeys: keys,
      transport: async (request) => { own.push(request); return { status: 200, body: answer() }; },
      bedrockTransport: async (request) => { bedrock.push(request); return { status: 200, body: answer() }; },
      answers: { keys, meter },
    });
    running.push(gateway);
    const token = (cid: string) => mint({ stp: ANSWERS_STEP, cid, pay: { kind: "project", project: claims.pid }, runPrice: {
      companyId: cid, model: claims.mdl[0], provider: "bedrock", sourceId, connectionRevision: createHash("sha256").update(JSON.stringify([[claims.mdl[0], BEDROCK_ID]])).digest("hex"),
      catalogModel: BEDROCK_ID, snapshotHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshotVersion: 1, expiresAt: now + 60_000,
      // The deployed catalog also bounds this Claude model's >200k tier; short calls still settle at the base rates above.
      inputUsdPerMillion: 2, outputUsdPerMillion: 4, cacheReadUsdPerMillion: 2, cacheWriteUsdPerMillion: 4,
    } });
    return { gateway, own, bedrock, wire, token };
  }
  it("exempt A is free and non-exempt B is billed, each with one durable call receipt", async () => {
    const s = await serveRovara();
    expect((await post(s.gateway.server, s.token(cidA))).statusCode).toBe(200);
    expect((await post(s.gateway.server, s.token(cidB))).statusCode).toBe(200);
    expect(s.bedrock).toHaveLength(2); expect(s.own).toEqual([]);
    await settleAll();
    expect(s.wire.items(ANSWERS.ledger).filter((r) => r.line !== undefined).map((r) => [r.cid, (r.line as { charge: string }).charge])).toEqual([[cidA, "exempt"], [cidB, "customer"]]);
    const receipts = s.wire.items(ANSWERS.ledger).flatMap(r => !String(r.sk).startsWith("CALL#") || r.receipt === undefined ? [] : [r.receipt as ChargeReceiptV1]);
    expect(receipts).toHaveLength(2);
    expect(receipts.map(r => [r.companyId, r.billing, r.billableMicros])).toEqual([
      [cidA, "exempt", { state: "available", value: 0 }], [cidB, "customer", { state: "available", value: 19 }],
    ]);
  });
  it("the deployed model-disable setting refuses purpose calls before a hold or provider send", async () => {
    const s = await serveRovara(undefined, true);
    expect((await post(s.gateway.server, s.token(cidB))).statusCode).toBe(400);
    expect(s.bedrock).toEqual([]); expect(s.own).toEqual([]);
    expect(s.wire.items(ANSWERS.meter)).toEqual([]);
    expect(s.wire.items(ANSWERS.ledger)).toEqual([]);
    expect(s.wire.items(TABLES.meter)).toEqual([]);
  });
  it("exempt A that saved its own source is paused as before (the saved choice is read from the Companies table)", async () => {
    const s = await serveRovara({ [cidA]: "openai_key" });
    expect((await post(s.gateway.server, mint({ stp: ANSWERS_STEP, cid: cidA }))).headers[ANSWERS_PAUSE_HEADER]).toBe("no_provider");
    expect(s.bedrock).toEqual([]);
  });
});
