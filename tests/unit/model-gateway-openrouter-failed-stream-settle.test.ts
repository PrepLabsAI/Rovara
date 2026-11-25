// OpenRouter cloud gateway: (1) its stream repeats the finish reason on the final usage chunk and the call now settles FINAL at its reported cost;
// (2) a FAILED stream that already received OpenRouter's complete reported cost settles at that cost, never above the hold; no usage keeps the hold.
// Billing stays external_provider with billableMicros 0 (Rovara never charges).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody, scope } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { translatedAnswer } from "../../packages/model-gateway/src/agent-openai.js";
const ev = (l: unknown): unknown => (l as { event?: unknown }).event;
beforeAll(denyNetwork);

type Json = Record<string, unknown>;
const model = "vendor/model";
const data = (value: Json | string) => Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
const delta = (d: Json, finish: string | null = null) => data({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] });
const wireUsage = (cost: number): Json => ({ prompt_tokens: 10, completion_tokens: 5, cost, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 2 } });
// OpenRouter's usage chunk: one choice with a content-free delta that repeats the finish reason, plus usage.
const usageChunk = (finish: string, cost: number, d: Json = { role: "assistant", content: "" }) => data({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish, native_finish_reason: finish }], usage: wireUsage(cost) });

async function run(chunks: Buffer[]) {
  const tariff = { model, route: "fixture", pricing: { prompt: "0.000001", completion: "0.000002", internal_reasoning: "0.000002", request: "0.000004", input_cache_read: "0", input_cache_write: "0" }, max_completion_tokens: 2048, reasoning: { mode: "disabled" as const }, verifiedAt: now - 1, expiresAt: now + 60_000, evidence: "fixture" };
  const prices = new SnapshotPriceSource({ load: async () => undefined, save: async () => false }, { now: () => now, openRouterTariffs: [tariff] }); await prices.reload();
  const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
  const keys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
  const sources = { sourceFor: async () => "openrouter_key" as const };
  const quote = await answerRateQuote({ prices, keys, sources, now: () => now, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  expect(quote.status).toBe(200);
  const w = setup({ prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved } });
  w.deps.agentAi = { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport: async () => translatedAnswer("openrouter", { model, streaming: true }, 200, (async function* () { for (const c of chunks) yield c; })(), () => undefined) } };
  const reserve = vi.spyOn(w.meter, "reserve"); const settle = vi.spyOn(w.meter, "settleV2");
  const result = await call(w.deps, { ...requestBody, model, stream: true }, mint({ mdl: [model], runPrice: (quote.body as { runPrice: RunPrice }).runPrice }));
  const held = reserve.mock.calls[0]![0].estimateMicros;
  return { w, result, held, receipt: settle.mock.calls[0]?.[0].receipt };
}
const text = (cost: number, finish = "stop") => [delta({ role: "assistant", content: "ok" }), delta({ content: "!" }, finish), usageChunk(finish, cost), data("[DONE]")];

describe("OpenRouter repeats the finish reason on the usage chunk", () => {
  it("settles the call FINAL at OpenRouter's reported cost (not the hold, no provider error)", async () => {
    const { w, result, held, receipt } = await run(text(0.000087));
    expect(result.status).toBe(200); expect(result.destroyed).toBe(false);
    expect(held).toBeGreaterThan(87);
    expect(receipt).toMatchObject({ status: "final", reason: "reported_cost", billing: "external_provider", billableMicros: { state: "available", value: 0 }, amountMicros: { state: "available", value: 87 }, providerCostMicros: { state: "available", value: 87 } });
    expect(w.logs.some((l) => ev(l) === "provider_error")).toBe(false);
    expect((await w.meter.read(scope)).every((r) => r.spentMicros === 87 && r.estimatedMicros === 0)).toBe(true);
  });
  it("a completed call above its hold still settles at the true cost and raises the over-reservation alarm (unchanged)", async () => {
    const { w, result, held, receipt } = await run(text(1));
    expect(result.status).toBe(200);
    expect(receipt).toMatchObject({ status: "final", reason: "reported_cost", amountMicros: { value: 1_000_000 } });
    expect(w.logs).toContainEqual({ event: "openrouter_over_reservation", costMicros: 1_000_000, holdMicros: held, sourceId: "src_router" });
  });
});

describe("a FAILED OpenRouter stream", () => {
  // The usage chunk arrives (the cost is read first), then the same chunk's choice is broken: a different finish reason.
  const brokenAfterUsage = (cost: number) => [delta({ role: "assistant", content: "ok" }, "stop"), usageChunk("length", cost), data("[DONE]")];
  it("that received complete usage settles at the REPORTED cost, not the hold (billing external_provider, billable 0)", async () => {
    const { w, result, held, receipt } = await run(brokenAfterUsage(0.000085));
    expect(result.destroyed).toBe(true);
    expect(held).toBeGreaterThan(85);
    expect(receipt).toMatchObject({ status: "final", reason: "reported_cost", billing: "external_provider", billableMicros: { state: "available", value: 0 }, amountMicros: { state: "available", value: 85 }, providerCostMicros: { value: 85 } });
    expect((await w.meter.read(scope)).every((r) => r.spentMicros === 85 && r.estimatedMicros === 0)).toBe(true);
    expect(w.logs.some((l) => ev(l) === "openrouter_over_reservation" || ev(l) === "customer_source_over_reservation")).toBe(false);
  });
  it("without usage keeps the whole hold (fail closed)", async () => {
    const { w, result, held, receipt } = await run([delta({ role: "assistant", content: "ok" }, "stop"), data("[DONE]")]);
    expect(result.destroyed).toBe(true);
    expect(receipt).toMatchObject({ status: "awaiting_usage", reason: "missing_usage", billing: "external_provider", billableMicros: { value: 0 }, amountMicros: { state: "available", value: held } });
    expect((await w.meter.read(scope)).every((r) => r.spentMicros === held)).toBe(true);
  });
  // REVIEW-OPUS: above the hold the known debit is counted (never the hold, which would under-count the customer's own caps), and the alarm still sees it.
  it("whose reported cost exceeds the hold counts the whole known cost (estimated) and still raises the over-reservation alarm, marked failed", async () => {
    const { w, result, held, receipt } = await run(brokenAfterUsage(1));
    expect(result.destroyed).toBe(true);
    expect(held).toBeLessThan(1_000_000);
    expect(receipt).toMatchObject({ status: "estimated", reason: "derived_rate", billing: "external_provider", billableMicros: { state: "available", value: 0 }, amountMicros: { state: "available", value: 1_000_000 }, providerCostMicros: { value: 1_000_000 } });
    expect(w.logs).toContainEqual({ event: "openrouter_over_reservation", costMicros: 1_000_000, holdMicros: held, sourceId: "src_router", failed: true });
    expect(w.logs).toContainEqual({ event: "customer_source_over_reservation", source: "openrouter", company: claims.cid, costMicros: 1_000_000, heldMicros: held, overageMicros: 1_000_000 - held });
  });
  // REVIEW-OPUS: a cost read before the answer ended is a partial figure: the broken stream keeps the hold, never that partial cost.
  const early = (cost: number) => data({ id: "c1", object: "chat.completion.chunk", choices: [], usage: wireUsage(cost) });
  it("whose cost arrived BEFORE the answer (then more output, then a break) keeps the hold", async () => {
    const { result, held, receipt } = await run([early(0.000001), delta({ role: "assistant", content: "x".repeat(2000) }), delta({ content: "y".repeat(2000) })]);
    expect(result.destroyed).toBe(true);
    expect(receipt).toMatchObject({ status: "awaiting_usage", reason: "missing_usage", amountMicros: { state: "available", value: held }, providerCostMicros: { value: 1 } });
  });
  it("whose final cost is followed by more answer output (then a break) keeps the hold", async () => {
    const { result, held, receipt } = await run([delta({ role: "assistant", content: "ok" }, "stop"), early(0.000001), delta({ content: "more" })]);
    expect(result.destroyed).toBe(true);
    expect(receipt).toMatchObject({ status: "awaiting_usage", amountMicros: { state: "available", value: held } });
  });
  it("whose cost arrived after output but BEFORE the finish reason (then a break) keeps the hold", async () => {
    const { result, held, receipt } = await run([delta({ role: "assistant", content: "ok" }), early(0.000001)]);
    expect(result.destroyed).toBe(true);
    expect(receipt).toMatchObject({ status: "awaiting_usage", amountMicros: { state: "available", value: held } });
  });
  it("that the GATEWAY cut after the final cost (its secret guard stopped the answer) keeps the hold", async () => {
    // The answer text repeats the provider key ("fixture"): the gateway stops it, after the same read delivered the final cost.
    const { w, result, held, receipt } = await run([Buffer.concat([delta({ role: "assistant", content: "the fixture" }, "stop"), usageChunk("stop", 0.00002)])]);
    expect(result.destroyed).toBe(true);
    expect(w.logs.some((l) => ev(l) === "provider_error" && String((l as { reason?: unknown }).reason).startsWith("provider_"))).toBe(false);
    expect(receipt).toMatchObject({ status: "awaiting_usage", amountMicros: { state: "available", value: held }, providerCostMicros: { value: 20 } });
  });
  it("whose final cost arrived after the finish and then the connection dropped (no [DONE]) settles at the reported cost", async () => {
    const { result, receipt } = await run([delta({ role: "assistant", content: "ok" }, "stop"), early(0.00002)]);
    expect(result.destroyed).toBe(true);
    expect(receipt).toMatchObject({ status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 20 } });
  });
});

