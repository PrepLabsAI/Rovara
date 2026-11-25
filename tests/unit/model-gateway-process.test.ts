import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter, HOLD_SWEEP_AGE_MS } from "../../packages/model-gateway/src/dynamo-meter.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { LITELLM_URL } from "../../packages/model-gateway/src/price-sources.js";
import type { ProductRouteResolver } from "../../packages/model-gateway/src/server.js";
import { GatewayConfigError, readGatewayConfig, runGateway, runPriceFetch, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { caps, claims, jwk, keys, kid, mint, now, requestBody, scope, sse } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf";
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: SECRET,
};
// A second key Code publishes for sign-in (ADDENDUM-4): purpose "developer". Its kid is listed here on purpose, as a
// misconfigured CodeTaskKeyIds would: the purpose filter must still refuse it.
const developer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const developerKid = createHash("sha256").update(developer.publicKey.export({ type: "spki", format: "der" })).digest("base64url").slice(0, 16);
const developerJwk = { ...developer.publicKey.export({ format: "jwk" }), kid: developerKid, alg: "RS256", use: "sig", rovara_purpose: "developer" };
function mintWithDeveloperKey(): string {
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-task+jwt", kid: developerKid }), JSON.stringify(claims)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), developer.privateKey).toString("base64url")}`;
}

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false; finished = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.finished = true; this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
function request(server: RunningGateway["server"], method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<FakeResponse> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers });
  const res = new FakeResponse();
  const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
  server.emit("request", req, res);
  return done;
}
const callHeaders = (token = mint()) => ({ "content-type": "application/json", "x-api-key": token });
const jwksFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [developerJwk, jwk] }), { status: 200 });

const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) { await gateway.drain(); } });

function serve(options: { gate?: Promise<void>; caps?: boolean } = {}) {
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
  const lines: Array<Record<string, unknown>> = [];
  let sent = 0;
  const config: ServeConfig = { ...(readGatewayConfig({ ...ENV, [GATEWAY_ENV.installTaskKids]: `${kid},${developerKid}` }) as ServeConfig), port: 0 };
  const start = startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: (line) => lines.push(line),
    keys: { keyFor: async () => "fixture-provider-key" },
    ...(options.caps === false ? {} : { caps: new FixedCapsSource(caps) }),
    transport: async () => { sent++; return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 2 } } }); await options.gate; yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop"); })() }; },
  });
  return { wire, db, lines, start, sent: () => sent };
}

describe("gateway process: settings", () => {
  it("reads every setting from deploy.ts's names and refuses a bad one by name, never echoing the value", () => {
    expect(readGatewayConfig(ENV)).toEqual({ mode: "serve", region: "us-west-2", port: 8080, install: { issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }, tables: TABLES, anthropicKeySecret: SECRET });
    expect(readGatewayConfig({ [GATEWAY_ENV.mode]: "price-fetch", AWS_REGION: "us-west-2", [GATEWAY_ENV.pricesTable]: "gw-prices" })).toEqual({ mode: "price-fetch", region: "us-west-2", tables: { prices: "gw-prices" } });
    const bad: Array<[string, string | undefined]> = [
      [GATEWAY_ENV.installJwksUrl, "https://evil.example/jwks.json"], [GATEWAY_ENV.installIssuer, "http://install-a.example/v1/auth"],
      [GATEWAY_ENV.installTaskKids, "a,b,c"], [GATEWAY_ENV.anthropicKeySecret, "sk-ant-api03-not-an-arn"], [GATEWAY_ENV.mode, "debug"], [GATEWAY_ENV.meterTable, undefined], [GATEWAY_ENV.port, "99999"],
    ];
    for (const [name, value] of bad) {
      const error = (() => { try { readGatewayConfig({ ...ENV, [name]: value }); return undefined; } catch (e) { return e; } })();
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as GatewayConfigError).variable).toBe(name === GATEWAY_ENV.installIssuer ? GATEWAY_ENV.installIssuer : name);
      if (value !== undefined) expect(String(error)).not.toContain(value);
    }
  });

  it("a bad setting exits 2 with the variable's name in the log; SIGTERM drains then exits 0", async () => {
    const exits: number[] = []; const lines: Array<Record<string, unknown>> = [];
    await runGateway({ ...ENV, [GATEWAY_ENV.anthropicKeySecret]: "sk-ant-api03-secret" }, { onSignal: () => undefined, exit: (code) => exits.push(code) }, { log: (line) => lines.push(line) });
    expect(exits).toEqual([2]);
    expect(lines).toEqual([{ event: "config_invalid", variable: GATEWAY_ENV.anthropicKeySecret }]);
    const signals = new Map<string, () => void>();
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport });
    const gateway = await runGateway(ENV, { onSignal: (signal, handler) => signals.set(signal, handler), exit: (code) => exits.push(code) }, { db, fetch: jwksFetch, listen: false, log: (line) => lines.push(line), keys: { keyFor: async () => "k".repeat(10) } });
    expect(gateway).toBeDefined();
    expect([...signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    signals.get("SIGTERM")!();
    await gateway!.drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual([2, 0]);
    expect(lines.map((line) => line.event)).toEqual(expect.arrayContaining(["started", "draining", "stopped"]));
  });
});

describe("gateway process: serving", () => {
  it("answers the health check, streams a call, and on drain fails health and refuses new calls while the open call finishes and settles", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = serve({ gate });
    const gateway = await f.start; running.push(gateway);
    expect(f.lines[0]).toMatchObject({ event: "started", mode: "serve" });
    expect((await request(gateway.server, "GET", "/healthz")).statusCode).toBe(200);
    const open = request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody);
    while (f.sent() === 0) await new Promise((resolve) => setImmediate(resolve));
    const draining = gateway.drain();
    expect(gateway.draining()).toBe(true);
    const health = await request(gateway.server, "GET", "/healthz");
    expect([health.statusCode, health.headers.connection]).toEqual([503, "close"]);
    expect((await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody)).statusCode).toBe(503);
    let stopped = false; void draining.then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    const done = await open;
    expect(done.statusCode).toBe(200);
    expect(done.text()).toContain("message_stop");
    await draining;
    const events = f.lines.map((line) => line.event);
    expect(events.indexOf("draining")).toBeLessThan(events.indexOf("settled"));
    expect(events.indexOf("settled")).toBeLessThan(events.indexOf("stopped"));
    const rows = await new DynamoMeter({ db: f.db, tables: TABLES, now: () => now }).read(scope);
    expect(rows.every((row) => row.spentMicros > 0 && row.reservedMicros === 0)).toBe(true);
    for (const line of f.lines) expect(JSON.stringify(line)).not.toMatch(/fixture-provider-key|eyJ/u);
  });

  it("accepts only keys published for tasks: a token signed with Code's developer-purpose key is refused like an unknown key", async () => {
    const f = serve();
    const gateway = await f.start; running.push(gateway);
    const refused = await request(gateway.server, "POST", "/v1/messages", callHeaders(mintWithDeveloperKey()), requestBody);
    expect(refused.statusCode).toBe(401);
    expect(JSON.parse(refused.text())).toEqual({ error: { type: "authentication_error", message: "invalid or expired model access" } });
    const unknown = await request(gateway.server, "POST", "/v1/messages", callHeaders(mint({}, { kid: "AAAAAAAAAAAAAAAA" })), requestBody);
    expect([unknown.statusCode, unknown.text()]).toEqual([refused.statusCode, refused.text()]);
    expect(f.sent()).toBe(0);
    expect((await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody)).statusCode).toBe(200);
    expect(f.lines.filter((line) => line.event === "refused")).toHaveLength(2);
  });

  it("reads the company's budgets from the Cloud company backend's table: none set refuses 503 before any provider call; set, the task cap holds", async () => {
    const f = serve({ caps: false });
    const gateway = await f.start; running.push(gateway);
    const answer = await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody);
    expect([answer.statusCode, JSON.parse(answer.text())]).toEqual([503, { error: { type: "unavailable", message: "model access unavailable" } }]);
    expect(f.sent()).toBe(0);
    expect(f.lines.at(-1)).toMatchObject({ event: "refused" });
    const budgets = (taskUsdMicros: number) => f.db.put(TABLES.companies, { pk: `COMPANY#${claims.cid}`, sk: "SETTINGS", companyId: claims.cid, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 1_000_000_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros } } });
    await budgets(1);
    const capped = await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody);
    expect([capped.statusCode, (JSON.parse(capped.text()) as { error: { message: string } }).error.message]).toEqual([422, "Budget has been exceeded! Key=task"]);
    expect(f.sent()).toBe(0);
    await budgets(1_000_000_000);
    expect((await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody)).statusCode).toBe(200);
    expect(f.sent()).toBe(1);
  });

  it("runs a bounded maintenance pass: reloads prices, sweeps expiry, runs corrections, closes holds left open, logs each", async () => {
    const f = serve();
    const gateway = await f.start; running.push(gateway);
    await gateway.maintain();
    expect(f.lines.at(-1)).toMatchObject({ event: "maintenance", corrected: 0, expired: 0, unknown: 0 });
    // A hold taken long ago whose settle never landed (its server stopped): the next pass closes it at its estimate.
    const old = await new DynamoMeter({ db: f.db, tables: TABLES, now: () => now - HOLD_SWEEP_AGE_MS - 1 }).reserve({ scope, caps, estimateMicros: 25 });
    expect(old.ok).toBe(true);
    await gateway.maintain();
    expect(f.lines.filter((line) => line.event === "holds_swept")).toEqual([expect.objectContaining({ swept: 1, failed: 0 })]);
    expect((await new DynamoMeter({ db: f.db, tables: TABLES, now: () => now - HOLD_SWEEP_AGE_MS - 1 }).read(scope))[0]).toMatchObject({ spentMicros: 25, reservedMicros: 0 });
  });
});

describe("gateway process: product route", () => {
  it("mounts the product resolver and runs the product meter's hold sweep, expiry and corrections in the same pass", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const lines: Array<Record<string, unknown>> = [];
    const swept: number[] = [];
    // A meter must say which tables it combines with and owns (a DynamoMeter does), so the startup checks can see them.
    const productMeter = Object.assign(new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: new InMemoryMeter(() => now) }), { sweepOpenHolds: async (at: number) => { swept.push(at); return { swept: 2, already: 0, failed: 0, more: false }; }, combinedTables: () => ({ meter: TABLES.meter, markers: TABLES.markers }), ownTables: () => ({ meter: "p-meter", ledger: "p-ledger", markers: "p-markers" }) });
    const routes = { route: () => undefined };
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const stageSweeps: number[] = [];
    const stages = { sweep: async (at?: number) => { stageSweeps.push(at ?? -1); return { released: 1, failed: 0 }; } };
    const gateway = await startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: (line) => lines.push(line), keys: { keyFor: async () => "fixture-provider-key" }, caps: new FixedCapsSource(caps), product: { routes, meter: productMeter, caps: new FixedCapsSource(caps), stages } });
    running.push(gateway);
    await gateway.maintain();
    expect(swept).toEqual([now]);
    // Expired eval stages are released in the same pass, before the meter's open-hold sweep.
    expect(stageSweeps).toEqual([now]);
    // Given only to the route (createProductRoutes evalStages), the pass still releases them.
    const routeSweeps: number[] = [];
    const routed = await startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, caps: new FixedCapsSource(caps), product: { routes: { route: () => undefined, evalStages: { sweep: async (at?: number) => { routeSweeps.push(at ?? -1); return { released: 0, failed: 0 }; } } } as unknown as ProductRouteResolver, meter: productMeter, caps: new FixedCapsSource(caps) } });
    running.push(routed);
    await routed.maintain();
    expect(routeSweeps).toEqual([now]);
    expect(lines).toContainEqual({ event: "eval_stages_released", route: "product", released: 1, failed: 0 });
    expect(lines).toContainEqual(expect.objectContaining({ event: "holds_swept", route: "product", swept: 2 }));
    expect(lines.some((line) => line.event === "maintenance_failed")).toBe(false);
    // A failing product sweep is logged and never stops the agent pass.
    productMeter.sweepOpenHolds = async () => { throw new Error("down"); };
    await gateway.maintain();
    expect(lines).toContainEqual({ event: "maintenance_failed", route: "product" });
    expect(lines.filter((line) => line.event === "maintenance")).toHaveLength(2);
  });
});

describe("gateway process: one combined company cap (DEC 228c)", () => {
  it("refuses to start a product route whose meter does not take the agent meter's company row", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const productMeter = Object.assign(new InMemoryMeter(() => now), { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    await expect(startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, caps: new FixedCapsSource(caps), product: { routes: { route: () => undefined }, meter: productMeter, caps: new FixedCapsSource(caps) } }))
      .rejects.toThrow("product meter must combine the company cap with the agent meter");
    expect(wire.calls).toHaveLength(0);
  });
});

describe("gateway process: the product meter combines with THIS agent meter", () => {
  it("refuses a product DynamoMeter combined with other tables", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const productMeter = new DynamoMeter({ db, tables: { meter: "p-meter", ledger: "p-ledger", markers: "p-markers" }, combinedCompany: { meter: "someone-elses-meter", markers: config.tables.markers } });
    await expect(startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, caps: new FixedCapsSource(caps), product: { routes: { route: () => undefined }, meter: productMeter, caps: new FixedCapsSource(caps) } }))
      .rejects.toThrow("product meter must combine the company cap with the agent meter");
  });
});

describe("gateway process: a wired product meter must show its tables (DEFERRED GATEWAY-LEARNING-FOLLOWUPS-2)", () => {
  const fixture = () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0 };
    const start = (meter: unknown) => startServe(config, { db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "fixture-provider-key" }, caps: new FixedCapsSource(caps), product: { routes: { route: () => undefined }, meter: meter as never, caps: new FixedCapsSource(caps) } });
    return { db, start };
  };
  const sweep = { sweepOpenHolds: async () => ({ swept: 0, already: 0, failed: 0, more: false }) };
  it("refuses a meter that combines but cannot say which tables (an in-memory meter, or a half-given view)", async () => {
    const { start } = fixture();
    const combined = () => new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: new InMemoryMeter(() => now) });
    await expect(start(Object.assign(combined(), sweep))).rejects.toThrow("product meter must expose its tables");
    await expect(start(Object.assign(combined(), sweep, { combinedTables: () => ({ meter: TABLES.meter, markers: TABLES.markers }) }))).rejects.toThrow("product meter must expose its tables");
    await expect(start(Object.assign(combined(), sweep, { ownTables: () => ({ meter: "p-meter", ledger: "p-ledger", markers: "p-markers" }) }))).rejects.toThrow("product meter must expose its tables");
  });
  it("refuses a product meter whose ledger is the agent meter's (DynamoMeter itself already refuses its meter or markers table being the agent's)", async () => {
    const { db, start } = fixture();
    const own = (tables: { meter: string; ledger: string; markers: string }) => Object.assign(new DynamoMeter({ db, tables, now: () => now, combinedCompany: { meter: TABLES.meter, markers: TABLES.markers } }), sweep);
    await expect(start(own({ meter: "p-meter", ledger: TABLES.ledger, markers: "p-markers" }))).rejects.toThrow("product meter must have tables of its own");
    expect(() => own({ meter: TABLES.meter, ledger: "p-ledger", markers: "p-markers" })).toThrow();
    running.push(await start(own({ meter: "p-meter", ledger: "p-ledger", markers: "p-markers" })));
  });
});

describe("gateway process: price fetch", () => {
  const litellm = Buffer.from(JSON.stringify(Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`model-${String(i)}`, { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }]))));
  const fakeFetch = (litellmOk: boolean): typeof fetch => async (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url === LITELLM_URL && litellmOk) { const response = new Response(litellm, { status: 200 }); Object.defineProperty(response, "url", { value: url }); return response; }
    throw new Error("unreachable in this test");
  };
  it("writes only the prices table, keeps what one source gave, and logs price_fetch_failed when a source fails", async () => {
    const wire = new WireDynamo([TABLES.prices]);
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport });
    const lines: Array<Record<string, unknown>> = [];
    expect(await runPriceFetch({ mode: "price-fetch", region: "us-west-2", tables: { prices: TABLES.prices } }, { db, fetch: fakeFetch(true), log: (line) => lines.push(line), now: () => now })).toBe(1);
    expect(lines.at(-1)).toEqual({ event: "price_fetch_failed" });
    expect(wire.items(TABLES.prices).find((item) => item.sk === "HEAD")).toMatchObject({ version: 1 });
    expect(new Set(wire.calls.map((call) => call.table))).toEqual(new Set([TABLES.prices]));
    const empty = new WireDynamo([TABLES.prices]);
    const emptyDb = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: empty.transport });
    expect(await runPriceFetch({ mode: "price-fetch", region: "us-west-2", tables: { prices: TABLES.prices } }, { db: emptyDb, fetch: fakeFetch(false), log: (line) => lines.push(line), now: () => now })).toBe(1);
    expect(empty.items(TABLES.prices)).toEqual([]);
  });
});

it("the deployed process writes revision-one receipts bound to the connected source and its saved revision", async () => {
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), agentKeys: "company", port: 0 };
  const source = { kind: "company_key" as const, id: "saved-source-1", name: "Company anthropic", provider: "anthropic", connectionRevision: "saved-version-7" };
  const gateway = await startServe(config, {
    db, fetch: jwksFetch, now: () => now, listen: false, log: () => undefined,
    caps: new FixedCapsSource(caps), agentAiSources: { sourceFor: async () => "anthropic_key" },
    agentKeys: {
      connected: async () => true,
      keyFor: async () => { throw new Error("unbound credential read"); },
      resolveForCharge: async () => ({ source, key: async () => "fixture-provider-key" }),
    },
    transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: {} }); })() }),
  });
  running.push(gateway);
  const response = await request(gateway.server, "POST", "/v1/messages", callHeaders(), requestBody);
  expect(response.statusCode).toBe(200);
  await gateway.drain();
  const calls = wire.items(TABLES.ledger).filter(row => String(row.sk).startsWith("CALL#"));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ revision: 1, chargeStatus: "awaiting_usage", receipt: { source, billing: "external_provider", status: "awaiting_usage", usageComplete: false } });
  expect(wire.items(TABLES.ledger).some(row => String(row.sk).startsWith("ADJUST#"))).toBe(true);
});

it("registers the signed company price read in the serving route table", async () => {
  const { RATE_QUOTE_AUDIENCE } = await import("../../packages/model-gateway/src/rate-quote.js");
  const wire = new WireDynamo(Object.values(TABLES));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), transport: wire.transport });
  const config = { ...(readGatewayConfig(ENV) as ServeConfig), agentKeys: "company" as const };
  const gateway = await startServe(config, { db, now: () => now, fetch: jwksFetch, listen: false, log: () => undefined, agentKeys: { connected: async () => true, keyFor: async () => { throw new Error("must not open a key"); }, identityFor: async () => ({ sourceId: "own", versionId: "1" }) }, agentAiSources: { sourceFor: async () => "anthropic_key" } });
  running.push(gateway);
  const path = `/v1/service/companies/${claims.cid}/rate-quote?model=claude-test`;
  expect((await request(gateway.server, "GET", path)).statusCode).toBe(401);
  const input = [JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid }), JSON.stringify({ iss: claims.iss, aud: RATE_QUOTE_AUDIENCE, cid: claims.cid, jti: "00000000-0000-4000-8000-000000000001", iat: now / 1000, nbf: now / 1000 - 30, exp: now / 1000 + 60 })].map((v) => Buffer.from(v).toString("base64url")).join(".");
  const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  const answer = await request(gateway.server, "GET", path, { authorization: `Bearer ${token}` });
  expect(answer.statusCode).toBe(200);
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(answer.text())).toEqual({ state: "unavailable", reason: "missing_price" });
});
