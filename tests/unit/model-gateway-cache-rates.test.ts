// CACHE-RATES (money). Staging 2026-11-23, Code 0.5.47: a setup run on Bedrock Haiku 4.5 (tokens in 349 / out 6,121 / cache read 266,037 / cache write 15,952) was SHOWN 73 cents and booked $0.72 while the gateway
// settled about $0.098 (7.4x). The signed run price DOES carry cache rates, but they are the POOLED maxima over the base band and the cautious unknown-long band (2x above 200K): cache read $2.20 against a real
// $0.11. The cure is the signed BASE band of PRICE-BANDS, which carries the real cache read and cache write rates, and the gateway refuses a call whose real cache rates exceed it. These tests run the exact run, end to
// end through the real functions: the quote, the signed task token, the gateway's per-call settle (`settleChargeAmount`); the worker's count is the band's rates, rounded up per call as the gateway rounds. The same
// figures are pinned in Code `tests/unit/cache-rates-spend.test.ts`.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE, type RateQuoteOptions } from "../../packages/model-gateway/src/rate-quote.js";
import { parseTaskClaims, type RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { runPriceDenial } from "../../packages/model-gateway/src/run-price.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import { settleChargeAmount } from "../../packages/model-gateway/src/reported-cost.js";
import type { TokenUsage } from "../../packages/model-gateway/src/usage.js";
import type { PriceEntry } from "../../packages/model-gateway/src/price-snapshot.js";
import { claims, mint, verifier, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const model = "claude-haiku-4-5";
const bedrock = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
/** Haiku 4.5 on Bedrock as the staging settle shows it (the regional profile's 1.1x): $1.10 in / $5.50 out / cache read $0.11 / write $1.375 (5 minutes) and $2.20 (1 hour). No long band stated. */
const HAIKU = { inputMicrosPerMTok: 1_100_000, outputMicrosPerMTok: 5_500_000, cacheReadMicrosPerMTok: 110_000, cacheWrite5mMicrosPerMTok: 1_375_000, cacheWrite1hMicrosPerMTok: 2_200_000 };
async function world(entry: Record<string, unknown> = HAIKU) {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: bedrock, kind: "chat", ...entry } as PriceEntry] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const options: RateQuoteOptions = { prices, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }), now: () => now,
    sources: { sourceFor: async () => "rovara" }, keys: { connected: async () => true, identityFor: async () => ({ sourceId: "company", versionId: "r1" }) },
    rovara: { sourceId: "operator-source", models: new Map([[model, bedrock]]), exempt: new Set() }, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]) };
  return options;
}
type Body = { runPrice: RunPrice; runPriceBaseBand: { upToInputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number; cacheWriteUsdPerMillion: number; cacheReadUsdPerMillion: number } };
const quote = async (options: RateQuoteOptions) => (await answerRateQuote(options, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}&runPrice=1`, headers: { authorization: "Bearer fixture" } })).body as Body;

/** The staging run: 15 calls, each one under 200K input, summing to the run's totals EXACTLY (deterministic split, every call has all four classes). */
const TOTAL = { input: 349, output: 6_121, cacheRead: 266_037, cacheWrite: 15_952 };
const CALLS = 15;
function split(total: number, seed: number, calls = CALLS): number[] {
  let state = seed;
  const weights = Array.from({ length: calls }, () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return 1 + state / 4_294_967_296; });
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[calls - 1]! += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}
function stagingCalls(calls = CALLS, seed = 0): TokenUsage[] {
  const input = split(TOTAL.input, 1 + seed, calls), output = split(TOTAL.output, 2 + seed, calls), read = split(TOTAL.cacheRead, 3 + seed, calls), write = split(TOTAL.cacheWrite, 4 + seed, calls);
  return input.map((_, i) => ({ input: input[i]!, output: output[i]!, cacheRead: read[i]!, cacheWrite: write[i]!, cacheWrite5m: 0, cacheWrite1h: write[i]! }));
}
/** The worker's count of one call: every class at the signed band's rate, rounded UP to a whole micro as the gateway rounds a call. */
const workerMicros = (band: Body["runPriceBaseBand"], u: TokenUsage): number => {
  const per = (usd: number) => BigInt(Math.round(usd * 1_000_000));
  const numerator = BigInt(u.input) * per(band.inputUsdPerMillion) + BigInt(u.output) * per(band.outputUsdPerMillion) + BigInt(u.cacheRead) * per(band.cacheReadUsdPerMillion) + BigInt(u.cacheWrite) * per(band.cacheWriteUsdPerMillion);
  return Number((numerator + 999_999n) / 1_000_000n);
};

describe("the staging Haiku 4.5 run, end to end through the real gateway functions", () => {
  it("the quote states the REAL cache rates in the signed base band; the pooled ones are the cautious long-band maxima", async () => {
    const body = await quote(await world());
    expect(body.runPriceBaseBand).toEqual({ upToInputTokens: 200_000, inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5, cacheWriteUsdPerMillion: 2.2, cacheReadUsdPerMillion: 0.11 });
    expect(body.runPrice).toMatchObject({ inputUsdPerMillion: 2.2, outputUsdPerMillion: 11, cacheWriteUsdPerMillion: 4.4, cacheReadUsdPerMillion: 2.2 });
  });
  it("the signed token carries the band, the gateway admits the real price against it, and the run counts about $0.098 and NEVER below what the gateway settles", async () => {
    const w = await world();
    const body = await quote(w);
    const token = mint({ mdl: [model], runPrice: { ...body.runPrice, baseBand: body.runPriceBaseBand } });
    const signed = (await verifier()(token))!;
    expect(signed.runPrice?.baseBand).toEqual(body.runPriceBaseBand);
    expect(parseTaskClaims(signed)).toBeDefined();
    const price = { ...(await resolvePrice(w.prices, "bedrock", bedrock)), priceVersion: 9 };
    const source = { source: { provider: "bedrock", id: "operator-source", connectionRevision: body.runPrice.connectionRevision } } as unknown as Parameters<typeof runPriceDenial>[3];
    expect(runPriceDenial(signed, "bedrock", bedrock, source, price, now)).toBeUndefined();

    let gateway = 0, band = 0, pooled = 0;
    for (const usage of stagingCalls()) {
      expect(usage.input + usage.cacheRead + usage.cacheWrite).toBeLessThanOrEqual(200_000);
      const settled = settleChargeAmount({ usage, price, reservationMicros: 0 }).actualMicros;
      expect(workerMicros(body.runPriceBaseBand, usage), JSON.stringify(usage)).toBeGreaterThanOrEqual(settled);
      gateway += settled; band += workerMicros(body.runPriceBaseBand, usage);
      pooled += workerMicros({ upToInputTokens: 0, inputUsdPerMillion: body.runPrice.inputUsdPerMillion, outputUsdPerMillion: body.runPrice.outputUsdPerMillion, cacheWriteUsdPerMillion: body.runPrice.cacheWriteUsdPerMillion, cacheReadUsdPerMillion: body.runPrice.cacheReadUsdPerMillion }, usage);
    }
    // The gateway's settle of this split of the run (15 calls, 1h writes, each call rounded up to a micro): pinned; the exact figure is 98,407.9 micros, so staging's 98,422 is the same run with its own call split.
    // The band's count equals the settle call by call (the band IS the real base rates and the worker rounds as the gateway does).
    expect(gateway).toBe(98_416);
    expect(band).toBe(gateway);
    expect(band / 1_000_000).toBeGreaterThan(0.08); expect(band / 1_000_000).toBeLessThan(0.1);
    // Without the band the same run is counted at the pooled maxima: the 7.4x of staging (72 cents).
    expect(pooled / gateway).toBeGreaterThan(7);
  });
  it("property: whatever the call split (10 to 40 calls, 20 seeds), the band's count is never below the gateway's settle, call by call and in total, and never above it by more than a micro a call", async () => {
    const w = await world();
    const body = await quote(w);
    const price = { ...(await resolvePrice(w.prices, "bedrock", bedrock)), priceVersion: 9 };
    for (let seed = 0; seed < 20; seed += 1) for (const calls of [10, 15, 25, 40]) {
      let gateway = 0, band = 0;
      for (const usage of stagingCalls(calls, seed)) {
        const settled = settleChargeAmount({ usage, price, reservationMicros: 0 }).actualMicros;
        expect(workerMicros(body.runPriceBaseBand, usage)).toBeGreaterThanOrEqual(settled);
        gateway += settled; band += workerMicros(body.runPriceBaseBand, usage);
      }
      expect(band).toBeGreaterThanOrEqual(gateway); expect(band - gateway).toBeLessThanOrEqual(calls);
      expect(gateway).toBeGreaterThanOrEqual(98_408); expect(gateway).toBeLessThanOrEqual(98_408 + calls);
    }
  });
  it("the gateway refuses a call whose REAL cache read or cache write rate is above the signed one (the count would be under the settle)", async () => {
    const body = await quote(await world());
    const signedClaims = { ...claims, mdl: [model], runPrice: { ...body.runPrice, baseBand: body.runPriceBaseBand } } as unknown as Parameters<typeof runPriceDenial>[0];
    const source = { source: { provider: "bedrock", id: "operator-source", connectionRevision: body.runPrice.connectionRevision } } as unknown as Parameters<typeof runPriceDenial>[3];
    const denial = async (entry: Record<string, unknown>) => runPriceDenial(signedClaims, "bedrock", bedrock, source, { ...(await resolvePrice((await world(entry)).prices, "bedrock", bedrock)), priceVersion: 9 }, now);
    expect(await denial(HAIKU)).toBeUndefined();
    expect(await denial({ ...HAIKU, cacheReadMicrosPerMTok: 120_000 })).toBe("rate_above_ceiling");
    expect(await denial({ ...HAIKU, cacheWrite1hMicrosPerMTok: 2_300_000 })).toBe("rate_above_ceiling");
    expect(await denial({ ...HAIKU, cacheWrite5mMicrosPerMTok: 2_300_000 })).toBe("rate_above_ceiling");
  });
  it("a price source that states NO cache rates quotes the gateway's own fallback in the band (read at the input rate, write at 2x): the count is still the settle", async () => {
    const w = await world({ inputMicrosPerMTok: 1_100_000, outputMicrosPerMTok: 5_500_000 });
    const body = await quote(w);
    expect(body.runPriceBaseBand).toMatchObject({ cacheReadUsdPerMillion: 1.1, cacheWriteUsdPerMillion: 2.2 });
    const price = { ...(await resolvePrice(w.prices, "bedrock", bedrock)), priceVersion: 9 };
    for (const usage of stagingCalls()) expect(workerMicros(body.runPriceBaseBand, usage)).toBeGreaterThanOrEqual(settleChargeAmount({ usage, price, reservationMicros: 0 }).actualMicros);
  });
});
