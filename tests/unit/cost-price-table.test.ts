// What a model costs: the provider's own table first, then the catalog's list price; a model neither knows is unpriced, and unpriced is never free. The same lookup prices the usage the metering port records.
import { describe, expect, it } from "vitest";
import type { ModelProviderAdapter } from "@agentx/contracts";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";
import { catalogPriceOf, createModelPrices, type CatalogPrices } from "../../packages/broker/src/core/cost/price-table.js";
import { createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";

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

describe("the price table", () => {

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
