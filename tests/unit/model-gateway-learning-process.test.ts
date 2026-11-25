// The learning route in the deployed process (startServe): the company backend's Companies row supplies both the budgets and the
// lessons switch, the learning meter is a DynamoMeter combined with the agent meter's tables (DEC 228c), the key is the company's
// own (never the install key), and the learning meter's holds, expiry and corrections run in the maintenance pass.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
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
function post(server: RunningGateway["server"], token: string): Promise<FakeResponse> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: LEARNING_PATH, headers: { "content-type": "application/json", "x-api-key": token } });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });

async function serve(options: { lessons?: unknown; combined?: boolean } = {}) {
  const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(LEARNING)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  await db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 1, settings: { featureGates: { lessons: options.lessons ?? true }, budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } as never });
  const lines: Array<Record<string, unknown>> = [];
  const sent: ProviderRequest[] = [];
  const installKeyReads: number[] = [];
  const keys: LearningKeySource = { connected: async () => true, keyFor: async (_iss, cid) => `customer-${cid}` };
  const base = new DynamoMeter({ db, tables: LEARNING, now: () => now, ...(options.combined === false ? {} : { combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } }) });
  const swept: number[] = [];
  const meter = Object.assign(base, { sweepOpenHolds: async (at: number, limit: number) => { swept.push(at); return DynamoMeter.prototype.sweepOpenHolds.call(base, at, limit); } });
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: (line) => lines.push(line),
    keys: { keyFor: async () => { installKeyReads.push(1); return "rovara-install-key"; } },
    transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
    learning: { keys, meter },
  });
  running.push(gateway);
  return { gateway, db, lines, sent, installKeyReads, swept, agent: new DynamoMeter({ db, tables: TABLES, now: () => now }), learning: base };
}

describe("gateway process: learning route", () => {
  it("serves a learning call on the company's own key, counts it in the combined company total, and sweeps the learning meter", async () => {
    const s = await serve();
    const res = await post(s.gateway.server, mint({ stp: LEARNING_STEP }));
    expect(res.statusCode).toBe(200);
    expect(s.sent.map((r) => r.key)).toEqual([`customer-${claims.cid}`]);
    expect(s.installKeyReads).toEqual([]);
    // The settle runs in the handler's finally, after the response closed: let open calls finish.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid };
    const learned = (await s.learning.read(scope)).find((r) => r.item === "company")!.spentMicros;
    expect(learned).toBeGreaterThan(0);
    expect((await s.agent.read(scope)).find((r) => r.item === "company")!.spentMicros).toBe(learned);
    await s.gateway.maintain();
    expect(s.swept).toEqual([now]);
    expect(s.lines.some((line) => line.event === "maintenance_failed")).toBe(false);
  });

  it("the switch off in the company backend's row: lessons_off, nothing sent", async () => {
    const s = await serve({ lessons: false });
    const res = await post(s.gateway.server, mint({ stp: LEARNING_STEP }));
    expect(res.statusCode).toBe(403);
    expect(res.headers[LEARNING_PAUSE_HEADER]).toBe("lessons_off");
    expect(s.sent).toEqual([]);
  });

  it("a failing learning sweep is logged and never stops the agent pass", async () => {
    const s = await serve();
    (s.learning as unknown as { sweepOpenHolds: () => Promise<never> }).sweepOpenHolds = async () => { throw new Error("down"); };
    await s.gateway.maintain();
    expect(s.lines).toContainEqual({ event: "maintenance_failed", route: "learning" });
    expect(s.lines.filter((line) => line.event === "maintenance")).toHaveLength(1);
  });

  it("refuses to start with a learning meter combined with other tables, or sharing the agent's or the product meter's tables", async () => {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(LEARNING)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const keys: LearningKeySource = { connected: async () => true, keyFor: async () => "k-123456" };
    const sweep = { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) };
    const meterOf = (tables: typeof LEARNING, combined = { meter: TABLES.meter, markers: TABLES.markers }) => Object.assign(new DynamoMeter({ db, tables, now: () => now, combinedCompany: combined }), sweep);
    const start = (deps: Record<string, unknown>) => startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, ...deps });
    await expect(start({ learning: { keys, meter: meterOf(LEARNING, { meter: "someone-elses-meter", markers: TABLES.markers }) } })).rejects.toThrow("learning meter must combine");
    await expect(start({ learning: { keys, meter: meterOf({ ...LEARNING, ledger: TABLES.ledger }) } })).rejects.toThrow("learning meter must have tables of its own");
    const PRODUCT = { meter: "gwp-meter", ledger: "gwp-ledger", markers: "gwp-markers" };
    await expect(start({ product: { routes: { route: () => undefined }, meter: meterOf(PRODUCT), caps: { capsFor: async () => ({}) } }, learning: { keys, meter: meterOf({ ...LEARNING, meter: PRODUCT.meter }) } })).rejects.toThrow("learning meter must have tables of its own");
    // Its own tables, combined with this agent meter: starts.
    running.push(await start({ learning: { keys, meter: meterOf(LEARNING) } }));
  });

  it("refuses to start with a learning meter that cannot show its tables (the checks above would pass it unseen)", async () => {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(LEARNING)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const keys: LearningKeySource = { connected: async () => true, keyFor: async () => "k-123456" };
    const sweep = { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) };
    const combined = () => new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: new InMemoryMeter(() => now) });
    const start = (meter: unknown) => startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, learning: { keys, meter: meter as never } });
    await expect(start(Object.assign(combined(), sweep))).rejects.toThrow("learning meter must expose its tables");
    await expect(start(Object.assign(combined(), sweep, { ownTables: () => LEARNING }))).rejects.toThrow("learning meter must expose its tables");
    await expect(start(Object.assign(combined(), sweep, { combinedTables: () => ({ meter: TABLES.meter, markers: TABLES.markers }) }))).rejects.toThrow("learning meter must expose its tables");
    // A meter that exposes both views passes, whatever class it is.
    running.push(await start(Object.assign(combined(), sweep, { combinedTables: () => ({ meter: TABLES.meter, markers: TABLES.markers }), ownTables: () => LEARNING })));
  });

  it("refuses to start when the product and learning meters share a table, or the product meter uses the agent's", async () => {
    const wire = new WireDynamo([...Object.values(TABLES), ...Object.values(LEARNING)], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const keys: LearningKeySource = { connected: async () => true, keyFor: async () => "k-123456" };
    const sweep = { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) };
    const meterOf = (tables: typeof LEARNING) => Object.assign(new DynamoMeter({ db, tables, now: () => now, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } }), sweep);
    const start = (deps: Record<string, unknown>) => startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, ...deps });
    const product = (tables: typeof LEARNING) => ({ routes: { route: () => undefined }, meter: meterOf(tables), caps: { capsFor: async () => ({}) } });
    await expect(start({ product: product({ meter: "gwp-meter", ledger: TABLES.ledger, markers: "gwp-markers" }) })).rejects.toThrow("product meter must have tables of its own");
    await expect(start({ product: product({ meter: "gwp-meter", ledger: LEARNING.ledger, markers: "gwp-markers" }), learning: { keys, meter: meterOf(LEARNING) } })).rejects.toThrow("learning meter must have tables of its own");
  });

  it("refuses to start with a learning meter that does not take the agent meter's company row", async () => {
    await expect(serve({ combined: false })).rejects.toThrow("learning meter must combine the company cap with the agent meter");
    const lone = Object.assign(new InMemoryMeter(() => now), { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) });
    await expect(startServe({ ...(readGatewayConfig(ENV) as ServeConfig), port: 0 }, { db: {} as Dynamo, listen: false, log: () => undefined, learning: { keys: { connected: async () => true, keyFor: async () => "k-123456" }, meter: lone } })).rejects.toThrow("learning meter must combine");
  });
});
