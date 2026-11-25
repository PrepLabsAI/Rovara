// PRICE-BANDS (money). A setup run's spend must not be counted at the pooled maximum over every long-context band when no call reached that band. The signed run price stays pooled (the gateway's ceiling,
// unchanged for old workers); the quote ADDS the base band beside it, the signed task token carries it inside `runPrice.baseBand`, and the gateway refuses a call whose real rates no longer fit it.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE, type RateQuoteOptions } from "../../packages/model-gateway/src/rate-quote.js";
import { parseRunPrice, parseTaskClaims, type RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";
import { runPriceDenial } from "../../packages/model-gateway/src/run-price.js";
import { resolvePrice } from "../../packages/model-gateway/src/price.js";
import type { PriceEntry } from "../../packages/model-gateway/src/price-snapshot.js";
import { claims, mint, verifier, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const model = "claude-haiku-4-5";
const bedrock = "zai.glm-5";
/** glm-5 on Bedrock: $1.00 in / $3.20 out / cache read $0.20 / write $1.25, and a 2x band above 200K input tokens per call. */
const GLM = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_200_000, cacheReadMicrosPerMTok: 200_000, cacheWrite5mMicrosPerMTok: 1_250_000, cacheWrite1hMicrosPerMTok: 1_250_000 };
const LONG = { aboveTokens: 200_000, inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 6_400_000, cacheReadMicrosPerMTok: 400_000, cacheWrite5mMicrosPerMTok: 2_500_000, cacheWrite1hMicrosPerMTok: 2_500_000 };
async function world(entry: Record<string, unknown> = { ...GLM, longContext: [LONG] }) {
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: bedrock, kind: "chat", ...entry } as PriceEntry] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const options: RateQuoteOptions = { prices, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }), now: () => now,
    sources: { sourceFor: async () => "rovara" }, keys: { connected: async () => true, identityFor: async () => ({ sourceId: "company", versionId: "r1" }) },
    rovara: { sourceId: "operator-source", models: new Map([[model, bedrock]]), exempt: new Set() }, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]) };
  return options;
}
const quote = (options: RateQuoteOptions, query = "&runPrice=1") => answerRateQuote(options, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${model}${query}`, headers: { authorization: "Bearer fixture" } });
type Body = { runPrice: RunPrice; runPriceBaseBand?: Record<string, number> };

describe("the quote carries the base band beside the pooled price", () => {
  it("glm-5: the pooled fields stay at 2x and the base band holds the real base rates and its threshold", async () => {
    const body = (await quote(await world())).body as Body;
    expect(body.runPrice).toMatchObject({ inputUsdPerMillion: 2, outputUsdPerMillion: 6.4, cacheWriteUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.4 });
    expect(body.runPriceBaseBand).toEqual({ upToInputTokens: 200_000, inputUsdPerMillion: 1, outputUsdPerMillion: 3.2, cacheWriteUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.2 });
    // The pooled object keeps EXACTLY its old shape (an old Code worker parses it strictly).
    expect(Object.keys(body.runPrice)).toHaveLength(13);
    expect(body.runPrice).not.toHaveProperty("baseBand");
  });
  it("the base band applies up to the LOWEST threshold when a model has several bands", async () => {
    const w = await world({ ...GLM, longContext: [{ aboveTokens: 32_000, inputMicrosPerMTok: 1_500_000, outputMicrosPerMTok: 4_000_000 }, LONG] });
    const body = (await quote(w)).body as Body;
    expect(body.runPriceBaseBand).toMatchObject({ upToInputTokens: 32_000, inputUsdPerMillion: 1, outputUsdPerMillion: 3.2 });
    expect(body.runPrice.inputUsdPerMillion).toBe(2);
  });
  it("a model whose source states no long band is still pooled at the cautious unknown-long band (2x above 200K): the base band separates that too, so the same 2x over-count is gone", async () => {
    const body = (await quote(await world({ ...GLM }))).body as Body;
    expect(body.runPrice.inputUsdPerMillion).toBe(2);
    expect(body.runPriceBaseBand).toEqual({ upToInputTokens: 200_000, inputUsdPerMillion: 1, outputUsdPerMillion: 3.2, cacheWriteUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.2 });
  });
  it("the band's cache write is the dearer of the base 5 minute and 1 hour writes, as the pooled field is", async () => {
    const w = await world({ ...GLM, cacheWrite1hMicrosPerMTok: 2_000_000, longContext: [{ ...LONG, cacheWrite1hMicrosPerMTok: 4_000_000 }] });
    const body = (await quote(w)).body as Body;
    expect(body.runPriceBaseBand).toMatchObject({ cacheWriteUsdPerMillion: 2 });
    expect(body.runPrice.cacheWriteUsdPerMillion).toBe(4);
  });
  it("no base band without the runPrice request or when the price is unavailable", async () => {
    expect(await quote(await world(), "")).toMatchObject({ body: { state: "available" } });
    expect((await quote(await world(), "")).body).not.toHaveProperty("runPriceBaseBand");
  });
});

const POOLED: RunPrice = { companyId: claims.cid, model, provider: "bedrock", sourceId: "operator-source", connectionRevision: "r1", catalogModel: bedrock, snapshotHash: "a".repeat(64), snapshotVersion: 9, expiresAt: now + 60_000,
  inputUsdPerMillion: 2, outputUsdPerMillion: 6.4, cacheWriteUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.4 };
const BAND = { upToInputTokens: 200_000, inputUsdPerMillion: 1, outputUsdPerMillion: 3.2, cacheWriteUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.2 };

describe("the signed task token carries the base band", () => {
  it("an old 13-field run price and a new 14-field one both parse (compatible both ways)", () => {
    expect(parseRunPrice(POOLED)).toBeDefined();
    expect(parseRunPrice({ ...POOLED, baseBand: BAND })).toEqual({ ...POOLED, baseBand: BAND });
    expect(parseTaskClaims({ ...claims, mdl: [model], runPrice: { ...POOLED, baseBand: BAND } })).toBeDefined();
  });
  it("refuses a base band that is not strictly inside the pooled ceiling, malformed, or with extra keys", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...BAND, inputUsdPerMillion: 2.01 }, { ...BAND, outputUsdPerMillion: 6.41 }, { ...BAND, cacheWriteUsdPerMillion: 2.51 }, { ...BAND, cacheReadUsdPerMillion: 0.41 },
      { ...BAND, upToInputTokens: 0 }, { ...BAND, upToInputTokens: 1.5 }, { ...BAND, upToInputTokens: "200000" }, { ...BAND, inputUsdPerMillion: 0 }, { ...BAND, inputUsdPerMillion: Number.NaN },
      { ...BAND, extra: 1 }, { ...BAND, cacheReadUsdPerMillion: -1 },
    ];
    for (const band of bad) expect(parseRunPrice({ ...POOLED, baseBand: band }), JSON.stringify(band)).toBeUndefined();
    const { upToInputTokens: _drop, ...missing } = BAND; void _drop;
    expect(parseRunPrice({ ...POOLED, baseBand: missing })).toBeUndefined();
    expect(parseRunPrice({ ...POOLED, baseBand: null })).toBeUndefined();
    expect(parseRunPrice({ ...POOLED, extraRate: 1 })).toBeUndefined();
  });
  it("the signature covers the base band: a tampered base rate (signed token, payload edited afterwards) is rejected", async () => {
    const token = mint({ mdl: [model], runPrice: { ...POOLED, baseBand: BAND } });
    expect(await verifier()(token)).toMatchObject({ runPrice: { baseBand: BAND } });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString()) as { runPrice: { baseBand: { inputUsdPerMillion: number } } };
    edited.runPrice.baseBand.inputUsdPerMillion = 0.5;
    const tampered = `${header}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
    expect(await verifier()(tampered)).toBeUndefined();
    // And a band that is not inside the ceiling is refused even with a valid signature.
    expect(await verifier()(mint({ mdl: [model], runPrice: { ...POOLED, baseBand: { ...BAND, inputUsdPerMillion: 5 } } }))).toBeUndefined();
  });
});

describe("the gateway refuses a call whose real rates no longer fit the signed base band", () => {
  const claimsWith = (baseBand: unknown) => ({ ...claims, mdl: [model], runPrice: { ...POOLED, baseBand } } as unknown as Parameters<typeof runPriceDenial>[0]);
  const source = { source: { provider: "bedrock", id: "operator-source", connectionRevision: "r1" } } as unknown as Parameters<typeof runPriceDenial>[3];
  async function denial(entry: Record<string, unknown>, baseBand: unknown) {
    const w = await world(entry);
    const price = await resolvePrice(w.prices, "bedrock", bedrock);
    return runPriceDenial(claimsWith(baseBand), "bedrock", bedrock, source, { ...price, priceVersion: 9 }, now);
  }
  it("fits: the real base equals the band, the real threshold equals its limit", async () => {
    expect(await denial({ ...GLM, longContext: [LONG] }, BAND)).toBeUndefined();
  });
  it("a real base rate above the signed one is refused (the worker would under-count)", async () => {
    expect(await denial({ ...GLM, inputMicrosPerMTok: 1_100_000, longContext: [LONG] }, BAND)).toBe("rate_above_ceiling");
    expect(await denial({ ...GLM, outputMicrosPerMTok: 3_300_000, longContext: [LONG] }, BAND)).toBe("rate_above_ceiling");
  });
  it("a real cache read or cache write rate above the signed one is refused too", async () => {
    expect(await denial({ ...GLM, cacheReadMicrosPerMTok: 250_000, longContext: [LONG] }, BAND)).toBe("rate_above_ceiling");
    expect(await denial({ ...GLM, cacheWrite1hMicrosPerMTok: 1_300_000, longContext: [LONG] }, BAND)).toBe("rate_above_ceiling");
  });
  it("a long band that now starts BELOW the signed limit is refused (calls between would be charged long but counted base)", async () => {
    expect(await denial({ ...GLM, longContext: [{ ...LONG, aboveTokens: 128_000 }] }, BAND)).toBe("rate_above_ceiling");
  });
  it("REVIEW (Opus): the boundary: a signed limit one token past the real long band's start is refused; at the start it fits", async () => {
    // A call of exactly 200,001 input tokens is settled at the long band (tokens > aboveTokens); a worker trusting a limit of 200,001 would count it at the base band.
    expect(await denial({ ...GLM, longContext: [LONG] }, { ...BAND, upToInputTokens: 200_001 })).toBe("rate_above_ceiling");
    expect(await denial({ ...GLM, longContext: [LONG] }, { ...BAND, upToInputTokens: 200_000 })).toBeUndefined();
  });
  it("a token without a base band is judged exactly as before", async () => {
    expect(await denial({ ...GLM, longContext: [LONG] }, undefined)).toBeUndefined();
  });
});
