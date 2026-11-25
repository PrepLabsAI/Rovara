// Ruling (b): the gateway CLAMPS an OpenRouter call's max_tokens to the installed row's ceiling (never refuses a larger request),
// holds the clamped value, and still refuses what the row cannot serve (at/below the bounded-reasoning floor). Also Q4: the
// outgoing provider object pins the proven endpoint in BOTH `order` and `only`, with no fallback.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, answer } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
beforeAll(denyNetwork);
const model = "vendor/clamp-model";
const CEILING = 2048;
const tariff = { model, route: "fixture-endpoint/fp8", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.001", input_cache_read: "0", input_cache_write: "0" }, max_completion_tokens: CEILING, reasoning: { mode: "bounded" as const, max_tokens: 1024 }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture only; not a vendor tariff" };
const source = { kind: "company_key" as const, id: "src_router", name: "Company OpenRouter", provider: "openrouter", connectionRevision: "r1" };
// A REAL Pi/Anthropic request shape: cache markers on system/message/tool_use/tool_result/tool, tool schemas, streaming.
const cacheControl = { type: "ephemeral" };
const piBody = (max_tokens: number, extra: Record<string, unknown> = {}) => ({
 model, max_tokens, stream: true,
 system: [{ type: "text", text: "You are a coding agent.", cache_control: cacheControl }],
 messages: [
  { role: "user", content: [{ type: "text", text: "read the file", cache_control: cacheControl }] },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "read", input: { path: "a.ts" }, cache_control: cacheControl }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "contents", cache_control: cacheControl }], cache_control: cacheControl }] },
 ],
 tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, cache_control: cacheControl }],
 ...extra,
});
async function world(options: { limit?: number; request?: string } = {}) {
 const row = options.request === undefined ? tariff : { ...tariff, pricing: { ...tariff.pricing, request: options.request } };
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [row] }); await prices.reload();
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [row], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 const runPrice = (quote.body as { runPrice: RunPrice }).runPrice; expect(runPrice).toBeDefined();
 const f = setup({ prices, agentKeys: keys, openRouterTariffs: [row], chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 const sent: Record<string, unknown>[] = [];
 f.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { ...(options.limit === undefined ? {} : { maxOutputTokens: () => options.limit }), transport: async request => { sent.push(JSON.parse(request.body.toString()) as Record<string, unknown>); return { status: 200, body: answer() }; } } };
 const reserve = vi.spyOn(f.meter, "reserve");
 return { ...f, sent, open, runPrice, reserve };
}
const run = async (w: Awaited<ReturnType<typeof world>>, body: unknown) => { const sink = await call(w.deps, body, mint({ mdl: [model], runPrice: w.runPrice })); return sink; };
const estimateOf = (w: Awaited<ReturnType<typeof world>>) => (w.reserve.mock.calls[0]![0] as { estimateMicros: number }).estimateMicros;
const appliedOf = (w: Awaited<ReturnType<typeof world>>) => (w.reserve.mock.calls[0]![0] as { appliedMaxOutputTokens: number }).appliedMaxOutputTokens;
// Independent arithmetic (no gateway helper): completion 2 micro-USD per token; the request fee (1000 micro-USD) makes the OpenRouter hold dominate the generic estimate.
const COMPLETION_MICROS = 2; const REQUEST_MICROS = 1000;

it("C1/C2: a request ABOVE the ceiling is clamped (not refused) and a request AT the ceiling is unchanged; the hold uses the clamped value", async () => {
 const above = await world(); const aboveSink = await run(above, piBody(32_000));
 expect(aboveSink.status).toBe(200);
 expect(above.sent).toHaveLength(1);
 expect(above.sent[0]).toMatchObject({ max_tokens: CEILING });
 expect(appliedOf(above)).toBe(CEILING);
 const at = await world(); expect((await run(at, piBody(CEILING))).status).toBe(200);
 expect(at.sent[0]).toMatchObject({ max_tokens: CEILING });
 expect(appliedOf(at)).toBe(CEILING);
 // Same prompt, same clamped output: identical holds. The hold covers every clamped output token at the completion rate plus the request fee.
 expect(estimateOf(above)).toBe(estimateOf(at));
 expect(estimateOf(above)).toBeGreaterThanOrEqual(CEILING * COMPLETION_MICROS + REQUEST_MICROS);
 // One above the ceiling clamps to exactly the ceiling too (off-by-one pin).
 const plusOne = await world(); expect((await run(plusOne, piBody(CEILING + 1))).status).toBe(200);
 expect(plusOne.sent[0]).toMatchObject({ max_tokens: CEILING }); expect(estimateOf(plusOne)).toBe(estimateOf(at));
});

it("C3: a request BELOW the ceiling (above the reasoning floor) is kept as asked: never raised, held at its own size", async () => {
 const below = await world(); expect((await run(below, piBody(1500))).status).toBe(200);
 expect(below.sent[0]).toMatchObject({ max_tokens: 1500 });
 expect(appliedOf(below)).toBe(1500);
 const at = await world(); await run(at, piBody(CEILING));
 // (2048 - 1500) tokens * 2 micro-USD per token cheaper, exactly.
 expect(estimateOf(at) - estimateOf(below)).toBe((CEILING - 1500) * COMPLETION_MICROS);
 const one = await world(); expect((await run(one, piBody(1025))).status).toBe(200);
 expect(one.sent[0]).toMatchObject({ max_tokens: 1025 });
});

it.each([1024, 1000, 500, 1])("C4 (Q5): max_tokens %s is not above the bounded-reasoning floor: refused before any hold, key or send", async maxTokens => {
 const w = await world(); const sink = await run(w, piBody(maxTokens));
 expect(sink.status).toBe(400);
 expect(sink.text()).toContain("invalid_request");
 expect(w.reserve).not.toHaveBeenCalled(); expect(w.open).not.toHaveBeenCalled(); expect(w.sent).toEqual([]);
});

it("C5: the price snapshot's own output limit still wins when it is lower than the row ceiling", async () => {
 const w = await world({ limit: 1500 }); expect((await run(w, piBody(32_000))).status).toBe(200);
 expect(w.sent[0]).toMatchObject({ max_tokens: 1500 }); expect(appliedOf(w)).toBe(1500);
});

it("C7: an expired row is not served (refused before any hold); a row that expires between admission and the guard is refused by the guard, never sent unpinned; three sizes hold exactly their own output", async () => {
 const expired = await world(); expired.deps.now = () => tariff.expiresAt + 1;
 const sink = await run(expired, piBody(2048)); expect(sink.status).toBe(403);
 expect(expired.reserve).not.toHaveBeenCalled(); expect(expired.sent).toEqual([]);
 // The row ends after N clock reads: some N lands in the guard (400 invalid_request, the early refusal).
 const statuses = new Set<number>();
 for (let reads = 0; reads < 80; reads++) {
  const w = await world(); let n = 0; w.deps.now = () => (n++ < reads ? now : tariff.expiresAt + 1);
  const result = await run(w, piBody(2048)); statuses.add(result.status);
  // Whatever was sent (before the row ended) is the pinned, clamped body; a call refused at admission, in the guard or at the hold sends nothing.
  for (const request of w.sent) expect(request, `reads=${reads}`).toMatchObject({ max_tokens: CEILING, provider: { order: [tariff.route], only: [tariff.route], allow_fallbacks: false } });
  if (result.status === 400 || result.status === 403 || result.status === 409) expect(w.sent, `reads=${reads}`).toEqual([]);
 }
 expect(statuses.has(400)).toBe(true);
 const holds: number[] = [];
 for (const size of [1100, 1600, 2048]) { const w = await world(); await run(w, piBody(size)); holds.push(estimateOf(w)); expect(w.sent[0]).toMatchObject({ max_tokens: size }); }
 expect(holds[1]! - holds[0]!).toBe(500 * COMPLETION_MICROS);
 expect(holds[2]! - holds[1]!).toBe(448 * COMPLETION_MICROS);
});

it("Q4: the outgoing provider object pins the proven endpoint in order AND only, no fallback, and its caps equal the row", async () => {
 const w = await world(); expect((await run(w, piBody(2048))).status).toBe(200);
 expect(w.sent[0]!.provider).toEqual({ order: [tariff.route], only: [tariff.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 2, request: 0.001 } });
 expect(w.sent[0]!.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
});

it("T1: Pi's enabled thinking (OpenRouter reasoning models) is DROPPED, not refused: no client thinking upstream, reasoning only the row's bound, hold and size unchanged", async () => {
 const thinking = { type: "enabled", budget_tokens: 60_000, display: "summarized" };
 const plain = await world(); expect((await run(plain, piBody(2048))).status).toBe(200);
 for (const t of [thinking, { type: "adaptive" }]) {
  const w = await world(); const sink = await run(w, piBody(2048, { thinking: t }));
  expect(sink.status).toBe(200);
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]).not.toHaveProperty("thinking");
  expect(JSON.stringify(w.sent[0])).not.toContain("budget_tokens");
  expect(w.sent[0]!.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
  expect(w.sent[0]).toMatchObject({ max_tokens: CEILING });
  // The hold and the applied output limit are exactly those of the same request without thinking.
  expect(estimateOf(w)).toBe(estimateOf(plain)); expect(appliedOf(w)).toBe(appliedOf(plain));
 }
 // A client budget far above the row never raises max_tokens: still clamped to the ceiling.
 const big = await world(); expect((await run(big, piBody(32_000, { thinking }))).status).toBe(200);
 expect(big.sent[0]).toMatchObject({ max_tokens: CEILING }); expect(appliedOf(big)).toBe(CEILING);
 // Disabled thinking is as before: accepted, no client thinking upstream.
 const off = await world(); expect((await run(off, piBody(2048, { thinking: { type: "disabled" } }))).status).toBe(200);
 expect(off.sent[0]).not.toHaveProperty("thinking"); expect(estimateOf(off)).toBe(estimateOf(plain));
});

it("N4: a cache_control anywhere (system, message, tool_use, tool_result, tool, tool schema) never reaches OpenRouter", async () => {
 const nested = { name: "read", input_schema: { type: "object", properties: { cache_control: { type: "string" } } } };
 const variants: Record<string, unknown> = {
  real: piBody(2048),
  schemaKey: piBody(2048, { tools: [nested] }),
  deepSchema: piBody(2048, { tools: [{ name: "read", input_schema: { type: "object", properties: { a: { type: "object", properties: { cache_control: { type: "string" } } } } } }] }),
  topLevel: piBody(2048, { cache_control: cacheControl }),
 };
 for (const [name, body] of Object.entries(variants)) {
  const w = await world(); const sink = await run(w, body);
  for (const request of w.sent) expect(JSON.stringify(request), name).not.toMatch(/cache_control|prompt_cache|"caching"/u);
  if (name === "real") { expect(sink.status).toBe(200); expect(w.sent).toHaveLength(1); } else expect(w.sent.length === 0 || sink.status === 200, name).toBe(true);
 }
});

// Q-B: an absent/zero request price counts as zero ONLY because every OpenRouter call carries max_price.request = 0 with the pinned order + only and no fallback.
const assistantToolHistory = { messages: [
 { role: "user", content: [{ type: "text", text: "read it" }] },
 { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "read", input: { path: "a.ts" } }] },
 { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "contents" }] }] },
] };
const SHAPES: Record<string, Record<string, unknown>> = {
 "streaming with tools and cache markers (real Pi body)": {},
 "non streaming": { stream: false },
 "no tools, plain text": { tools: undefined, system: undefined, messages: [{ role: "user", content: "hello" }] },
 "string system and tool history": { system: "be brief", ...assistantToolHistory },
 "tool_choice": { tool_choice: { type: "auto" } },
};
it.each(Object.entries(SHAPES))("Q-B: max_price.request is 0 (with pinned order/only, no fallback) on every OpenRouter call: %s", async (_name, patch) => {
 for (const size of [1500, 2048, 32_000]) {
  const w = await world({ request: "0" }); const sink = await run(w, piBody(size, patch));
  // (the fake upstream answers SSE, so a non-streaming call may fail on the way back; the request itself was sent exactly once)
  if (patch.stream !== false) expect(sink.status, `${size}`).toBe(200);
  expect(w.sent, `${size}`).toHaveLength(1);
  expect(w.sent[0]!.provider, `${size}`).toEqual({ order: [tariff.route], only: [tariff.route], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 1, completion: 2, request: 0 } });
 }
});
it("Q-B: the only builder of an OpenRouter request body in the gateway is openRouterRequest (no second path can send an uncapped request)", () => {
 const dir = new URL("../../packages/model-gateway/src/", import.meta.url);
 const sources = readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => [f, readFileSync(new URL(f, dir), "utf8")] as const);
 expect(sources.filter(([, text]) => text.includes("max_price")).map(([f]) => f)).toEqual(["openrouter-policy.ts"]);
 expect(sources.filter(([, text]) => text.includes("openRouterRequest(")).map(([f]) => f).sort()).toEqual(["agent-openai.ts", "openrouter-policy.ts"]);
 expect(sources.filter(([, text]) => /openrouter\.ai/u.test(text)).map(([f]) => f)).toEqual(["agent-openai.ts"]);
 // The server's OpenRouter branch always hands the installed row to the translator.
 expect(sources.find(([f]) => f === "server.ts")![1]).toContain('chat.provider, policy); } catch { translated = undefined; }');
});
