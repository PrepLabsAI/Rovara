// Opus money review (lead 4) of the reviewed OpenRouter v3 rows: settlement floors for every reported-cost shape,
// and a row that expires DURING a call still settles at the admitted row price (never at 0, never refused after sending).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { claims, now, setup, call, mint, requestBody, sse } from "./model-gateway-fixture.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { REVIEWED_OPENROUTER_POLICIES, openRouterDecimal } from "../../packages/model-gateway/src/openrouter-policy.js";
import { parseReportedCost, settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
beforeAll(denyNetwork);
const store = { load: async () => undefined, save: async () => false };
const tokenFloor = (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, p: Record<string, string>) => {
 const d = openRouterDecimal; const write = d(p.input_cache_write!) > d(p.prompt!) ? d(p.input_cache_write!) : d(p.prompt!);
 const usd = d(p.prompt!) * BigInt(usage.input) + d(p.input_cache_read!) * BigInt(usage.cacheRead) + write * BigInt(usage.cacheWrite) + d(p.completion!) * BigInt(usage.output);
 return Number((usd * 1_000_000n) / 10n ** 18n);
};
describe.each(REVIEWED_OPENROUTER_POLICIES.map(r => [r.model, r] as const))("%s settlement floor", (_model, row) => {
 it("never settles below the token cost for absent / 0 / negative / NaN / Infinity / fractional / huge reported costs", async () => {
  const t = row.verifiedAt + 1;
  const prices = new SnapshotPriceSource(store, { now: () => t }); await prices.reload();
  const price = prices.priceFor("openrouter", row.model)!;
  expect(price).toBeDefined(); expect(price).toMatchObject({ estimated: false });
  for (const usage of [{ input: 100_000, output: 2048, cacheRead: 0, cacheWrite: 0 }, { input: 3, output: 1, cacheRead: 7, cacheWrite: 5 }]) {
   const floor = tokenFloor(usage, row.pricing);
   for (const reported of [undefined, 0, -1, -1e12, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, floor - 0.5, Number.MAX_SAFE_INTEGER + 2, 1e30]) {
    const out = settleChargeAmount({ usage, price: { ...price, estimated: false }, reservationMicros: 1, ...(reported === undefined ? {} : { reportedCostMicros: reported }) });
    expect(out.actualMicros, `reported=${reported}`).toBeGreaterThanOrEqual(floor);
    expect(Number.isSafeInteger(out.actualMicros), `reported=${reported}`).toBe(true);
   }
   // A valid reported cost above the token floor is charged in full.
   expect(settleChargeAmount({ usage, price: { ...price, estimated: false }, reservationMicros: 1, reportedCostMicros: floor * 3 + 11 }).actualMicros).toBe(floor * 3 + 11);
  }
 });
});
it("parses no negative / NaN / Infinity / non-number / unbounded OpenRouter cost into money", () => {
 for (const cost of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.01", null, 1e30]) expect(parseReportedCost("openrouter", { cost }), String(cost)).toBeUndefined();
 expect(parseReportedCost("openrouter", { cost: 0.0000132375 })).toBe(14);
 expect(parseReportedCost("openrouter", { cost: 0.00001, cost_details: { upstream_inference_cost: 0.00002 } })).toBe(20);
});
it.each(["mid_stream", "after_stream", "never"] as const)("a reviewed row (haiku prices, else the first explicit-write row) that expires DURING the call (%s) never settles below the token cost at the row price", async (when) => {
 const reviewed = REVIEWED_OPENROUTER_POLICIES.find(r => r.model === "anthropic/claude-haiku-5.5") ?? REVIEWED_OPENROUTER_POLICIES.find(r => r.cacheWriteBasis === undefined)!;
 // Same prices/route/bounds; the fixture clock is later than the real expiry, so only the window moves.
 const tariff = { ...reviewed, verifiedAt: now - 1, expiresAt: now + 60_000 };
 const model = tariff.model; let clock = now;
 const prices = new SnapshotPriceSource(store, { now: () => clock, openRouterTariffs: [tariff] }); await prices.reload();
 const source = { kind: "company_key" as const, id: "src_router", name: "Fixture", provider: "openrouter", connectionRevision: "r1" };
 const keys = { connected: async () => true, keyFor: async () => "fixture", resolveForCharge: async () => ({ source, key: async () => "fixture" }), identityFor: async () => ({ sourceId: source.id, versionId: source.connectionRevision }) };
 const sources = { sourceFor: async () => "openrouter_key" as const };
 const quote = await answerRateQuote({ prices, keys, sources, now: () => clock, region: "us-west-2", switchedOn: new Set(["openrouter"]), offeredProviders: new Set(["openrouter"]), openRouterTariffs: [tariff], verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
 expect(quote.status).toBe(200);
 const output = 1500; const input = 40;
 const w = setup({ now: () => clock, prices, agentKeys: keys, openRouterTariffs: [tariff], chargeReceipts: { source: (_c, _m, resolved) => resolved }, agentAi: { sources, switchedOn: new Set(["openrouter"]), openrouter: { transport: async () => ({ status: 200, body: (async function* () { if (when === "mid_stream") clock = tariff.expiresAt + 1; yield sse("message_start", { message: { usage: { input_tokens: input, output_tokens: 0 } } }); yield sse("message_delta", { usage: { output_tokens: output } }); yield sse("message_stop"); if (when === "after_stream") clock = tariff.expiresAt + 1; })(), reportedCostMicros: () => 1, reportedCostComplete: () => true }) } } });
 const settle = vi.spyOn(w.meter, "settleV2");
 await call(w.deps, { ...requestBody, model, max_tokens: 2048 }, mint({ mdl: [model], runPrice: (quote.body as { runPrice: RunPrice }).runPrice }));
 if (when !== "never") expect(clock).toBeGreaterThan(tariff.expiresAt);
 const floor = tokenFloor({ input, output, cacheRead: 0, cacheWrite: 0 }, tariff.pricing);
 expect(floor).toBeGreaterThan(1);
 expect(settle).toHaveBeenCalledTimes(1);
 const receipt = settle.mock.calls[0]![0].receipt as { status: string; amountMicros: { value: number }; usage: { state: string } };
 const held = (receipt as unknown as { originalReservationMicros: { value: number } }).originalReservationMicros.value;
 // Before expiry the usage is rated at the row (final). If the row (and so the signed run price) ends during the call, the gateway cuts the call (a deadline cut, DEC 254zzz521):
 //   after_stream: the provider's complete usage was already read, so it settles at that ACTUAL usage at the admitted row price (never below the token cost);
 //   mid_stream: nothing was read yet. A row whose reasoning is bounded CAN bill reasoning that is never streamed, so it cannot be priced: the hold stands (awaiting_usage).
 //   A row with reasoning disabled settles at an ESTIMATE OF USE (the input sent), marked estimated, never the whole hold and never above it.
 if (when !== "mid_stream") expect(receipt.amountMicros.value).toBeGreaterThanOrEqual(floor);
 if (when !== "mid_stream") expect(receipt).toMatchObject({ status: "final", usage: { state: "available" } });
 else if (tariff.reasoning.mode === "bounded") { expect(receipt).toMatchObject({ status: "awaiting_usage", usage: { state: "unavailable" } }); expect(receipt.amountMicros.value).toBe(held); }
 else { expect(receipt).toMatchObject({ status: "estimated", reason: "missing_usage", neverConfirmed: true, usage: { state: "unavailable" } }); expect(receipt.amountMicros.value).toBeGreaterThan(0); expect(receipt.amountMicros.value).toBeLessThan(held); }
});
