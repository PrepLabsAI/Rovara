// DEC 236: the core engine agents' AI keys live in the model gateway. In company-key mode the agent route (/v1/messages, task
// tokens) sends ONLY the company's own connected key from the sealed company-level store (the one the learning route reads), the
// one combined company cap still applies, and a company with no usable key is refused with "connect an AI key": never Rovara's
// install key, never another company's key.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import type { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { AGENT_KEY_MISSING, AGENT_KEY_REFUSED, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps, claims, jwk, kid, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const keyOf = (cid: string) => `customer-key-${cid}`;

class CompanyKeys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  reads: string[] = [];
  lose = false;
  fail = false;
  providers: string[] = [];
  async connected(_iss: string, cid: string, provider: string): Promise<boolean> { this.providers.push(provider); if (this.fail) throw new Error("store down"); return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string, provider: string): Promise<string | undefined> { this.providers.push(provider); this.reads.push(cid); if (this.fail) throw new Error("store down"); return this.lose ? undefined : keyOf(cid); }
}

function companyGateway(overrides: Partial<GatewayDependencies> = {}) {
  const companyKeys = new CompanyKeys();
  const installKeyReads: string[] = [];
  const sent: ProviderRequest[] = [];
  const base = setup({
    agentKeys: companyKeys,
    keys: { keyFor: async (c) => { installKeyReads.push(c.cid); return "rovara-install-key"; } },
    transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
    ...overrides,
  });
  return { ...base, companyKeys, installKeyReads, sent };
}
const error = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const committed = async (meter: InMemoryMeter, cid = cidA) => (await meter.read({ ...scope, cid })).reduce((sum, row) => sum + row.committed, 0);

describe("agent route, company-key mode (DEC 236)", () => {
  it("sends the company's own connected key and never reads Rovara's install key", async () => {
    const g = companyGateway();
    const sink = await call(g.deps);
    expect(sink.status).toBe(200);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0]!.key).toBe(keyOf(cidA));
    expect(g.installKeyReads).toEqual([]);
    expect(g.companyKeys.reads).toEqual([cidA]);
    // The agent route speaks Anthropic Messages: only the company's Anthropic source is asked.
    expect(g.companyKeys.providers).toEqual(["anthropic", "anthropic"]);
  });

  it("each company's call goes out on that company's own key only (two companies)", async () => {
    const g = companyGateway();
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.sent.map((r) => r.key)).toEqual([keyOf(cidA), keyOf(cidB)]);
    // B without a key is refused while A still works: one company's key never serves another.
    g.companyKeys.connectedTo.delete(cidB);
    const refused = await call(g.deps, requestBody, mint({ cid: cidB }));
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect(g.sent.map((r) => r.key)).toEqual([keyOf(cidA), keyOf(cidB), keyOf(cidA)]);
    expect(g.installKeyReads).toEqual([]);
  });

  it("a company with no key connected is refused with 'connect an AI key' before anything is held or sent", async () => {
    const g = companyGateway();
    g.companyKeys.connectedTo.clear();
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: "no_ai_key", message: AGENT_KEY_MISSING.message });
    expect(AGENT_KEY_MISSING.message).toMatch(/^Connect an AI key/u);
    expect(g.sent).toEqual([]);
    expect(g.installKeyReads).toEqual([]);
    expect(g.companyKeys.reads).toEqual([]);
    for (const row of await g.meter.read(scope)) expect([row.committed, row.reservedMicros, row.spentMicros]).toEqual([0, 0, 0]);
  });

  it("a key gone between admission and sending is not sent: $0 and the same refusal, never the install key", async () => {
    const g = companyGateway();
    g.companyKeys.lose = true;
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink).type).toBe("no_ai_key");
    expect(g.sent).toEqual([]);
    expect(g.installKeyReads).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
  });

  it("an unreadable key store refuses with the fixed 503 and holds nothing", async () => {
    const g = companyGateway();
    g.companyKeys.fail = true;
    const sink = await call(g.deps);
    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: "unavailable", message: "model access unavailable" });
    expect(sink.text()).not.toContain("store down");
    expect(g.sent).toEqual([]);
    expect(g.installKeyReads).toEqual([]);
    for (const row of await g.meter.read(scope)) expect([row.committed, row.reservedMicros, row.spentMicros]).toEqual([0, 0, 0]);
  });

  it("a key read that fails after admission is not sent: the fixed 503 at $0", async () => {
    const g = companyGateway();
    let reads = 0;
    g.companyKeys.keyFor = async () => { reads++; throw new Error("store down"); };
    const sink = await call(g.deps);
    expect(reads).toBe(1);
    expect(sink.status).toBe(503);
    expect(sink.text()).not.toContain("store down");
    expect(g.sent).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
  });

  it("a provider answer echoing the company's key is cut, never streamed back", async () => {
    const echoed = keyOf(cidA);
    const g = companyGateway({ transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from(`event: message_start\ndata: {"type":"message_start","text":"${echoed}"}\n\n`); })() }) });
    const sink = await call(g.deps);
    expect(sink.text()).not.toContain(echoed);
  });

  it("the provider refusing the company's key is free and says to connect a working key", async () => {
    for (const status of [401, 403]) {
      const g = companyGateway({ transport: async () => ({ status, body: (async function* () { yield Buffer.from("{}"); })() }) });
      const sink = await call(g.deps);
      expect(sink.status).toBe(403);
      expect(error(sink)).toEqual({ type: "no_ai_key", message: AGENT_KEY_REFUSED.message });
      expect(await committed(g.meter)).toBe(0);
      expect(g.installKeyReads).toEqual([]);
    }
  });

  it("other provider failures keep the install-key route's accounting (500 charged, 429 free)", async () => {
    const g500 = companyGateway({ transport: async () => ({ status: 500, body: (async function* () { yield Buffer.from("{}"); })() }) });
    const s500 = await call(g500.deps);
    expect(s500.status).toBe(502);
    expect(await committed(g500.meter)).toBeGreaterThan(0);
    const g429 = companyGateway({ transport: async () => ({ status: 429, body: (async function* () { yield Buffer.from("{}"); })() }) });
    expect((await call(g429.deps)).status).toBe(502);
    expect(await committed(g429.meter)).toBe(0);
  });

  it("the combined company cap still applies on the company's own key", async () => {
    const g = companyGateway({ caps: new FixedCapsSource({ ...caps, companyMonth: 1 }) });
    const sink = await call(g.deps);
    expect(sink.status).toBe(422);
    expect(error(sink)).toEqual({ type: "budget_exceeded", message: "Budget has been exceeded! Team=company" });
    expect(g.sent).toEqual([]);
  });

  it("without company keys the agent route is the install-key route, as before", async () => {
    const g = setup();
    const sent: ProviderRequest[] = [];
    g.deps.transport = async (request) => { sent.push(request); return { status: 200, body: answer() }; };
    expect((await call(g.deps)).status).toBe(200);
    expect(sent[0]!.key).toBe(g.providerKey);
  });
});

// ---- the process setting -------------------------------------------------------------------------------------------------
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: "gwp-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:123456789012:key/0b5d3f9e-1111-2222-3333-444455556666",
  [GATEWAY_ENV.productMeterTable]: "gwp-meter", [GATEWAY_ENV.productLedgerTable]: "gwp-ledger", [GATEWAY_ENV.productMarkersTable]: "gwp-markers", [GATEWAY_ENV.evalStagesTable]: "gwp-stages",
};

describe("gateway setting GATEWAY_AGENT_KEYS", () => {
  it("absent: the config is exactly as before (install key)", () => {
    const config = readGatewayConfig(ENV) as ServeConfig;
    expect(Object.hasOwn(config, "agentKeys")).toBe(false);
  });
  it("company needs the product key store (the company's key lives there)", () => {
    expect(() => readGatewayConfig({ ...ENV, [GATEWAY_ENV.agentKeys]: "company" })).toThrow(new GatewayConfigError(GATEWAY_ENV.productKeysTable));
    expect((readGatewayConfig({ ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.agentKeys]: "company" }) as ServeConfig).agentKeys).toBe("company");
    expect((readGatewayConfig({ ...ENV, [GATEWAY_ENV.agentKeys]: "install" }) as ServeConfig).agentKeys).toBe("install");
  });
  it("any other value is refused by name", () => {
    for (const value of ["", "Company", "rovara", "company "]) expect(() => readGatewayConfig({ ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.agentKeys]: value })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) await gateway.drain(); });

describe("gateway process, company-key mode", () => {
  async function serve(agentKeys: LearningKeySource | undefined) {
    const wire = new WireDynamo(Object.values(TABLES), { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    await db.put(TABLES.companies, { pk: `COMPANY#${cidA}`, sk: "SETTINGS", companyId: cidA, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    await db.put(TABLES.companies, { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "anthropic_key", version: 1 });
    const sent: ProviderRequest[] = [];
    const installKeyReads: number[] = [];
    // The product route itself is given (no KMS here); company-key mode is set on the config.
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0, agentKeys: "company" };
    const gateway = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => { installKeyReads.push(1); return "rovara-install-key"; } },
      transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
      ...(agentKeys === undefined ? {} : { agentKeys }),
    });
    running.push(gateway);
    return { gateway, sent, installKeyReads };
  }
  function post(server: RunningGateway["server"], token: string): Promise<FakeResponse> {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    server.emit("request", req, res);
    return done;
  }

  it("serves agent calls on the company's key; the install key is not even read when one is given", async () => {
    const keys = new CompanyKeys();
    const s = await serve(keys);
    const res = await post(s.gateway.server, mint());
    expect(res.statusCode).toBe(200);
    expect(s.sent.map((r) => r.key)).toEqual([keyOf(cidA)]);
    expect(s.installKeyReads).toEqual([]);
  });

  it("refuses to start in company-key mode without a company key source (no silent fallback)", async () => {
    await expect(serve(undefined)).rejects.toThrow("company-key mode needs the company key store");
  });
});
