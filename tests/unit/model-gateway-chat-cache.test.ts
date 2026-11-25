import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, claims, mint, now, scope, setup } from "./model-gateway-fixture.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { serializeEndpointConnection } from "../../packages/model-gateway/src/endpoint-source.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";

beforeAll(denyNetwork);
type Route = "openai" | "openrouter" | "endpoint";
async function world(route: Route, stream: boolean, writePrice: "missing" | "known" = "missing") {
  const provider = route === "openrouter" ? "openrouter" : "openai";
  const model = route === "endpoint" ? "our-coder" : route === "openrouter" ? "openai/gpt-5-mini" : "gpt-5-mini";
  const catalogModel = route === "endpoint" ? "gpt-5-mini" : model;
  const source = { kind: "company_key" as const, id: `saved_${route}`, name: "Company AI", provider, connectionRevision: "r1" };
  const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0", request: "0", input_cache_read: "0.000003", input_cache_write: "0.000009" },
    max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "offline fixture, not a production tariff" };
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider, model: catalogModel, kind: "chat",
    inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 3_000_000,
    ...(writePrice === "known" ? { cacheWrite5mMicrosPerMTok: 9_000_000, cacheWrite1hMicrosPerMTok: 9_000_000 } : {}) }] } } }), save: async () => false },
  { now: () => now, overrides: [], openRouterTariffs: [tariff] });
  await prices.reload();
  const endpoint = { scheme: "openai_compatible" as const, baseUrl: "https://llm.example.com/v1", key: "fixture-endpoint-key-123456789", models: [{ name: model, catalog: { provider, modelId: catalogModel } }] };
  const key = route === "endpoint" ? serializeEndpointConnection(endpoint) : "fixture-key";
  const keys = { connected: async () => true, keyFor: async () => key, resolveForCharge: async () => ({ source, key: async () => key }),
    identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }),
    endpointMetadata: async () => ({ sourceId: source.id, versionId: source.connectionRevision, models: endpoint.models }) };
  const sources = { sourceFor: async () => route === "endpoint" ? "custom_endpoint" as const : route === "openrouter" ? "openrouter_key" as const : "openai_key" as const };
  const quoted = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set([route]), offeredProviders: new Set([route]), openRouterTariffs: [tariff],
    verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice;
  expect(grant).toBeDefined();
  const sent: ProviderRequest[] = [];
  const usage = { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 }, ...(route === "openrouter" ? { cost: 0.000021 } : {}) };
  const transport: ProviderTransport = async request => {
    sent.push(request);
    const chunks = stream ? [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`, "data: [DONE]\n\n",
    ] : [JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage })];
    return translatedAnswer(route, { model, streaming: stream }, 200, (async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })(), () => undefined);
  };
  const f = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_claims, _model, resolved) => resolved },
    agentAi: { sources, switchedOn: new Set([route]), ...(route === "endpoint" ? { endpoint: { transport: () => transport } } : { [route]: { transport } }) } });
  const body = { model, stream, max_tokens: 64, system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
    tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }] };
  return { ...f, prices, grant, body, model, catalogModel, provider, source, sent };
}

for (const route of ["openai", "openrouter", "endpoint"] as const) it.each([false, true])(`${route}: priced cache-marked Messages translate, hold and settle at the real tariff (stream=%s)`, async stream => {
  const f = await world(route, stream);
  const reserve = vi.spyOn(f.meter, "reserve"); const settle = vi.spyOn(f.meter, "settleV2");
  const result = await call(f.deps, f.body, mint({ mdl: [f.model], runPrice: f.grant }));
  expect(result.status, result.text()).toBe(200);
  expect(f.sent).toHaveLength(1);
  const forwarded = f.sent[0]!;
  expect(forwarded.path).toBe(route === "openrouter" ? "/api/v1/chat/completions" : "/v1/chat/completions");
  expect(JSON.parse(forwarded.body.toString())).toMatchObject({ model: f.model, messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "read" } }] });
  expect(forwarded.body.toString()).not.toMatch(/cache_control|prompt_cache/u);
  // OpenRouter retains its policy hold ($3 reads + $9 writes); other chat routes hold plain input at $1.
  expect(reserve.mock.calls).toHaveLength(1);
  expect(reserve.mock.calls[0]![0]).toMatchObject({ estimateMicros: (forwarded.body.length + 4096) * (route === "openrouter" ? 12 : 1) + 64 * 2 });
  expect(settle.mock.calls).toHaveLength(1);
  // 2 uncached * $1 + 3 cached * $3 + 5 output * $2 = 21 microdollars, independently of the hold.
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", source: f.source, billing: "external_provider", model: { provider: f.provider, modelId: f.catalogModel },
    amountMicros: { state: "available", value: 21 }, billableMicros: { state: "available", value: 0 }, usageComplete: true,
    usage: { state: "available", value: { input: 2, output: 5, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } } });
  expect((await f.meter.read(scope))[0]).toMatchObject({ spentMicros: 21, reservedMicros: 0 });
});

for (const route of ["openai", "endpoint"] as const) it(`${route}: stripped markers do not inflate the hold even with a known expensive write tariff`, async () => {
  const f = await world(route, false, "known"); const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, f.body, mint({ mdl: [f.model], runPrice: f.grant }))).status).toBe(200);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(f.sent[0]!.body.length + 4096 + 64 * 2);
});

it("openrouter: stripped markers do not demand a write component from the PriceSource port", async () => {
  const f = await world("openrouter", false);
  // Fault injection only: current SnapshotPriceSource always supplies writes from the complete reviewed policy.
  // Pin the route's flag independently, without inventing a tariff or changing production pricing.
  const real = f.prices.effectiveFor("openrouter", f.model, "chat");
  const plain = { ...real };
  delete plain.cacheWrite5mMicrosPerMTok; delete plain.cacheWrite1hMicrosPerMTok;
  f.deps.prices = { priceFor: f.prices.priceFor.bind(f.prices), quoteBasis: f.prices.quoteBasis.bind(f.prices),
    effectiveFor: () => ({ ...plain, derived: [{ aboveTokens: 0, keys: ["cacheWrite5mMicrosPerMTok", "cacheWrite1hMicrosPerMTok"] }] }) };
  const result = await call(f.deps, f.body, mint({ mdl: [f.model], runPrice: f.grant }));
  expect(result.status, result.text()).toBe(200);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.body.toString()).not.toContain("cache_control");
});

// Real Pi 1.5.2 requests (tests/fixtures/model-gateway, captured from its anthropic-messages serializer): every tool carries `eager_input_streaming`.
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/model-gateway/${name}`, import.meta.url), "utf8")) as T;
type PiBody = { model: string; stream: boolean; max_tokens: number; system: unknown; messages: unknown[]; tools: Array<Record<string, unknown>> };
const piSingle = fixture<PiBody>("pi-ai-1.5.2-anthropic-messages.json");
const piMulti = fixture<Record<"toolResult" | "final" | "thinking", PiBody>>("pi-ai-1.5.2-multiturn.json");
const piCases: Array<[string, PiBody]> = [["first turn", piSingle], ["tool result turn", piMulti.toolResult], ["final turn", piMulti.final]];

for (const route of ["openai", "openrouter", "endpoint"] as const) for (const [turn, pi] of piCases) it(`${route}: real Pi 1.5.2 ${turn} (eager_input_streaming on tools) is answered 200 without the key upstream`, async () => {
  const f = await world(route, pi.stream);
  expect(pi.tools.every((t) => t.eager_input_streaming === true)).toBe(true);
  const reserve = vi.spyOn(f.meter, "reserve");
  const result = await call(f.deps, { ...structuredClone(pi), model: f.model }, mint({ mdl: [f.model], runPrice: f.grant }));
  expect(result.status, result.text()).toBe(200);
  expect(f.sent).toHaveLength(1);
  const upstream = f.sent[0]!.body.toString();
  expect(upstream).not.toContain("eager_input_streaming");
  expect((JSON.parse(upstream) as { tools: unknown }).tools).toEqual([{ type: "function", function: { name: "read", description: "Read a file.", parameters: pi.tools[0]!.input_schema } }]);
  // The hold is taken on exactly the translated body: dropping a streaming hint changes no price, only a few bytes of the estimate.
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe((f.sent[0]!.body.length + 4096) * (route === "openrouter" ? 12 : 1) + 64 * 2);
});

for (const route of ["openai", "openrouter", "endpoint"] as const) it(`${route}: an unknown OTHER tool key is still refused 400 beside eager_input_streaming, before any hold or send`, async () => {
  const f = await world(route, true); const reserve = vi.spyOn(f.meter, "reserve");
  for (const extra of [{ defer_loading: true }, { allowed_callers: ["direct"] }, { eager_input_streaming_x: true }]) {
    const body = { ...structuredClone(piSingle), model: f.model, tools: [{ ...piSingle.tools[0], ...extra }] };
    expect((await call(f.deps, body, mint({ mdl: [f.model], runPrice: f.grant }))).status).toBe(400);
  }
  // The hint itself must still be a boolean.
  expect((await call(f.deps, { ...structuredClone(piSingle), model: f.model, tools: [{ ...piSingle.tools[0], eager_input_streaming: "yes" }] }, mint({ mdl: [f.model], runPrice: f.grant }))).status).toBe(400);
  expect(f.sent).toHaveLength(0);
  expect(reserve).not.toHaveBeenCalled();
});
