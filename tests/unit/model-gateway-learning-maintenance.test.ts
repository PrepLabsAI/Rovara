// The learning meter on the DEPLOYED meter (DynamoMeter over the wire fake) inside startServe: the open gaps of DEFERRED
// GATEWAY-LEARNING-FOLLOWUPS (L4), proven end to end instead of by wiring alone:
//   - learning corrections and expiry run in the maintenance pass and move BOTH the learning row and the combined company row;
//   - the pause labels (monthly_limit, no_budget, cost_too_high) are the right ones on the Dynamo meter, not only the in-memory one;
//   - a learning call waits behind the shared one-at-a-time company marker, and holds it against the agent route;
//   - the company's own learning cap (settings) bounds the learning month on the Dynamo meter.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import type { ReserveInput } from "../../packages/model-gateway/src/meter.js";
import { DynamoPriceSnapshotStore } from "../../packages/model-gateway/src/dynamo-prices.js";
import { LEARNING_PATH, LEARNING_PAUSE_HEADER, LEARNING_STEP, type LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { answer, claims, jwk, kid, mint, now, requestBody } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const LEARNING = { meter: "gwl-meter", ledger: "gwl-ledger", markers: "gwl-markers" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const jwksFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
function post(server: RunningGateway["server"], token = mint({ stp: LEARNING_STEP })): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: LEARNING_PATH, headers: { "content-type": "application/json", "x-api-key": token } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const settleAll = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });
const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid };
const PRICE = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 100_000, cacheWrite5mMicrosPerMTok: 1_250_000, cacheWrite1hMicrosPerMTok: 2_000_000 };
const snapshot = (version: number) => ({ version, sources: { litellm: { fetchedAt: now, count: 1, entries: [{ provider: "anthropic" as const, model: claims.mdl[0]!, kind: "chat" as const, ...PRICE }] } } });

async function serve(options: { companyMonth?: number; learningMonth?: number; priced?: boolean; clock?: { at: number } } = {}) {
  const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(LEARNING)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const clock = options.clock ?? { at: now };
  const budgets = (learningMonth: number | undefined) => ({ companyMonthlyUsdMicros: options.companyMonth ?? 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, ...(learningMonth === undefined ? {} : { learningMonthlyUsdMicros: learningMonth }) });
  await db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 1, settings: { featureGates: { lessons: true }, budgets: budgets(options.learningMonth) } });
  const prices = new DynamoPriceSnapshotStore(db, TABLES.prices);
  if (options.priced === true) expect(await prices.save(snapshot(1), 0)).toBe(true);
  const lines: Array<Record<string, unknown>> = [];
  const sent: ProviderRequest[] = [];
  const keys: LearningKeySource = { connected: async () => true, keyFor: async (_iss, cid) => `customer-${cid}` };
  const meter = new DynamoMeter({ db, tables: LEARNING, now: () => clock.at, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } });
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => clock.at, listen: false, log: (line) => lines.push(line),
    keys: { keyFor: async () => "rovara-install-key" },
    transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
    learning: { keys, meter },
  });
  running.push(gateway);
  return { gateway, db, wire, lines, sent, clock, prices, learning: meter, agent: new DynamoMeter({ db, tables: TABLES, now: () => clock.at }) };
}
const row = async (m: DynamoMeter, item: string) => (await m.read(scope)).find((r) => r.item === item)!;
const reason = (res: FakeResponse) => res.headers[LEARNING_PAUSE_HEADER];
const learningCaps = (month: number, combined = 500_000_000) => ({ task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: month, combinedCompanyMonth: combined });

describe("learning meter in the deployed process: corrections and expiry in the maintenance pass", () => {
  it("an estimated learning call is corrected to the real price: the learning row AND the combined company row fall together", async () => {
    const s = await serve();
    expect((await post(s.gateway.server)).statusCode).toBe(200);
    await settleAll();
    const estimated = (await row(s.learning, "company")).spentMicros;
    expect(estimated).toBeGreaterThan(0);
    expect((await row(s.agent, "company")).spentMicros).toBe(estimated);
    expect((await s.learning.pendingKeys(10)).items).toHaveLength(1);
    // The price fetch lands later: the next pass prices the call for real.
    expect(await s.prices.save(snapshot(1), 0)).toBe(true);
    await s.gateway.maintain();
    expect(s.lines).toContainEqual(expect.objectContaining({ event: "price_corrected", route: "learning" }));
    const real = (await row(s.learning, "company")).spentMicros;
    // 2 input at $1/M, 3 cache reads at $0.10/M, 4 cache writes at $1.25/M, 5 output at $2/M, rounded up to the micro.
    expect(real).toBeLessThan(estimated);
    expect(real).toBeGreaterThan(0);
    expect((await row(s.agent, "company")).spentMicros).toBe(real);
    expect((await row(s.learning, "company")).estimatedMicros).toBe(0);
    expect((await s.learning.pendingKeys(10)).items).toEqual([]);
    expect(s.lines.some((line) => line.event === "maintenance_failed")).toBe(false);
  });

  it("an unpriceable learning call is expired after the retention window: it stays charged, leaves the pending index, and is logged for the learning route", async () => {
    const s = await serve();
    expect((await post(s.gateway.server)).statusCode).toBe(200);
    await settleAll();
    const charged = (await row(s.learning, "company")).spentMicros;
    await s.gateway.maintain();
    expect(s.lines.some((line) => line.event === "price_expired")).toBe(false);
    s.clock.at = now + 63 * 86_400_000;
    await s.gateway.maintain();
    expect(s.lines).toContainEqual({ event: "price_expired", route: "learning" });
    expect((await s.learning.pendingKeys(10)).items).toEqual([]);
    // Expired unpriceable charges remain as charged (estimated), in the old month's rows.
    clockBack(s);
    expect((await row(s.learning, "company")).spentMicros).toBe(charged);
    expect((await row(s.agent, "company")).spentMicros).toBe(charged);
  });
});
const clockBack = (s: { clock: { at: number } }) => { s.clock.at = now; };

describe("learning meter in the deployed process: the pause labels on the Dynamo meter", () => {
  it("the learning month used up: monthly_limit (422), nothing sent", async () => {
    const s = await serve({ priced: true, learningMonth: 1_000 });
    const held = await s.learning.reserve({ scope, caps: learningCaps(1_000), estimateMicros: 1_000 });
    if (!held.ok) throw new Error("reserve"); await s.learning.settle(held.reservation, 1_000);
    const res = await post(s.gateway.server);
    expect([res.statusCode, reason(res)]).toEqual([422, "monthly_limit"]);
    expect(s.sent).toEqual([]);
  });

  it("the combined company cap used up by agent spend: no_budget although the learning month has room", async () => {
    const s = await serve({ priced: true, companyMonth: 100_000, learningMonth: 100_000 });
    const a = await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 100_000 }, estimateMicros: 99_990 });
    if (!a.ok) throw new Error("reserve"); await s.agent.settle(a.reservation, 99_990);
    const res = await post(s.gateway.server);
    expect([res.statusCode, reason(res)]).toEqual([422, "no_budget"]);
    expect(s.sent).toEqual([]);
  });

  it("the combined cap blocked only by other calls' open holds still reads as no_budget, not monthly_limit (nothing is spent yet)", async () => {
    const s = await serve({ priced: true, companyMonth: 100_000, learningMonth: 50_000 });
    const held = await s.learning.reserve({ scope: { ...scope, tid: "other" }, caps: learningCaps(50_000, 100_000), estimateMicros: 49_999 });
    expect(held.ok).toBe(true);
    const a = await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 100_000 }, estimateMicros: 50_000 });
    if (!a.ok) throw new Error("reserve"); await s.agent.settle(a.reservation, 99_995);
    const res = await post(s.gateway.server);
    expect(reason(res)).toBe("no_budget");
    expect(s.sent).toEqual([]);
  });

  it("the company's own learning cap (settings) of zero: no_budget; below one call's cost: cost_too_high", async () => {
    const zero = await serve({ priced: true, learningMonth: 0 });
    expect(reason(await post(zero.gateway.server))).toBe("no_budget");
    const tiny = await serve({ priced: true, learningMonth: 1 });
    expect(reason(await post(tiny.gateway.server))).toBe("cost_too_high");
    expect(zero.sent).toEqual([]); expect(tiny.sent).toEqual([]);
  });

  it("the company's own learning cap (settings) is the learning month row's cap that is held; the $20 default for an older row", async () => {
    for (const [learningMonth, expected] of [[3_000_000, 3_000_000], [400_000_000, 400_000_000], [undefined, 20_000_000]] as const) {
      const s = await serve({ priced: true, ...(learningMonth === undefined ? {} : { learningMonth }) });
      let seen: unknown;
      const reserve = s.learning.reserve.bind(s.learning);
      s.learning.reserve = async (input: ReserveInput) => { seen = input.caps; return reserve(input); };
      expect((await post(s.gateway.server)).statusCode).toBe(200);
      await settleAll();
      expect(seen).toMatchObject({ companyMonth: expected, combinedCompanyMonth: 500_000_000 });
    }
  });
});

describe("learning meter in the deployed process: the shared one-at-a-time company marker", () => {
  const marker = (at: number) => ({ deadlineSeconds: at / 1000 + 60, tokenExpiresSeconds: at / 1000 + 900 });
  it("an overrun-capable learning call waits (429 busy) behind an agent call holding the marker, then runs when it settles", async () => {
    const s = await serve();
    const a = await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 500_000_000 }, estimateMicros: 10, overrun: marker(now) });
    if (!a.ok) throw new Error("reserve");
    const busy = await post(s.gateway.server);
    expect(busy.statusCode).toBe(429);
    expect((JSON.parse(busy.text()) as { error: { type: string } }).error.type).toBe("busy");
    expect(s.sent).toEqual([]);
    expect(s.lines).toContainEqual({ event: "overrun_busy", company: claims.cid });
    await s.agent.settle(a.reservation, 10);
    expect((await post(s.gateway.server)).statusCode).toBe(200);
  });

  it("a learning call holding the marker makes the agent route's overrun-capable call busy", async () => {
    const s = await serve();
    const l = await s.learning.reserve({ scope, caps: learningCaps(20_000_000), estimateMicros: 10, overrun: marker(now) });
    if (!l.ok) throw new Error("reserve");
    expect(await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 500_000_000 }, estimateMicros: 10, overrun: marker(now) })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
    await s.learning.settle(l.reservation, 10);
    expect((await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 500_000_000 }, estimateMicros: 10, overrun: marker(now) })).ok).toBe(true);
  });

  it("a priced (not overrun-capable) learning call does not need the marker", async () => {
    const s = await serve({ priced: true });
    const a = await s.agent.reserve({ scope: { ...scope, per: claims.per }, caps: { task: 1e9, personMonth: 1e9, projectMonth: 1e9, companyMonth: 500_000_000 }, estimateMicros: 10, overrun: marker(now) });
    if (!a.ok) throw new Error("reserve");
    expect((await post(s.gateway.server)).statusCode).toBe(200);
  });
});
