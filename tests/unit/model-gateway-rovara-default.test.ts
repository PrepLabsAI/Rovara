// DEC 254zzz263: no saved choice defaults to company-billed Rovara AI; explicit choices win.
import { denyNetwork } from "./model-gateway-no-network.js";
import { createHash } from "node:crypto";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultAgentSource, resolveAgentSource, type AgentAiSource, type AgentAiSourceReader, type RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import { createAnswersRoutes, ANSWERS_PATH, ANSWERS_STEP, ANSWERS_PAUSE_HEADER } from "../../packages/model-gateway/src/answers-route.js";
import { FixedCapsSource, type Caps } from "../../packages/model-gateway/src/caps.js";
import type { CredentialSource } from "../../packages/model-gateway/src/aws.js";
import type { BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import { createLearningRoutes, LEARNING_PATH, LEARNING_STEP, type LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { InMemoryMeter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import { answerOfferedModels, type OfferedModelsHandlerOptions } from "../../packages/model-gateway/src/offered-models.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_KEY_MISSING, BYO_BEDROCK_NOT_CONNECTED, handleGateway, ROVARA_AI_MODEL, ROVARA_AI_OFF, ROVARA_AI_UNAVAILABLE, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps as baseCaps, claims, MemorySink, mint, now, requestBody, scope as agentScope, setup } from "./model-gateway-fixture.js";

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
const cidC = `org_${"c".repeat(20)}`;
const MODEL = claims.mdl[0]!;
const BEDROCK_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const keyOf = (cid: string) => `customer-key-${cid}`;
const error = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;

class CompanyKeys implements LearningKeySource {
  connectedTo = new Set<string>();
  reads: string[] = []; asked: string[] = [];
  fail = false;
  async connected(_iss: string, cid: string, provider: string): Promise<boolean> { if (this.fail) throw new Error("store down"); this.asked.push(`${cid}/${provider}`); return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.reads.push(cid); return keyOf(cid); }
  async resolveForCharge(_iss: string, cid: string) {
    if (!this.connectedTo.has(cid)) return undefined;
    return { source: { kind: "company_key" as const, id: "src_own_anthropic", name: "Company key", provider: "anthropic", connectionRevision: "11111111-1111-4111-8111-111111111111" },
      key: () => this.keyFor(_iss, cid) };
  }
}
class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  fail = false;
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { if (this.fail) throw new Error("store down"); return this.saved.get(cid); }
}
const conn = (cid: string): BedrockConnection => ({ scheme: "assume_role", roleArn: `arn:aws:iam::111111111111:role/RovaraBedrockInvoke-${cid}`, region: "us-west-2", models: { [MODEL]: BEDROCK_ID }, allowGlobal: false });

interface Options { exempt?: string[]; caps?: Partial<Caps>; upkeepLimits?: { limitFor(): Promise<number | null | undefined> } }
function gateway(options: Options = {}) {
  const companyKeys = new CompanyKeys();
  const choices = new Choices();
  const bedrockConnected = new Set<string>();
  const rovaraSent: ProviderRequest[] = []; const keySent: ProviderRequest[] = []; const byoSent: ProviderRequest[] = [];
  const installKeyReads: string[] = [];
  const byoReads: string[] = [];
  const rovara: RovaraAi = { models: new Map([[MODEL, BEDROCK_ID]]), exempt: new Set(options.exempt ?? [cidA]), transport: async (request) => { rovaraSent.push(request); return { status: 200, body: answer() }; } };
  const byo = {
    async connection(iss: string, cid: string) { byoReads.push(cid); return bedrockConnected.has(cid) ? { row: { iss, cid, owner: "_company", sourceId: "src_bedrock", versionId: "11111111-1111-4111-8111-111111111111" }, connection: conn(cid) } : undefined; },
    sessions: { credentials: async () => ({ ok: true as const, credentials: { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s", sessionToken: "t", expiresAt: Date.now() + 3_600_000 } }), forget: () => undefined },
    transport: (_region: string, credentials: CredentialSource): ProviderTransport => async (request) => { await credentials(); byoSent.push(request); return { status: 200, body: answer() }; },
  };
  const base = setup({
    agentKeys: companyKeys,
    agentAi: { sources: choices, rovara, byo: byo },
    keys: { keyFor: async (c) => { installKeyReads.push(c.cid); return "rovara-install-key"; } },
    transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
    prices: { priceFor: () => ({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }) },
    ...(options.caps === undefined ? {} : { caps: new FixedCapsSource({ ...baseCaps, ...options.caps }) }),
    ...(options.upkeepLimits === undefined ? {} : { upkeep: options.upkeepLimits }),
  });
  return { ...base, byo, companyKeys, choices, bedrockConnected, rovara, rovaraSent, keySent, byoSent, installKeyReads, byoReads };
}
type G = ReturnType<typeof gateway>;
const sources = (g: G) => g.logs.filter((e) => (e as { event?: string }).event === "agent_source");
const nothingSent = (g: G) => { expect(g.rovaraSent).toEqual([]); expect(g.keySent).toEqual([]); expect(g.byoSent).toEqual([]); expect(g.installKeyReads).toEqual([]); };

describe("the pure default: preserve connected own keys (R-1)", () => {
  it("covers every combination", () => {
    // DEC 254zzz525: a connected Bedrock role is not an input: it never makes a default.
    expect(defaultAgentSource({ keyConnected: false })).toEqual({ source: "rovara", via: "default" });
    expect(defaultAgentSource({ keyConnected: true })).toEqual({ source: "anthropic_key", via: "own_key" });
  });
});

describe("agent route: no saved choice", () => {
  it("an EXEMPT company with nothing connected is served by Rovara's AI, with no key read, billed as exempt, and the source is audited (ids only)", async () => {
    const g = gateway();
    const sink = await call(g.deps, requestBody, mint({ cid: cidA }));
    expect(sink.status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.rovaraSent[0]!.key).toMatch(/^rovara-ai-[0-9a-f-]{36}$/u);
    expect(g.keySent).toEqual([]); expect(g.installKeyReads).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ line: { source: "rovara_ai", charge: "exempt", model: BEDROCK_ID } }]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "rovara", via: "default" }]);
    // Only ids and words: nothing of the request, a key or a token.
    expect(JSON.stringify(g.logs)).not.toMatch(/customer-key|hello|rovara-ai-[0-9a-f]{8}/u);
  });

  it.each(["anthropic_key"] as const)("R-1: %s connected after backfill with no saved choice uses its own account and produces no Rovara receipt or bill line", async (source) => {
    const g = gateway({ exempt: [] });
    // The backfill left this company without a row because it had nothing connected.
    expect(await g.choices.sourceFor(cidB)).toBeUndefined();
    if (source === "anthropic_key") g.companyKeys.connectedTo.add(cidB);
    else g.bedrockConnected.add(cidB);
    g.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved ?? {
      source: { kind: "company_key", id: "src_anthropic", name: "Company key", provider: "anthropic", connectionRevision: "1" }, billing: "external_provider",
    } };
    const settlements = vi.spyOn(g.meter, "settleV2");
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(source === "anthropic_key" ? g.keySent.map(r => r.key) : g.byoSent.map(r => r.path)).toHaveLength(1);
    if (source === "anthropic_key") expect(g.keySent[0]!.key).toBe(keyOf(cidB));
    expect(g.rovaraSent).toEqual([]);
    expect(settlements.mock.calls.map(([input]) => input.receipt)).toMatchObject([{ source: { kind: "company_key", provider: source === "anthropic_key" ? "anthropic" : "bedrock" }, billing: "external_provider" }]);
    expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidB, source: source === "anthropic_key" ? "company_key" : "bedrock_byo", via: "own_key" }]);
    expect(await g.choices.sourceFor(cidB)).toBeUndefined();
  });

  it.each(["anthropic_key"] as const)("R-1: disconnected %s without a choice returns to company-billed Rovara AI under its caps", async (source) => {
    const g = gateway({ exempt: [] });
    const connection = source === "anthropic_key" ? g.companyKeys.connectedTo : g.bedrockConnected;
    connection.add(cidB); connection.delete(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { source: "rovara_ai", charge: "customer" } }]);
    const blocked = gateway({ exempt: [], caps: { companyMonth: 0 } });
    expect((await call(blocked.deps, requestBody, mint({ cid: cidB }))).status).toBe(422);
    nothingSent(blocked);
  });

  it("DEC 254zzz525: a connected Bedrock role with no saved choice and no own key is NOT used: Rovara's AI as today (billed to the company), the role never read; an explicit choice is what turns it on", async () => {
    const g = gateway({ exempt: [] });
    g.bedrockConnected.add(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1); expect(g.byoSent).toEqual([]); expect(g.byoReads).toEqual([]); expect(g.keySent).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { source: "rovara_ai", charge: "customer" } }]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidB, source: "rovara", via: "default" }]);
    // The company then explicitly chooses its own Bedrock: now the role is used, and Rovara's AI is not.
    g.choices.saved.set(cidB, "bedrock_byo");
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.byoSent).toHaveLength(1); expect(g.rovaraSent).toHaveLength(1);
  });

  it("R-1: Anthropic precedes Bedrock when both are connected without a choice", async () => {
    const g = gateway(); g.companyKeys.connectedTo.add(cidA); g.bedrockConnected.add(cidA);
    expect((await call(g.deps)).status).toBe(200);
    expect(g.keySent.map(r => r.key)).toEqual([keyOf(cidA)]);
    expect(g.rovaraSent).toEqual([]); expect(g.byoSent).toEqual([]); expect(g.byoReads).toEqual([]);
  });

  it("a NON-exempt default is charged to its company, including with no exemption list", async () => {
    for (const exempt of [[cidA], []]) {
      const g = gateway({ exempt });
      const sink = await call(g.deps, requestBody, mint({ cid: cidB }));
      expect(sink.status).toBe(200); expect(g.rovaraSent).toHaveLength(1);
      expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { source: "rovara_ai", charge: "customer", model: BEDROCK_ID } }]);
      expect((await g.meter.read({ ...agentScope, cid: cidB })).find(r => r.item === "company")!.spentMicros).toBeGreaterThan(0);
      expect(g.installKeyReads).toEqual([]); expect(g.companyKeys.reads).toEqual([]);
      expect(sources(g)).toEqual([{ event: "agent_source", company: cidB, source: "rovara", via: "default" }]);
    }
  });

  it("only the configured internal staging company is exempt; a real customer receives a customer receipt", async () => {
    const demo = "org_dddddddddddddddddddd"; // An internal staging company (placeholder id).
    const g = gateway({ exempt: [demo] });
    g.deps.chargeReceipts = { source: (_claims, _model, resolved) => resolved };
    const settled = vi.spyOn(g.meter, "settleV2");
    for (const cid of [demo, cidB]) expect((await call(g.deps, requestBody, mint({ cid }))).status).toBe(200);
    expect(settled.mock.calls.map(([input]) => ({ company: input.receipt.companyId, billing: input.receipt.billing }))).toEqual([{ company: demo, billing: "exempt" }, { company: cidB, billing: "customer" }]);
    expect(g.meter.billedCalls(claims.iss, demo)).toMatchObject([{ line: { charge: "exempt" } }]);
    expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { charge: "customer" } }]);
  });

  it("a non-exempt default needs a connection only when Rovara AI is unavailable on this gateway", async () => {
    const g = gateway({ exempt: [] });
    delete g.deps.agentAi!.rovara;
    const reserve = vi.spyOn(g.meter, "reserve");
    const sink = await call(g.deps, requestBody, mint({ cid: cidB }));
    expect(sink.status).toBe(ROVARA_AI_OFF.status);
    expect(error(sink)).toEqual({ type: ROVARA_AI_OFF.code, message: ROVARA_AI_OFF.message });
    expect(reserve).not.toHaveBeenCalled(); nothingSent(g);
  });

  it.each(["anthropic_key", "bedrock_byo"] as const)("a non-exempt company opting out via saved %s is refused until its chosen source is connected", async source => {
    const g = gateway({ exempt: [] }); g.choices.saved.set(cidB, source);
    const reserve = vi.spyOn(g.meter, "reserve");
    const sink = await call(g.deps, requestBody, mint({ cid: cidB }));
    const refusal = source === "anthropic_key" ? AGENT_KEY_MISSING : BYO_BEDROCK_NOT_CONNECTED;
    expect(sink.status).toBe(refusal.status);
    expect(error(sink)).toEqual({ type: refusal.code, message: refusal.message });
    expect(reserve).not.toHaveBeenCalled(); nothingSent(g);
  });

  it("a NON-exempt company with an explicit own-key choice uses it; its Bedrock is not read", async () => {
    const g = gateway();
    g.choices.saved.set(cidB, "anthropic_key"); g.companyKeys.connectedTo.add(cidB); g.bedrockConnected.add(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidB)]);
    expect(g.byoReads).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidB, source: "company_key", via: "chosen" }]);
  });
});

describe("agent route: a saved choice always wins (no fallback)", () => {
  it("exempt + saved anthropic_key but no key connected: refused for the missing key, never slid onto Rovara's AI", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "anthropic_key");
    const sink = await call(g.deps);
    expect(error(sink)).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    nothingSent(g);
  });

  it("exempt + saved bedrock_byo but no connection: refused, never slid onto Rovara's AI", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "bedrock_byo");
    const sink = await call(g.deps);
    expect(error(sink)).toEqual({ type: BYO_BEDROCK_NOT_CONNECTED.code, message: BYO_BEDROCK_NOT_CONNECTED.message });
    nothingSent(g);
  });

  it("exempt + saved anthropic_key with a key connected: its key (a saved choice beats the default)", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "anthropic_key"); g.companyKeys.connectedTo.add(cidA);
    expect((await call(g.deps)).status).toBe(200);
    expect(g.keySent).toHaveLength(1); expect(g.rovaraSent).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "company_key", via: "chosen" }]);
  });

  it("exempt + an explicit return to Rovara's AI while a key is connected: Rovara's AI (explicit choice)", async () => {
    const g = gateway();
    g.choices.saved.set(cidA, "rovara"); g.companyKeys.connectedTo.add(cidA);
    expect((await call(g.deps)).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1); expect(g.keySent).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "rovara", via: "chosen" }]);
  });

  it("a NON-exempt explicit Rovara choice is company-billed", async () => {
    const g = gateway(); g.choices.saved.set(cidB, "rovara");
    g.companyKeys.connectedTo.add(cidB); g.bedrockConnected.add(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { charge: "customer" } }]);
    expect(g.rovaraSent).toHaveLength(1);
  });
});

describe("agent route: faults fail closed", () => {
  it("the saved-choice read fails: 503, nothing sent", async () => {
    const g = gateway(); g.choices.fail = true;
    expect((await call(g.deps)).status).toBe(503);
    nothingSent(g);
  });

  it("an unreadable own-key connection refuses before any send", async () => {
    const g = gateway(); g.companyKeys.fail = true;
    expect((await call(g.deps)).status).toBe(503); nothingSent(g);
  });

  it("an unreadable Bedrock connection is irrelevant with no choice (Rovara's AI, role never read); with an explicit bedrock_byo choice it refuses before any send", async () => {
    const g = gateway(); g.byo.connection = async () => { throw new Error("unreadable"); };
    expect((await call(g.deps)).status).toBe(200); expect(g.rovaraSent).toHaveLength(1); expect(g.byoSent).toEqual([]);
    const h = gateway(); h.byo.connection = async () => { throw new Error("unreadable"); }; h.choices.saved.set(cidA, "bedrock_byo");
    expect((await call(h.deps)).status).toBe(503); nothingSent(h);
  });
});

describe("agent route: two companies", () => {
  it("A (exempt, nothing connected) is served by Rovara's AI; B (not exempt, own key) on its own key; neither touches the other's key or choice", async () => {
    const g = gateway();
    g.choices.saved.set(cidB, "anthropic_key"); g.companyKeys.connectedTo.add(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidB)]);
    expect(g.companyKeys.reads).toEqual([cidB]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toHaveLength(1);
    expect(g.meter.billedCalls(claims.iss, cidB)).toHaveLength(0);
  });

  it("A (exempt, no key) cannot use B's connected key or B's Bedrock: it goes to Rovara's AI", async () => {
    const g = gateway();
    g.companyKeys.connectedTo.add(cidB); g.bedrockConnected.add(cidB);
    expect((await call(g.deps, requestBody, mint({ cid: cidA }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.keySent).toEqual([]); expect(g.byoSent).toEqual([]);
    expect(g.companyKeys.reads).toEqual([]);
    expect(g.byoReads).toEqual([]);
  });

  it("A's saved choice never moves B, and the exempt list is per company id (C is not exempt)", async () => {
    const g = gateway({ exempt: [cidA, cidB] });
    g.choices.saved.set(cidA, "anthropic_key"); g.companyKeys.connectedTo.add(cidA);
    expect((await call(g.deps, requestBody, mint({ cid: cidB }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect((await call(g.deps, requestBody, mint({ cid: cidC }))).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(2);
    expect(g.meter.billedCalls(claims.iss, cidC)).toMatchObject([{ line: { charge: "customer" } }]);
  });
});

describe("agent route: every cap still applies to Rovara-AI spend (default source)", () => {
  const refusedFor = async (caps: Partial<Caps>, words: string) => {
   for (const cid of [cidA, cidB]) {
    const g = gateway({ caps });
    const sink = await call(g.deps, requestBody, mint({ cid }));
    expect(sink.status).toBe(422);
    expect(error(sink)).toEqual({ type: "budget_exceeded", message: words });
    expect(g.rovaraSent).toEqual([]);
    for (const row of await g.meter.read({ ...agentScope, cid })) expect(row.committed).toBe(0);
   }
  };
  it("task cap", () => refusedFor({ task: 0 }, "Budget has been exceeded! Key=task"));
  it("person cap", () => refusedFor({ personMonth: 0 }, "ExceededBudget: User=person"));
  it("project cap", () => refusedFor({ projectMonth: 0 }, "Budget has been exceeded! Project=project"));
  it("company cap", () => refusedFor({ companyMonth: 0 }, "Budget has been exceeded! Team=company"));

  it("upkeep cap: a nightly call is held to the project's upkeep limit and is never sent past it", async () => {
    const g = gateway({ upkeepLimits: { limitFor: async () => 0 } });
    const sink = await call(g.deps, requestBody, mint({ cid: cidA, src: "nightly" }));
    expect(sink.status).toBe(422);
    expect(error(sink).type).toBe("upkeep_paused");
    expect(g.rovaraSent).toEqual([]);
  });

  it("the spend is metered on the company row (exempt means nothing is billed, not that nothing is counted)", async () => {
    const g = gateway();
    expect((await call(g.deps)).status).toBe(200);
    const company = (await g.meter.read({ ...agentScope, cid: cidA })).find((r) => r.item === "company")!;
    expect(company.committed).toBeGreaterThan(0);
  });
});

describe("offered models follow the same default (they must equal what the agent route accepts on its very next call)", () => {
  const offered = async (g: G, cid: string, overrides: Partial<OfferedModelsHandlerOptions> = {}) => {
    const options: OfferedModelsHandlerOptions = {
      verify: async () => ({ iss: claims.iss, aud: "rovara-model-gateway-offered-models", jti: "00000000-0000-4000-8000-000000000000", iat: 0, nbf: 0, exp: 0, cid }),
      sources: g.choices, rovara: { models: g.rovara.models, exempt: g.rovara.exempt }, disabled: new Set(), keys: g.companyKeys, byo: g.byo, ...overrides,
    };
    return answerOfferedModels(options, { method: "GET", url: `/v1/service/companies/${cid}/offered-models`, headers: { authorization: "Bearer x" } });
  };
  it("an exempt company on the default: Rovara's AI model list", async () => {
    const g = gateway();
    expect(await offered(g, cidA)).toEqual({ status: 200, body: { version: 1, models: [{ model: MODEL }] } });
  });
  it("an exempt company with its own key: the Anthropic key list", async () => {
    const g = gateway(); g.choices.saved.set(cidA, "anthropic_key"); g.companyKeys.connectedTo.add(cidA);
    const out = await offered(g, cidA);
    expect(out.status).toBe(200);
    expect((out.body as { models: Array<{ model: string }> }).models.map((m) => m.model)).toContain("claude-haiku-5-5");
  });
  it("an exempt company with its own Bedrock: the Bedrock models it picked", async () => {
    const g = gateway(); g.choices.saved.set(cidA, "bedrock_byo"); g.bedrockConnected.add(cidA);
    expect(await offered(g, cidA)).toEqual({ status: 200, body: { version: 1, models: [{ model: MODEL }] } });
  });
  it("a non-exempt default offers exactly the configured Rovara models", async () => {
    const g = gateway();
    expect(await offered(g, cidB)).toEqual({ status: 200, body: { version: 1, models: [{ model: MODEL }] } });
  });
  it("a read fault: the fixed 503, nothing guessed", async () => {
    const g = gateway(); g.choices.fail = true;
    expect((await offered(g, cidA)).status).toBe(503);
  });
});

describe("resolveAgentSource", () => {
  it("saved choices skip connection discovery; every no-choice company checks its own Anthropic key and never a Bedrock role (DEC 254zzz525)", async () => {
    const keys = new CompanyKeys(); const choices = new Choices();
    choices.saved.set(cidA, "openai_key");
    expect(await resolveAgentSource({ sources: choices, exempt: new Set([cidA, cidB]), keys }, claims.iss, cidA)).toEqual({ source: "openai_key", via: "chosen" });
    expect(await resolveAgentSource({ sources: choices, exempt: new Set([cidA]), keys }, claims.iss, cidB)).toEqual({ source: "rovara", via: "default" });
    expect(await resolveAgentSource({ sources: choices, keys }, claims.iss, cidB)).toEqual({ source: "rovara", via: "default" });
    expect(keys.asked).toEqual([`${cidB}/anthropic`, `${cidB}/anthropic`]);
  });
});

// ---- answers and learning (the company-key purposes) ----
function purposeGateway(purpose: "answers" | "learning", options: { exempt?: string[]; companyMonth?: number; answersLimit?: number | undefined; noRovara?: boolean; bedrockStatus?: number; models?: Map<string, string> } = {}) {
  const customer = new CompanyKeys(); const choices = new Choices(); const bedrockConnected = new Set<string>();
  const ownSent: ProviderRequest[] = []; const rovaraSent: ProviderRequest[] = []; const agentKeyReads: string[] = [];
  const agentMeter = new InMemoryMeter(() => now);
  const meter = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
  const companyCaps = new FixedCapsSource({ ...baseCaps, companyMonth: options.companyMonth ?? 1_000_000_000 });
  const rovara: RovaraAi = { sourceId: "operator-source", models: options.models ?? new Map([[MODEL, BEDROCK_ID]]), exempt: new Set(options.exempt ?? [cidA]), transport: async (request) => { rovaraSent.push(request); return options.bedrockStatus === undefined ? { status: 200, body: answer() } : { status: options.bedrockStatus, body: (async function* () { yield Buffer.from("{}"); })() }; } };
  const rovaraDefault = options.noRovara === true ? {} : { rovaraDefault: { ai: rovara, sources: choices } };
  const transport: ProviderTransport = async (request) => { ownSent.push(request); return { status: 200, body: answer() }; };
  const common = { keys: customer, meter, companyCaps, modelLimits: { maxOutputTokens: () => 128_000 }, transport, transports: { openai: transport }, ...rovaraDefault };
  const routes = purpose === "answers"
    ? createAnswersRoutes({ ...common, limits: { limitFor: async () => options.answersLimit } })
    : createLearningRoutes({ ...common, lessons: { isOn: async () => true } });
  const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 1_000_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 1_000_000, priceVersion: 1, estimated: false };
  const base = setup({ meter: agentMeter, caps: companyCaps, keys: { keyFor: async (c) => { agentKeyReads.push(c.cid); return "rovara-install-key"; } }, [purpose]: routes,
    prices: { priceFor: () => price, effectiveFor: () => price, quoteBasis: (provider: string) => ({ version: 1, hash: "a".repeat(64), model: provider === "anthropic" ? MODEL : BEDROCK_ID, fetchedAt: now }) },
    chargeReceipts: { source: (_c, _m, resolved) => resolved } });
  return { ...base, customer, choices, bedrockConnected, ownSent, rovaraSent, agentKeyReads, meter, agentMeter };
}
const ownRunPrice = (cid = cidA) => ({ companyId: cid, model: MODEL, provider: "anthropic", sourceId: "src_own_anthropic",
  connectionRevision: "11111111-1111-4111-8111-111111111111", catalogModel: MODEL, snapshotHash: "a".repeat(64), snapshotVersion: 1,
  expiresAt: now + 60_000, inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 1 });
async function ask(deps: GatewayDependencies, purpose: "answers" | "learning", changes: Record<string, unknown> = {}, bodyChange: Record<string, unknown> = {}) {
  const sink = new MemorySink();
  const runPrice = { companyId: changes.cid ?? cidA, model: MODEL, provider: "bedrock", sourceId: "operator-source", connectionRevision: createHash("sha256").update(JSON.stringify([[MODEL, BEDROCK_ID]])).digest("hex"), catalogModel: BEDROCK_ID,
    snapshotHash: "a".repeat(64), snapshotVersion: 1, expiresAt: now + 60_000, inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 1 };
  await handleGateway(deps, { method: "POST", url: purpose === "answers" ? ANSWERS_PATH : LEARNING_PATH, headers: { "content-type": "application/json", "x-api-key": mint({ stp: purpose === "answers" ? ANSWERS_STEP : LEARNING_STEP, runPrice, ...changes }) }, body: (async function* () { yield Buffer.from(JSON.stringify({ ...requestBody, ...bodyChange })); })() }, sink);
  return sink;
}

for (const purpose of ["answers", "learning"] as const) {
  describe(`${purpose}: the same default (exempt company, no own account)`, () => {
    it("an exempt company with no connected account is served by Rovara's AI, billed exempt, under its own month and the company cap", async () => {
      const g = purposeGateway(purpose);
      const sink = await ask(g.deps, purpose, { cid: cidA });
      expect(sink.status).toBe(200);
      expect(g.rovaraSent).toHaveLength(1);
      expect(g.rovaraSent[0]!.key).toMatch(/^rovara-ai-[0-9a-f-]{36}$/u);
      expect(g.ownSent).toEqual([]); expect(g.customer.reads).toEqual([]); expect(g.agentKeyReads).toEqual([]);
      expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ line: { source: "rovara_ai", charge: "exempt", model: BEDROCK_ID } }]);
      const s: MeterScope = { iss: claims.iss, cid: cidA, pid: claims.pid, tid: claims.tid };
      expect((await g.meter.read(s)).find((r) => r.item === "company")!.committed).toBeGreaterThan(0);
      // The agent meter's combined company row counts it too.
      expect((await g.agentMeter.read({ ...agentScope, cid: cidA })).find((r) => r.item === "company")!.committed).toBeGreaterThan(0);
    });

    it("its own connected Anthropic account wins (unchanged), Rovara's AI is not called", async () => {
      const g = purposeGateway(purpose); g.customer.connectedTo.add(cidA);
      expect((await ask(g.deps, purpose, { runPrice: ownRunPrice() })).status).toBe(200);
      expect(g.ownSent.map((r) => r.key)).toEqual([keyOf(cidA)]);
      expect(g.rovaraSent).toEqual([]);
    });

    it("a NON-exempt company with no account is served and company-billed", async () => {
      const g = purposeGateway(purpose);
      const sink = await ask(g.deps, purpose, { cid: cidB });
      expect(sink.status).toBe(200);
      expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { charge: "customer" } }]);
      expect(g.rovaraSent).toHaveLength(1); expect(g.ownSent).toEqual([]);
    });

    it("a NON-exempt company that explicitly chose Rovara's AI is company-billed", async () => {
      const g = purposeGateway(purpose); g.choices.saved.set(cidB, "rovara");
      const sink = await ask(g.deps, purpose, { cid: cidB });
      expect(sink.status).toBe(200);
      expect(g.meter.billedCalls(claims.iss, cidB)).toMatchObject([{ line: { charge: "customer" } }]);
      expect(g.rovaraSent).toHaveLength(1);
    });

    it("only the Anthropic Messages path: the OpenAI path of an exempt company with no OpenAI account is paused, never put on Rovara's AI", async () => {
      const g = purposeGateway(purpose);
      const sink = new MemorySink();
      await handleGateway(g.deps, { method: "POST", url: `/v1/${purpose}/openai/chat/completions`, headers: { "content-type": "application/json", "x-api-key": mint({ stp: purpose === "answers" ? ANSWERS_STEP : LEARNING_STEP }) }, body: (async function* () { yield Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 10 })); })() }, sink);
      expect(sink.headers[purpose === "answers" ? ANSWERS_PAUSE_HEADER : "x-rovara-lessons-pause"]).toBe("no_provider");
      expect(g.rovaraSent).toEqual([]);
    });

    it("an exempt company that chose another source (own OpenAI key, own endpoint, own Bedrock) is paused as before: no slide onto Rovara's AI", async () => {
      for (const saved of ["openai_key", "custom_endpoint", "bedrock_byo", "anthropic_key"] as const) {
        const g = purposeGateway(purpose); g.choices.saved.set(cidA, saved);
        const sink = await ask(g.deps, purpose);
        expect(sink.headers[purpose === "answers" ? ANSWERS_PAUSE_HEADER : "x-rovara-lessons-pause"]).toBe("no_provider");
        expect(g.rovaraSent).toEqual([]);
      }
    });

    it("DEC 254zzz525: an exempt company with its own Bedrock connected and no choice is served by Rovara's AI exactly as without the role (the role changes no default)", async () => {
      const g = purposeGateway(purpose); g.bedrockConnected.add(cidA);
      const sink = await ask(g.deps, purpose);
      expect(sink.headers[purpose === "answers" ? ANSWERS_PAUSE_HEADER : "x-rovara-lessons-pause"]).toBeUndefined();
      expect(sink.status).toBe(200);
      expect(g.rovaraSent).toHaveLength(1);
    });

    it("an exempt company that explicitly returned to Rovara's AI is served by it", async () => {
      const g = purposeGateway(purpose); g.choices.saved.set(cidA, "rovara");
      expect((await ask(g.deps, purpose)).status).toBe(200);
      expect(g.rovaraSent).toHaveLength(1);
    });

    it("no Rovara's AI configured: today's pause", async () => {
      const g = purposeGateway(purpose, { noRovara: true });
      const sink = await ask(g.deps, purpose);
      expect(sink.headers[purpose === "answers" ? ANSWERS_PAUSE_HEADER : "x-rovara-lessons-pause"]).toBe("no_provider");
    });

    it("a source read fault is a 503, never a guess; a model Rovara's AI does not offer is refused before any hold", async () => {
      const g = purposeGateway(purpose); g.choices.fail = true;
      expect((await ask(g.deps, purpose)).status).toBe(503);
      expect(g.rovaraSent).toEqual([]);
      const h = purposeGateway(purpose, { models: new Map([["claude-other", BEDROCK_ID]]) });
      const sink = await ask(h.deps, purpose);
      expect(sink.status).toBe(400);
      expect(error(sink).message).toBe(ROVARA_AI_MODEL.message);
      expect(h.rovaraSent).toEqual([]);
      for (const r of await h.meter.read({ iss: claims.iss, cid: cidA, pid: claims.pid, tid: claims.tid })) expect(r.committed).toBe(0);
    });

    it("a key-connected read fault for an exempt company is a 503, nothing sent (never a guess onto Rovara's AI)", async () => {
      const g = purposeGateway(purpose);
      g.customer.connectedTo.clear();
      const connected = g.customer.connected.bind(g.customer);
      g.customer.connected = async () => { throw new Error("down"); };
      expect((await ask(g.deps, purpose)).status).toBe(503);
      g.customer.connected = connected;
      expect(g.rovaraSent).toEqual([]);
    });

    it("a Bedrock refusal of Rovara's own role is Rovara's to fix: 503, never charged", async () => {
      const g = purposeGateway(purpose, { bedrockStatus: 403 });
      const sink = await ask(g.deps, purpose);
      expect(sink.status).toBe(ROVARA_AI_UNAVAILABLE.status);
      expect(error(sink).message).toBe(ROVARA_AI_UNAVAILABLE.message);
      for (const r of await g.meter.read({ iss: claims.iss, cid: cidA, pid: claims.pid, tid: claims.tid })) expect(r.spentMicros).toBe(0);
    });

    it("two companies: A exempt, C on its own key, B company-billed; no one reads another's key", async () => {
      const g = purposeGateway(purpose, { exempt: [cidA, cidC] }); g.customer.connectedTo.add(cidC);
      expect((await ask(g.deps, purpose, { cid: cidA })).status).toBe(200);
      expect((await ask(g.deps, purpose, { cid: cidC, runPrice: ownRunPrice(cidC) })).status).toBe(200);
      expect((await ask(g.deps, purpose, { cid: cidB })).status).toBe(200);
      expect(g.rovaraSent).toHaveLength(2);
      expect(g.ownSent.map((r) => r.key)).toEqual([keyOf(cidC)]);
      expect(g.customer.reads).toEqual([cidC]);
    });

    it("the month cap applies: a company monthly cap of 0 pauses the call before anything is sent", async () => {
      const g = purposeGateway(purpose, { companyMonth: 0 });
      const sink = await ask(g.deps, purpose);
      expect(sink.status).toBe(422);
      expect(g.rovaraSent).toEqual([]);
    });
  });
}

describe("answers: answers_month enforcement on Rovara-AI spend", () => {
  it("a $0 answers month pauses (no_budget) and nothing is sent; a tiny month pauses cost_too_high", async () => {
    const zero = purposeGateway("answers", { answersLimit: 0 });
    const a = await ask(zero.deps, "answers");
    expect(a.headers[ANSWERS_PAUSE_HEADER]).toBe("no_budget");
    expect(zero.rovaraSent).toEqual([]);
    const tiny = purposeGateway("answers", { answersLimit: 1 });
    const b = await ask(tiny.deps, "answers");
    expect(b.headers[ANSWERS_PAUSE_HEADER]).toBe("cost_too_high");
    expect(tiny.rovaraSent).toEqual([]);
  });
  it("spend fills the month: once the month is used a call is paused monthly_limit", async () => {
    const g = purposeGateway("answers", { answersLimit: 1_500 });
    let paused = false;
    for (let i = 0; i < 200 && !paused; i++) {
      const sink = await ask(g.deps, "answers");
      if (sink.status !== 200) { expect(sink.headers[ANSWERS_PAUSE_HEADER]).toBe("monthly_limit"); paused = true; }
    }
    expect(paused).toBe(true);
    const before = g.rovaraSent.length;
    await ask(g.deps, "answers");
    expect(g.rovaraSent.length).toBe(before);
  });
});

