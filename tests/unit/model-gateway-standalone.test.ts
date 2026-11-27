import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticBudgetCaps, NO_CAP } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_ENV, GATEWAY_STANDALONE_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { OFFERED_MODELS_PATH, SERVICE_TOKEN_AUDIENCE } from "../../packages/model-gateway/src/offered-models.js";
import { LITELLM_URL } from "../../packages/model-gateway/src/price-sources.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { createStandaloneKeySource } from "../../packages/model-gateway/src/secrets.js";
import { claims, jwk, keys, kid, mint, now, scope, sse } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices" };
const ANTHROPIC_SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/test/anthropic-AbCdEf";
const OPENAI_SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/test/openai-AbCdEf";
const OPENROUTER_SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/test/openrouter-AbCdEf";

const BASE_STANDALONE_ENV = {
  [GATEWAY_ENV.mode]: "serve",
  AWS_REGION: "us-west-2",
  [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss,
  [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`,
  [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter,
  [GATEWAY_ENV.ledgerTable]: TABLES.ledger,
  [GATEWAY_ENV.markersTable]: TABLES.markers,
  [GATEWAY_ENV.pricesTable]: TABLES.prices,
  [GATEWAY_STANDALONE_ENV.defaultCompanyCapMicros]: "100000000",
  [GATEWAY_ENV.rovaraAiModels]: "on",
  [GATEWAY_STANDALONE_ENV.standaloneProvider]: "bedrock",
  [GATEWAY_STANDALONE_ENV.seedPricesOnStart]: "on",
};

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

function serviceToken(aud: string): string {
  const input = [
    JSON.stringify({ alg: "RS256", typ: "rovara-service+jwt", kid }),
    JSON.stringify({ iss: claims.iss, aud, cid: claims.cid, jti: "00000000-0000-4000-8000-000000000001", iat: now / 1000, nbf: now / 1000 - 30, exp: now / 1000 + 60 }),
  ].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

const litellmPayload = Buffer.from(JSON.stringify({
  "claude-sonnet-4-6": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6, max_output_tokens: 64_000 },
  "us.anthropic.claude-sonnet-4-6": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6, max_output_tokens: 64_000 },
  "claude-haiku-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, max_output_tokens: 64_000 },
  "gpt-5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 8e-6, max_output_tokens: 32_000 },
  ...Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`model-${String(i)}`, { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }])),
}));

const jwksAndPricesFetch: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  if (url === `${claims.iss}/.well-known/jwks.json`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  if (url === LITELLM_URL) {
    const response = new Response(litellmPayload, { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
  throw new Error(`unexpected fetch url in standalone test: ${url}`);
};

const running: RunningGateway[] = [];
afterEach(async () => { for (const gateway of running.splice(0)) { await gateway.drain(); } });

describe("standalone model-gateway config (issue #1554 phase 1)", () => {
  it("accepts standalone Bedrock, Anthropic, OpenAI, or OpenRouter without GATEWAY_COMPANY_TABLE or Cloud tables", () => {
    const bedrock = readGatewayConfig(BASE_STANDALONE_ENV) as ServeConfig;
    expect(bedrock.tables.companies).toBeUndefined();
    expect(bedrock.anthropicKeySecret).toBeUndefined();
    expect(bedrock.defaultCaps).toEqual({ companyMonth: 100_000_000 });
    expect(bedrock.standaloneProvider).toBe("bedrock");
    expect(bedrock.seedPricesOnStart).toBe(true);
    expect(bedrock.rovaraAi?.models.get("claude-sonnet-4-6")).toBe("us.anthropic.claude-sonnet-4-6");
    expect(bedrock.rovaraAi?.sourceId).toBe("standalone-bedrock@us-west-2");

    const anthropicOnly = readGatewayConfig({
      ...BASE_STANDALONE_ENV,
      [GATEWAY_ENV.rovaraAiModels]: undefined,
      [GATEWAY_STANDALONE_ENV.standaloneProvider]: "anthropic",
      [GATEWAY_ENV.anthropicKeySecret]: ANTHROPIC_SECRET,
      [GATEWAY_STANDALONE_ENV.defaultProjectCapMicros]: "50000000",
      [GATEWAY_STANDALONE_ENV.defaultTaskCapMicros]: "10000000",
    }) as ServeConfig;
    expect(anthropicOnly.anthropicKeySecret).toBe(ANTHROPIC_SECRET);
    expect(anthropicOnly.defaultCaps).toEqual({ companyMonth: 100_000_000, projectMonth: 50_000_000, task: 10_000_000 });

    const openaiOnly = readGatewayConfig({
      ...BASE_STANDALONE_ENV,
      [GATEWAY_ENV.rovaraAiModels]: undefined,
      [GATEWAY_STANDALONE_ENV.standaloneProvider]: "openai",
      [GATEWAY_STANDALONE_ENV.openaiKeySecret]: OPENAI_SECRET,
    }) as ServeConfig;
    expect(openaiOnly.openaiKeySecret).toBe(OPENAI_SECRET);

    const openrouterOnly = readGatewayConfig({
      ...BASE_STANDALONE_ENV,
      [GATEWAY_ENV.rovaraAiModels]: undefined,
      [GATEWAY_STANDALONE_ENV.standaloneProvider]: "openrouter",
      [GATEWAY_STANDALONE_ENV.openrouterKeySecret]: OPENROUTER_SECRET,
    }) as ServeConfig;
    expect(openrouterOnly.openrouterKeySecret).toBe(OPENROUTER_SECRET);
  });

  it("refuses missing default company cap, no provider, or mismatched standaloneProvider", () => {
    const cases: Array<[string, Record<string, string | undefined>]> = [
      [GATEWAY_STANDALONE_ENV.defaultCompanyCapMicros, { ...BASE_STANDALONE_ENV, [GATEWAY_STANDALONE_ENV.defaultCompanyCapMicros]: undefined }],
      [GATEWAY_STANDALONE_ENV.defaultCompanyCapMicros, { ...BASE_STANDALONE_ENV, [GATEWAY_STANDALONE_ENV.defaultCompanyCapMicros]: "0" }],
      [GATEWAY_ENV.anthropicKeySecret, { ...BASE_STANDALONE_ENV, [GATEWAY_ENV.rovaraAiModels]: undefined, [GATEWAY_STANDALONE_ENV.standaloneProvider]: undefined }],
      [GATEWAY_STANDALONE_ENV.openaiKeySecret, { ...BASE_STANDALONE_ENV, [GATEWAY_STANDALONE_ENV.standaloneProvider]: "openai" }],
      [GATEWAY_STANDALONE_ENV.seedPricesOnStart, { ...BASE_STANDALONE_ENV, [GATEWAY_STANDALONE_ENV.seedPricesOnStart]: "yes" }],
    ];
    for (const [variable, env] of cases) {
      let caught: unknown;
      try { readGatewayConfig(env); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GatewayConfigError);
      expect((caught as GatewayConfigError).variable).toBe(variable);
    }
  });

  it("StaticBudgetCaps validates scope and returns configured caps with NO_CAP defaults", async () => {
    const source = new StaticBudgetCaps({ companyMonth: 100_000_000, task: 5_000_000 });
    expect(await source.capsFor(scope)).toEqual({ companyMonth: 100_000_000, projectMonth: NO_CAP, task: 5_000_000 });
    expect(await source.capsFor({ ...scope, cid: "bad-company" })).toEqual({});
  });

  it("createStandaloneKeySource caches versioned secret identity matching resolveForCharge", async () => {
    let calls = 0;
    const keysSource = createStandaloneKeySource({
      region: "us-west-2",
      credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret" }),
      secretArns: { anthropic: ANTHROPIC_SECRET },
      transport: async () => {
        calls++;
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ SecretString: "sk-ant-api03-test-key", VersionId: "ver-42" })) };
      },
      now: () => now,
    });
    expect(await keysSource.connected(claims.iss, claims.cid, "anthropic")).toBe(true);
    expect(await keysSource.connected(claims.iss, claims.cid, "openai")).toBe(false);
    const id = await keysSource.identityFor!(claims.iss, claims.cid, "anthropic");
    const charge = await keysSource.resolveForCharge!(claims.iss, claims.cid, "anthropic");
    expect(calls).toBe(1);
    expect(id?.versionId).toBe("ver-42");
    expect(charge?.source.id).toBe(id?.sourceId);
    expect(charge?.source.connectionRevision).toBe(id?.versionId);
    expect(await charge?.key()).toBe("sk-ant-api03-test-key");
  });
});

describe("standalone model-gateway serving & cold-start price seeding", () => {
  it("seeds Prices on cold start, serves /healthz with runPrice.snapshotVersion >= 1, rate-quote?runPrice=1, offered-models, and signed-price /v1/messages on Bedrock", async () => {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret" }), transport: wire.transport });
    const config: ServeConfig = { ...(readGatewayConfig(BASE_STANDALONE_ENV) as ServeConfig), port: 0 };
    let bedrockSent = 0;
    const gateway = await startServe(config, {
      db, fetch: jwksAndPricesFetch, now: () => now, listen: false, log: () => undefined,
      bedrockTransport: async () => {
        bedrockSent++;
        return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 10 } } }); yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop"); })() };
      },
    });
    running.push(gateway);

    // 1. Cold-start seeding populated Prices and /healthz reports runPrice readiness immediately.
    const health = await request(gateway.server, "GET", "/healthz");
    expect(health.statusCode).toBe(200);
    const healthBody = JSON.parse(health.text()) as { ok: boolean; runPrice?: { version: number; admissionVersion: number; snapshotVersion: number } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.runPrice?.version).toBe(1);
    expect(healthBody.runPrice?.admissionVersion).toBe(1);
    expect(healthBody.runPrice?.snapshotVersion).toBeGreaterThanOrEqual(1);

    // 2. Offered models works without Cloud Companies table.
    const offeredPath = `/v1/service/companies/${claims.cid}/offered-models`;
    expect(OFFERED_MODELS_PATH.test(offeredPath)).toBe(true);
    const offered = await request(gateway.server, "GET", offeredPath, { authorization: `Bearer ${serviceToken(SERVICE_TOKEN_AUDIENCE)}` });
    expect(offered.statusCode).toBe(200);
    const offeredBody = JSON.parse(offered.text()) as { models: Array<{ model: string }> };
    expect(offeredBody.models.map((m) => m.model)).toContain("claude-sonnet-4-6");

    // 3. Rate quote with runPrice=1 returns signed runPrice grant for Bedrock.
    const quote = await request(gateway.server, "GET", `/v1/service/companies/${claims.cid}/rate-quote?model=claude-sonnet-4-6&runPrice=1`, { authorization: `Bearer ${serviceToken(RATE_QUOTE_AUDIENCE)}` });
    expect(quote.statusCode).toBe(200);
    const quoteBody = JSON.parse(quote.text()) as { state: string; runPrice?: Record<string, unknown> };
    expect(quoteBody.state).toBe("available");
    expect(quoteBody.runPrice).toMatchObject({ companyId: claims.cid, model: "claude-sonnet-4-6", provider: "bedrock", catalogModel: "us.anthropic.claude-sonnet-4-6" });

    // 4. Signed-price task token is admitted and routed to Bedrock with static caps (no Companies table).
    const token = mint({ mdl: ["claude-sonnet-4-6"], runPrice: quoteBody.runPrice as never });
    const call = await request(gateway.server, "POST", "/v1/messages", { "content-type": "application/json", "x-api-key": token }, { model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(call.statusCode).toBe(200);
    expect(bedrockSent).toBe(1);
    expect(call.text()).toContain("message_stop");
  });
});
