// The laptop's answers to the second review's seams: a model is served only from a provider that is signed in, and only with a catalog price (its spend cap is priced from it); the cap is sized from the model's rates.
import { describe, expect, it } from "vitest";
import type { ModelKeyStore } from "@rovara-code/contracts";
import { catalogModelIds, listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { SECOND_REVIEW_CAP_TYPICAL_REVIEWS, SECOND_REVIEW_CAP_WORST_CALLS, capUsdOf, createLocalSecondReviewSeams } from "../../packages/core/src/local/app/second-review.js";
import { ASSUMED_MAX_OUTPUT_TOKENS, builtinModelProviderBook } from "../../packages/core/src/local/model-proxy/proxy.js";
import { SONNET } from "../support/second-review-world.js";

const keys = (have: string[]): ModelKeyStore => ({ async get() { return undefined; }, async providers() { return have; } });
const seams = (have: string[], catalog?: (provider: string) => readonly string[]) => createLocalSecondReviewSeams({
  companyId: "org_00000000000000000000", providers: builtinModelProviderBook(), keys: keys(have), chosen: async () => ({ provider: "anthropic", model: SONNET.modelId }),
  projects: { latest: async () => undefined }, ...(catalog === undefined ? {} : { catalog }),
});

describe("the laptop's second-review seams", () => {
  const priced = catalogModelIds("openai").find((id) => listPricesPerMillion({ provider: "openai", modelId: id }) !== undefined);

  it("refuses a model with no catalog price (its cap could not be priced), and serves a priced one with a cap of its own", async () => {
    expect(priced).toBeDefined();
    const s = seams(["anthropic", "openai"]);
    expect(await s.route({ provider: "openai", modelId: "a-model-the-catalog-has-never-heard-of" }, "web")).toBeUndefined();
    const route = await s.route({ provider: "openai", modelId: priced! }, "web");
    expect(route).toMatchObject({ alias: `openai/${priced!}`, workerRoute: { alias: `openai/${priced!}` }, cap: { capUsd: expect.any(Number) as number } });
    expect(route!.cap!.usdPerMTok).toMatchObject({ input: expect.any(Number) as number, output: expect.any(Number) as number });
  });

  it("serves nothing from a provider that is not signed in", async () => {
    expect(await seams(["anthropic"]).route({ provider: "openai", modelId: priced! }, "web")).toBeUndefined();
    expect((await seams(["anthropic"], () => [priced!]).sources("web")).map((model) => model.provider)).not.toContain("openai");
  });

  it("sizes the cap from the model's rates: ten typical reviews, and never less than three of the most one call can be assumed to cost", () => {
    const cheap = { input: 0.1, output: 0.4 };
    const dear = { input: 15, output: 75 };
    for (const rates of [cheap, dear]) {
      const typical = (60_000 * rates.input + 4_000 * rates.output) / 1_000_000;
      const worstCall = (300_000 * rates.input + ASSUMED_MAX_OUTPUT_TOKENS * rates.output) / 1_000_000;
      expect(capUsdOf(rates)).toBeCloseTo(Math.max(SECOND_REVIEW_CAP_TYPICAL_REVIEWS * typical, SECOND_REVIEW_CAP_WORST_CALLS * worstCall), 8);
    }
    expect(capUsdOf(dear)).toBeGreaterThan(capUsdOf(cheap));
  });
});
