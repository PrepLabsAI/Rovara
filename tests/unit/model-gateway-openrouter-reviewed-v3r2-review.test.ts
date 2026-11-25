// Opus money review of 0b6b34979 (OpenRouter v3 run 2, 64 reviewed rows): the cases the lane's own test does not cover.
// P1: exact pins independent of the generated fixture (count, kind split, explicit-write model list, earliest/latest expiry, dropped/kept run-1 models).
// P2: per row, the rate the settle floor uses for a reported write is never below the row's listed prices (enforced rows: the HIGHEST listed price).
// P3: per enforced row, through the real gateway: a reported write stops the call and settles at >= max(hold, reported cost), flagged noWriteRoute, not final.
// P4: per explicit-write row, through the real gateway: a reported write is billed (not stopped) and never settles below the reported cost.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
import { REVIEWED_OPENROUTER_POLICIES, openRouterPolicy, openRouterRates, openRouterHold, openRouterDecimal, type OpenRouterTariff } from "../../packages/model-gateway/src/openrouter-policy.js";
import { settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
beforeAll(denyNetwork);

const rows = REVIEWED_OPENROUTER_POLICIES;
const enforced = rows.filter(r => r.cacheWriteBasis === "never_requested_enforced");
const explicit = rows.filter(r => r.cacheWriteBasis === undefined);
const EXPLICIT_WRITE_MODELS = ["anthropic/claude-haiku-5.5", "google/gemini-3.5-flash", "google/gemini-3.6-flash", "google/gemini-4-hydrogen", "openai/gpt-5.6-luna", "openai/gpt-6-luna", "qwen/qwen3.7-flash", "qwen/qwen3.7-max", "qwen/qwen3.7-plus"];

it("P1 pins the installed set independently of the fixture: 64 rows, 51 enforced + 13 explicit, expiry window, run-1 models", () => {
 expect(rows).toHaveLength(64);
 expect(enforced).toHaveLength(51);
 expect(explicit).toHaveLength(13);
 for (const m of EXPLICIT_WRITE_MODELS) expect(explicit.map(r => r.model), m).toContain(m);
 expect(explicit.filter(r => r.model.startsWith("google/") && r.route.endsWith("/priority"))).toHaveLength(7);
 // earliest expiry openai/gpt-oss-20b 2026-11-25 01:57:28.153Z, latest 08:25:24.688Z; every row exactly 24 h
 const first = rows.reduce((a, b) => (b.expiresAt < a.expiresAt ? b : a));
 expect(first.model).toBe("openai/gpt-oss-20b");
 expect(first.expiresAt).toBe(Date.UTC(2026, 10, 25, 1, 57, 28, 153));
 expect(Math.max(...rows.map(r => r.expiresAt))).toBe(Date.UTC(2026, 10, 25, 8, 25, 24, 688));
 expect(rows.every(r => r.expiresAt - r.verifiedAt === 86_400_000)).toBe(true);
 // run-1 qwen3.8-2.4t-a95b dropped; gpt-6-luna moved to openai/flex; gpt-5-mini now installed (no longer an expected refusal)
 expect(rows.some(r => r.model === "qwen/qwen3.8-2.4t-a95b")).toBe(false);
 expect(rows.find(r => r.model === "openai/gpt-6-luna")?.route).toBe("openai/flex");
 expect(rows.find(r => r.model === "openai/gpt-5-mini")?.cacheWriteBasis).toBe("never_requested_enforced");
 // all fresh together at the latest verifiedAt: every model validates at once
 const t = Math.max(...rows.map(r => r.verifiedAt)) + 1;
 expect(rows.filter(r => openRouterPolicy(r.model, t) !== undefined)).toHaveLength(64);
 // one ms after the earliest expiry, that model (only) is switched off
 expect(openRouterPolicy(first.model, first.expiresAt)).toBeUndefined();
 expect(rows.filter(r => openRouterPolicy(r.model, first.expiresAt) !== undefined)).toHaveLength(63);
});

const micros = (s: string) => Number(openRouterDecimal(s) / 1_000_000n);
describe.each(rows.map(r => [r.model, r] as const))("P2 %s", (_m, r) => {
 it("rates a reported write at >= every relevant listed price, and the retained settle is >= max(hold, reported, token cost)", () => {
  const policy = openRouterPolicy(r.model, r.verifiedAt + 1)!;
  const rates = openRouterRates(policy);
  const p = r.pricing;
  const listed = [p.prompt, p.completion, p.internal_reasoning, p.input_cache_read].map(micros);
  if (r.cacheWriteBasis === "never_requested_enforced") {
   expect(rates.cacheWrite5mMicrosPerMTok).toBe(Math.max(...listed));
   expect(rates.cacheWrite5mMicrosPerMTok).toBeGreaterThan(0);
  } else {
   expect(rates.cacheWrite5mMicrosPerMTok).toBe(Math.max(micros(p.prompt), micros(p.input_cache_write)));
   expect(rates.cacheWrite5mMicrosPerMTok).toBeGreaterThanOrEqual(micros(p.input_cache_write));
  }
  expect(rates.cacheWrite1hMicrosPerMTok).toBe(rates.cacheWrite5mMicrosPerMTok);
  expect(rates.outputMicrosPerMTok).toBeGreaterThanOrEqual(micros(p.completion));
  expect(rates.inputMicrosPerMTok).toBe(micros(p.prompt));
  // retained settle (the path server.ts forces for a write on a no-write route / missing cost)
  const hold = openRouterHold(policy, 50_000, 2048);
  const usage = { input: 40_000, output: 2048, cacheRead: 0, cacheWrite: 10_000 };
  const big = Math.ceil(((40_000 * micros(p.prompt) + 10_000 * rates.cacheWrite5mMicrosPerMTok + 2048 * rates.outputMicrosPerMTok) / 1_000_000)) ;
  const price = { inputMicrosPerMTok: rates.inputMicrosPerMTok, outputMicrosPerMTok: rates.outputMicrosPerMTok, cacheReadMicrosPerMTok: rates.cacheReadMicrosPerMTok, cacheWrite5mMicrosPerMTok: rates.cacheWrite5mMicrosPerMTok, cacheWrite1hMicrosPerMTok: rates.cacheWrite1hMicrosPerMTok, estimated: false, knownTokenPrice: true, priceVersion: 1 } as never;
  for (const reportedCostMicros of [undefined, 0, 1, hold * 3 + 11]) {
   const out = settleChargeAmount({ usage, price, reservationMicros: hold, retainMissingUsage: true, ...(reportedCostMicros === undefined ? {} : { reportedCostMicros }) });
   expect(out.actualMicros).toBeGreaterThanOrEqual(hold);
   expect(out.actualMicros).toBeGreaterThanOrEqual(reportedCostMicros ?? 0);
   expect(out.actualMicros).toBeGreaterThanOrEqual(big - 1);
   expect(out.status).not.toBe("final");
  }
 });
});

// Real gateway, real reviewed row (prices/route/bounds/basis unchanged), only the freshness window moved to the fixture clock.
const head = (model: string) => ({ id: "gen-v3r2-review", provider: "Fixture", model, object: "chat.completion.chunk", created: 1_763_900_000 });
const sse = (model: string, chunk: unknown) => Buffer.from(`data: ${JSON.stringify({ ...head(model), ...(chunk as object) })}\n\n`);
const usageWith = (write: number, cost: number) => ({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost, is_byok: false,
 prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: write, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0 },
 cost_details: { upstream_inference_cost: cost, upstream_inference_prompt_cost: cost / 2, upstream_inference_completions_cost: cost / 2 } });
async function world(row: OpenRouterTariff) {
 const MODEL = row.model;
 const tariffs = [{ ...row, verifiedAt: now - 1, expiresAt: now + 60_000 }];
 const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: tariffs }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const open = vi.fn(async () => "fixture-key");
 const keys = { connected: async () => true, keyFor: open, resolveForCharge: async () => ({ source, key: open }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: tariffs, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${MODEL}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 expect(quote.status, MODEL).toBe(200);
 const w = setup({ prices, agentKeys: keys, openRouterTariffs: tariffs, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
 const token = mint({ mdl: [MODEL], runPrice: (quote.body as { runPrice: RunPrice }).runPrice });
 const transport = vi.fn(async () => translatedAnswer("openrouter", { model: MODEL, streaming: true }, 200, (async function* () {
  yield sse(MODEL, { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop", native_finish_reason: "stop", logprobs: null }] });
  yield sse(MODEL, { choices: [], usage: usageWith(2, 0.000004) });
  yield Buffer.from("data: [DONE]\n\n");
 })(), () => undefined));
 w.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport } };
 const reserve = vi.spyOn(w.deps.meter, "reserve");
 const settle = vi.spyOn(w.deps.meter, "settleV2" as never) as unknown as { mock: { calls: [{ receipt: { status: string; amountMicros: { value: number } }; noWriteRoute?: boolean }][] } };
 const result = await call(w.deps, { ...requestBody, model: MODEL, max_tokens: 2048, stream: true }, token);
 return { result, transport, held: () => (reserve.mock.calls[0]![0] as { estimateMicros: number }).estimateMicros, settled: () => settle.mock.calls[0]![0] };
}

describe.each(enforced.map(r => [r.model, r] as const))("P3 enforced %s", (_m, row) => {
 it("a reported write stops the call and settles at >= max(hold, reported cost), noWriteRoute, not final", async () => {
  const { result, held, settled, transport } = await world(row);
  expect(result.status).toBe(200);
  expect(result.destroyed).toBe(true);
  const { receipt, noWriteRoute } = settled();
  expect(noWriteRoute).toBe(true);
  expect(receipt.amountMicros.value).toBeGreaterThanOrEqual(held());
  expect(receipt.amountMicros.value).toBeGreaterThanOrEqual(4);
  expect(receipt.status).not.toBe("final");
  expect(transport).toHaveBeenCalledTimes(1);
 });
});

describe.each(explicit.map(r => [r.model, r] as const))("P4 explicit-write %s", (_m, row) => {
 it("a reported write is billed (not a no-write stop) and never settles below the reported cost", async () => {
  const { result, settled } = await world(row);
  expect(result.status).toBe(200);
  expect(result.destroyed).toBe(false);
  const { receipt, noWriteRoute } = settled();
  expect(noWriteRoute).toBeUndefined();
  expect(receipt.amountMicros.value).toBeGreaterThanOrEqual(4);
 });
});
