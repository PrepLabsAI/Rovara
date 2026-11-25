// The learning route on the company's other connected providers (DEC 226 follow-up): Gemini (AI Studio), Gemini on Vertex and
// OpenAI, through the same route object, money core, learning meter, combined company cap and pause codes as Anthropic.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource, type CapsSource } from "../../packages/model-gateway/src/caps.js";
import { guardOpenAi, OPENAI_DEFAULT_MAX_OUTPUT_TOKENS, OpenAiUsageCollector, openAiUsage } from "../../packages/model-gateway/src/learning-openai.js";
import { createLearningRoutes, LEARNING_PATH, LEARNING_PAUSE_HEADER, LEARNING_PAUSE_MESSAGES, LEARNING_STEP, parseLearningPath, type LearningKeySource, type LearningProvider } from "../../packages/model-gateway/src/learning-route.js";
import { InMemoryMeter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { caps as agentCaps, claims, MemorySink, mint, now, scope as agentScope, setup } from "./model-gateway-fixture.js";
import { geminiAnswer, geminiBody } from "./model-gateway-product-fixture.js";

const cid = claims.cid;
const learningScope = (): MeterScope => ({ iss: claims.iss, cid, pid: claims.pid, tid: claims.tid });
const GEMINI_MODEL = "gemini-2.5-flash";
const OPENAI_MODEL = "gpt-5-mini";
const GEMINI_PATH = `/v1/learning/gemini/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
const GEMINI_WHOLE = `/v1/learning/gemini/v1beta/models/${GEMINI_MODEL}:generateContent`;
const VERTEX_PATH = (project = "acme-learn", location = "us-central1") => `/v1/learning/vertex/v1/projects/${project}/locations/${location}/publishers/google/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
const OPENAI_PATH = "/v1/learning/openai/chat/completions";
const openAiBody = { model: OPENAI_MODEL, messages: [{ role: "user", content: "reflect" }], max_completion_tokens: 50, stream: true };
const mdl = ["claude-sonnet-4-5", GEMINI_MODEL, OPENAI_MODEL];

async function* openAiStream(usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 }, done = true) {
  yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
  yield Buffer.from(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  if (done) yield Buffer.from("data: [DONE]\n\n");
}
class Keys implements LearningKeySource {
  readonly connectedFor = new Set<string>();
  readonly used: Array<[string, LearningProvider]> = [];
  readonly refusedBy: string[] = [];
  target: { projectId: string; location: string } | undefined = { projectId: "acme-learn", location: "us-central1" };
  async connected(_iss: string, c: string, provider: LearningProvider) { return this.connectedFor.has(`${c}:${provider}`); }
  async keyFor(_iss: string, c: string, provider: LearningProvider): Promise<string | undefined> { this.used.push([c, provider]); return `${provider}-key-of-${c}`; }
  async vertexTarget() { return this.target; }
  async refused(_iss: string, c: string, provider: LearningProvider) { this.refusedBy.push(`${c}:${provider}`); }
}
function gateway(options: { providers?: LearningProvider[]; companyMonth?: number; companyCaps?: CapsSource; ceiling?: number; transports?: Partial<Record<LearningProvider, ProviderTransport>>; lessons?: boolean; combined?: boolean } = {}) {
  const keys = new Keys();
  for (const p of options.providers ?? ["gemini", "vertex", "openai", "anthropic"]) keys.connectedFor.add(`${cid}:${p}`);
  const sent: Record<LearningProvider, ProviderRequest[]> = { anthropic: [], gemini: [], vertex: [], openai: [] };
  const answers: Record<LearningProvider, () => AsyncIterable<Uint8Array>> = { anthropic: () => geminiAnswer(), gemini: () => geminiAnswer(), vertex: () => geminiAnswer(), openai: () => openAiStream() };
  const transportOf = (p: LearningProvider): ProviderTransport => options.transports?.[p] ?? (async (r) => { sent[p].push(r); return { status: 200, body: answers[p]() }; });
  const agentMeter = new InMemoryMeter(() => now);
  const learningMeter = new InMemoryMeter(() => now, undefined, undefined, options.combined === false ? {} : { combineCompanyWith: agentMeter });
  const companyCaps = options.companyCaps ?? new FixedCapsSource({ ...agentCaps, companyMonth: options.companyMonth ?? 1_000_000_000 });
  const learning = createLearningRoutes({
    keys, meter: learningMeter, companyCaps, lessons: { isOn: async () => options.lessons !== false }, modelLimits: { maxOutputTokens: () => 8192 },
    transport: transportOf("anthropic"), transports: { gemini: transportOf("gemini"), vertex: transportOf("vertex"), openai: transportOf("openai") },
    ...(options.ceiling === undefined ? {} : { monthCeilingMicros: options.ceiling }),
  });
  const base = setup({ meter: agentMeter, caps: companyCaps, keys: { keyFor: async () => { throw new Error("install key must not be read"); } }, learning });
  return { ...base, agentMeter, learningMeter, keys, sent, learning };
}
async function learn(deps: GatewayDependencies, path: string, body: unknown, changes: Record<string, unknown> = {}) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify(body));
  await handleGateway(deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({ stp: LEARNING_STEP, mdl, ...changes }) }, body: (async function* () { yield bytes; })() }, sink);
  return sink;
}
const error = (sink: MemorySink) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;
const expectPaused = (sink: MemorySink, reason: keyof typeof LEARNING_PAUSE_MESSAGES) => {
  expect(error(sink)).toEqual({ type: "lessons_paused", message: LEARNING_PAUSE_MESSAGES[reason] });
  expect(sink.headers[LEARNING_PAUSE_HEADER]).toBe(reason);
};
const row = async (m: InMemoryMeter, item: string) => (await m.read(learningScope())).find((r) => r.item === item);
const nothingMoved = async (g: ReturnType<typeof gateway>) => {
  for (const p of Object.values(g.sent)) expect(p).toHaveLength(0);
  for (const r of await g.learningMeter.read(learningScope())) expect(r.committed).toBe(0);
  for (const r of await g.agentMeter.read(agentScope)) expect(r.committed).toBe(0);
};
const CASES: Array<[LearningProvider, string, unknown]> = [["gemini", GEMINI_PATH, geminiBody], ["vertex", VERTEX_PATH(), geminiBody], ["openai", OPENAI_PATH, openAiBody]];

describe("learning providers: one route, the company's own key per provider", () => {
  for (const [provider, path, body] of CASES) {
    it(`${provider}: runs on the company's key for that provider, counts in the learning month AND the combined company row`, async () => {
      const g = gateway();
      const sink = await learn(g.deps, path, body);
      expect(sink.status).toBe(200);
      expect(g.sent[provider]).toHaveLength(1);
      expect(g.sent[provider][0]!.key).toBe(`${provider}-key-of-${cid}`);
      expect(g.keys.used).toEqual([[cid, provider]]);
      // 10 input at $1/M and 5 output at $2/M = 20 micros, on the learning meter's company row and the agent meter's combined row.
      expect((await row(g.learningMeter, "company"))!.spentMicros).toBe(20);
      expect((await g.agentMeter.read(agentScope)).find((r) => r.item === "company")!.spentMicros).toBe(20);
      // No person pays, and task and project rows are accounting only.
      expect((await row(g.learningMeter, "person"))?.committed ?? 0).toBe(0);
      expect(g.logs).toContainEqual(expect.objectContaining({ event: "settled", route: "learning", costMicros: 20 }));
    });

    it(`${provider}: not connected FOR THAT PROVIDER is no_provider before any hold, even with other providers connected`, async () => {
      const g = gateway({ providers: (["anthropic", "gemini", "vertex", "openai"] as const).filter((p) => p !== provider) });
      const sink = await learn(g.deps, path, body);
      expect(sink.status).toBe(403);
      expectPaused(sink, "no_provider");
      expect(g.keys.used).toEqual([]);
      await nothingMoved(g);
    });

    it(`${provider}: the lessons switch off refuses before the key, the hold or the provider`, async () => {
      const g = gateway({ lessons: false });
      expectPaused(await learn(g.deps, path, body), "lessons_off");
      expect(g.keys.used).toEqual([]);
      await nothingMoved(g);
    });

    it(`${provider}: a model the token does not name is refused (400), nothing held or sent`, async () => {
      const g = gateway();
      const sink = await learn(g.deps, path, body, { mdl: ["claude-sonnet-4-5"] });
      expect(sink.status).toBe(400);
      expect(error(sink)).toEqual({ type: "invalid_request", message: "request not allowed" });
      await nothingMoved(g);
    });

    it(`${provider}: no transport mounted is a 404`, async () => {
      const g = gateway();
      const learning = createLearningRoutes({ keys: g.keys, meter: g.learningMeter, companyCaps: new FixedCapsSource(agentCaps), lessons: { isOn: async () => true }, modelLimits: { maxOutputTokens: () => 8192 }, transport: async () => { throw new Error("no"); } });
      expect((await learn({ ...g.deps, learning }, path, body)).status).toBe(404);
    });

    it(`${provider}: the company's learning cap and the combined cap hold it like an Anthropic call`, async () => {
      // The company cap is full of agent spend: no_budget although the learning month has room.
      const g = gateway({ companyMonth: 100_000 });
      const a = await g.agentMeter.reserve({ scope: agentScope, caps: { ...agentCaps, companyMonth: 100_000 }, estimateMicros: 99_990 });
      if (!a.ok) throw new Error("reserve"); await g.agentMeter.settle(a.reservation, 99_990);
      expectPaused(await learn(g.deps, path, body), "no_budget");
      expect(g.sent[provider]).toHaveLength(0);
      // The learning month used up: monthly_limit.
      const h = gateway({ ceiling: 1_000 });
      const r = await h.learningMeter.reserve({ scope: learningScope(), caps: { task: Number.MAX_SAFE_INTEGER, projectMonth: Number.MAX_SAFE_INTEGER, companyMonth: 1_000, combinedCompanyMonth: 1_000_000_000 }, estimateMicros: 1_000 });
      if (!r.ok) throw new Error("reserve"); await h.learningMeter.settle(r.reservation, 1_000);
      expectPaused(await learn(h.deps, path, body), "monthly_limit");
      expect(h.sent[provider]).toHaveLength(0);
    });

    it(`${provider}: a learning meter that does not combine holds nothing (503)`, async () => {
      const g = gateway({ combined: false });
      expect((await learn(g.deps, path, body)).status).toBe(503);
      await nothingMoved(g);
    });

    it(`${provider}: the provider refusing the company's key (401/403) costs nothing, tells Code no_provider and tells the adapter`, async () => {
      for (const status of [401, 403]) {
        const g = gateway({ transports: { [provider]: async () => ({ status, body: (async function* () { /* empty */ })() }) } });
        expectPaused(await learn(g.deps, path, body), "no_provider");
        expect(await row(g.learningMeter, "company")).toMatchObject({ committed: 0, spentMicros: 0 });
        expect(g.keys.refusedBy).toEqual([`${cid}:${provider}`]);
      }
    });

    it(`${provider}: 429 is free and any other failure keeps the hold`, async () => {
      const free = gateway({ transports: { [provider]: async () => ({ status: 429, body: (async function* () { /* empty */ })() }) } });
      await learn(free.deps, path, body);
      expect((await row(free.learningMeter, "company"))!.spentMicros).toBe(0);
      const charged = gateway({ transports: { [provider]: async () => ({ status: 500, body: (async function* () { /* empty */ })() }) } });
      await learn(charged.deps, path, body);
      expect((await row(charged.learningMeter, "company"))!.spentMicros).toBeGreaterThan(0);
    });

    it(`${provider}: a task token is refused here, and no provider route takes the company's key for another company`, async () => {
      const g = gateway();
      const sink = new MemorySink();
      await handleGateway(g.deps, { method: "POST", url: path, headers: { "content-type": "application/json", "x-api-key": mint({ mdl }) }, body: (async function* () { yield Buffer.from(JSON.stringify(body)); })() }, sink);
      expect(sink.status).toBe(401);
      await nothingMoved(g);
    });
  }

  it("a learning token is still refused on the agent route and the product route; the anthropic path is unchanged", async () => {
    const g = gateway();
    expect(parseLearningPath(LEARNING_PATH, "")).toEqual({ provider: "anthropic" });
    expect(parseLearningPath(LEARNING_PATH, "x=1")).toBeUndefined();
    expect(parseLearningPath("/v1/learning/other", "")).toBeUndefined();
    expect(parseLearningPath(OPENAI_PATH, "x=1")).toBeUndefined();
    expect((await learn(g.deps, "/v1/learning/gemini/v1/models/x:other", geminiBody)).status).toBe(404);
    expect((await learn(g.deps, "/v1/learning/openai/other", openAiBody)).status).toBe(404);
  });

  it("vertex: a path naming another project or location is refused before any hold, token or send; no connected target is no_provider", async () => {
    for (const path of [VERTEX_PATH("other-project"), VERTEX_PATH("acme-learn", "europe-west4")]) {
      const g = gateway();
      const sink = await learn(g.deps, path, geminiBody);
      expect(sink.status).toBe(400);
      expect(g.keys.used).toEqual([]);
      await nothingMoved(g);
    }
    const g = gateway(); g.keys.target = undefined;
    expectPaused(await learn(g.deps, VERTEX_PATH(), geminiBody), "no_provider");
    await nothingMoved(g);
  });

  it("each provider is priced on its own price rows (Vertex on the Gemini rows and its own)", async () => {
    for (const [path, body, expected] of [[GEMINI_PATH, geminiBody, ["gemini"]], [VERTEX_PATH(), geminiBody, ["gemini", "vertex"]], [OPENAI_PATH, openAiBody, ["openai"]], [LEARNING_PATH, { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream: true }, ["anthropic"]]] as const) {
      const g = gateway();
      const seen = new Set<string>();
      const prices: GatewayDependencies["prices"] = { priceFor: (provider) => { seen.add(provider); return { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }; } };
      await learn({ ...g.deps, prices }, path, body);
      expect([...seen].sort(), path).toEqual([...expected].sort());
    }
  });

  it("vertex: sends to the connected project and location, with the minted token, and is priced at the dearer of the Gemini and Vertex rows", async () => {
    const g = gateway();
    const seen: string[] = [];
    const prices: GatewayDependencies["prices"] = { priceFor: (provider, model) => { seen.push(`${provider}/${model}`); return { inputMicrosPerMTok: provider === "vertex" ? 3_000_000 : 1_000_000, outputMicrosPerMTok: 2_000_000 }; } };
    const sink = await learn({ ...g.deps, prices }, VERTEX_PATH(), geminiBody);
    expect(sink.status).toBe(200);
    expect(g.sent.vertex[0]!.path).toBe(`/v1/projects/acme-learn/locations/us-central1/publishers/google/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`);
    expect(g.sent.vertex[0]!.key).toBe(`vertex-key-of-${cid}`);
    expect(seen).toContain(`vertex/${GEMINI_MODEL}`);
    // 10 x $3/M + 5 x $2/M = 40 micros (the dearer input rate).
    expect((await row(g.learningMeter, "company"))!.spentMicros).toBe(40);
  });

  describe("provider answers rejected before any generation are free (400, 404, 422), as on the product route", () => {
    const failing = (status: number, text = "") => async () => ({ status, body: (async function* () { yield Buffer.from(text); })() });
    for (const [provider, path, body] of CASES) {
      for (const status of [400, 404, 422]) {
        it(`${provider} ${String(status)}: nothing charged, no pause, a fixed 502`, async () => {
          const g = gateway({ transports: { [provider]: failing(status, '{"error":{"message":"model not found"}}') } });
          const sink = await learn(g.deps, path, body);
          expect(sink.status).toBe(502);
          expect(error(sink)).toEqual({ type: "provider_error", message: "provider unavailable" });
          expect(await row(g.learningMeter, "company")).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
          expect(g.keys.refusedBy).toEqual([]);
        });
      }
    }
    it("an AI Studio 400 API_KEY_INVALID is the no_provider pause at $0 and tells the adapter; the same words on other providers are not", async () => {
      const g = gateway({ transports: { gemini: failing(400, '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}') } });
      expectPaused(await learn(g.deps, GEMINI_PATH, geminiBody), "no_provider");
      expect(await row(g.learningMeter, "company")).toMatchObject({ committed: 0, spentMicros: 0 });
      expect(g.keys.refusedBy).toEqual([`${cid}:gemini`]);
      const v = gateway({ transports: { vertex: failing(400, "API_KEY_INVALID") } });
      expect((await learn(v.deps, VERTEX_PATH(), geminiBody)).status).toBe(502);
      expect(v.keys.refusedBy).toEqual([]);
    });
    it("a 400 with a huge body is read only in part and still free", async () => {
      const g = gateway({ transports: { gemini: failing(400, "x".repeat(200_000)) } });
      expect((await learn(g.deps, GEMINI_PATH, geminiBody)).status).toBe(502);
      expect((await row(g.learningMeter, "company"))!.spentMicros).toBe(0);
    });
    it("golden: Anthropic keeps its rule (a 400 is charged); a 5xx on every provider is charged", async () => {
      const a = gateway({ transports: { anthropic: failing(400) } });
      await learn(a.deps, LEARNING_PATH, { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream: true });
      expect((await row(a.learningMeter, "company"))!.spentMicros).toBeGreaterThan(0);
      for (const [provider, path, body] of CASES) {
        const g = gateway({ transports: { [provider]: failing(500) } });
        await learn(g.deps, path, body);
        expect((await row(g.learningMeter, "company"))!.spentMicros, provider).toBeGreaterThan(0);
      }
    });
  });

  it("a key gone between admission and send is no_provider at $0 on every provider; the install key is never a fallback", async () => {
    for (const [provider, path, body] of CASES) {
      const g = gateway();
      g.keys.keyFor = async () => undefined;
      expectPaused(await learn(g.deps, path, body), "no_provider");
      expect(g.sent[provider]).toHaveLength(0);
      expect(await row(g.learningMeter, "company")).toMatchObject({ committed: 0, spentMicros: 0, reservedMicros: 0 });
    }
  });

  it("whole (non-streamed) answers settle on the reported counts", async () => {
    const whole = (usage: unknown) => async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(usage)); })() });
    const o = gateway({ transports: { openai: whole({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } }) } });
    expect((await learn(o.deps, OPENAI_PATH, { ...openAiBody, stream: false })).status).toBe(200);
    // 60 uncached input at $1/M + 40 cached (no cache price: the input rate) + 10 output at $2/M.
    expect((await row(o.learningMeter, "company"))!.spentMicros).toBeGreaterThan(0);
    const gm = gateway({ transports: { gemini: whole({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) } });
    expect((await learn(gm.deps, GEMINI_WHOLE, geminiBody)).status).toBe(200);
    expect((await row(gm.learningMeter, "company"))!.spentMicros).toBe(20);
  });

  it("an incomplete OpenAI stream (no [DONE], or no usage) is charged at the hold, never at $0", async () => {
    for (const body of [() => openAiStream({ prompt_tokens: 1, completion_tokens: 1 }, false), async function* () { yield Buffer.from("data: [DONE]\n\n"); }]) {
      const g = gateway({ transports: { openai: async () => ({ status: 200, body: body() }) } });
      await learn(g.deps, OPENAI_PATH, openAiBody);
      const spent = (await row(g.learningMeter, "company"))!;
      expect(spent.spentMicros).toBeGreaterThan(20);
      expect((await g.agentMeter.read(agentScope)).find((r) => r.item === "company")!.spentMicros).toBe(spent.spentMicros);
    }
  });
});

describe("guardOpenAi: text only, one answer, an output ceiling", () => {
  const headers = { "content-type": "application/json" };
  const limits = { maxOutputTokens: () => 1000 as unknown };
  const guard = (body: unknown, h: Record<string, string | undefined> = headers, l = limits) => guardOpenAi(Buffer.from(JSON.stringify(body)), h, l);
  const ok = (body: unknown, l = limits) => { const r = guard(body, headers, l); if (!r.ok) throw new Error(`refused: ${r.message}`); return r; };
  const base = { model: OPENAI_MODEL, messages: [{ role: "user", content: "hi" }] };

  it("forwards max_completion_tokens (never max_tokens), the row's ceiling when none is asked, include_usage when streaming", () => {
    const a = ok({ ...base, max_tokens: 50 });
    expect(JSON.parse(a.bytes.toString())).toEqual({ ...base, max_completion_tokens: 50 });
    expect(a.maxTokens).toBe(50);
    expect(ok(base).maxTokens).toBe(1000);
    expect((JSON.parse(ok({ ...base, stream: true }).bytes.toString()) as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
    expect((JSON.parse(ok({ ...base, stream: true, stream_options: { include_usage: true } }).bytes.toString()) as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
    expect(ok({ ...base, stream: true }).streaming).toBe(true);
    expect(ok(base).path).toBe("/v1/chat/completions");
    // No row for the model: the fixed default, which is also the most a request may ask.
    expect(ok(base, { maxOutputTokens: () => undefined }).maxTokens).toBe(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(ok(base, { maxOutputTokens: () => { throw new Error("x"); } }).maxTokens).toBe(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS);
  });
  const refusals: Array<[string, unknown]> = [
    ["above the ceiling", { ...base, max_completion_tokens: 1001 }],
    ["two ceilings that differ", { ...base, max_tokens: 5, max_completion_tokens: 6 }],
    ["a zero ceiling", { ...base, max_completion_tokens: 0 }],
    ["a fractional ceiling", { ...base, max_completion_tokens: 1.5 }],
    ["several answers", { ...base, n: 2 }],
    ["an unknown field", { ...base, web_search_options: {} }],
    ["a priority service tier", { ...base, service_tier: "priority" }],
    ["audio output", { ...base, modalities: ["text", "audio"] }],
    ["an image part", { ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }],
    ["an image part that also carries text", { ...base, messages: [{ role: "user", content: [{ type: "image_url", text: "a" }] }] }],
    ["an audio part", { ...base, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }] }],
    ["a file part", { ...base, messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }] }],
    ["a text part with an extra key", { ...base, messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: {} }] }] }],
    ["a message with an unknown key", { ...base, messages: [{ role: "user", content: "a", audio: {} }] }],
    ["an unknown role", { ...base, messages: [{ role: "function", content: "a" }] }],
    ["no messages", { ...base, messages: [] }],
    ["a null message body with no tool calls", { ...base, messages: [{ role: "assistant", content: null }] }],
    ["a built-in tool", { ...base, tools: [{ type: "web_search" }] }],
    ["a bad tool choice", { ...base, tool_choice: "everything" }],
    ["stream options without a stream", { ...base, stream_options: { include_usage: true } }],
    ["stream options asking more", { ...base, stream: true, stream_options: { include_obfuscation: true } }],
    ["a bad model name", { ...base, model: "gpt 5" }],
    ["no model", { messages: base.messages }],
    ["a bad reasoning effort", { ...base, reasoning_effort: "extreme" }],
    ["a non-boolean stream", { ...base, stream: "yes" }],
  ];
  for (const [name, body] of refusals) it(`refuses ${name}, in fixed words`, () => {
    const r = guard(body);
    expect(r).toEqual({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" });
  });
  it("accepts plain function tools, tool results and assistant tool calls", () => {
    expect(ok({ ...base, tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: { type: "function", function: { name: "f" } }, messages: [
      { role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "ok" },
    ] }).hasTools).toBe(true);
  });
  it("refuses a wrong content type, a header that names another account, and a body past the limit or not JSON", () => {
    expect(guard(base, { "content-type": "text/plain" }).ok).toBe(false);
    expect(guard(base, { ...headers, "openai-organization": "org-x" }).ok).toBe(false);
    expect(guard(base, { ...headers, "openai-project": "p" }).ok).toBe(false);
    expect(guard(base, { ...headers, "x-litellm-key": "k" }).ok).toBe(false);
    expect(guardOpenAi(Buffer.from("not json"), headers, limits).ok).toBe(false);
    expect(guardOpenAi(Buffer.alloc(4 * 1024 * 1024 + 1), headers, limits)).toMatchObject({ ok: false, status: 413 });
  });
  it("the input is bounded by its bytes (nothing the hold can't see)", () => { expect(ok(base).inputBounded).toBe(true); });
});

describe("OpenAiUsageCollector", () => {
  const feed = (...frames: string[]) => { const c = new OpenAiUsageCollector(); for (const f of frames) c.push(Buffer.from(f)); return c.finish(); };
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  it("reads the last chunk's usage, cached tokens at the cache-read rate, reasoning inside completion", () => {
    expect(feed(chunk({ choices: [{ delta: {} }] }), chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 } } }), "data: [DONE]\n\n"))
      .toEqual({ input: 60, output: 30, cacheRead: 40, cacheWrite: 0 });
  });
  it("reads a stream split anywhere, with CRLF", () => {
    const whole = `${chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}data: [DONE]\n\n`.replaceAll("\n", "\r\n");
    const c = new OpenAiUsageCollector();
    for (const piece of whole.match(/[\s\S]{1,7}/gu)!) c.push(Buffer.from(piece));
    expect(c.finish()).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
  });
  it.each([
    ["no [DONE]", [chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })]],
    ["no usage", [chunk({ choices: [{ delta: {} }] }), "data: [DONE]\n\n"]],
    ["a null usage only", [chunk({ choices: [], usage: null }), "data: [DONE]\n\n"]],
    ["an error chunk", [chunk({ error: { message: "x" } }), "data: [DONE]\n\n"]],
    ["data after [DONE]", ["data: [DONE]\n\n", chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })]],
    ["usage going down", [chunk({ usage: { prompt_tokens: 1, completion_tokens: 5 } }), chunk({ usage: { prompt_tokens: 1, completion_tokens: 4 } }), "data: [DONE]\n\n"]],
    ["a fractional count", [chunk({ usage: { prompt_tokens: 1.5, completion_tokens: 1 } }), "data: [DONE]\n\n"]],
    ["cached above the prompt", [chunk({ usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } }), "data: [DONE]\n\n"]],
    ["an unknown line", ["junk\n\n", chunk({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), "data: [DONE]\n\n"]],
    ["invalid JSON", ["data: {\n\n", "data: [DONE]\n\n"]],
  ])("is unusable with %s (the call keeps its hold)", (_name, frames) => { expect(feed(...frames)).toBeUndefined(); });
  it("openAiUsage reads counts only and refuses anything else", () => {
    expect(openAiUsage({ prompt_tokens: 1, completion_tokens: 2 })).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    for (const bad of [undefined, null, [], { prompt_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 2e9, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: [] }]) expect(openAiUsage(bad)).toBeUndefined();
  });
});
