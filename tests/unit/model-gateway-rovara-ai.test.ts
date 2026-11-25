// DEC 240: "Rovara's AI" as an agent AI source. In company-key mode (DEC 236) each company's admin picks the source for its agents:
// Rovara's AI (Claude on Bedrock in Rovara's own AWS account, charged to the company at list price, DEC 240b), the company's own
// Anthropic key, or (later) its own Bedrock. The choice of company A never affects company B, there is never a fallback between
// sources, and no saved choice is DEC 236 exactly.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeBedrockModel } from "../../packages/model-gateway/src/price-identity.js";
import { CompanyAgentAiSource, parseRovaraAiExempt, parseRovaraAiModels, ROVARA_AI_US_MODELS, type AgentAiSource, type AgentAiSourceReader, type RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter, HOLD_SWEEP_AGE_MS } from "../../packages/model-gateway/src/dynamo-meter.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import type { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_KEY_MISSING, AGENT_SOURCE_NOT_OFFERED, BEDROCK_ANTHROPIC_VERSION, ROVARA_AI_MODEL, ROVARA_AI_MODEL_NOT_ENABLED, ROVARA_AI_OFF, ROVARA_AI_QUOTA, ROVARA_AI_UNAVAILABLE, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps, claims, jwk, kid, mint, now, requestBody, scope, setup } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const keyOf = (cid: string) => `customer-key-${cid}`;
const MODEL = claims.mdl[0]!; // "claude-sonnet-4-5", the model the task token allows
const BEDROCK_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

class CompanyKeys implements LearningKeySource {
  readonly connectedTo = new Set<string>([cidA, cidB]);
  reads: string[] = []; asked: string[] = [];
  async connected(_iss: string, cid: string): Promise<boolean> { this.asked.push(cid); return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.reads.push(cid); return keyOf(cid); }
}
class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  fail = false;
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { if (this.fail) throw new Error("store down"); return this.saved.get(cid); }
}

function gateway(options: { rovara?: Partial<RovaraAi> | false; overrides?: Partial<GatewayDependencies>; bedrock?: ProviderTransport } = {}) {
  const companyKeys = new CompanyKeys();
  const choices = new Choices();
  const keySent: ProviderRequest[] = [];
  const bedrockSent: ProviderRequest[] = [];
  const installKeyReads: string[] = [];
  const priced: Array<[string, string]> = [];
  const rovara: RovaraAi | undefined = options.rovara === false ? undefined : {
    models: new Map([[MODEL, BEDROCK_ID]]), exempt: new Set([cidA, cidB]),
    transport: options.bedrock ?? (async (request) => { bedrockSent.push(request); return { status: 200, body: answer() }; }),
    ...options.rovara,
  };
  const base = setup({
    agentKeys: companyKeys,
    agentAi: { sources: choices, ...(rovara === undefined ? {} : { rovara }) },
    keys: { keyFor: async (c) => { installKeyReads.push(c.cid); return "rovara-install-key"; } },
    transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
    prices: { priceFor: (provider, model) => { priced.push([provider, model]); return { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }; } },
    ...options.overrides,
  });
  if (options.bedrock !== undefined) {
    const inner = options.bedrock;
    rovara!.transport = async (request) => { bedrockSent.push(request); return inner(request); };
  }
  return { ...base, companyKeys, choices, keySent, bedrockSent, installKeyReads, priced };
}
const error = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const committed = async (meter: InMemoryMeter, cid = cidA) => (await meter.read({ ...scope, cid })).filter((row) => row.item === "company").reduce((sum, row) => sum + row.committed, 0);
const failing = (status: number): ProviderTransport => async () => ({ status, body: (async function* () { yield Buffer.from("{}"); })() });

describe("agent route: Rovara's AI (DEC 240)", () => {
  it("a company that chose Rovara's AI is served by Bedrock in Rovara's account; its own key and Rovara's install key are never read", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps, { ...requestBody, metadata: { user_id: "u1" } }, mint(), undefined, { "anthropic-beta": "interleaved-thinking-2025-05-14" });
    expect(sink.status).toBe(200);
    expect(sink.text()).toContain("event: message_stop");
    expect(g.bedrockSent).toHaveLength(1);
    expect(g.keySent).toEqual([]);
    expect(g.companyKeys.reads).toEqual([]);
    expect(g.companyKeys.asked).toEqual([]);
    expect(g.installKeyReads).toEqual([]);
    const sent = g.bedrockSent[0]!;
    expect(sent.path).toBe("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream");
    expect(sent.headers).toEqual({ "content-type": "application/json" });
    expect(sent.key).toMatch(/^rovara-ai-[0-9a-f-]{36}$/u);
    const body = JSON.parse(Buffer.from(sent.body).toString("utf8")) as Record<string, unknown>;
    expect(body).toEqual({ anthropic_version: BEDROCK_ANTHROPIC_VERSION, messages: requestBody.messages, max_tokens: requestBody.max_tokens, anthropic_beta: ["interleaved-thinking-2025-05-14"] });
    // Priced from the Bedrock rows (dearest-of across their regions and sources, price-sources.ts), never the Anthropic rows.
    expect(g.priced.map(([provider]) => provider)).toEqual(["bedrock"]);
    expect(g.priced[0]![1]).toBe(BEDROCK_ID);
  });

  it("a non-streaming call goes to InvokeModel and is settled from its usage", async () => {
    const g = gateway({ bedrock: async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 100, output_tokens: 10 } })); })() }) });
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps, { ...requestBody, stream: false });
    expect(sink.status).toBe(200);
    expect(g.bedrockSent[0]!.path).toBe("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke");
    // 100 x $3/M + 10 x $15/M = 450 micro-dollars, the company's spend and its billable line.
    expect(await committed(g.meter)).toBe(450);
    expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ settledMicros: 450, estimated: false, line: { source: "rovara_ai", charge: "exempt", model: BEDROCK_ID } }]);
  });

  it("each settled call is one billable line for the company that made it, under its own combined cap (two companies)", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "rovara");
    g.choices.saved.set(cidB, "anthropic_key");
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    // A's calls went to Rovara's AI; B's on B's own key only. A's choice never moved B's call, nor B's A's.
    expect(g.bedrockSent).toHaveLength(2);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidB)]);
    expect(g.companyKeys.reads).toEqual([cidB]);
    const linesA = g.meter.billedCalls(claims.iss, cidA);
    expect(linesA).toHaveLength(2);
    expect(linesA.every((l) => l.cid === cidA && l.line.charge === "exempt" && l.settledMicros > 0)).toBe(true);
    // B pays its own provider directly: no line, and none of A's lines on B.
    expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
    expect(await committed(g.meter, cidA)).toBe(linesA.reduce((s, l) => s + l.settledMicros, 0));
    expect(await committed(g.meter, cidB)).toBeGreaterThan(0);
  });

  it("an explicit anthropic_key choice preserves DEC 236 company-key behavior", async () => {
    for (const saved of ["anthropic_key"] as const) {
      const g = gateway({ rovara: { exempt: new Set() } });
      if (saved !== undefined) g.choices.saved.set(cidA, saved);
      const plain = setup({ agentKeys: new CompanyKeys(), keys: { keyFor: async () => "rovara-install-key" }, transport: async () => ({ status: 200, body: answer() }), prices: g.deps.prices! });
      const sentPlain: ProviderRequest[] = [];
      plain.deps.transport = async (request) => { sentPlain.push(request); return { status: 200, body: answer() }; };
      const ours = await call(g.deps); const theirs = await call(plain.deps);
      expect(ours.status).toBe(theirs.status);
      expect(ours.text()).toBe(theirs.text());
      expect(g.keySent.map((r) => [Buffer.from(r.body).toString(), r.headers, r.key, r.path])).toEqual(sentPlain.map((r) => [Buffer.from(r.body).toString(), r.headers, r.key, r.path]));
      expect(g.bedrockSent).toEqual([]);
      expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
      // ...including the refusal of a company with no key connected.
      g.companyKeys.connectedTo.delete(cidA); plain.deps.agentKeys = new CompanyKeys(); (plain.deps.agentKeys as CompanyKeys).connectedTo.delete(cidA);
      expect((await call(g.deps)).text()).toBe((await call(plain.deps)).text());
      expect(error(await call(g.deps))).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    }
  });

  it("no automatic fallback: Rovara's AI chosen but not offered here is refused, never sent on the company's key", async () => {
    const g = gateway({ rovara: false });
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: ROVARA_AI_OFF.code, message: ROVARA_AI_OFF.message });
    expect(g.keySent).toEqual([]); expect(g.companyKeys.reads).toEqual([]); expect(g.companyKeys.asked).toEqual([]); expect(g.installKeyReads).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
    // B, explicitly on its own key, is unaffected.
    g.choices.saved.set(cidB, "anthropic_key");
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
  });

  it("no automatic fallback the other way: anthropic_key chosen with no key connected is refused, never sent to Rovara's AI", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "anthropic_key");
    g.choices.saved.set(cidB, "rovara");
    g.companyKeys.connectedTo.delete(cidA);
    expect(error(await call(g.deps))).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    expect(g.bedrockSent).toEqual([]);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.bedrockSent).toHaveLength(1);
  });

  it("your own Bedrock (DEC 238) on a gateway that does not offer it is refused: nothing held or sent, the other company unaffected", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(error(sink)).toEqual({ type: AGENT_SOURCE_NOT_OFFERED.code, message: AGENT_SOURCE_NOT_OFFERED.message });
    expect(g.keySent).toEqual([]); expect(g.bedrockSent).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
  });

  it("an unreadable choice refuses with the fixed 503 and holds nothing (no guess at a source)", async () => {
    const g = gateway();
    g.choices.fail = true;
    const sink = await call(g.deps);
    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: "unavailable", message: "model access unavailable" });
    expect(g.keySent).toEqual([]); expect(g.bedrockSent).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
  });

  it("only allow-listed models: another model is refused before any hold", async () => {
    const g = gateway({ rovara: { models: new Map([["claude-opus-5-5", "us.anthropic.claude-opus-5-5"]]) } });
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps);
    expect(sink.status).toBe(400);
    expect(error(sink)).toEqual({ type: ROVARA_AI_MODEL.code, message: ROVARA_AI_MODEL.message });
    expect(g.bedrockSent).toEqual([]);
    expect(await committed(g.meter)).toBe(0);
  });

  it("only the operator-named company is exempt; the other company is charged (two companies)", async () => {
    const g = gateway({ rovara: { exempt: new Set([cidA]) } });
    g.choices.saved.set(cidA, "rovara"); g.choices.saved.set(cidB, "rovara");
    await call(g.deps, requestBody, mint({ cid: cidA }));
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.meter.billedCalls(claims.iss, cidA).map((l) => l.line.charge)).toEqual(["exempt"]);
    expect(g.meter.billedCalls(claims.iss, cidB).map(l => l.line.charge)).toEqual(["customer"]);
    // Exempt from the charge, never from the cap: the spend still counts.
    expect(await committed(g.meter, cidA)).toBeGreaterThan(0);
  });

  it("the one combined company cap applies to Rovara's AI", async () => {
    const g = gateway({ overrides: { caps: new FixedCapsSource({ ...caps, companyMonth: 1 }) } });
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps);
    expect(sink.status).toBe(422);
    expect(error(sink)).toEqual({ type: "budget_exceeded", message: "Budget has been exceeded! Team=company" });
    expect(g.bedrockSent).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toEqual([]);
  });

  it("a Bedrock error answer (no output, no token counts) is never charged; refusing Rovara's own role says so", async () => {
    for (const status of [401, 403]) {
      const g = gateway({ bedrock: failing(status) }); g.choices.saved.set(cidA, "rovara");
      const sink = await call(g.deps);
      expect(sink.status).toBe(503);
      expect(error(sink)).toEqual({ type: ROVARA_AI_UNAVAILABLE.code, message: ROVARA_AI_UNAVAILABLE.message });
      expect(await committed(g.meter)).toBe(0);
      expect(g.keySent).toEqual([]);
    }
    for (const status of [400, 404, 408, 424, 500, 503]) {
      const g = gateway({ bedrock: failing(status) }); g.choices.saved.set(cidA, "rovara");
      expect((await call(g.deps)).status).toBe(502);
      expect(await committed(g.meter)).toBe(0);
      expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ settledMicros: 0 }]);
    }
  });

  it("a Bedrock throttle on Rovara's AI (a model whose quota is 0) answers an honest quota reason, free; other statuses and models are unaffected", async () => {
    const throttled: ProviderTransport = async () => ({ status: 429, body: (async function* () { yield Buffer.from(JSON.stringify({ message: "Too many tokens, please wait before trying again. BEDROCK-CANARY arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5" })); })() });
    const g = gateway({ bedrock: throttled });
    g.choices.saved.set(cidA, "rovara");
    const sink = await call(g.deps);
    expect(sink.status).toBe(429);
    expect(error(sink)).toEqual({ type: ROVARA_AI_QUOTA.code, message: ROVARA_AI_QUOTA.message });
    expect(ROVARA_AI_QUOTA.message).toMatch(/quota/u);
    expect(sink.text()).not.toMatch(/BEDROCK-CANARY|arn:aws/u);
    expect(await committed(g.meter)).toBe(0);
    expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ settledMicros: 0 }]);
    expect(g.logs.filter((line) => (line as { event?: unknown }).event === "refused")).toEqual([
      { event: "refused", code: "rate_limit_error", status: 429, upstreamStatus: 429, route: "agent", payer: "rovara", reason: "bedrock_429" },
    ]);
    expect(JSON.stringify(g.logs)).not.toContain("BEDROCK-CANARY");
    // The same throttle as a first stream frame (an exception before any output) is the same answer.
    const h = gateway({ bedrock: async () => ({ status: 429, body: (async function* () { /* empty: the transport's first-frame exception */ })() }) });
    h.choices.saved.set(cidA, "rovara");
    expect(error(await call(h.deps))).toEqual({ type: ROVARA_AI_QUOTA.code, message: ROVARA_AI_QUOTA.message });
    // A 500 stays the generic provider error.
    const k = gateway({ bedrock: failing(500) }); k.choices.saved.set(cidA, "rovara");
    expect(error(await call(k.deps))).toEqual({ type: "provider_error", message: "provider unavailable" });
  });

  it("logs Bedrock failure status as a fixed reason without logging the provider body", async () => {
    for (const [status, reason] of [[401, "bedrock_401"], [403, "bedrock_403"], [500, "bedrock_other"]] as const) {
      const g = gateway({ bedrock: async () => ({ status, body: (async function* () { yield Buffer.from("BEDROCK-CANARY private provider text"); })() }) });
      g.choices.saved.set(cidA, "rovara");
      await call(g.deps);
      expect(g.logs.filter((line) => (line as { event?: unknown }).event === "refused")).toEqual([
        { event: "refused", code: status === 500 ? "provider_error" : "unavailable", status: status === 500 ? 502 : 503, upstreamStatus: status, route: "agent", payer: "rovara", reason },
      ]);
      expect(JSON.stringify(g.logs)).not.toContain("BEDROCK-CANARY");
    }
  });

  it("a model on the list but not enabled yet in Rovara's account answers 'not enabled yet', free; the other company is unaffected", async () => {
    // Bedrock's AccessDeniedException words when the account's Marketplace agreement for the model is missing.
    const notEnabled: ProviderTransport = async () => ({ status: 403, body: (async function* () { yield Buffer.from(JSON.stringify({ message: "Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access to this model." })); })() });
    const g = gateway({ bedrock: notEnabled });
    g.choices.saved.set(cidA, "rovara"); g.choices.saved.set(cidB, "anthropic_key");
    const sink = await call(g.deps);
    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: ROVARA_AI_MODEL_NOT_ENABLED.code, message: ROVARA_AI_MODEL_NOT_ENABLED.message });
    expect(sink.text()).not.toContain("Marketplace");
    expect(await committed(g.meter)).toBe(0);
    expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ settledMicros: 0 }]);
    expect(g.keySent).toEqual([]);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
  });

  it("classifies Bedrock's unavailable-for-this-account AccessDeniedException as a model-access refusal", async () => {
    const message = "anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock...";
    const g = gateway({ bedrock: async () => ({ status: 403, body: (async function* () { yield Buffer.from(JSON.stringify({ message })); })() }) });
    g.choices.saved.set(cidA, "rovara");

    const sink = await call(g.deps);

    expect(sink.status).toBe(503);
    expect(error(sink)).toEqual({ type: ROVARA_AI_MODEL_NOT_ENABLED.code, message: ROVARA_AI_MODEL_NOT_ENABLED.message });
    expect(g.logs.filter((line) => (line as { event?: unknown }).event === "refused")).toMatchObject([{ reason: "bedrock_403" }]);
    expect(JSON.stringify(g.logs)).not.toContain("is not available for this account");
  });

  it("a stream that breaks after output started is charged (the core's rule), as a billable line", async () => {
    const g = gateway({ bedrock: async () => ({ status: 200, body: (async function* () { yield Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'); throw new Error("stream cut"); })() }) });
    g.choices.saved.set(cidA, "rovara");
    await call(g.deps);
    expect(await committed(g.meter)).toBeGreaterThan(0);
    expect(g.meter.billedCalls(claims.iss, cidA)[0]!.settledMicros).toBeGreaterThan(0);
  });
});

describe("Rovara's AI settings", () => {
  it("models: in-geography Claude models and profiles only; global routing and other geographies refused", () => {
    expect([...parseRovaraAiModels("claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5, claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0", "us-west-2")]).toEqual([["claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5"], ["claude-haiku-4-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"]]);
    expect([...parseRovaraAiModels("claude-sonnet-5-5=eu.anthropic.claude-sonnet-5-5", "eu-west-1")]).toHaveLength(1);
    for (const bad of ["", "claude-sonnet-5-5=anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=global.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=eu.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=us.meta.llama3", "gpt-5=us.anthropic.claude-sonnet-5-5",
      "claude-a=us.anthropic.claude-a,claude-a=us.anthropic.claude-b", "claude-a=us.anthropic.claude-a=x", "claude-a", "claude-a=arn:aws:bedrock:us-west-2:111122223333:inference-profile/x"]) {
      expect(() => parseRovaraAiModels(bad, "us-west-2")).toThrow();
    }
  });

  it("DEC 243: the built-in list offers the five Claude models by their engine names, each priced by the AWS price list's row", () => {
    const models = parseRovaraAiModels(ROVARA_AI_US_MODELS, "us-west-2");
    expect([...models.keys()]).toEqual(["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);
    // The AWS price list names these models so (its "model" attribute, 2026-11-15); the price fetcher folds each the same way
    // (price-sources.ts fetchAWS), and the price index folds the Bedrock id (normalizeBedrockModel): both must meet.
    const awsNames: Record<string, string> = { "claude-haiku-4-5": "Claude Haiku 4.5", "claude-haiku-4-5-20251001": "Claude Haiku 4.5", "claude-haiku-5-5": "Claude Haiku 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5", "claude-fable-5-2": "Claude Fable 5.2" };
    for (const [name, id] of models) expect([name, normalizeBedrockModel(id)]).toEqual([name, awsNames[name]!.toLowerCase().replace(/[^a-z0-9]+/gu, "-")]);
  });

  it("exempt companies: an explicit list of company ids only", () => {
    expect(parseRovaraAiExempt(undefined)).toEqual(new Set());
    expect(parseRovaraAiExempt("")).toEqual(new Set());
    expect(parseRovaraAiExempt(`${cidA},${cidB}`)).toEqual(new Set([cidA, cidB]));
    for (const bad of ["*", "org_short", `${cidA},${cidA}`, `${cidA},founders`]) expect(() => parseRovaraAiExempt(bad)).toThrow();
  });
});

const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
describe("the company's choice in Cloud's Companies table (COMPANY#<org>/AGENT_AI)", () => {
  async function table() {
    const wire = new WireDynamo(["cloud-companies"]);
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    return { wire, db, reader: new CompanyAgentAiSource(db, "cloud-companies") };
  }
  it("reads each company's own row only (two companies); none saved is undefined", async () => {
    const { db, reader } = await table();
    await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "rovara", version: 1 });
    expect(await reader.sourceFor(cidA)).toBe("rovara");
    expect(await reader.sourceFor(cidB)).toBeUndefined();
    await db.put("cloud-companies", { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "anthropic_key", version: 1 });
    expect(await reader.sourceFor(cidA)).toBe("rovara");
    expect(await reader.sourceFor(cidB)).toBe("anthropic_key");
  });
  it("fails closed: another company's row, an unknown source, or a bad company id throws", async () => {
    const { db, reader } = await table();
    await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidB, source: "rovara", version: 1 });
    await expect(reader.sourceFor(cidA)).rejects.toThrow();
    await db.put("cloud-companies", { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "openai", version: 1 });
    await expect(reader.sourceFor(cidB)).rejects.toThrow();
    await expect(reader.sourceFor("org_x")).rejects.toThrow();
  });
});

describe("InMemoryMeter: billable lines (DEC 240b)", () => {
  it("a malformed line is refused at the hold; a good one lands only on its own company", async () => {
    const { meter } = setup();
    const good = { source: "rovara_ai" as const, charge: "customer" as const, model: BEDROCK_ID };
    for (const bad of [{ ...good, charge: "free" }, { ...good, source: "anthropic" }, { ...good, model: "X Y" }, { ...good, extra: 1 }]) {
      expect(await meter.reserve({ scope, caps, estimateMicros: 40, line: bad as never })).toEqual({ ok: false, reason: "busy" });
    }
    expect(await committed(meter)).toBe(0);
    const held = await meter.reserve({ scope, caps, estimateMicros: 40, line: good });
    if (!held.ok) throw new Error("hold refused");
    await meter.settle(held.reservation, 30);
    expect(meter.billedCalls(claims.iss, cidA)).toMatchObject([{ settledMicros: 30, line: good }]);
    expect(meter.billedCalls(claims.iss, cidB)).toEqual([]);
  });
});

describe("DynamoMeter: the billable line on the ledger row (DEC 240b)", () => {
  const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" };
  const meterScope = (cid: string) => ({ iss: "https://install.example/v1/auth", cid, pid: "web", tid: "task_1" });
  const T0 = Date.UTC(2026, 0, 1);
  function meter(clock = () => T0) {
    const wire = new WireDynamo(Object.values(TABLES));
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    return { wire, meter: new DynamoMeter({ db, tables: TABLES, now: clock }) };
  }
  const limits = { task: 1_000, projectMonth: 1_000, companyMonth: 1_000 };
  const line = { source: "rovara_ai" as const, charge: "customer" as const, model: BEDROCK_ID };

  it("a settled call's ledger row carries its company's line and settled cost; another company's call carries none", async () => {
    const { wire, meter: m } = meter();
    const a = await m.reserve({ scope: meterScope(cidA), caps: limits, estimateMicros: 40, line });
    const b = await m.reserve({ scope: meterScope(cidB), caps: limits, estimateMicros: 40 });
    if (!a.ok || !b.ok) throw new Error("hold refused");
    await m.settle(a.reservation, 30); await m.settle(b.reservation, 25);
    const rows = wire.items(TABLES.ledger);
    const rowA = rows.find((r) => r.cid === cidA)!; const rowB = rows.find((r) => r.cid === cidB)!;
    expect(rowA.line).toEqual(line);
    expect(rowA.settledMicros).toBe(30);
    expect(rowB.line).toBeUndefined();
  });

  it("a hold the sweep closes still lands its line (at the hold's estimate)", async () => {
    let clock = T0;
    const { wire, meter: m } = meter(() => clock);
    const a = await m.reserve({ scope: meterScope(cidA), caps: limits, estimateMicros: 40, line: { ...line, charge: "exempt" } });
    expect(a.ok).toBe(true);
    clock = T0 + HOLD_SWEEP_AGE_MS + 1;
    expect((await m.sweepOpenHolds(clock, 10)).swept).toBe(1);
    const row = wire.items(TABLES.ledger)[0]!;
    expect(row.line).toEqual({ ...line, charge: "exempt" });
    expect(row.settledMicros).toBe(40);
  });

  it("a malformed line is refused at the hold (nothing held)", async () => {
    const { wire, meter: m } = meter();
    for (const bad of [{ ...line, charge: "free" }, { ...line, source: "anthropic" }, { ...line, model: "X Y" }, { ...line, extra: 1 }]) {
      expect(await m.reserve({ scope: meterScope(cidA), caps: limits, estimateMicros: 40, line: bad as never })).toEqual({ ok: false, reason: "busy" });
    }
    expect(wire.items(TABLES.meter)).toEqual([]);
  });
});

// ---- the process ----------------------------------------------------------------------------------------------------------
const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers", prices: "gw-prices", companies: "cloud-companies" };
const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: TABLES.meter, [GATEWAY_ENV.ledgerTable]: TABLES.ledger, [GATEWAY_ENV.markersTable]: TABLES.markers, [GATEWAY_ENV.pricesTable]: TABLES.prices, [GATEWAY_ENV.companyTable]: TABLES.companies,
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:111122223333:secret:rovara-cloud/test/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT_ENV = {
  [GATEWAY_ENV.productKeysTable]: "gwp-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:111122223333:key/0b5d3f9e-1111-2222-3333-444455556666",
  [GATEWAY_ENV.productMeterTable]: "gwp-meter", [GATEWAY_ENV.productLedgerTable]: "gwp-ledger", [GATEWAY_ENV.productMarkersTable]: "gwp-markers", [GATEWAY_ENV.evalStagesTable]: "gwp-stages",
};
const COMPANY_MODE = { ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.agentKeys]: "company" };

describe("gateway settings GATEWAY_ROVARA_AI_MODELS / _EXEMPT", () => {
  it("absent: Rovara's AI is off, the config exactly as before", () => {
    expect(Object.hasOwn(readGatewayConfig(COMPANY_MODE) as ServeConfig, "rovaraAi")).toBe(false);
  });
  it("read in company-key mode only; malformed values refused by name; the exempt list never alone", () => {
    const config = readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.rovaraAiModels]: `${MODEL}=${BEDROCK_ID}`, [GATEWAY_ENV.rovaraAiExempt]: cidA }) as ServeConfig;
    expect([...config.rovaraAi!.models]).toEqual([[MODEL, BEDROCK_ID]]);
    expect([...config.rovaraAi!.exempt]).toEqual([cidA]);
    expect(() => readGatewayConfig({ ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.rovaraAiModels]: `${MODEL}=${BEDROCK_ID}` })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
    expect(() => readGatewayConfig({ ...ENV, ...PRODUCT_ENV, [GATEWAY_ENV.agentKeys]: "install", [GATEWAY_ENV.rovaraAiModels]: `${MODEL}=${BEDROCK_ID}` })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.rovaraAiModels]: `${MODEL}=global.anthropic.claude-sonnet-4-5` })).toThrow(new GatewayConfigError(GATEWAY_ENV.rovaraAiModels));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.rovaraAiModels]: `${MODEL}=${BEDROCK_ID}`, [GATEWAY_ENV.rovaraAiExempt]: "everyone" })).toThrow(new GatewayConfigError(GATEWAY_ENV.rovaraAiExempt));
    expect(() => readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.rovaraAiExempt]: cidA })).toThrow(new GatewayConfigError(GATEWAY_ENV.rovaraAiModels));
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
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("gateway process: Rovara's AI from each company's saved choice", () => {
  async function serve(rovaraAi: boolean, paused = false) {
    const wire = new WireDynamo(Object.values(TABLES), { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    for (const cid of [cidA, cidB]) await db.put(TABLES.companies, { pk: `COMPANY#${cid}`, sk: "SETTINGS", companyId: cid, version: 1, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    // A chose Rovara's AI in Cloud; B chose its own Anthropic key.
    await db.put(TABLES.companies, { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "rovara", version: 1 });
    await db.put(TABLES.companies, { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "anthropic_key", version: 1 });
    if (paused) await db.put(TABLES.companies, { pk: "INSTALL#ROVARA_AI", sk: "SETTING", enabled: false });
    const keySent: ProviderRequest[] = []; const bedrockSent: ProviderRequest[] = [];
    const config: ServeConfig = { ...(readGatewayConfig(ENV) as ServeConfig), port: 0, agentKeys: "company", ...(rovaraAi ? { rovaraAi: { models: new Map([[MODEL, BEDROCK_ID]]), exempt: new Set([cidA]) } } : {}) };
    const clock = { now };
    const gateway = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => clock.now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "rovara-install-key" }, agentKeys: new CompanyKeys(),
      transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
      bedrockTransport: async (request) => { bedrockSent.push(request); return { status: 200, body: answer() }; },
    });
    running.push(gateway);
    return { gateway, keySent, bedrockSent, wire, db, clock };
  }
  function post(server: RunningGateway["server"], token: string): Promise<FakeResponse> {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    server.emit("request", req, res);
    return done;
  }

  it("A goes to Rovara's AI and lands a billable line; B goes on its own key with no line", async () => {
    const s = await serve(true);
    expect((await post(s.gateway.server, mint({ cid: cidA }))).statusCode).toBe(200);
    expect((await post(s.gateway.server, mint({ cid: cidB }))).statusCode).toBe(200);
    expect(s.bedrockSent).toHaveLength(1);
    expect(s.keySent.map((r) => r.key)).toEqual([keyOf(cidB)]);
    const ledger = s.wire.items(TABLES.ledger);
    expect(ledger.filter((r) => r.line !== undefined).map((r) => [r.cid, (r.line as { charge: string }).charge])).toEqual([[cidA, "exempt"]]);
  });

  it("DEC 328: a running process observes pause and resume within a minute with no deploy", async () => {
    const s = await serve(true);
    const token = mint({ cid: cidA });
    expect((await post(s.gateway.server, token)).statusCode).toBe(200);
    await s.db.put(TABLES.companies, { pk: "INSTALL#ROVARA_AI", sk: "SETTING", enabled: false });
    s.clock.now += 60_000;
    expect((await post(s.gateway.server, token)).statusCode).toBe(403);
    expect(s.bedrockSent).toHaveLength(1);
    await s.db.put(TABLES.companies, { pk: "INSTALL#ROVARA_AI", sk: "SETTING", enabled: true });
    s.clock.now += 60_000;
    expect((await post(s.gateway.server, token)).statusCode).toBe(200);
    expect(s.bedrockSent).toHaveLength(2);
  });

  it("DEC 328: deployed process wires the Companies-table stop, with own-key calls unaffected", async () => {
    const s = await serve(true, true);
    const refused = await post(s.gateway.server, mint({ cid: cidA }));
    expect(refused.statusCode).toBe(403);
    expect((JSON.parse(refused.text()) as { error: { message: string } }).error.message).toBe("Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.");
    expect(s.bedrockSent).toEqual([]);
    expect((await post(s.gateway.server, mint({ cid: cidB }))).statusCode).toBe(200);
  });

  it("without Rovara's AI configured, A is refused (no fallback to any key) and B is unaffected", async () => {
    const s = await serve(false);
    const refused = await post(s.gateway.server, mint({ cid: cidA }));
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.text())).toEqual({ error: { type: ROVARA_AI_OFF.code, message: ROVARA_AI_OFF.message } });
    expect((await post(s.gateway.server, mint({ cid: cidB }))).statusCode).toBe(200);
    expect(s.bedrockSent).toEqual([]);
    expect(s.keySent.map((r) => r.key)).toEqual([keyOf(cidB)]);
  });
});

it("DEC 328: actual nightly upkeep origin pauses before its budget lookup or any hold/send", async () => {
  const limitFor = vi.fn(async () => 1_000_000);
  const g = gateway({ overrides: { rovaraAiSetting: { enabled: async () => false }, upkeep: { limitFor } } });
  g.choices.saved.set(cidA, "rovara");
  const reserve = vi.spyOn(g.meter, "reserve");
  const sink = await call(g.deps, requestBody, mint({ src: "nightly" }));
  expect(sink.status).toBe(403);
  expect(error(sink).message).toBe("Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.");
  expect(limitFor).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(g.bedrockSent).toEqual([]);
});
