// DEC 254zzz521 (count only what was actually spent, DEC 254zzz493, covers the company's cap meter): a call WE cut short (the client left, the
// deadline passed, the task ended: cause "aborted") on the company's OWN provider key settles at the ACTUAL usage when the provider reported it,
// else at an ESTIMATE OF USE (failed-call.ts, the rule Rovara's own Bedrock uses), marked estimated; NEVER the whole hold unless the estimate itself
// reaches it. The hold is closed once. A stream the PROVIDER broke on a company key, and Rovara's own Bedrock, are unchanged.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, MemorySink, mint, now, requestBody, scope, setup, sse } from "./model-gateway-fixture.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { mayReasonUnseen, cutCallMicros, FAILED_CALL_INPUT_BYTES_PER_TOKEN, FAILED_CALL_OUTPUT_BYTES_PER_TOKEN, failedCallMicros } from "../../packages/model-gateway/src/failed-call.js";
import { serializeEndpointConnection } from "../../packages/model-gateway/src/endpoint-source.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import type { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { createLearningRoutes, LEARNING_STEP } from "../../packages/model-gateway/src/learning-route.js";
import { InMemoryMeter as LearningMeter } from "../../packages/model-gateway/src/meter.js";
import { productGateway, productScope, streamPath, geminiBody } from "./model-gateway-product-fixture.js";
beforeAll(denyNetwork);

type Family = "anthropic_key" | "openrouter" | "endpoint" | "bedrock_byo";
const FAMILIES: Family[] = ["anthropic_key", "openrouter", "endpoint", "bedrock_byo"];
const ev = (l: unknown): unknown => (l as { event?: unknown }).event;
const data = (value: unknown) => Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
const delta = (d: Record<string, unknown>, finish: string | null = null) => data({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** What the provider sends before the cut. `usage`: a complete answer that reports its usage (then the connection stays open, as if the client left while it was being sent). */
type Sent = { kind: "nothing" } | { kind: "text"; text: string; inputTokens?: number } | { kind: "complete"; text: string };
const TEXT = "p".repeat(98);
/** Anthropic SSE for the families that speak it. */
const anthropicFrames = (sent: Sent): Buffer[] => {
  if (sent.kind === "nothing") return [];
  const input = sent.kind === "text" ? sent.inputTokens ?? 0 : 1_000;
  const head = [sse("message_start", { message: { usage: { input_tokens: input, output_tokens: 0 } } }), sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: sent.text } })];
  return sent.kind === "text" ? head : [...head, sse("content_block_stop", { index: 0 }), sse("message_delta", { usage: { output_tokens: 20 } }), sse("message_stop")];
};
/** Chat Completions SSE for the OpenAI-shaped families (OpenRouter, the company's endpoint). */
const chatFrames = (sent: Sent, family: Family): Buffer[] => {
  if (sent.kind === "nothing") return [];
  if (sent.kind === "text") return [delta({ role: "assistant", content: sent.text })];
  const usage = { prompt_tokens: 1_000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, ...(family === "openrouter" ? { cost: 0.001234 } : {}) };
  return [delta({ role: "assistant", content: sent.text }), delta({ content: "" }, "stop"), data({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }), data("[DONE]")];
};
const hang = (): Promise<never> => new Promise<never>(() => undefined);

/** `reasoning`: the call CAN reason without streaming it (a reasoning model, or a request that asks for thinking). */
async function world(family: Family, durable = false, reasoning = false, modelOverride?: string) {
  const reached = { done: false };
  const forwarded: ProviderRequest[] = [];
  let frames: Buffer[] = [];
  const transport: ProviderTransport = async (request) => {
    forwarded.push(request);
    const body = (async function* () { for (const f of frames) yield f; reached.done = true; await hang(); })();
    if (family === "openrouter" || family === "endpoint") return translatedAnswer(family === "endpoint" ? "endpoint" : "openrouter", { model: MODEL[family], streaming: true }, 200, body, () => undefined);
    return { status: 200, body };
  };
  const MODEL: Record<Family, string> = { anthropic_key: "claude-sonnet-4-5", openrouter: "vendor/model", endpoint: "our-coder", bedrock_byo: "claude-haiku-4-5" };
  const model = modelOverride ?? MODEL[family];
  const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 };
  let token = mint({ mdl: [model] });
  let w: ReturnType<typeof setup>;
  if (family === "anthropic_key") w = setup({ transport });
  else if (family === "bedrock_byo") {
    w = setup({ prices: { priceFor: () => price }, agentKeys: { connected: async () => false, keyFor: async () => undefined } });
    w.deps.agentAi = { sources: { sourceFor: async () => "bedrock_byo" }, byo: {
      connection: async (iss, cid) => ({ row: { iss, cid, owner: "_company", sourceId: "own", versionId: "r1" }, connection: { scheme: "assume_role", roleArn: `arn:aws:iam::${"1".repeat(12)}:role/RovaraBedrockInvoke-fixture`, region: "us-west-2", models: { [model]: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, allowGlobal: false } }),
      sessions: { credentials: async () => ({ ok: true as const, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture", sessionToken: "fixture" } }), forget: () => undefined }, transport: () => transport,
    } };
  } else {
    const provider = family === "endpoint" ? "openai" : "openrouter";
    const catalogModel = family === "endpoint" ? (reasoning ? "gpt-5-mini" : "gpt-4.1-mini") : model;
    const source = { kind: "company_key" as const, id: `saved_${family}`, name: "Company AI", provider, connectionRevision: "r1" };
    const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0", request: "0", input_cache_read: "0", input_cache_write: "0" }, max_completion_tokens: 2048, reasoning: reasoning ? { mode: "bounded" as const, max_tokens: 1_024 } : { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "offline fixture, not a production tariff" };
    const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider, model: catalogModel, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000 }] } } }), save: async () => false }, { now: () => now, overrides: [], openRouterTariffs: [tariff] });
    await prices.reload();
    const endpoint = { scheme: "openai_compatible" as const, baseUrl: "https://llm.example.com/v1", key: "fixture-endpoint-key-123456789", models: [{ name: model, catalog: { provider, modelId: catalogModel } }] };
    const key = family === "endpoint" ? serializeEndpointConnection(endpoint) : "fixture-key";
    const keys = { connected: async () => true, keyFor: async () => key, resolveForCharge: async () => ({ source, key: async () => key }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }), endpointMetadata: async () => ({ sourceId: source.id, versionId: source.connectionRevision, models: endpoint.models }) };
    const sources = { sourceFor: async () => family === "endpoint" ? "custom_endpoint" as const : "openrouter_key" as const };
    const quoted = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set([family === "endpoint" ? "endpoint" : "openrouter"]), offeredProviders: new Set([family === "endpoint" ? "endpoint" : "openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
    expect(quoted.status).toBe(200);
    w = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved }, agentAi: { sources, switchedOn: new Set([family === "endpoint" ? "endpoint" : "openrouter"]), ...(family === "endpoint" ? { endpoint: { transport: () => transport } } : { openrouter: { transport } }) } });
    token = mint({ mdl: [model], runPrice: (quoted.body as { runPrice: RunPrice }).runPrice });
  }
  if (durable) {
    const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
    const wire = new WireDynamo(Object.values(tables));
    w.deps.meter = new DynamoMeter({ db: new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }), transport: wire.transport }), tables, now: () => now });
  }
  const meter = w.deps.meter as InMemoryMeter | DynamoMeter;
  const reserve = vi.spyOn(meter, "reserve"); const settleV2 = vi.spyOn(meter, "settleV2"); const settle = vi.spyOn(meter, "settle");
  const lines = (family === "anthropic_key" || family === "bedrock_byo") ? anthropicFrames : (s: Sent) => chatFrames(s, family);
  /** Send the request, let the provider send `sent`, then cut the call (the client leaves). */
  async function cut(sent: Sent, max = 4_096) {
    const thinking = reasoning && (family === "anthropic_key" || family === "bedrock_byo") ? { thinking: { type: "enabled", budget_tokens: 1_024 } } : {};
    frames = lines(sent);
    const controller = new AbortController(); const sink = new MemorySink();
    const body = Buffer.from(JSON.stringify({ ...requestBody, ...thinking, model, max_tokens: max, stream: true, messages: [{ role: "user", content: "Please read a.ts and tell me what it exports. ".repeat(20) }] }));
    const done = handleGateway(w.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield body; })(), signal: controller.signal }, sink);
    for (let i = 0; i < 400 && !reached.done; i++) await new Promise((r) => setTimeout(r, 5));
    expect(reached.done).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await done;
    const held = reserve.mock.calls.at(-1)![0].estimateMicros;
    const receipt = settleV2.mock.calls.at(-1)?.[0].receipt;
    return { sink, held, receipt, bytes: forwarded.at(-1)!.body.length, rows: await meter.read(scope), reasons: (w.logs as Array<{ event: string; reason?: string }>).filter((l) => l.event === "provider_error").map((l) => l.reason) };
  }
  return { ...w, meter, cut, reserve, settle, settleV2, forwarded };
}
const spent = (rows: readonly { spentMicros: number }[]) => rows.map((r) => r.spentMicros);
const estimatedOf = (rows: readonly { estimatedMicros: number }[]) => rows.map((r) => r.estimatedMicros);

describe.each(FAMILIES)("a cut call on the company's own key (%s)", (family) => {
  const ownKeyReceipt = family === "anthropic_key" ? undefined : true;
  it("provider usage already read in full (a complete answer, the client left before the end): settles at the ACTUAL usage, not estimated", async () => {
    const w = await world(family);
    const out = await w.cut({ kind: "complete", text: TEXT });
    expect(out.reasons).toEqual(["aborted_after_output"]);
    // 1,000 input tokens at $1 a million and 20 output tokens at $2 a million; OpenRouter reports its own cost, which wins.
    const actual = family === "openrouter" ? 1_234 : 1_000 + 40;
    expect(spent(out.rows).every((s) => s === actual)).toBe(true);
    expect(estimatedOf(out.rows).every((s) => s === 0)).toBe(true);
    expect(actual).toBeLessThan(out.held);
    if (ownKeyReceipt) expect(out.receipt).toMatchObject({ status: "final", amountMicros: { state: "available", value: actual } });
  });

  it("no usage reported yet: an ESTIMATE OF USE (input sent + output streamed so far), marked estimated, never the whole hold", async () => {
    const w = await world(family);
    const out = await w.cut({ kind: "text", text: TEXT });
    expect(out.reasons).toEqual(["aborted_after_output"]);
    const [micros] = spent(out.rows) as [number];
    const outputBytes = (family === "anthropic_key" || family === "bedrock_byo") ? 1 + TEXT.length : TEXT.length + 1;
    const input = Math.ceil(out.bytes / FAILED_CALL_INPUT_BYTES_PER_TOKEN);
    const output = Math.ceil(outputBytes / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN);
    // $1 and $2 a million: a micro-dollar per input token, two per output token.
    expect(micros).toBeGreaterThanOrEqual(input + 2 * (output - 1)); expect(micros).toBeLessThanOrEqual(input + 2 * (output + 1));
    expect(micros).toBeLessThan(out.held / 2);
    expect(spent(out.rows).every((s) => s === micros)).toBe(true);
    expect(estimatedOf(out.rows).every((s) => s === micros)).toBe(true);
    if (ownKeyReceipt) expect(out.receipt).toMatchObject({ status: "estimated", reason: "missing_usage", neverConfirmed: true, amountMicros: { state: "available", value: micros }, usageComplete: false });
  });

  it("the provider's own input count (the start event) is used for the input, plus the output estimate", async () => {
    if (family === "openrouter" || family === "endpoint") return; // Chat Completions has no start-event count.
    const w = await world(family);
    const out = await w.cut({ kind: "text", text: TEXT, inputTokens: 1_000 });
    const expected = 1_000 + 2 * Math.ceil((1 + TEXT.length) / FAILED_CALL_OUTPUT_BYTES_PER_TOKEN);
    expect(spent(out.rows).every((s) => s === expected)).toBe(true);
    expect(estimatedOf(out.rows).every((s) => s === expected)).toBe(true);
  });

  it("cut before the provider sent anything: the input estimate only (a call WE cut may already be billed its input), never the hold", async () => {
    const w = await world(family);
    const out = await w.cut({ kind: "nothing" });
    const [micros] = spent(out.rows) as [number];
    expect(micros).toBe(Math.ceil(out.bytes / FAILED_CALL_INPUT_BYTES_PER_TOKEN));
    expect(micros).toBeLessThan(out.held);
    expect(estimatedOf(out.rows)[0]).toBe(micros);
    expect(out.reasons).toEqual(["aborted_before_output"]);
  });

  it("an estimate that itself reaches the hold settles at the hold, never above it, and is still marked estimated", async () => {
    const w = await world(family);
    const out = await w.cut({ kind: "text", text: "z".repeat(200_000) }, 1);
    expect(spent(out.rows).every((s) => s === out.held)).toBe(true);
    expect(estimatedOf(out.rows).every((s) => s === out.held)).toBe(true);
  });

  it("the hold is closed once: a second settle of the same hold changes nothing, and the handler logged one settle", async () => {
    const w = await world(family);
    const out = await w.cut({ kind: "text", text: TEXT });
    const before = JSON.stringify(out.rows);
    const id = (w.reserve.mock.results.at(-1)!.value as Promise<{ ok: true; reservation: { id: string } }>);
    const { reservation } = await id;
    await w.meter.settle(reservation, out.held, undefined);
    if (out.receipt !== undefined) await w.meter.settleV2({ reservationId: reservation.id, receipt: out.receipt });
    expect(JSON.stringify(await w.meter.read(scope))).toBe(before);
    expect((w.logs).filter((l) => ev(l) === "settled")).toHaveLength(1);
  });
});

describe("the same rules on a durable meter (anthropic key)", () => {
  it("a cut call settles at an estimate of use once; the conditional close refuses a second settle", async () => {
    const w = await world("anthropic_key", true);
    const out = await w.cut({ kind: "text", text: TEXT });
    const [micros] = spent(out.rows) as [number];
    expect(micros).toBeLessThan(out.held / 2);
    expect(estimatedOf(out.rows)[0]).toBe(micros);
    const { reservation } = await (w.reserve.mock.results.at(-1)!.value as Promise<{ ok: true; reservation: { id: string } }>);
    await w.meter.settle(reservation, out.held, undefined).catch(() => undefined);
    expect(spent(await w.meter.read(scope))[0]).toBe(micros);
    expect(await (w.meter as DynamoMeter).sweepOpenHolds(now + 48 * 3_600_000, 10)).toEqual({ swept: 0, already: 0, failed: 0, more: false });
  });
});

describe("what does not change", () => {
  it("a stream the PROVIDER broke on the company's own key still keeps the hold, marked estimated (only a call WE cut settles at use)", async () => {
    const w = setup({ transport: async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }); yield sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); yield sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } }); throw new Error("socket hang up"); })() }) });
    const reserve = vi.spyOn(w.meter, "reserve");
    const out = await call(w.deps, { ...requestBody, max_tokens: 4_096, stream: true }, mint());
    expect(out.destroyed).toBe(true);
    const held = reserve.mock.calls[0]![0].estimateMicros;
    expect((await w.meter.read(scope)).every((r) => r.spentMicros === held && r.estimatedMicros === held)).toBe(true);
    expect((w.logs as Array<{ event: string; reason?: string }>).filter((l) => l.event === "provider_error").map((l) => l.reason)).toEqual(["provider_after_output"]);
  });

  it("a call that completed with its usage settles as before (final, measured)", async () => {
    const w = setup();
    await call(w.deps, requestBody, mint());
    expect((await w.meter.read(scope)).every((r) => r.estimatedMicros === 0 && r.spentMicros > 0)).toBe(true);
  });

  it("cutCallMicros: Rovara's own Bedrock settles every failure after the send at use; any other route only a call WE cut", () => {
    const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000, estimated: false };
    const base = { inputBytes: 4_000, outputBytes: 400, price, plainInput: true, reservationMicros: 100_000, phase: "after_output" as const };
    const own = failedCallMicros({ ...base, cause: "provider" });
    expect(own).toBe(1_000 + 200 * 4);
    expect(cutCallMicros({ ...base, cause: "provider", ownBedrock: true })).toBe(own);
    expect(cutCallMicros({ ...base, cause: "aborted", ownBedrock: true })).toBe(own);
    expect(cutCallMicros({ ...base, cause: "aborted", ownBedrock: false })).toBe(own);
    expect(cutCallMicros({ ...base, cause: "provider", ownBedrock: false })).toBeUndefined();
    expect(cutCallMicros({ ...base, cause: "gateway", ownBedrock: false })).toBeUndefined();
    expect(cutCallMicros({ ...base, cause: "gateway", ownBedrock: true })).toBeUndefined();
    // Never above the hold; a whole answer that already came is billed in full (the hold stands).
    expect(cutCallMicros({ ...base, cause: "aborted", ownBedrock: false, reservationMicros: 500 })).toBe(500);
    expect(cutCallMicros({ ...base, cause: "aborted", ownBedrock: false, wholeAnswer: true })).toBeUndefined();
  });
});

// Readers that do NOT count stream progress (the OpenAI learning reader, the Gemini product reader): a call cut after output streamed is charged
// the bytes received as output, never the input only (Opus review F1).
describe("a cut call on a route whose reader does not count progress charges the output received", () => {
  const geminiChunk = (n: number) => Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "g".repeat(400) + n }] } }] })}\r\n\r\n`);
  const openAiChunk = () => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "o".repeat(400) } }] })}\n\n`);
  async function cutAfter(chunks: number, chunk: (n: number) => Buffer, start: (transport: ProviderTransport) => Promise<{ deps: GatewayDependencies; url: string; body: unknown; token: string; read: () => Promise<readonly { spentMicros: number; estimatedMicros: number }[]>; held: () => number }>) {
    const reached = { done: false };
    const transport: ProviderTransport = async () => ({ status: 200, body: (async function* () { for (let i = 0; i < chunks; i++) yield chunk(i); reached.done = true; await hang(); })() });
    const w = await start(transport);
    const controller = new AbortController();
    const done = handleGateway(w.deps, { method: "POST", url: w.url, headers: { "content-type": "application/json", "x-api-key": w.token }, body: (async function* () { yield Buffer.from(JSON.stringify(w.body)); })(), signal: controller.signal }, new MemorySink());
    for (let i = 0; i < 400 && !reached.done; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40));
    controller.abort(); await done;
    const rows = await w.read();
    return { micros: rows[0]!.spentMicros, estimated: rows[0]!.estimatedMicros, held: w.held(), logs: w.deps };
  }
  const gemini = (transport: ProviderTransport, thinking = false) => async () => {
    const g = await productGateway({ transport });
    const reserve = vi.spyOn(g.productMeter, "reserve");
    return { deps: g.deps, url: streamPath, body: { ...geminiBody, generationConfig: { maxOutputTokens: 8_192, thinkingConfig: { thinkingBudget: thinking ? 1_024 : 0 } } }, token: mint(), read: () => g.productMeter.read(productScope), held: () => reserve.mock.calls[0]![0].estimateMicros };
  };
  const runLearning = (chunks: number, model = "gpt-4.1-mini", effort?: string) => cutAfter(chunks, openAiChunk, async (transport) => {
    const keys = { connected: async () => true, keyFor: async () => "openai-key", vertexTarget: async () => undefined, refused: async () => undefined };
    const agentMeter = new LearningMeter(() => now);
    const learningMeter = new LearningMeter(() => now, undefined, undefined, { combineCompanyWith: agentMeter });
    const companyCaps = new FixedCapsSource({ task: 1_000_000_000, personMonth: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 });
    const learning = createLearningRoutes({ keys, meter: learningMeter, companyCaps, lessons: { isOn: async () => true }, modelLimits: { maxOutputTokens: () => 8192 }, transport, transports: { openai: transport } });
    const g = setup({ meter: agentMeter, caps: companyCaps, keys: { keyFor: async () => { throw new Error("install key must not be read"); } }, learning });
    const reserve = vi.spyOn(learningMeter, "reserve");
    return { deps: g.deps, url: "/v1/learning/openai/chat/completions", body: { model, messages: [{ role: "user", content: "reflect" }], max_completion_tokens: 4_096, stream: true, ...(effort === undefined ? {} : { reasoning_effort: effort }) }, token: mint({ stp: LEARNING_STEP, mdl: [model] }), read: () => learningMeter.read({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }), held: () => reserve.mock.calls[0]![0].estimateMicros };
  });
  const bytesOf = (n: number, chunk: (i: number) => Buffer) => Array.from({ length: n }, (_, i) => chunk(i).length).reduce((x, y) => x + y, 0);
  it("product Gemini stream (thinking off): the bytes received are output at ONE byte a token (two micro-dollars each at $2 a million), estimated, below the hold", async () => {
    const none = await cutAfter(0, geminiChunk, (t) => gemini(t)());
    const some = await cutAfter(10, geminiChunk, (t) => gemini(t)());
    expect(some.micros - none.micros).toBe(2 * bytesOf(10, geminiChunk));
    expect(some.micros).toBeLessThan(some.held);
    expect(some.estimated).toBe(some.micros);
    expect(none.estimated).toBe(none.micros);
  });
  it("product Gemini stream with thinking on (cannot be priced: the hidden thoughts are never streamed): the HOLD, estimated, with or without chunks", async () => {
    for (const chunks of [0, 10]) {
      const out = await cutAfter(chunks, geminiChunk, (t) => gemini(t, true)());
      expect(out.micros).toBe(out.held); expect(out.estimated).toBe(out.held);
    }
  });
  it("product Gemini *-latest aliases are not on the allow-list: the hold, even with thinkingBudget 0", async () => {
    for (const model of ["gemini-flash-latest", "gemini-pro-latest"]) {
      const out = await cutAfter(10, geminiChunk, async (t) => { const w = await gemini(t)(); return { ...w, url: streamPath.replace("gemini-2.5-flash", model) }; });
      expect(out.micros, model).toBe(out.held); expect(out.estimated).toBe(out.held);
    }
  });
  it("product Gemini 2.5 with no thinkingConfig thinks by default: the hold", async () => {
    const out = await cutAfter(10, geminiChunk, async (t) => { const w = await gemini(t)(); return { ...w, body: { ...geminiBody, generationConfig: { maxOutputTokens: 8_192 } } }; });
    expect(out.micros).toBe(out.held);
  });
  it("learning OpenAI stream, a non-reasoning model: the bytes received at one byte a token, estimated, below the hold", async () => {
    const none = await runLearning(0); const some = await runLearning(5);
    expect(some.micros - none.micros).toBe(2 * bytesOf(5, openAiChunk));
    expect(some.micros).toBeLessThan(some.held);
    expect(some.estimated).toBe(some.micros);
  });
  it("learning OpenAI stream, a reasoning, unknown or new model (gpt-5, codex, gpt-6), or a listed one with reasoning_effort: the hold (the reasoning is billed and never streamed)", async () => {
    for (const out of [await runLearning(10, "gpt-5-mini"), await runLearning(10, "gpt-4.1-mini", "low"), await runLearning(0, "gpt-5-mini"), await runLearning(10, "codex-mini-latest"), await runLearning(10, "gpt-6"), await runLearning(10, "some-new-model")]) { expect(out.micros).toBe(out.held); expect(out.estimated).toBe(out.held); }
  });
});

describe.each(FAMILIES)("a cut call that CAN reason without streaming it (%s)", (family) => {
  it("no usage read: the HOLD (the hidden reasoning is billed and unknowable), marked estimated, even after output streamed", async () => {
    const w = await world(family, false, true);
    for (const sent of [{ kind: "nothing" }, { kind: "text", text: TEXT }] as Sent[]) {
      const out = await w.cut(sent);
      const last = out.rows.map((r) => r.spentMicros);
      expect(last.every((v) => v >= out.held)).toBe(true);
      expect(estimatedOf(out.rows).every((v) => v > 0)).toBe(true);
    }
  });
  it("usage read in full (it counts the reasoning tokens): settles at the ACTUAL usage, not the hold", async () => {
    const w = await world(family, false, true);
    const out = await w.cut({ kind: "complete", text: TEXT });
    const actual = family === "openrouter" ? 1_234 : 1_000 + 40;
    expect(spent(out.rows).every((s) => s === actual)).toBe(true);
    expect(estimatedOf(out.rows).every((s) => s === 0)).toBe(true);
  });
});

describe("mayReasonUnseen decides by code, from the request and the model", () => {
  const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
  it("table: only a listed non-reasoning model is safe to estimate; everything else keeps the hold", () => {
    expect(mayReasonUnseen("anthropic", "claude-sonnet-4-5", bytes({ messages: [] }))).toBe(false);
    expect(mayReasonUnseen("anthropic", "claude-sonnet-4-5", bytes({ thinking: { type: "disabled" } }))).toBe(false);
    expect(mayReasonUnseen("anthropic", "claude-sonnet-4-5", bytes({ thinking: { type: "enabled", budget_tokens: 1_024 } }))).toBe(true);
    expect(mayReasonUnseen("anthropic", "claude-sonnet-4-5", bytes({ thinking: { type: "adaptive" } }))).toBe(true);
    expect(mayReasonUnseen("anthropic", "mystery-model", bytes({}))).toBe(true);
    for (const name of ["claude-3-haiku-20240307", "claude-3-5-sonnet-20241022", "claude-3-7-sonnet-20250219", "claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-haiku-4-5"]) expect(mayReasonUnseen("anthropic", name, bytes({})), name).toBe(false);
    // Claude 5.x think with NO `thinking` field (the thinking streams as empty text): every one of them, and anything new, keeps the hold.
    for (const name of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-sonnet-6", "claude-sonnet-4-5-latest", "claude-haiku-4-5x"]) { expect(mayReasonUnseen("anthropic", name, bytes({})), name).toBe(true); expect(mayReasonUnseen("bedrock", name, bytes({})), name).toBe(true); }
    expect(mayReasonUnseen("bedrock", "us.anthropic.claude-sonnet-5-5-20260101-v1:0", bytes({}))).toBe(true);
    expect(mayReasonUnseen("bedrock", "claude-haiku-4-5", bytes({ messages: [] }))).toBe(false);
    expect(mayReasonUnseen("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", bytes({}))).toBe(false);
    expect(mayReasonUnseen("bedrock", "claude-haiku-4-5", bytes({ additionalModelRequestFields: { thinking: { type: "enabled" } } }))).toBe(true);
    expect(mayReasonUnseen("bedrock", "zai.glm-5", bytes({ messages: [] }))).toBe(true);
    expect(mayReasonUnseen("openrouter", "vendor/model", bytes({ reasoning: { enabled: false } }))).toBe(false);
    expect(mayReasonUnseen("openrouter", "vendor/model", bytes({ reasoning: { enabled: true, max_tokens: 1_024 } }))).toBe(true);
    expect(mayReasonUnseen("openrouter", "vendor/model", bytes({}))).toBe(true);
    for (const name of ["gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "gpt-4.5-preview", "chatgpt-4o-latest"]) expect(mayReasonUnseen("openai", name, bytes({})), name).toBe(false);
    expect(mayReasonUnseen("openai", "gpt-4.1-mini", bytes({ reasoning_effort: "low" }))).toBe(true);
    expect(mayReasonUnseen("openai", "gpt-4.1-mini", bytes({ reasoning_effort: "none" }))).toBe(false);
    for (const name of ["gpt-5-mini", "gpt-5.1", "gpt-6", "o4-mini", "o3", "codex-mini-latest", "gpt-oss-120b", "gpt-4.1-reasoner", "gpt-40", "whatever"]) expect(mayReasonUnseen("openai", name, bytes({})), name).toBe(true);
    expect(mayReasonUnseen("openai", "gpt-5.1", bytes({ reasoning_effort: "none" }))).toBe(true);
    for (const name of ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash-002", "gemini-2.0-flash-lite"]) expect(mayReasonUnseen("gemini", name, bytes({})), name).toBe(false);
    expect(mayReasonUnseen("gemini", "gemini-2.0-flash", bytes({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }))).toBe(true);
    expect(mayReasonUnseen("gemini", "gemini-2.0-flash", bytes({ generationConfig: { thinkingConfig: { includeThoughts: true } } }))).toBe(true);
    for (const name of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro", "gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest", "models/gemini-pro-latest"]) expect(mayReasonUnseen("gemini", name, bytes({})), name).toBe(true);
    const off = bytes({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } });
    expect(mayReasonUnseen("gemini", "gemini-2.5-flash", off)).toBe(false);
    expect(mayReasonUnseen("vertex", "gemini-2.5-flash-lite", off)).toBe(false);
    for (const name of ["gemini-2.5-pro", "gemini-flash-latest", "gemini-pro-latest", "gemini-3-flash"]) expect(mayReasonUnseen("vertex", name, off), name).toBe(true);
    expect(mayReasonUnseen("gemini", "gemini-2.5-flash", bytes({ generationConfig: { thinkingConfig: { thinkingBudget: 1_024 } } }))).toBe(true);
    expect(mayReasonUnseen("anthropic", "claude-x", Buffer.from("not json"))).toBe(true);
    expect(mayReasonUnseen("somewhere", "claude-x", bytes({}))).toBe(true);
  });
});

describe("a cut Claude 5.x call (it thinks with no `thinking` field)", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"])("%s with no usage read keeps the hold; an older listed id settles at an estimate", async (model) => {
    const w = await world("anthropic_key", false, false, model);
    const out = await w.cut({ kind: "text", text: TEXT });
    expect(spent(out.rows).every((v) => v === out.held)).toBe(true);
    expect(estimatedOf(out.rows).every((v) => v === out.held)).toBe(true);
    const old = await (await world("anthropic_key", false, false, "claude-sonnet-4-5-20250929")).cut({ kind: "text", text: TEXT });
    expect(spent(old.rows)[0]).toBeLessThan(old.held / 2);
  });
});
