import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, mint, now, scope, setup, sse } from "./model-gateway-fixture.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";

beforeAll(denyNetwork);
// Captured offline from Pi 1.5.2's anthropic-messages.js stream/onPayload,
// with normalizeContext, a non-OAuth client, cacheRetention: short and maxTokens: 64.
// Source: Code node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
// getCacheControl :37, buildParams :1108-1158, convertMessages :1408-1428, convertTools :1520.
const pi = JSON.parse(readFileSync(new URL("../fixtures/model-gateway/pi-ai-1.5.2-anthropic-messages.json", import.meta.url), "utf8")) as {
  model: string; system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  tools: Array<Record<string, unknown>>; stream: boolean; max_tokens: number;
};
// Captured offline using the installed Pi 1.5.2 serializer (no client send):
// anthropic-messages.js:1236-1241 (tool result), :1331-1384 (thinking/tool use), :1408-1428 (cache).
// The three snapshots include the tool-result turn, its final assistant reply, and thinking carryover.
const multiTurn = JSON.parse(readFileSync(new URL("../fixtures/model-gateway/pi-ai-1.5.2-multiturn.json", import.meta.url), "utf8")) as Record<"toolResult" | "final" | "thinking", typeof pi>;
const id = "us.anthropic.claude-sonnet-4-5-v1:0";
async function world(missingWrite: false | "all" | "5m" | "1h" | "tier" = false, model = pi.model, tiered = false) {
  const catalogModel = model === pi.model ? id : model;
  const rates = tiered ? { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, cacheReadMicrosPerMTok: 300_000, cacheWrite5mMicrosPerMTok: 3_750_000, cacheWrite1hMicrosPerMTok: 6_000_000 } : { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000,
    ...(missingWrite === "all" || missingWrite === "5m" ? {} : { cacheWrite5mMicrosPerMTok: 4_000_000 }),
    ...(missingWrite === "all" || missingWrite === "1h" ? {} : { cacheWrite1hMicrosPerMTok: 6_000_000 }) };
  const band = tiered ? { aboveTokens: 200_000, inputMicrosPerMTok: 6_000_000, outputMicrosPerMTok: 22_500_000, cacheReadMicrosPerMTok: 600_000, cacheWrite5mMicrosPerMTok: 7_500_000, cacheWrite1hMicrosPerMTok: 12_000_000 } : missingWrite === "tier" ? { aboveTokens: 32_000, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000 } : { aboveTokens: 200_000, ...rates };
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1,
    entries: [{ provider: "bedrock", model: catalogModel, kind: "chat", ...rates, longContext: [band] }] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const rovara = { sourceId: "operator-account@region", models: new Map([[model, catalogModel]]), exempt: new Set<string>() };
  const sources = { sourceFor: async () => "rovara" as const };
  const keys = { connected: async () => false, keyFor: async () => undefined };
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys, rovara,
    verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice;
  expect(grant).toBeDefined();
  const f = setup({ prices, agentKeys: keys, chargeReceipts: { source: (_claims, _model, resolved) => resolved } });
  const sent: Buffer[] = [];
  f.deps.agentAi = { sources, rovara: { ...rovara, transport: async (request) => { sent.push(Buffer.from(request.body)); return f.deps.transport(request); } } };
  return { ...f, grant, sent };
}

it("GLM Converse needs no cache-write price because its outgoing request has no cachePoint (F5)", async () => {
  const f = await world("all", "zai.glm-5");
  const reserve = vi.spyOn(f.meter, "reserve"); const settle = vi.spyOn(f.meter, "settleV2");
  f.deps.transport = async () => ({ status: 200, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0 } } });
    yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
  })() });
  const body = { ...structuredClone(pi), model: "zai.glm-5" };
  expect((await call(f.deps, body, mint({ mdl: [body.model], runPrice: f.grant }))).status).toBe(200);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.toString()).not.toMatch(/cache_control|cachePoint/u);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(f.sent[0]!.length + 4096 + 64 * 2);
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", reason: "rated_usage", amountMicros: { value: 12 } });
});

it("admits Pi's exact cached system/message/tool request and settles split usage at actual cache rates", async () => {
  const f = await world();
  const grant = { ...f.grant, cacheWriteUsdPerMillion: 9, cacheReadUsdPerMillion: 0.5 };
  const reserve = vi.spyOn(f.meter, "reserve");
  const settle = vi.spyOn(f.meter, "settleV2");
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(200);
  // Signed rates authorize a ceiling; unknown write duration uses the actual dearer ($6) write rate.
  // 2 input * $1 + 3 reads * $0.25 + 4 writes * $6 + 5 output * $2 = 36.75 microdollars, rounded up.
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", reason: "rated_usage", amountMicros: { value: 37 }, billableMicros: { value: 37 },
    usage: { value: { input: 2, output: 5, cacheRead: 3, cacheWriteUnknown: 4 } } });
  expect(reserve.mock.calls[0]![0].overrun).toBeUndefined();
  expect((await f.meter.read(scope))[0]).toMatchObject({ spentMicros: 37, reservedMicros: 0 });
});

it("holds every byte-derived prompt token at the actual cache-write maximum plus maximum output", async () => {
  const f = await world();
  const grant = { ...f.grant, cacheWriteUsdPerMillion: 9 };
  const reserve = vi.spyOn(f.meter, "reserve");
  let forwardedBytes = 0;
  const transport = f.deps.transport;
  f.deps.agentAi!.rovara!.transport = async (request) => { forwardedBytes = request.body.length; return transport(request); };
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(200);
  expect(forwardedBytes).toBeGreaterThan(0);
  // One token per serialized byte plus the existing 4096-token tool allowance; no estimator helper supplies this expectation.
  expect(reserve.mock.calls[0]![0].estimateMicros).toBeGreaterThanOrEqual((forwardedBytes + 4096) * 6 + 64 * 2);
});

it("settles cached and uncached Claude usage at the same actual tiered tariff while holding the cache ceiling", async () => {
  const amounts: number[] = [];
  for (const cached of [false, true]) {
    const f = await world(false, pi.model, true);
    expect(f.grant).toMatchObject({ inputUsdPerMillion: 6, outputUsdPerMillion: 22.5, cacheReadUsdPerMillion: 0.6, cacheWriteUsdPerMillion: 12 });
    const body = structuredClone(pi);
    // The byte bound can reach the long-context band, while the provider's actual usage stays in the base band.
    body.system[0]!.text = "prefix ".repeat(30_000);
    if (!cached) for (const block of [...body.system, ...body.messages[0]!.content, ...body.tools]) delete block.cache_control;
    let forwardedBytes = 0;
    f.deps.agentAi!.rovara!.transport = async (request) => {
      forwardedBytes = request.body.length;
      return { status: 200, body: (async function* () {
        yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 } } } });
        yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
      })() };
    };
    const reserve = vi.spyOn(f.meter, "reserve");
    const settle = vi.spyOn(f.meter, "settleV2");
    expect((await call(f.deps, body, mint({ runPrice: f.grant }))).status).toBe(200);
    expect(forwardedBytes).toBeGreaterThan(200_000);
    if (cached) expect(reserve.mock.calls[0]![0].estimateMicros).toBeGreaterThanOrEqual((forwardedBytes + 4096) * 12 + 64 * 22.5);
    // Actual base-band usage: 2*$3 + 3*$0.30 + 4*$3.75 (5m writes) + 5*$15 = 96.9 -> 97 microdollars.
    expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", reason: "rated_usage", amountMicros: { value: 97 }, billableMicros: { value: 97 } });
    amounts.push((await f.meter.read(scope))[0]!.spentMicros);
  }
  expect(amounts).toEqual([97, 97]);
});

it("admits Pi's exact cached shape on zai.glm-5 without snapshot cache-write prices and sends no cache fields", async () => {
  const model = "zai.glm-5";
  const f = await world("all", model);
  const reserve = vi.spyOn(f.meter, "reserve");
  const settle = vi.spyOn(f.meter, "settleV2");
  const sent: Array<{ body: Buffer; path?: string }> = [];
  f.deps.agentAi!.rovara!.transport = async (request) => {
    sent.push({ ...request, body: Buffer.from(request.body) });
    return { status: 200, body: (async function* () {
      yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0 } } });
      yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
    })() };
  };
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.path).toBe("/model/zai.glm-5/converse-stream");
  const upstream = JSON.parse(sent[0]!.body.toString("utf8")) as Record<string, unknown>;
  expect(upstream).toMatchObject({ system: [{ text: "You are a coding assistant." }], messages: [{ role: "user", content: [{ text: "Read the project README." }] }],
    toolConfig: { tools: [{ toolSpec: { name: "read" } }] }, inferenceConfig: { maxTokens: 64 } });
  expect(JSON.stringify(upstream)).not.toMatch(/"[^"]*cache[^"]*"\s*:/iu);
  // Converse drops every marker, so only input + output can be held (one token/byte plus the tool allowance).
  expect(reserve.mock.calls[0]![0]).toMatchObject({ estimateMicros: sent[0]!.body.length + 4096 + 64 * 2 });
  expect(reserve.mock.calls[0]![0].overrun).toBeUndefined();
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", amountMicros: { value: 12 }, usage: { value: { input: 2, output: 5, cacheRead: 0 } } });
});

for (const model of [pi.model, "zai.glm-5"]) it.each(["toolResult", "final"] as const)(`admits Pi's real multi-turn tool-args history on ${model}: %s`, async (turn) => {
  const f = await world(false, model);
  const body = { ...structuredClone(multiTurn[turn]), model };
  expect((await call(f.deps, body, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  const sent = JSON.parse(f.sent[0]!.toString("utf8")) as Record<string, unknown>;
  if (model === "zai.glm-5") {
    expect(sent).toMatchObject({ messages: [
      { role: "user" },
      { role: "assistant", content: [{ toolUse: { input: { type: "file", source: "workspace", tools: [{ type: "web_search" }] } } }] },
      { role: "user", content: [{ toolResult: { content: [{ text: '{"type":"file","source":"workspace","fileData":{},"cachedContent":"literal result","tools":[{"type":"web_search"}]}' }] } }] },
      ...(turn === "final" ? [{ role: "assistant", content: [{ text: "The README describes the project." }] }] : []),
    ] });
    expect(JSON.stringify(sent)).not.toMatch(/"(?:cachePoint|cache_control)"\s*:/u);
  } else expect(sent).toMatchObject({ messages: body.messages, system: body.system, tools: body.tools });
});

it("admits Pi's three-turn Claude history with thinking and redacted_thinking sent back", async () => {
  const f = await world();
  expect((await call(f.deps, multiTurn.thinking, mint({ runPrice: f.grant }))).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(JSON.parse(f.sent[0]!.toString("utf8"))).toMatchObject({ messages: multiTurn.thinking.messages });
});

it.each([
  { type: "file", source: "workspace", fileData: {}, cachedContent: "literal", tools: [{ type: "web_search" }] },
  [{ type: "text", text: '{"type":"image","source":{"type":"local"}}' }],
])("counts tool-result JSON/text as opaque bytes, not content-block selectors: %j", async (content) => {
  const f = await world();
  const body = structuredClone(multiTurn.toolResult);
  body.messages[2]!.content[0]!.content = content;
  expect(guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [pi.model], { maxOutputTokens: () => 64 })).toMatchObject({ ok: true, inputBounded: true });
  expect((await call(f.deps, body, mint({ runPrice: f.grant }))).status).toBe(200);
  expect(JSON.parse(f.sent[0]!.toString("utf8"))).toMatchObject({ messages: body.messages });
});

it.each(["system", "message", "toolResult"])("refuses remote and unknown content blocks in %s", async (where) => {
  for (const block of [{ type: "text", text: "remote", fileData: {} }, { type: "text", text: "remote", cachedContent: "remote" }, { type: "unknown_block" }]) {
    const f = await world();
    const body = structuredClone(multiTurn.toolResult);
    if (where === "system") body.system = [block];
    else if (where === "message") body.messages[0]!.content = [block];
    else body.messages[2]!.content[0]!.content = [block];
    expect((await call(f.deps, body, mint({ runPrice: f.grant }))).status).toBe(409);
    expect(f.calls).toHaveLength(0);
    expect((await f.meter.read(scope)).every((row) => row.reservedMicros === 0 && row.spentMicros === 0)).toBe(true);
  }
});

it("refuses a Claude runPrice without its signed cache rates before holding or sending", async () => {
  const f = await world();
  const reserve = vi.spyOn(f.meter, "reserve");
  const grant: Partial<RunPrice> = { ...f.grant };
  delete grant.cacheWriteUsdPerMillion; delete grant.cacheReadUsdPerMillion;
  expect((await call(f.deps, pi, mint({ runPrice: grant }))).status).toBe(401);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each(["system", "message", "tool"])("keeps a %s-only cache marker bounded", (where) => {
  const body = structuredClone(pi);
  for (const block of [...body.system, ...body.messages[0]!.content, ...body.tools]) delete block.cache_control;
  const block = where === "system" ? body.system[0]! : where === "message" ? body.messages[0]!.content[0]! : body.tools[0]!;
  block.cache_control = { type: "ephemeral", ttl: "1h" };
  expect(guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [pi.model], { maxOutputTokens: () => 64 })).toMatchObject({ ok: true, inputBounded: true, usesPromptCache: true });
});

for (const model of [pi.model, "zai.glm-5"]) it.each([
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  { type: "text", text: "remote", source: { url: "https://offline.invalid/file" } },
  { type: "unknown_block", text: "unknown" },
  { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
  { type: "tool_result", tool_use_id: "toolu_read_1", content: [{ type: "text", text: "image follows" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
  { type: "tool_result", tool_use_id: "toolu_read_1", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }] },
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "example" } },
  { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "read", input_schema: { type: "object" } } } },
  { type: "tool_definition", definition: { name: "read", input_schema: { type: "object" } } },
])(`refuses media/remote/unknown blocks on ${model} before a hold or provider send: $type`, async (block) => {
  const f = await world(false, model);
  const reserve = vi.spyOn(f.meter, "reserve");
  const body = structuredClone(pi);
  for (const plain of [...body.system, ...body.tools]) delete plain.cache_control;
  body.messages = [{ role: "user", content: [block] }];
  body.model = model;
  const result = await call(f.deps, body, mint({ mdl: [model], runPrice: f.grant }));
  const status = model === "zai.glm-5" && block.type !== "text" ? 400 : 409;
  expect(result.status).toBe(status);
  expect(result.text()).toContain(status === 409 ? "run_price_authorization_required" : "invalid_request");
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each(["all", "5m", "1h", "tier"] as const)("refuses a cached call with no snapshot cache-write price (%s) before holding or sending", async (missing) => {
  const f = await world(missing);
  const reserve = vi.spyOn(f.meter, "reserve");
  const body = structuredClone(pi);
  if (missing === "tier") body.system[0]!.text = "prefix ".repeat(5_000);
  const result = await call(f.deps, body, mint({ runPrice: f.grant }));
  expect(result.status).toBe(409);
  expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});

it.each([pi.model, "zai.glm-5"])("retains the hidden-charge backstop on %s when reported cost exceeds the admitted maximum", async (model) => {
  const f = await world(false, model);
  f.deps.caps = new FixedCapsSource({ task: 100_000, personMonth: 100_000, projectMonth: 100_000, companyMonth: 100_000 });
  f.deps.agentAi!.rovara!.transport = async () => ({ status: 200, reportedCostMicros: () => 200_000, body: (async function* () {
    yield sse("message_start", { message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
    yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop");
  })() });
  const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBeLessThan(100_000);
  expect((await f.meter.read(scope)).find((row) => row.item === "company")).toMatchObject({ spentMicros: 200_000, overrun: true, reservedMicros: 0 });
  expect((await call(f.deps, { ...pi, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(422);
});

// Ported from lead 4's offline probe; diagnostic-only cases now pin the observed contract.
const guardBody = (body: unknown) => guardRequest(Buffer.from(JSON.stringify(body)), { "content-type": "application/json" }, [pi.model], { maxOutputTokens: () => 64 });
function withBlock(block: unknown): Record<string, unknown> {
  return { ...structuredClone(multiTurn.toolResult), messages: [{ role: "user", content: [block] }] };
}
const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
it.each([
  ["array type", { type: ["text"], text: "x" }],
  ["Image with source", { type: "Image", source: { type: "base64", data: "AAAA" } }],
  ["Image without source", { type: "Image", data: "AAAA" }],
  ["IMAGE without source", { type: "IMAGE", data: "AAAA" }],
  ["array Image without source", { type: ["Image"], data: "AAAA" }],
  ["text with source", { type: "text", text: "x", source: { url: "offline" } }],
  ["thinking with source", { type: "thinking", thinking: "x", signature: "s", source: { url: "offline" } }],
  ["redacted with fileData", { type: "redacted_thinking", data: "x", fileData: {} }],
  ["tool_use with source", { type: "tool_use", id: "t", name: "read", input: {}, source: {} }],
  ["missing type", { text: "x" }],
  ["numeric type", { type: 1 }],
  ["nested tool_result image", { type: "tool_result", tool_use_id: "t", content: [{ type: "tool_result", tool_use_id: "u", content: [{ type: "tool_result", tool_use_id: "v", content: [imageBlock] }] }] }],
  ["nested array image", { type: "tool_result", tool_use_id: "t", content: [[[imageBlock]]] }],
  ["tool_result text with source", { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x", source: {} }] }],
])("classifies and refuses %s before a hold or provider send", async (_name, block) => {
  const body = withBlock(block);
  expect(guardBody(body)).toMatchObject({ ok: true, inputBounded: false });
  const f = await world();
  const reserve = vi.spyOn(f.meter, "reserve");
  const result = await call(f.deps, body, mint({ runPrice: f.grant }));
  expect(result.status).toBe(409);
  expect(result.text()).toContain("run_price_authorization_required");
  expect(reserve).not.toHaveBeenCalled();
  expect(f.sent).toHaveLength(0);
});

it.each([
  ["message content object", { messages: [{ role: "user", content: imageBlock }] }],
  ["system image", { system: [imageBlock] }],
  ["deep message array", { messages: [{ role: "user", content: [[imageBlock]] }] }],
])("classifies an image in %s as unbounded", (_name, content) => {
  expect(guardBody({ ...multiTurn.toolResult, ...content })).toMatchObject({ ok: true, inputBounded: false });
});

it("keeps a non-array tool-result object opaque and preserves its bytes", () => {
  const result = guardBody(withBlock({ type: "tool_result", tool_use_id: "t", content: imageBlock }));
  expect(result).toMatchObject({ ok: true, inputBounded: true });
  expect(result.ok && JSON.parse(result.bytes.toString("utf8"))).toMatchObject({ messages: [{ content: [{ content: imageBlock }] }] });
});

it("keeps a non-object content block bounded and preserves its bytes", () => {
  const result = guardBody(withBlock("plain string block"));
  expect(result).toMatchObject({ ok: true, inputBounded: true });
  expect(result.ok && result.bytes.toString("utf8")).toContain("plain string block");
});

async function holdOf(body: typeof pi, model = pi.model) {
  const f = await world(false, model);
  const reserve = vi.spyOn(f.meter, "reserve");
  let forwardedBytes = 0;
  const transport = f.deps.agentAi!.rovara!.transport;
  f.deps.agentAi!.rovara!.transport = async (request) => { forwardedBytes = request.body.length; return transport(request); };
  expect((await call(f.deps, { ...body, model }, mint({ mdl: [model], runPrice: f.grant }))).status).toBe(200);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(f.sent).toHaveLength(1);
  return { estimateMicros: reserve.mock.calls[0]![0].estimateMicros, forwardedBytes };
}

const growPayloads: Array<[string, keyof typeof multiTurn, (body: typeof pi) => void]> = [
  ["tool_use.input", "toolResult", (body) => { (body.messages[1]!.content[0]!.input as Record<string, unknown>).blob = "z".repeat(100_000); }],
  ["tool_result string", "toolResult", (body) => { body.messages[2]!.content[0]!.content = "z".repeat(100_000); }],
  ["tool_result nested text", "toolResult", (body) => { body.messages[2]!.content[0]!.content = [{ type: "text", text: "z".repeat(100_000) }]; }],
  ["redacted_thinking.data", "thinking", (body) => { body.messages[1]!.content[1]!.data = "q".repeat(100_000); }],
  ["thinking.signature", "thinking", (body) => { body.messages[1]!.content[0]!.signature = "q".repeat(100_000); }],
  ["thinking.thinking", "thinking", (body) => { body.messages[1]!.content[0]!.thinking = "q".repeat(100_000); }],
];
it.each(growPayloads)("holds every added byte of a 100 KB %s payload at Claude's cache-write maximum", async (_name, turn, grow) => {
  const base = await holdOf(multiTurn[turn]);
  const body = structuredClone(multiTurn[turn]);
  grow(body);
  const after = await holdOf(body);
  const addedBytes = after.forwardedBytes - base.forwardedBytes;
  expect(addedBytes).toBeGreaterThan(99_000);
  expect(after.estimateMicros - base.estimateMicros).toBeGreaterThanOrEqual(addedBytes * 6);
  expect(after.estimateMicros).toBeGreaterThanOrEqual((after.forwardedBytes + 4096) * 6 + 64 * 2);
});

it("holds every added tool_use.input byte on the GLM Converse plain-input path", async () => {
  const base = await holdOf(multiTurn.toolResult, "zai.glm-5");
  const body = structuredClone(multiTurn.toolResult);
  (body.messages[1]!.content[0]!.input as Record<string, unknown>).blob = "z".repeat(100_000);
  const after = await holdOf(body, "zai.glm-5");
  const addedBytes = after.forwardedBytes - base.forwardedBytes;
  expect(addedBytes).toBeGreaterThanOrEqual(100_000);
  expect(after.estimateMicros - base.estimateMicros).toBeGreaterThanOrEqual(addedBytes);
  expect(after.estimateMicros).toBeGreaterThanOrEqual(after.forwardedBytes + 4096 + 64 * 2);
});

it("refuses thinking/redacted history on GLM before holding or sending", async () => {
  const f = await world(false, "zai.glm-5");
  const reserve = vi.spyOn(f.meter, "reserve");
  const result = await call(f.deps, { ...multiTurn.thinking, model: "zai.glm-5" }, mint({ mdl: ["zai.glm-5"], runPrice: f.grant }));
  expect(result.status).toBe(400);
  expect(result.text()).toContain("invalid_request");
  expect(reserve).not.toHaveBeenCalled();
  expect(f.sent).toHaveLength(0);
});

it("settles cached and uncached split 5m/1h writes at the actual base tariff", async () => {
  const amounts: number[] = [];
  for (const cached of [false, true]) {
    const f = await world(false, pi.model, true);
    const body = structuredClone(pi);
    if (!cached) for (const block of [...body.system, ...body.messages[0]!.content, ...body.tools]) delete block.cache_control;
    f.deps.agentAi!.rovara!.transport = async () => ({ status: 200, body: (async function* () {
      yield sse("message_start", { message: { usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } } });
      yield sse("message_delta", { usage: { output_tokens: 7 } }); yield sse("message_stop");
    })() });
    expect((await call(f.deps, body, mint({ runPrice: f.grant }))).status).toBe(200);
    amounts.push((await f.meter.read(scope))[0]!.spentMicros);
  }
  // 1000*$3 + 2000*$0.3 + 1000*$3.75 + 2000*$6 + 7*$15 = 19455 microdollars.
  expect(amounts).toEqual([19455, 19455]);
});
