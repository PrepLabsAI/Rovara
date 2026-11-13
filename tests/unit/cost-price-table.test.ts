// What a model costs: the provider's own table first, then the catalog's list price; a model neither knows is unpriced, and unpriced is never free. The same lookup prices the usage the metering port records.
import { describe, expect, it } from "vitest";
import type { ModelProviderAdapter, ModelUsage } from "@rovara-code/contracts";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";
import { catalogPriceOf, costMicrosOf, createModelPrices, usdPerMillion, type CatalogPrices } from "../../packages/core/src/core/cost/price-table.js";
import { createPriceTableMetering } from "../../packages/core/src/ports/policy-defaults.js";

const provider = (kind: string, prices?: ModelProviderAdapter["prices"]): ModelProviderAdapter => ({
  kind, name: kind, address: "https://models.example.test/v1", signIn: { kind: "bearer-key" },
  formats: [{ format: "openai-completions", capabilities: { forcedToolChoice: true, parallelToolCalls: true, reasoning: "none", reasoningReturned: false, promptCaching: false, streamUsage: true } }],
  ...(prices === undefined ? {} : { prices }),
});
const LISTED: Record<string, CatalogPrices> = {
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "openrouter/some/free-model:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "openrouter/half/priced": { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const catalog = (model: { provider: string; modelId: string }): CatalogPrices | undefined => LISTED[`${model.provider}/${model.modelId}`];
const PRICE_LISTED: CatalogPrices = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 };
const usage = (tokens: Partial<ModelUsage["tokens"]>, provider_ = "anthropic", modelId = "claude-sonnet-4-5"): ModelUsage => ({ provider: provider_, modelId, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens } });

describe("the price table", () => {
  it("prices a model from the catalog in micros per million tokens, with the cache prices the catalog lists", () => {
    const found = createModelPrices({ providers: () => [], catalog }).find({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(found).toEqual({
      origin: "catalog", currency: "USD",
      price: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 3_750_000 },
    });
  });

  it("a provider's own table wins over the catalog, in its own currency, and a model its table lacks falls through to the catalog", () => {
    const own = provider("anthropic", { currency: "EUR", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 9_000_000 } } });
    const prices = createModelPrices({ providers: () => [own], catalog });
    expect(prices.find({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toEqual({ origin: "provider", currency: "EUR", price: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 9_000_000 } });
    expect(prices.find({ provider: "anthropic", modelId: "another-model" })).toBeUndefined();
    // Another provider's table does not price this provider's models.
    expect(createModelPrices({ providers: () => [provider("other-gateway", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } } })], catalog }).find({ provider: "anthropic", modelId: "claude-sonnet-4-5" })?.origin).toBe("catalog");
  });

  it("a catalog price of zero is a missing price, never a free model; only a provider's table may say a model is free", () => {
    const prices = createModelPrices({ providers: () => [], catalog });
    expect(catalogPriceOf(LISTED["openrouter/some/free-model:free"])).toBeUndefined();
    expect(prices.find({ provider: "anthropic", modelId: "claude-free:free" })).toBeUndefined();
    // One zero side is still no price: a budget would pass every call of the free half.
    expect(prices.find({ provider: "openrouter", modelId: "half/priced" })).toBeUndefined();
    expect(catalogPriceOf(undefined)).toBeUndefined();
    // A figure that rounds to nothing is no price.
    expect(catalogPriceOf({ input: 0.0000001, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(catalogPriceOf({ input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    const free = provider("local-llm", { currency: "USD", models: { tiny: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, free: true } } });
    expect(createModelPrices({ providers: () => [free], catalog }).find({ provider: "local-llm", modelId: "tiny" })?.price).toEqual({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  });

  it("an OpenRouter free variant is priced at exactly zero by a built-in rule, and only that; a catalog that lists it at a real price, or a plug-in's own price, wins", () => {
    const prices = createModelPrices({ providers: () => [], catalog });
    const free = prices.find({ provider: "openrouter", modelId: "some/free-model:free" });
    expect(free).toEqual({ price: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, currency: "USD", origin: "built-in" });
    expect(usdPerMillion(free)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(prices.findCap({ provider: "openrouter", modelId: "never/listed:free" })?.origin).toBe("built-in");
    // Not another aggregator's id, not a model that merely contains the word.
    expect(prices.find({ provider: "other-gateway", modelId: "x:free" })).toBeUndefined();
    expect(prices.find({ provider: "openrouter", modelId: "free-lunch" })).toBeUndefined();
    const dear = createModelPrices({ providers: () => [], catalog: () => PRICE_LISTED });
    expect(dear.find({ provider: "openrouter", modelId: "x:free" })?.origin).toBe("catalog");
    const own = provider("openrouter", { currency: "USD", models: { "x:free": { inputMicrosPerMillionTokens: 7, outputMicrosPerMillionTokens: 9 } } });
    expect(createModelPrices({ providers: () => [own] }).find({ provider: "openrouter", modelId: "x:free" })).toMatchObject({ origin: "provider", price: { inputMicrosPerMillionTokens: 7 } });
  });

  it("a cap never assumes less than the catalog's list price: the dearer of the plug-in's and the catalog's, by component; the recorded cost stays the plug-in's own", () => {
    // A slip (dollars where micros belong) would make the model cost almost nothing under a budget.
    const slip = provider("anthropic", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 15 } } });
    const prices = createModelPrices({ providers: () => [slip], catalog });
    expect(prices.find({ provider: "anthropic", modelId: "claude-sonnet-4-5" })?.price.inputMicrosPerMillionTokens).toBe(3);
    expect(prices.findCap({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toEqual({
      origin: "provider", currency: "USD",
      price: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000, cacheWriteMicrosPerMillionTokens: 3_750_000 },
    });
    // A plug-in that is dearer on one side keeps that side; its cache price counts at its input price when it lists none.
    const mixed = provider("anthropic", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 1_000_000 } } });
    expect(createModelPrices({ providers: () => [mixed], catalog }).findCap({ provider: "anthropic", modelId: "claude-sonnet-4-5" })?.price).toEqual({
      inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 4_000_000, cacheWriteMicrosPerMillionTokens: 4_000_000,
    });
    // A model the catalog does not price is the plug-in's word alone; another currency is not compared with dollars.
    const own = provider("gw", { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 5, outputMicrosPerMillionTokens: 6 } } });
    expect(createModelPrices({ providers: () => [own], catalog }).findCap({ provider: "gw", modelId: "m" })?.price.inputMicrosPerMillionTokens).toBe(5);
    const euro = provider("anthropic", { currency: "EUR", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } } });
    const eur = createModelPrices({ providers: () => [euro], catalog }).findCap({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(eur?.currency).toBe("EUR");
    expect(usdPerMillion(eur)).toBeUndefined();
  });

  it("a model the catalog prices is never free whatever a plug-in says, and the budget's price is the capped one while the recorded cost is the plug-in's", async () => {
    const lying = provider("anthropic", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, free: true } } });
    const prices = createModelPrices({ providers: () => [lying], catalog });
    expect(prices.find({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toMatchObject({ origin: "catalog", price: { inputMicrosPerMillionTokens: 3_000_000 } });
    const slip = provider("anthropic", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 15 } } });
    const metering = createPriceTableMetering({ currency: "USD", models: {} }, undefined, createModelPrices({ providers: () => [slip], catalog }));
    const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    // What a budget holds for a call is the capped price; what the call cost is the plug-in's own figure.
    expect(await metering.price({ provider: "anthropic", modelId: "claude-sonnet-4-5", tokens })).toEqual({ micros: 3_000_000, currency: "USD" });
    expect((await metering.record({ companyId: "c", entryId: "e", at: "2026-11-10T00:00:00.000Z", usage: { provider: "anthropic", modelId: "claude-sonnet-4-5", tokens } })).cost).toEqual({ micros: 3, currency: "USD" });
  });

  it("a zero price in a provider's table that is not declared free is no price, and the catalog is not asked in its place", () => {
    const zeroed = provider("anthropic", { currency: "USD", models: { "claude-sonnet-4-5": { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 5_000_000 } } });
    expect(createModelPrices({ providers: () => [zeroed], catalog }).find({ provider: "anthropic", modelId: "claude-sonnet-4-5" })).toBeUndefined();
  });

  it("without a catalog only the providers' tables price a model, and the providers are read at each lookup", () => {
    const rows: ModelProviderAdapter[] = [];
    const prices = createModelPrices({ providers: () => rows });
    expect(prices.find({ provider: "gw", modelId: "m" })).toBeUndefined();
    rows.push(provider("gw", { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 5, outputMicrosPerMillionTokens: 6 } } }));
    expect(prices.find({ provider: "gw", modelId: "m" })?.origin).toBe("provider");
  });

  it("counts tokens at the right prices: cache tokens at their own price, else at the input price, and shows dollars only for dollars", () => {
    const price = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000 };
    expect(costMicrosOf(price, { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 500_000 })).toBe(3_000_000 + 1_500_000 + 600_000 + 1_500_000);
    // With no cache price at all, cache tokens count at the input price in both directions.
    expect(costMicrosOf({ inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBe(6_000_000);
    const found = createModelPrices({ providers: () => [], catalog }).find({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(usdPerMillion(found)).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    // A catalog entry without cache prices counts cache tokens at the input price (it can over-count, never hide spend).
    const bare = catalogPriceOf({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 })!;
    expect(bare).toEqual({ inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 });
    expect(usdPerMillion({ price: bare, currency: "USD", origin: "catalog" })).toEqual({ input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
    expect(usdPerMillion({ price: bare, currency: "EUR", origin: "provider" })).toBeUndefined();
    expect(usdPerMillion(undefined)).toBeUndefined();
  });

  it("the metering port prices recorded usage from the layered table, and a model no table knows is recorded as unknown, never as free", async () => {
    const own = provider("gw", { currency: "USD", models: { m: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } });
    const metering = createPriceTableMetering({ currency: "USD", models: {} }, undefined, createModelPrices({ providers: () => [own], catalog }));
    expect(await metering.price(usage({ input: 1_000_000, output: 500_000 }))).toEqual({ micros: 3_000_000 + 7_500_000, currency: "USD" });
    expect(await metering.price(usage({ input: 1_000_000, output: 500_000 }, "gw", "m"))).toEqual({ micros: 2_000_000, currency: "USD" });
    expect(await metering.price(usage({ input: 1_000_000 }, "gw", "unlisted"))).toBeNull();
    const recorded = await metering.record({ companyId: "c", entryId: "e1", at: "2026-11-10T00:00:00.000Z", usage: usage({ input: 10 }, "gw", "unlisted") });
    expect(recorded).toEqual({ cost: null, source: "unknown" });
    // A table filled by hand still wins over the layered lookup.
    const fixed = createPriceTableMetering({ currency: "USD", models: { "gw/m": { inputMicrosPerMillionTokens: 10_000_000, outputMicrosPerMillionTokens: 10_000_000 } } }, undefined, createModelPrices({ providers: () => [own] }));
    expect(await fixed.price(usage({ input: 1_000_000 }, "gw", "m"))).toEqual({ micros: 10_000_000, currency: "USD" });
  });

  it("the installed catalog prices a model its maker lists, and does not price one it has never heard of", () => {
    const prices = createModelPrices({ providers: () => [], catalog: listPricesPerMillion });
    const listed = ["anthropic", "openai"].flatMap((name) => {
      const known = [{ provider: name, modelId: name === "anthropic" ? "claude-sonnet-4-5" : "gpt-5" }];
      return known.filter((model) => listPricesPerMillion(model) !== undefined);
    });
    expect(listed.length).toBeGreaterThan(0);
    for (const model of listed) {
      const found = prices.find(model)!;
      expect(found.origin).toBe("catalog");
      expect(found.price.inputMicrosPerMillionTokens).toBeGreaterThan(0);
      expect(found.price.outputMicrosPerMillionTokens).toBeGreaterThan(0);
    }
    expect(prices.find({ provider: "anthropic", modelId: "no-such-model-ever" })).toBeUndefined();
    expect(prices.find({ provider: "company-gateway", modelId: "house-model" })).toBeUndefined();
  });
});
