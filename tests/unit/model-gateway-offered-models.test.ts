// "Agents pick models" (DEC 243c, DEC 236j): the gateway answers one company's offered agent models to Code's broker. The core rule is
// company isolation: company B's caller never gets A's list. Auth is the install's task key signing a short service token.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { createHash, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseRovaraAiModels, ROVARA_AI_US_CONVERSE_MODELS, ROVARA_AI_US_MODELS, type AgentAiSource, type AgentAiSourceReader } from "../../packages/model-gateway/src/agent-ai.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { StaticInstallRegistry } from "../../packages/model-gateway/src/installs.js";
import {
  AGENT_MODELS_DISABLED_DEFAULT, ANTHROPIC_KEY_AGENT_MODELS, answerOfferedModels, createOfferedModelsHandler, offeredModelPrice, OFFERED_MODELS_MAX, OFFERED_MODELS_PER_MINUTE,
  OFFERED_SWITCHED_OFF, OPENAI_KEY_AGENT_MODELS, parseDisabledAgentModels, SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_KIND, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE, type OfferedModelsHandlerOptions,
} from "../../packages/model-gateway/src/offered-models.js";
import type { OpenRouterTariff } from "../../packages/model-gateway/src/openrouter-policy.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { createSignedTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, keys, kid, mint, now, requestBody } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

// ---- Code's contract, copied from PrepLabsAI/Rovara-Code PR #771 (packages/contracts/src/agent-model-choice.ts at 6a2a8d3d3) -----------------
const AGENT_MODEL_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62})$/u;
const CodeOfferedAgentModelsSchema = z.object({
  version: z.literal(1),
  models: z.array(z.object({ model: z.string().regex(AGENT_MODEL_NAME) }).strict()).min(1).max(64),
}).strict().superRefine((list, context) => {
  if (new Set(list.models.map((entry) => entry.model)).size !== list.models.length) context.addIssue({ code: "custom", path: ["models"], message: "a model is listed once" });
});

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const ISS = claims.iss;
const RESOLVED = parseRovaraAiModels(`${ROVARA_AI_US_MODELS},${ROVARA_AI_US_CONVERSE_MODELS}`, "us-west-2");
const CLAUDE_OFFERED = ["claude-haiku-4-5", "claude-haiku-5-5"];
const BEDROCK_17 = ROVARA_AI_US_CONVERSE_MODELS.split(",").map((pair) => pair.split("=")[0]!);
const secs = now / 1000;

function mintService(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const body = { iss: ISS, aud: SERVICE_TOKEN_AUDIENCE, jti: randomUUID(), iat: secs, nbf: secs - 30, exp: secs + SERVICE_TOKEN_SECONDS, cid: cidA, ...changes };
  const input = [JSON.stringify({ alg: "RS256", typ: SERVICE_TOKEN_TYPE, kid, ...header }), JSON.stringify(body)].map((v) => Buffer.from(v).toString("base64url")).join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
const verify = () => createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: async () => [jwk], now: () => now }, SERVICE_TOKEN_KIND);

class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  readonly asked: string[] = [];
  fail = false;
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { this.asked.push(cid); if (this.fail) throw new Error("store down"); return this.saved.get(cid); }
}
function options(overrides: Partial<OfferedModelsHandlerOptions> = {}, rovaraOff = false) {
  const choices = new Choices();
  choices.saved.set(cidA, "rovara"); choices.saved.set(cidB, "anthropic_key");
  const opts: OfferedModelsHandlerOptions = { verify: verify(), sources: choices, ...(rovaraOff ? {} : { rovara: { models: RESOLVED } }), disabled: new Set(AGENT_MODELS_DISABLED_DEFAULT), now: () => now, ...overrides };
  return { opts, choices };
}
const pathOf = (cid: string) => `/v1/service/companies/${cid}/offered-models`;
const get = (opts: OfferedModelsHandlerOptions, cid: string, token: string | undefined, extra: Record<string, string> = {}, method = "GET", url = pathOf(cid)) =>
  answerOfferedModels(opts, { method, url, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...extra } });
const names = (body: unknown) => (body as { models: Array<{ model: string }> }).models.map((m) => m.model);

describe("the list one company is offered", () => {
  it("Rovara's AI: the 17 Bedrock coding models and the Claude models that are enabled, one name per model, no disabled one", async () => {
    const { opts } = options();
    const answer = await get(opts, cidA, mintService());
    expect(answer.status).toBe(200);
    expect(names(answer.body)).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
    expect(names(answer.body)).toHaveLength(19);
    for (const off of AGENT_MODELS_DISABLED_DEFAULT) expect(names(answer.body)).not.toContain(off);
    expect(names(answer.body)).not.toContain("claude-haiku-4-5-20251001");
    // Every name is exactly an id the gateway's allow-list calls.
    for (const name of names(answer.body)) expect(RESOLVED.has(name)).toBe(true);
  });
  it("once the operator enables the three models they are offered: 5 Claude + 17 Bedrock", async () => {
    const { opts } = options({ disabled: parseDisabledAgentModels("") });
    expect(names((await get(opts, cidA, mintService())).body)).toEqual(["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", ...BEDROCK_17]);
  });
  it("an explicit own key offers Anthropic models; deleting the choice returns to the Rovara default", async () => {
    const { opts, choices } = options();
    expect(names((await get(opts, cidB, mintService({ cid: cidB }))).body)).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    choices.saved.delete(cidB);
    expect(names((await get(opts, cidB, mintService({ cid: cidB }))).body)).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
  });
  it("the Anthropic list is the Claude names of the Rovara allow-list, one per model", () => {
    const seen = new Set<string>(); const claude: string[] = [];
    for (const [name, id] of parseRovaraAiModels(ROVARA_AI_US_MODELS, "us-west-2")) if (!seen.has(id)) { seen.add(id); claude.push(name); }
    expect([...ANTHROPIC_KEY_AGENT_MODELS]).toEqual(claude);
  });
  it("the answer is byte for byte Code's OfferedAgentModels (strict, 1 to 64, unique, name pattern)", async () => {
    for (const [cid, disabled] of [[cidA, AGENT_MODELS_DISABLED_DEFAULT], [cidA, []], [cidB, []]] as const) {
      const { opts } = options({ disabled: new Set(disabled) });
      const answer = await get(opts, cid, mintService({ cid }));
      const text = JSON.stringify(answer.body);
      expect(CodeOfferedAgentModelsSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(text).toBe(JSON.stringify({ version: 1, models: names(answer.body).map((model) => ({ model })) }));
      expect(Object.keys(answer.body as object)).toEqual(["version", "models"]);
    }
  });
  it("is bounded: at most 64 names and a small body, even from an oversized or odd allow-list", async () => {
    const big = new Map<string, string>(Array.from({ length: 200 }, (_, i) => [`m${i}.v1:0`, `us.m${i}.v1:0`]));
    big.set("bad name", "x.y"); big.set("", "z.z");
    const { opts } = options({ rovara: { models: big }, disabled: new Set() });
    const answer = await get(opts, cidA, mintService());
    expect(names(answer.body).length).toBeLessThanOrEqual(OFFERED_MODELS_MAX);
    expect(JSON.stringify(answer.body).length).toBeLessThan(8_192);
    expect(CodeOfferedAgentModelsSchema.safeParse(answer.body).success).toBe(true);
  });
  it("never an empty list: a refusal (every model disabled; Rovara's AI off; own Bedrock not built)", async () => {
    const all = options({ disabled: new Set(RESOLVED.keys()) });
    expect((await get(all.opts, cidA, mintService())).status).toBe(503);
    const off = options({}, true);
    expect((await get(off.opts, cidA, mintService())).status).toBe(403);
    const byo = options(); byo.choices.saved.set(cidA, "bedrock_byo"); // no own-Bedrock support built here
    expect((await get(byo.opts, cidA, mintService())).status).toBe(403);
    for (const a of [await get(all.opts, cidA, mintService()), await get(off.opts, cidA, mintService())]) expect(Object.keys((a.body as { error: object; models?: unknown }))).toEqual(["error"]);
  });
  it("a source that cannot be read answers unavailable, never a guess", async () => {
    const { opts, choices } = options(); choices.fail = true;
    const answer = await get(opts, cidA, mintService());
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("store down");
  });
});

describe("bring your own Bedrock (DEC 238): the company's own connection is the list", () => {
  const connection = (models: Record<string, string>) => ({ row: {} as never, connection: { scheme: "assume_role", roleArn: "arn:aws:iam::111122223333:role/RovaraBedrockInvoke-x", region: "us-west-2", models, allowGlobal: false } as const });
  function byoSetup() {
    const asked: Array<[string, string]> = [];
    const store = new Map<string, Record<string, string>>([
      [cidA, { "claude-sonnet-5-5": "us.anthropic.claude-sonnet-5-5", "claude-haiku-5-5": "us.anthropic.claude-haiku-5-5", "qwen.qwen3-coder-480b-a35b-v1:0": "qwen.qwen3-coder-480b-a35b-v1:0", "bad name": "us.anthropic.claude-x" }],
      [cidB, { "claude-opus-5-5": "global.anthropic.claude-opus-5-5" }],
    ]);
    const byo = { connection: async (iss: string, cid: string) => { asked.push([iss, cid]); const models = store.get(cid); return models === undefined ? undefined : connection(models); } };
    const { opts, choices } = options({ byo });
    choices.saved.set(cidA, "bedrock_byo"); choices.saved.set(cidB, "bedrock_byo");
    return { opts, choices, asked, store };
  }
  it("offers exactly the Claude names the company connected (not Rovara's list, not the disabled list, no non-Claude id, no bad name)", async () => {
    const { opts, asked } = byoSetup();
    const a = await get(opts, cidA, mintService());
    expect(a.status).toBe(200);
    expect(names(a.body)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(CodeOfferedAgentModelsSchema.safeParse(a.body).success).toBe(true);
    expect(asked).toEqual([[ISS, cidA]]);
  });
  it("B's token reads only B's connection; a mismatched path reads nothing", async () => {
    const { opts, asked } = byoSetup();
    expect(names((await get(opts, cidB, mintService({ cid: cidB }))).body)).toEqual(["claude-opus-5-5"]);
    expect((await get(opts, cidA, mintService({ cid: cidB }))).status).toBe(401);
    expect(asked).toEqual([[ISS, cidB]]);
  });
  it("not connected: 403 in the agent route's words; unreadable: 503; not built on this gateway: 403; no Claude model: refusal", async () => {
    const s = byoSetup();
    s.store.delete(cidA);
    const none = await get(s.opts, cidA, mintService());
    expect(none.status).toBe(403); expect(JSON.stringify(none.body)).toContain("Connect your Bedrock");
    const failing = options({ byo: { connection: async () => { throw new Error("sealed store down"); } } }); failing.choices.saved.set(cidA, "bedrock_byo");
    const down = await get(failing.opts, cidA, mintService());
    expect(down.status).toBe(503); expect(JSON.stringify(down.body)).not.toContain("sealed");
    const off = options(); off.choices.saved.set(cidA, "bedrock_byo");
    expect((await get(off.opts, cidA, mintService())).status).toBe(403);
    s.store.set(cidA, { "qwen.qwen3-coder-480b-a35b-v1:0": "qwen.qwen3-coder-480b-a35b-v1:0" });
    expect((await get(s.opts, cidA, mintService())).status).toBe(503);
  });
});

describe("company isolation", () => {
  it("B's token never reads A's list or source, whatever address it asks", async () => {
    const { opts, choices } = options();
    const tokenB = mintService({ cid: cidB });
    expect((await get(opts, cidA, tokenB)).status).toBe(401);
    expect((await get(opts, cidB, tokenB)).status).toBe(200);
    expect(choices.asked).toEqual([cidB]);
    const tokenA = mintService({ cid: cidA });
    expect((await get(opts, cidB, tokenA)).status).toBe(401);
    expect(choices.asked).toEqual([cidB]);
  });
  it("A and B each get their own source's list in turn (no shared state between calls)", async () => {
    const { opts } = options();
    const a1 = names((await get(opts, cidA, mintService())).body);
    const b1 = names((await get(opts, cidB, mintService({ cid: cidB }))).body);
    const a2 = names((await get(opts, cidA, mintService())).body);
    expect(a1).toEqual(a2);
    expect(b1).not.toEqual(a1);
    expect(b1).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
  });
  it("the refusal for a wrong company and for no token are the same bytes (nothing about either company)", async () => {
    const { opts } = options();
    const wrong = await get(opts, cidA, mintService({ cid: cidB }));
    const none = await get(opts, cidA, undefined);
    expect(JSON.stringify(wrong)).toBe(JSON.stringify(none));
  });
});

describe("authentication", () => {
  const refused = async (token: string | undefined, extra: Record<string, string> = {}, method = "GET") => (await get(options().opts, cidA, token, extra, method)).status;
  it("takes only a Bearer token of the install's task key", async () => {
    expect(await refused(undefined)).toBe(401);
    expect(await refused("")).toBe(401);
    expect(await refused("a.b.c")).toBe(401);
    expect((await get(options().opts, cidA, mintService(), { "x-api-key": mintService() })).status).toBe(401);
    expect((await answerOfferedModels(options().opts, { method: "GET", url: pathOf(cidA), headers: { authorization: `Basic ${mintService()}` } })).status).toBe(401);
    expect((await answerOfferedModels(options().opts, { method: "GET", url: pathOf(cidA), headers: { "x-api-key": mintService() } })).status).toBe(401);
  });
  it("a valid token is accepted (control)", async () => { expect(await refused(mintService())).toBe(200); });
  it("a task token (the agent route's) never opens it", async () => {
    expect(await refused(mint({ cid: cidA }))).toBe(401);
  });
  it("refuses a service token that is wrong in any member", async () => {
    const bad: Array<[string, string]> = [
      ["wrong audience", mintService({ aud: "rovara-model-gateway" })],
      ["wrong type", mintService({}, { typ: "rovara-task+jwt" })],
      ["wrong issuer", mintService({ iss: "https://other.example/v1/auth" })],
      ["expired", mintService({ iat: secs - 400, nbf: secs - 430, exp: secs - 340 })],
      ["not yet valid", mintService({ iat: secs + 300, nbf: secs + 270, exp: secs + 360 })],
      ["too long lived", mintService({ exp: secs + SERVICE_TOKEN_SECONDS + 1 })],
      ["bad nbf", mintService({ nbf: secs })],
      ["extra claim", mintService({ pid: "web" })],
      ["task claims", mintService({ pid: "web", pay: { kind: "member", developerId: "a".repeat(64) }, tid: "t", ws: randomUUID(), op: randomUUID(), stp: "build", mdl: ["claude-haiku-5-5"] })],
      ["bad company id", mintService({ cid: "org_x" })],
      ["bad jti", mintService({ jti: "1" })],
      ["unpinned key id", mintService({}, { kid: "0000000000000000" })],
      ["extra header member", mintService({}, { cty: "x" })],
      ["wrong algorithm", mintService({}, { alg: "none" })],
    ];
    for (const [why, token] of bad) expect([why, await refused(token)]).toEqual([why, 401]);
    const missing = JSON.parse(Buffer.from(mintService().split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    delete missing.jti;
    const input = [JSON.stringify({ alg: "RS256", typ: SERVICE_TOKEN_TYPE, kid }), JSON.stringify(missing)].map((v) => Buffer.from(v).toString("base64url")).join(".");
    expect(await refused(`${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`)).toBe(401);
  });
  it("refuses a tampered signature or payload, and a token signed by another key", async () => {
    const [h, p, s] = mintService().split(".") as [string, string, string];
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), cid: cidB })).toString("base64url");
    expect(await refused(`${h}.${other}.${s}`)).toBe(401);
    expect(await refused(`${h}.${p}.${s.slice(0, -4)}AAAA`)).toBe(401);
    expect(await refused(`${h}.${p}.${createHash("sha256").update("x").digest("base64url")}`)).toBe(401);
  });
  it("is a GET of exactly this path: no other method, no query, no other address", async () => {
    const { opts } = options();
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) expect((await get(opts, cidA, mintService(), {}, method)).status).toBe(405);
    for (const url of [`${pathOf(cidA)}?x=1`, `${pathOf(cidA)}/`, `/v1/service/companies/${cidA}`, `/v1/service/companies/org_x/offered-models`, `/v1/service/offered-models`, `/v1/service/companies/${cidA}/offered-models/x`]) expect((await get(opts, cidA, mintService(), {}, "GET", url)).status).toBe(404);
  });
  it("a refusal never carries a token, a company or a model", async () => {
    const answer = await get(options().opts, cidA, mintService({ cid: cidB }));
    const text = JSON.stringify(answer.body);
    for (const secret of [cidA, cidB, "claude", "qwen"]) expect(text).not.toContain(secret);
  });
});

describe("the HTTP handler", () => {
  class Res extends EventEmitter { statusCode = 0; headers: Record<string, string> = {}; body = ""; headersSent = false; destroyed = false; writeHead(s: number, h: Record<string, string>) { this.statusCode = s; this.headers = h; this.headersSent = true; return this; } end(b?: string) { this.body += b ?? ""; return this; } }
  const run = async (handler: ReturnType<typeof createOfferedModelsHandler>, headers: Record<string, string>, url: string, method = "GET") => {
    const res = new Res();
    await handler(Object.assign(Readable.from([]), { method, url, headers }) as never, res as never);
    return res;
  };
  it("answers JSON that is never cached, and stops anonymous traffic at a per-minute count before any key fetch", async () => {
    let clock = now; const readJwks = vi.fn(async () => [jwk]);
    const choices = new Choices(); choices.saved.set(cidA, "anthropic_key");
    const handler = createOfferedModelsHandler({ verify: createSignedTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: ISS, jwksUrl: `${ISS}/jwks`, taskKids: [kid] }]), readJwks, now: () => clock }, SERVICE_TOKEN_KIND), sources: choices, disabled: new Set(), now: () => clock });
    const ok = await run(handler, { authorization: `Bearer ${mintService()}` }, pathOf(cidA));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
    expect(CodeOfferedAgentModelsSchema.safeParse(JSON.parse(ok.body)).success).toBe(true);
    for (let i = 1; i < OFFERED_MODELS_PER_MINUTE; i++) await run(handler, {}, pathOf(cidA));
    const busy = await run(handler, { authorization: `Bearer ${mintService()}` }, pathOf(cidA));
    expect(busy.statusCode).toBe(429);
    clock += 61_000;
    expect((await run(handler, { authorization: `Bearer ${mintService({ iat: clock / 1000, nbf: clock / 1000 - 30, exp: clock / 1000 + 60 })}` }, pathOf(cidA))).statusCode).toBe(200);
  });
});

describe("gateway settings GATEWAY_AGENT_MODELS_DISABLED", () => {
  it("absent: the three Marketplace-gated Claude models; set: exactly that list (empty: none); malformed refused by name", () => {
    expect([...parseDisabledAgentModels(undefined)]).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);
    expect([...parseDisabledAgentModels("")]).toEqual([]);
    expect([...parseDisabledAgentModels("claude-opus-5-5, zai.glm-5")]).toEqual(["claude-opus-5-5", "zai.glm-5"]);
    for (const bad of ["a b", "claude-opus-5-5,claude-opus-5-5", "../x", ",", Array.from({ length: 65 }, (_, i) => `m${i}`).join(",")]) expect(() => parseDisabledAgentModels(bad)).toThrow();
  });
});

// ---- the process: the real server, a real (wire-level) Companies table, two companies ------------------------------------------------
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:111122223333:secret:rovara-cloud/test/model-gateway/provider/anthropic-AbCdEf",
  [GATEWAY_ENV.productKeysTable]: "gwp-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:111122223333:key/0b5d3f9e-1111-2222-3333-444455556666",
  [GATEWAY_ENV.productMeterTable]: "gwp-meter", [GATEWAY_ENV.productLedgerTable]: "gwp-ledger", [GATEWAY_ENV.productMarkersTable]: "gwp-markers", [GATEWAY_ENV.evalStagesTable]: "gwp-stages",
  [GATEWAY_ENV.agentKeys]: "company",
};
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("gateway process: two companies, one server", () => {
  async function serve(extraEnv: Record<string, string> = {}, rovaraAi = true, keyConnected = true) {
    const wire = new WireDynamo(Object.values(TABLES), { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    for (const [cid, source] of [[cidA, "rovara"], [cidB, "anthropic_key"]] as const) {
      await db.put(TABLES.companies, { pk: `COMPANY#${cid}`, sk: "AGENT_AI", companyId: cid, source, version: 1 });
    }
    const env = { ...ENV, ...(rovaraAi ? { [GATEWAY_ENV.rovaraAiModels]: `${ROVARA_AI_US_MODELS},${ROVARA_AI_US_CONVERSE_MODELS}` } : {}), ...extraEnv };
    const gateway = await startServe({ ...(readGatewayConfig(env) as ServeConfig), port: 0 }, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "never" }, agentKeys: { connected: async () => keyConnected, keyFor: async () => "k" },
      transport: async () => { throw new Error("no model call in this test"); }, bedrockTransport: async () => { throw new Error("no model call in this test"); },
    });
    running.push(gateway);
    return { gateway, wire, db };
  }
  function ask(server: RunningGateway["server"], url: string, headers: Record<string, string>, method = "GET"): Promise<FakeResponse> {
    const req = Object.assign(Readable.from([]), { method, url, headers });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    server.emit("request", req, res);
    return done;
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("A gets Rovara's AI list, B gets Anthropic's, and neither can read the other's, by either address", async () => {
    const s = await serve();
    const a = await ask(s.gateway.server, pathOf(cidA), bearer(mintService({ cid: cidA })));
    const b = await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })));
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(names(JSON.parse(a.text()))).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
    expect(names(JSON.parse(b.text()))).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    for (const [url, token] of [[pathOf(cidA), mintService({ cid: cidB })], [pathOf(cidB), mintService({ cid: cidA })]] as const) {
      const refused = await ask(s.gateway.server, url, bearer(token));
      expect(refused.statusCode).toBe(401);
      expect(Object.keys(JSON.parse(refused.text()) as object)).toEqual(["error"]);
    }
  });
  it("a company's change applies on the very next read (strongly consistent), and a row that is not the company's is refused", async () => {
    const s = await serve();
    expect(names(JSON.parse((await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })))).text()))).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    await s.db.put(TABLES.companies, { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "rovara", version: 2 });
    expect(names(JSON.parse((await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })))).text()))).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
    // B's row is A's row: the store refuses it, and the route answers unavailable.
    await s.db.put(TABLES.companies, { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidA, source: "rovara", version: 3 });
    expect((await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })))).statusCode).toBe(503);
  });
  it("DEC 254t: the deployed handler applies the install's switch (GATEWAY_AI_SOURCE_KINDS) to an own-key source", async () => {
    for (const [kinds, status] of [[undefined, 403], ["openai", 200]] as const) {
      const s = await serve(kinds === undefined ? {} : { [GATEWAY_ENV.aiSourceKinds]: kinds });
      await s.db.put(TABLES.companies, { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "openai_key", version: 2 });
      const answer = await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })));
      expect(answer.statusCode).toBe(status);
      const off = OFFERED_SWITCHED_OFF as { code: string; message: string };
      if (status === 403) expect(JSON.parse(answer.text())).toEqual({ error: { type: off.code, message: off.message } });
      else expect(names(JSON.parse(answer.text()))).toEqual([...OPENAI_KEY_AGENT_MODELS]);
    }
  });
  it("R-1: deployed no-choice companies keep connected own keys; unconnected companies get Rovara models", async () => {
    const cidC = `org_${"c".repeat(20)}`;
    const exemptEnv = { [GATEWAY_ENV.rovaraAiExempt]: `${cidA},${cidC}` };
    // C: exempt, nothing saved, no key connected: Rovara's AI.
    const none = await serve(exemptEnv, true, false);
    expect(names(JSON.parse((await ask(none.gateway.server, pathOf(cidC), bearer(mintService({ cid: cidC })))).text()))).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
    // A connection made after backfill must immediately advertise the own-key models.
    const keyed = await serve(exemptEnv, true, true);
    expect(names(JSON.parse((await ask(keyed.gateway.server, pathOf(cidC), bearer(mintService({ cid: cidC })))).text()))).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    const notExempt = await serve({}, true, false);
    expect(names(JSON.parse((await ask(notExempt.gateway.server, pathOf(cidC), bearer(mintService({ cid: cidC })))).text()))).toEqual([...CLAUDE_OFFERED, ...BEDROCK_17]);
  });
  it("F-2: without Rovara AI, an unsaved own-key company still gets its models; an unconnected company is refused", async () => {
    const cidC = `org_${"c".repeat(20)}`;
    const keyed = await serve({}, false, true);
    const got = await ask(keyed.gateway.server, pathOf(cidC), bearer(mintService({ cid: cidC })));
    expect(got.statusCode).toBe(200);
    expect(names(JSON.parse(got.text()))).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    const none = await serve({}, false, false);
    expect((await ask(none.gateway.server, pathOf(cidC), bearer(mintService({ cid: cidC })))).statusCode).toBe(403);
  });
  it("task tokens and service tokens are not interchangeable between the two routes", async () => {
    const s = await serve();
    expect((await ask(s.gateway.server, pathOf(cidA), bearer(mint({ cid: cidA })))).statusCode).toBe(401);
    const post = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": mintService({ cid: cidA }) } });
    const res = new FakeResponse(); const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    s.gateway.server.emit("request", post, res);
    expect((await done).statusCode).toBe(401);
  });
  it("answers the disabled list from GATEWAY_AGENT_MODELS_DISABLED", async () => {
    const s = await serve({ [GATEWAY_ENV.agentModelsDisabled]: "" });
    expect(names(JSON.parse((await ask(s.gateway.server, pathOf(cidA), bearer(mintService({ cid: cidA })))).text()))).toHaveLength(22);
    const t = await serve({ [GATEWAY_ENV.agentModelsDisabled]: "zai.glm-5,claude-haiku-5-5" });
    const list = names(JSON.parse((await ask(t.gateway.server, pathOf(cidA), bearer(mintService({ cid: cidA })))).text()));
    expect(list).not.toContain("zai.glm-5"); expect(list).not.toContain("claude-haiku-5-5"); expect(list).toContain("claude-sonnet-5-5");
  });
  it("without Rovara's AI configured, A is refused here too (same as the agent route) and B is unaffected", async () => {
    const s = await serve({}, false);
    expect((await ask(s.gateway.server, pathOf(cidA), bearer(mintService({ cid: cidA })))).statusCode).toBe(403);
    expect((await ask(s.gateway.server, pathOf(cidB), bearer(mintService({ cid: cidB })))).statusCode).toBe(200);
  });
  it("not served in install-key mode (the path is as unknown as any other)", async () => {
    const wire = new WireDynamo(Object.values(TABLES), { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    const dropped: string[] = [GATEWAY_ENV.agentKeys, GATEWAY_ENV.productKeysTable, GATEWAY_ENV.productKeysKey, GATEWAY_ENV.productMeterTable, GATEWAY_ENV.productLedgerTable, GATEWAY_ENV.productMarkersTable, GATEWAY_ENV.evalStagesTable];
    const plain = Object.fromEntries(Object.entries(ENV).filter(([name]) => !dropped.includes(name)));
    const gateway = await startServe({ ...(readGatewayConfig(plain) as ServeConfig), port: 0 }, { db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined, keys: { keyFor: async () => "k" } });
    running.push(gateway);
    const res = await ask(gateway.server, pathOf(cidA), bearer(mintService({ cid: cidA })));
    expect(res.statusCode).not.toBe(200);
    expect(JSON.parse(res.text())).not.toHaveProperty("models");
    expect(() => readGatewayConfig({ ...plain, [GATEWAY_ENV.agentModelsDisabled]: "" })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
    expect(() => readGatewayConfig({ ...ENV, [GATEWAY_ENV.agentModelsDisabled]: "bad name" })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentModelsDisabled));
  });
});

describe("the contract file", () => {
  it("states what the code does", () => {
    const file = JSON.parse(readFileSync(new URL("../../contracts/shared/offered-agent-models.v1.json", import.meta.url), "utf8")) as { response: { modelNamePattern: string; modelsMax: number }; serviceToken: { typ: string; aud: string; lifetime: number; claims: string[] } };
    expect(file.response.modelsMax).toBe(OFFERED_MODELS_MAX);
    expect(file.response.modelNamePattern).toBe(AGENT_MODEL_NAME.source);
    expect(file.serviceToken).toMatchObject({ typ: SERVICE_TOKEN_TYPE, aud: SERVICE_TOKEN_AUDIENCE, lifetime: SERVICE_TOKEN_SECONDS });
  });
});

// ---- DEC 254zzz96 (2): list prices on the offered list (display only, behind GATEWAY_OFFERED_PRICES) -------------------------------------------------
// Code's contract from the release that added the optional price (packages/contracts/src/agent-model-choice.ts OfferedModelPriceSchema).
const CodePricedSchema = z.object({
  version: z.literal(1),
  models: z.array(z.object({ model: z.string().regex(AGENT_MODEL_NAME), price: z.object({ inputUsdPerMillion: z.number().finite().min(0).max(10_000), outputUsdPerMillion: z.number().finite().min(0).max(10_000) }).strict().optional() }).strict()).min(1).max(64),
}).strict();

describe("list prices on the offered list", () => {
  const PRICES: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> = { "claude-haiku-4-5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }, "zai.glm-5": { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 } };
  it("switched off (no priceOf): the answer carries no price at all, as before", async () => {
    const out = await get(options().opts, cidA, mintService());
    expect(out.status).toBe(200);
    expect((out.body as { models: Array<Record<string, unknown>> }).models.every((m) => Object.keys(m).length === 1)).toBe(true);
    expect(CodeOfferedAgentModelsSchema.safeParse(out.body).success).toBe(true);
  });
  it("switched on: each model carries its list price where known, others none, and the answer is Code's priced contract", async () => {
    const asked: string[] = [];
    const sources = new Set<string | undefined>();
    const out = await get(options({ priceOf: async (model, source) => { asked.push(model); sources.add(source); return PRICES[model]; } }).opts, cidA, mintService());
    expect(out.status).toBe(200);
    const models = (out.body as { models: Array<{ model: string; price?: unknown }> }).models;
    expect(models.find((m) => m.model === "claude-haiku-4-5")?.price).toEqual(PRICES["claude-haiku-4-5"]);
    expect(models.find((m) => m.model === "zai.glm-5")?.price).toEqual(PRICES["zai.glm-5"]);
    expect(models.filter((m) => m.price === undefined).length).toBe(models.length - 2);
    expect(asked).toEqual(models.map((m) => m.model));
    // Each model is priced as the source that serves it (company A: Rovara's AI).
    expect([...sources]).toEqual(["rovara"]);
    expect(CodePricedSchema.safeParse(out.body).success).toBe(true);
  });
  it("a price that can't be read, or isn't an amount, is left out: never a refusal, never a bad field", async () => {
    const bad: Record<string, unknown> = { "claude-haiku-5-5": PRICES["claude-haiku-4-5"], "claude-haiku-4-5": { inputUsdPerMillion: -1, outputUsdPerMillion: 5 }, "zai.glm-5": { inputUsdPerMillion: Number.NaN, outputUsdPerMillion: 1 }, "us.amazon.nova-2-lite-v1:0": { inputUsdPerMillion: 1, outputUsdPerMillion: 10_001 } };
    const out = await get(options({ priceOf: async (model) => { if (model === "deepseek.v3-v1:0") throw new Error("table down"); return bad[model] as never; } }).opts, cidA, mintService());
    expect(out.status).toBe(200);
    // Only the one good price is shown: the bad ones (and the read that failed) are left out, the others are not dropped with them.
    expect((out.body as { models: Array<{ model: string; price?: unknown }> }).models.filter((m) => m.price !== undefined)).toEqual([{ model: "claude-haiku-5-5", price: PRICES["claude-haiku-4-5"] }]);
  });
  it("company B's answer prices B's own list only", async () => {
    const sources = new Set<string | undefined>();
    const out = await get(options({ priceOf: async (model, source) => { sources.add(source); return PRICES[model]; } }).opts, cidB, mintService({ cid: cidB }));
    expect([...sources]).toEqual(["anthropic_key"]);
    expect(names(out.body)).toEqual([...ANTHROPIC_KEY_AGENT_MODELS]);
    expect((out.body as { models: Array<{ model: string; price?: unknown }> }).models.find((m) => m.model === "claude-haiku-4-5")?.price).toEqual(PRICES["claude-haiku-4-5"]);
  });
  it("the price shown is the exact snapshot row of the source that serves the model, as the agent route meters it; micros per million tokens to dollars", async () => {
    const asked: Array<[string, string]> = [];
    const rows: Record<string, { inputMicrosPerMTok: number; outputMicrosPerMTok: number; operatorReview?: true }> = {
      "anthropic|claude-sonnet-5-5": { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
      "bedrock|us.anthropic.claude-sonnet-5-5-v1:0": { inputMicrosPerMTok: 3_300_000, outputMicrosPerMTok: 16_500_000 },
      "openai|gpt-5": { inputMicrosPerMTok: 1_250_000, outputMicrosPerMTok: 10_000_000 },
      "anthropic|claude-review-me": { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, operatorReview: true },
    };
    const prices = { priceFor: (provider: string, model: string) => { asked.push([provider, model]); return rows[`${provider}|${model}`]; } };
    const rovara = new Map([["claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5-v1:0"]]);
    expect(await offeredModelPrice(prices, "claude-sonnet-5-5", "anthropic_key")).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    expect(await offeredModelPrice(prices, "claude-sonnet-5-5", undefined)).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    // Rovara's AI is metered on the Bedrock row of the id it calls, not Anthropic's.
    expect(await offeredModelPrice(prices, "claude-sonnet-5-5", "rovara", rovara)).toEqual({ inputUsdPerMillion: 3.3, outputUsdPerMillion: 16.5 });
    expect(await offeredModelPrice(prices, "claude-unknown", "rovara", rovara)).toBeUndefined();
    expect(await offeredModelPrice(prices, "gpt-5", "openai_key")).toEqual({ inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 });
    // Sources metered on another row than one list price: no price rather than one that could understate.
    asked.length = 0;
    for (const source of ["bedrock_byo", "openrouter_key", "custom_endpoint"] as const) expect(await offeredModelPrice(prices, "claude-sonnet-5-5", source, rovara)).toBeUndefined();
    expect(asked).toEqual([]);
    // A row that waits for an operator's review is never shown as a list price.
    expect(await offeredModelPrice(prices, "claude-review-me", "anthropic_key")).toBeUndefined();
  });
  it("the switch reads 'on' only; any other value is a broken setting", () => {
    const base = { ...ENV };
    expect((readGatewayConfig({ ...base, [GATEWAY_ENV.offeredPrices]: "on" }) as ServeConfig).offeredPrices).toBe(true);
    expect((readGatewayConfig(base) as ServeConfig).offeredPrices).toBeUndefined();
    for (const value of ["true", "ON", "", "off"]) expect(() => readGatewayConfig({ ...base, [GATEWAY_ENV.offeredPrices]: value })).toThrow(GatewayConfigError);
  });
});

describe("DEC 254zzz419: the OpenRouter list never exceeds the cap", () => {
  const tariff = (model: string, cents: number): OpenRouterTariff => {
    const price = ((2 + cents) / 1_000_000).toFixed(6);
    return { model, route: "r", pricing: { prompt: "0.000001", completion: price, internal_reasoning: price, request: "0.000001", input_cache_read: "0.0000005", input_cache_write: "0.000001" }, max_completion_tokens: 2048, reasoning: { mode: "bounded", max_tokens: 1024 }, verifiedAt: now - 1000, expiresAt: now + 3_600_000, evidence: "fixture" };
  };
  const ask = async (tariffs: readonly OpenRouterTariff[]) => {
    const { opts, choices } = options({ openRouterTariffs: tariffs, switchedOn: new Set(["openrouter"]), chat: { openrouter: true }, keys: { connected: async () => true, bedrockConnected: async () => true, identityFor: async () => ({ sourceId: "src-1", versionId: "v-1" }) } });
    choices.saved.set(cidA, "openrouter_key");
    return get(opts, cidA, mintService());
  };
  it("190 priced rows -> exactly 64 models: the best-known families first, then the cheapest (the schema Code enforces still accepts the list)", async () => {
    const families = ["openai", "anthropic", "google", "mistralai", "meta-llama", "deepseek", "qwen"];
    const rest = Array.from({ length: 183 }, (_, i) => ({ model: `vendor/o${String(i).padStart(3, "0")}`, cents: (i * 7) % 61 }));
    const tariffs = [...rest.map((r) => tariff(r.model, r.cents)), ...families.map((f) => tariff(`${f}/m`, 20)), tariff("qwen/last", 40), tariff("openai/first", 5)]; // 192 valid rows
    const answer = await ask(tariffs);
    expect(answer.status).toBe(200);
    const list = names(answer.body);
    expect(list).toHaveLength(OFFERED_MODELS_MAX);
    expect(CodeOfferedAgentModelsSchema.safeParse({ version: 1, models: (answer.body as { models: Array<{ model: string }> }).models.map((m) => ({ model: m.model })) }).success).toBe(true);
    expect(list.slice(0, 9)).toEqual(["openai/first", "openai/m", "anthropic/m", "google/m", "mistralai/m", "meta-llama/m", "deepseek/m", "qwen/m", "qwen/last"]);
    expect(list.slice(9)).toEqual([...rest].sort((a, b) => a.cents - b.cents || (a.model < b.model ? -1 : 1)).slice(0, 55).map((r) => r.model));
  });
  it("63, 64 and 65 rows: under or at the cap the tariff's own order and every model; one over the cap drops exactly one", async () => {
    for (const [count, expected] of [[63, 63], [64, 64], [65, 64]] as const) {
      const tariffs = Array.from({ length: count }, (_, i) => tariff(`vendor/m${String(i).padStart(3, "0")}`, i));
      const list = names((await ask(tariffs)).body);
      expect(list).toHaveLength(expected);
      expect(list).toEqual(tariffs.slice(0, expected).map((t) => t.model));
    }
  });
});
