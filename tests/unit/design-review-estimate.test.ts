// Design review stage: the estimate, the cost gate and the spend card source. Money, so every edge is pinned: the estimate equals the second-review picker's
// own function for one reviewer, "Cost unavailable" is never a number, a gate never runs on its own, and the card's choices are the ones the rules allow.
import { describe, expect, it } from "vitest";
import { DecisionCardSchema, type ModelIdentifier } from "@rovara-code/contracts";
import * as estimateModule from "../../packages/core/src/core/design-review/estimate.js";
import { PLANNER_REVISION_TOKENS, MERGE_TOKENS, REVIEWER_CACHE_READ_SHARE, ROLE_INPUT_FLOOR_TOKENS, ROLE_INPUT_TURN_FACTOR, ROLE_OUTPUT_TOKENS, estimateReviewerUsd, routeCaches, plannerRunsFor, estimateDesignReviewUsd as estimateWithPacket, designReviewKeyBudgets, gateDesignReviewCost, nextLowerTier, recordedReviewerCost, reviewersForRound, TIER_REVIEWERS, type DesignReviewEstimate, type DesignReviewEstimateInput, type PriceLookup } from "../../packages/core/src/core/design-review/estimate.js";
import { designSpendCardItem, designSpendChoicePath } from "../../packages/core/src/core/design-review/spend-card.js";
import { cardOfItem } from "../../packages/core/src/core/decisions/project.js";
import { estimateSecondReviewUsd } from "../../packages/core/src/core/design-review/estimate.js";

const STRONG: ModelIdentifier = { provider: "anthropic", modelId: "strong-model" };
const FAST: ModelIdentifier = { provider: "anthropic", modelId: "fast-model" };
const PLANNER: ModelIdentifier = { provider: "openai", modelId: "planner-model" };
const PRICES: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok?: number }> = {
  "strong-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "fast-model": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  "planner-model": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};
const price: PriceLookup = (model) => PRICES[model.modelId];
const models = { reviewer: STRONG, merge: FAST, planner: PLANNER };
/** The packet size is required (M4); most tests use the first real round's packet, 9,021 tokens . */
const PACKET = 9_021;
const estimateDesignReviewUsd = (input: Omit<DesignReviewEstimateInput, "packetTokens"> & { packetTokens?: number }): DesignReviewEstimate => estimateWithPacket({ packetTokens: PACKET, ...input });
const priced = (estimate: DesignReviewEstimate) => { if (estimate.kind !== "priced") throw new Error("expected a price"); return estimate; };

describe("the estimate", () => {
  it("matches estimateSecondReviewUsd for one reviewer: Light is one reviewer, no merge model, two rounds", () => {
    const estimate = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    // The one reviewer (Critic) searches with tools, so its input is the packet times its turn factor (M4), and never less than its floor.
    const one = estimateSecondReviewUsd(PRICES["strong-model"]!, { input: Math.max(PACKET * ROLE_INPUT_TURN_FACTOR.critic, ROLE_INPUT_FLOOR_TOKENS.critic), maxOutput: ROLE_OUTPUT_TOKENS.critic });
    // 9,021 x 23 = 207,483 turns at $3 plus 20k out at $15, by hand (this price has no cache-read price, so all input is full price).
    expect(one).toBeCloseTo(0.622449 + 0.3, 6);
    expect(estimate.reviewers).toBe(1);
    expect(estimate.breakdown.reviewersUsd).toBeCloseTo(one * 2, 6);
    // Light merges in code: nothing is priced for the merge.
    expect(estimate.breakdown.mergeUsd).toBe(0);
    // 3 planner runs for 2 rounds (round 1 asks then resolves; the last round does not ask).
    expect(estimate.breakdown.plannerUsd).toBeCloseTo(estimateSecondReviewUsd(PRICES["planner-model"]!, { input: PLANNER_REVISION_TOKENS.input, maxOutput: PLANNER_REVISION_TOKENS.output }) * 3, 6);
    expect(estimate.usd).toBeCloseTo(estimate.breakdown.reviewersUsd + estimate.breakdown.plannerUsd, 6);
  });

  it("prices every reviewer of the tier in every round, plus the merge model and a planner revision per round", () => {
    const standard = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
    expect(standard.reviewers).toBe(3);
    expect(TIER_REVIEWERS.standard).toEqual(["comprehension", "critic", "codebase"]);
    const reviewerUsd = (role: keyof typeof ROLE_INPUT_TURN_FACTOR) => estimateSecondReviewUsd(PRICES["strong-model"]!, { input: Math.max(PACKET * ROLE_INPUT_TURN_FACTOR[role], ROLE_INPUT_FLOOR_TOKENS[role]), maxOutput: ROLE_OUTPUT_TOKENS[role] });
    expect(standard.breakdown.reviewersUsd).toBeCloseTo((reviewerUsd("comprehension") + reviewerUsd("critic") + reviewerUsd("codebase")) * 2, 6);
    const merge = estimateSecondReviewUsd(PRICES["fast-model"]!, { input: MERGE_TOKENS.designInput + MERGE_TOKENS.perReviewerInput * 3, maxOutput: MERGE_TOKENS.output }) * 2;
    expect(standard.breakdown.mergeUsd).toBeCloseTo(merge, 6);
    const thorough = priced(estimateDesignReviewUsd({ tier: "thorough", models, price }));
    expect(thorough.reviewers).toBe(5);
    // Dearer tiers cost more; the estimate is monotone in the tier.
    const light = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    expect(light.usd).toBeLessThan(standard.usd);
    expect(standard.usd).toBeLessThan(thorough.usd);
    // One round costs less than two.
    expect(priced(estimateDesignReviewUsd({ tier: "standard", models, price, rounds: 1 })).usd).toBeLessThan(standard.usd);
  });

  it("uses the packet size the broker built, and a size that is not a usable number is Cost unavailable, never a default (M4)", () => {
    const small = priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 1_000 }));
    const typical = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    const big = priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 200_000 }));
    expect(small.breakdown.reviewersUsd).toBeLessThan(typical.breakdown.reviewersUsd);
    expect(big.breakdown.reviewersUsd).toBeGreaterThan(typical.breakdown.reviewersUsd);
    // N8: a packet with no tokens prices a review with no input; it is "cost unavailable", never a cheap price.
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, 0]) {
      expect(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: bad })).toEqual({ kind: "unavailable", tier: "light", missing: ["packet"] });
    }
    expect(priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 1 })).breakdown.reviewersUsd).toBeGreaterThan(0);
  });

  it("M4: tool-using reviewers re-send the context every turn, so the estimate is a multiple of the packet for them (named factors measured from the first real round; Comprehension never reads the repository)", () => {
    expect(ROLE_INPUT_TURN_FACTOR).toEqual({ comprehension: 5, critic: 23, codebase: 32, zoom_out: 23, critic_b: 23 });
    expect(ROLE_INPUT_FLOOR_TOKENS).toEqual({ comprehension: 43_000, critic: 207_000, codebase: 288_000, zoom_out: 207_000, critic_b: 207_000 });
    expect(ROLE_OUTPUT_TOKENS).toEqual({ comprehension: 17_000, critic: 20_000, codebase: 9_000, zoom_out: 20_000, critic_b: 20_000 });
    const free: PriceLookup = () => ({ inputUsdPerMTok: 1, outputUsdPerMTok: 0 });
    const cost = (tier: "standard" | "thorough") => priced(estimateDesignReviewUsd({ tier, models: { reviewer: STRONG, planner: PLANNER }, price: free, packetTokens: 1_000_000, rounds: 1 })).breakdown.reviewersUsd;
    // 5 + 23 + 32 packets of 1M tokens at $1 per million, one round.
    expect(cost("standard")).toBeCloseTo(60, 6);
    // Thorough adds Zoom-out (23) and Critic B (23).
    expect(cost("thorough")).toBeCloseTo(106, 6);
  });

  it("a small packet does not shrink what the repository readers take in: input is at least the role's floor", () => {
    const free: PriceLookup = () => ({ inputUsdPerMTok: 1, outputUsdPerMTok: 0 });
    const cost = (tier: "light" | "standard" | "thorough", packetTokens: number) => priced(estimateDesignReviewUsd({ tier, models: { reviewer: STRONG, planner: PLANNER }, price: free, packetTokens, rounds: 1 })).breakdown.reviewersUsd;
    // A 100-token packet: every role is at its floor (43k + 207k + 288k tokens at $1 per million).
    expect(cost("standard", 100)).toBeCloseTo(0.538, 6);
    expect(cost("light", 100)).toBeCloseTo(0.207, 6);
    // Zoom-out and Critic B use the Critic's floor: Thorough adds two of them.
    expect(cost("thorough", 100)).toBeCloseTo(0.538 + 0.207 * 2, 6);
    // A packet big enough that its multiple passes the floor is priced by the multiple.
    expect(cost("light", 100_000)).toBeCloseTo(2.3, 6);
  });

  it("the cache share is applied to input only, only on a route known to cache, and only for a cache-read price above 0 ", () => {
    const withCache = { inputUsdPerMTok: 2, outputUsdPerMTok: 0, cacheReadUsdPerMTok: 0.2 };
    const share = REVIEWER_CACHE_READ_SHARE;
    expect(share).toBe(0.5);
    const mtok = 1_000_000 / 32;
    // Input only: the cached share at the cache-read price, the rest at the full price.
    expect(estimateReviewerUsd(withCache, "codebase", mtok * 2, true)).toBeCloseTo(2 * (2 * (1 - share) + 0.2 * share), 6);
    // The role's own output is added at the output price, undiscounted.
    expect(estimateReviewerUsd({ ...withCache, outputUsdPerMTok: 10 }, "comprehension", 1_000_000 / 5, true)).toBeCloseTo(2 * (1 - share) + 0.2 * share + (ROLE_OUTPUT_TOKENS.comprehension * 10) / 1_000_000, 6);
    // The route does not cache: full input price, no discount.
    expect(estimateReviewerUsd(withCache, "codebase", mtok * 2, false)).toBeCloseTo(2 * 2, 6);
    // No cache-read price: full input price.
    expect(estimateReviewerUsd({ inputUsdPerMTok: 2, outputUsdPerMTok: 0 }, "codebase", mtok * 2, true)).toBeCloseTo(2 * 2, 6);
    // A cache-write price dearer than input prices the uncached share (the cost of writing what was not cached); a cheaper one never lowers it below the input price.
    expect(estimateReviewerUsd({ ...withCache, cacheWriteUsdPerMTok: 2.5 }, "codebase", mtok * 2, true)).toBeCloseTo(2 * (2.5 * (1 - share) + 0.2 * share), 6);
    expect(estimateReviewerUsd({ ...withCache, cacheWriteUsdPerMTok: 1 }, "codebase", mtok * 2, true)).toBeCloseTo(2 * (2 * (1 - share) + 0.2 * share), 6);
    // A cache price that is not a usable number is not trusted: the model is priced at the full input price. A cache-read price of 0 is "no cache price", not "cache reads are free".
    const bedrock: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" };
    const run = (cache: number) => priced(estimateDesignReviewUsd({ tier: "light", models: { reviewer: bedrock, planner: PLANNER }, price: () => ({ inputUsdPerMTok: 2, outputUsdPerMTok: 0, cacheReadUsdPerMTok: cache }), packetTokens: 1_000_000, rounds: 1, reviewerCaches: true })).breakdown.reviewersUsd;
    expect(run(Number.NaN)).toBeCloseTo(23 * 2, 6);
    expect(run(-1)).toBeCloseTo(23 * 2, 6);
    expect(run(0)).toBeCloseTo(23 * 2, 6);
    expect(run(0.2)).toBeCloseTo(23 * (2 * (1 - share) + 0.2 * share), 6);
  });

  it("only Claude on Amazon Bedrock is known to cache; every other route is priced at full input", () => {
    expect(routeCaches({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" })).toBe(true);
    expect(routeCaches({ provider: "amazon-bedrock", modelId: "anthropic.claude-sonnet-4-6" })).toBe(true);
    expect(routeCaches({ provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" })).toBe(false);
    expect(routeCaches({ provider: "anthropic", modelId: "claude-haiku-4-5" })).toBe(false);
    expect(routeCaches({ provider: "openai", modelId: "gpt-5" })).toBe(false);
    const price = () => ({ inputUsdPerMTok: 2, outputUsdPerMTok: 0, cacheReadUsdPerMTok: 0.2 });
    const run = (reviewer: ModelIdentifier, ...flag: [boolean | undefined] | []) => priced(estimateDesignReviewUsd({ tier: "light", models: { reviewer, planner: PLANNER }, price, packetTokens: 1_000_000, rounds: 1, reviewerCaches: flag.length === 0 ? true : flag[0] })).breakdown.reviewersUsd;
    expect(run({ provider: "anthropic", modelId: "claude-haiku-4-5" })).toBeCloseTo(23 * 2, 6);
    expect(run({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" })).toBeLessThan(23 * 2);
    // The SOURCE matters too: a customer's own Bedrock account has the same model ids and was never measured, and an unknown source is not assumed to cache.
    const bedrock: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" };
    expect(run(bedrock, false)).toBeCloseTo(23 * 2, 6);
    expect(run(bedrock, undefined)).toBeCloseTo(23 * 2, 6);
  });

  it("replays the first real round (one recorded round, haiku-4-5 standard, packet 9,021 tokens): every reviewer's estimate is at or above what it cost, and the total is above $0.444 but within 1.6x", () => {
    // The catalog's price for this model on Bedrock: $1.1 in, $5.5 out, $0.11 cache read, $1.375 cache write.
    const haiku: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" };
    const listed: PriceLookup = () => ({ inputUsdPerMTok: 1.1, outputUsdPerMTok: 5.5, cacheReadUsdPerMTok: 0.11, cacheWriteUsdPerMTok: 1.375 });
    const one = priced(estimateDesignReviewUsd({ tier: "standard", models: { reviewer: haiku, merge: haiku, planner: haiku }, price: listed, packetTokens: 9_021, rounds: 1, reviewerCaches: true }));
    expect(one.reviewers).toBe(3);
    const measured = 0.444;
    expect(one.breakdown.reviewersUsd).toBeGreaterThanOrEqual(measured);
    expect(one.breakdown.reviewersUsd).toBeLessThanOrEqual(measured * 1.6);
    // Each reviewer on its own: 0.1214 / 0.1908 / 0.1321.
    const roles = { comprehension: 0.1214, critic: 0.1908, codebase: 0.1321 } as const;
    for (const [role, usd] of Object.entries(roles)) expect(estimateReviewerUsd(listed(haiku)!, role as keyof typeof roles, 9_021, routeCaches(haiku)), role).toBeGreaterThanOrEqual(usd);
    // Light (the critic alone) is above what the critic cost.
    const light = priced(estimateDesignReviewUsd({ tier: "light", models: { reviewer: haiku, planner: haiku }, price: listed, packetTokens: 9_021, rounds: 1, reviewerCaches: true }));
    expect(light.breakdown.reviewersUsd).toBeGreaterThanOrEqual(roles.critic);
    // Where the route is not known to cache, the same round is priced at full input: higher still.
    const full = priced(estimateDesignReviewUsd({ tier: "standard", models: { reviewer: { provider: "anthropic", modelId: "claude-haiku-4-5" }, planner: haiku }, price: listed, packetTokens: 9_021, rounds: 1, reviewerCaches: true }));
    expect(full.breakdown.reviewersUsd).toBeGreaterThan(one.breakdown.reviewersUsd);
    // The same model through a source that is not Rovara's (a customer's own Bedrock account) is priced at full input, as is a source that is not known.
    for (const reviewerCaches of [false, undefined]) {
      const own = priced(estimateDesignReviewUsd({ tier: "standard", models: { reviewer: haiku, merge: haiku, planner: haiku }, price: listed, packetTokens: 9_021, rounds: 1, reviewerCaches }));
      expect(own.breakdown.reviewersUsd).toBeCloseTo(full.breakdown.reviewersUsd, 6);
      expect(own.breakdown.reviewersUsd).toBeGreaterThan(one.breakdown.reviewersUsd);
    }
  });

  it("L3: Zoom-out runs only after round 1, so round 1 of Thorough plans four reviewers and round 2 five", () => {
    expect(reviewersForRound("thorough", 1)).toEqual(["comprehension", "critic", "codebase", "critic_b"]);
    expect(reviewersForRound("thorough", 2)).toEqual(TIER_REVIEWERS.thorough);
    expect(reviewersForRound("standard", 1)).toEqual(TIER_REVIEWERS.standard);
    expect(reviewersForRound("light", 2)).toEqual(["critic"]);
  });

  it("is Cost unavailable, never a number, when the catalog has no price for a model it must price", () => {
    const noReviewerPrice: PriceLookup = (model) => (model.modelId === "strong-model" ? undefined : PRICES[model.modelId]);
    expect(estimateDesignReviewUsd({ tier: "standard", models, price: noReviewerPrice })).toEqual({ kind: "unavailable", tier: "standard", missing: ["reviewer"] });
    const nothing: PriceLookup = () => undefined;
    expect(estimateDesignReviewUsd({ tier: "standard", models, price: nothing })).toEqual({ kind: "unavailable", tier: "standard", missing: ["reviewer", "merge", "planner"] });
    // Light has no merge model to price, so the merge is not reported missing.
    expect(estimateDesignReviewUsd({ tier: "light", models, price: nothing })).toEqual({ kind: "unavailable", tier: "light", missing: ["reviewer", "planner"] });
    // A model the resolver did not resolve at all is also unavailable, not free.
    expect(estimateDesignReviewUsd({ tier: "light", models: { reviewer: undefined, planner: PLANNER }, price })).toMatchObject({ kind: "unavailable", missing: ["reviewer"] });
    // A catalog row that is not a usable number is no price.
    const broken: PriceLookup = () => ({ inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 5 });
    expect(estimateDesignReviewUsd({ tier: "light", models, price: broken }).kind).toBe("unavailable");
    expect(estimateDesignReviewUsd({ tier: "light", models, price: () => ({ inputUsdPerMTok: -1, outputUsdPerMTok: 5 }) }).kind).toBe("unavailable");
  });

  it("falls back to the reviewer's price for the merge step when no separate model was resolved (it can only come out high)", () => {
    const same = priced(estimateDesignReviewUsd({ tier: "standard", models: { reviewer: STRONG, planner: PLANNER }, price }));
    const cheaper = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
    expect(same.breakdown.mergeUsd).toBeGreaterThan(cheaper.breakdown.mergeUsd);
  });

  it("knows the next lower tier", () => {
    expect(nextLowerTier("thorough")).toBe("standard");
    expect(nextLowerTier("standard")).toBe("light");
    expect(nextLowerTier("light")).toBeUndefined();
  });
});

describe("the cap gate", () => {
  const est = (tier: "light" | "standard" | "thorough", capModels = models) => estimateDesignReviewUsd({ tier, models: capModels, price });
  const standard = priced(est("standard"));

  it("goes when the estimate is within the cap (at the cap too)", () => {
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: standard, canSkip: true })).toEqual({ kind: "go", estimateUsd: standard.usd });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: standard.usd, estimate: standard, canSkip: true }).kind).toBe("go");
  });

  it("asks when over the cap, with the lower tier only if it fits, a raise only if allowed, and skip only if the rules allow", () => {
    const light = priced(est("light"));
    const capBetween = (light.usd + standard.usd) / 2;
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    expect(gate.kind).toBe("ask");
    if (gate.kind !== "ask") return;
    expect(gate.why).toBe("over_cap");
    expect(gate.choices.map((c) => c.choice)).toEqual(["lower_tier", "raise_cap", "skip"]);
    expect(gate.choices[0]).toEqual({ choice: "lower_tier", tier: "light", estimateUsd: light.usd });
    // The raise is to the estimate rounded UP to a cent: it always covers the estimate.
    const raise = gate.choices[1] as { choice: "raise_cap"; newCapUsd: number };
    expect(raise.newCapUsd).toBeGreaterThanOrEqual(standard.usd);
    expect(raise.newCapUsd - standard.usd).toBeLessThan(0.0101);
    // The lower tier does not fit either: not offered.
    const tight = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: light.usd / 2, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    expect(tight.kind === "ask" && tight.choices.map((c) => c.choice)).toEqual(["raise_cap", "skip"]);
    // The lower tier has no price: not offered, and never guessed.
    const unpricedLower = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: { kind: "unavailable", tier: "light", missing: ["reviewer"] } }, canSkip: true });
    expect(unpricedLower.kind === "ask" && unpricedLower.choices.map((c) => c.choice)).toEqual(["raise_cap", "skip"]);
    // The skip rules take Skip away.
    const noSkip = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: false });
    expect(noSkip.kind === "ask" && noSkip.choices.map((c) => c.choice)).toEqual(["lower_tier", "raise_cap"]);
  });

  it("never offers a raise above the highest cap or the company's ceiling", () => {
    const huge: DesignReviewEstimate = { kind: "priced", usd: 250, breakdown: { reviewersUsd: 250, mergeUsd: 0, plannerUsd: 0 }, tier: "thorough", reviewers: 5, rounds: 2 };
    const overMax = gateDesignReviewCost({ spentUsd: 0, tier: "thorough", capUsd: 10, estimate: huge, canSkip: true });
    expect(overMax.kind === "ask" && overMax.choices.map((c) => c.choice)).toEqual(["skip"]);
    const ceiling = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 1, capCeilingUsd: 1.5, estimate: standard, canSkip: true });
    expect(standard.usd).toBeGreaterThan(1.5);
    expect(ceiling.kind === "ask" && ceiling.choices.map((c) => c.choice)).toEqual(["skip"]);
  });

  it("with no skip and nothing that fits, asks with NO choices: it never runs by itself", () => {
    const huge: DesignReviewEstimate = { kind: "priced", usd: 250, breakdown: { reviewersUsd: 250, mergeUsd: 0, plannerUsd: 0 }, tier: "thorough", reviewers: 5, rounds: 2 };
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "thorough", capUsd: 10, estimate: huge, canSkip: false })).toEqual({ kind: "ask", why: "over_cap", estimateUsd: 250, choices: [] });
  });

  it("Cost unavailable: asks, with run-anyway (one tap) and skip if allowed, and no number", () => {
    const unavailable = estimateDesignReviewUsd({ tier: "standard", models, price: () => undefined });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: true })).toEqual({ kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices: [{ choice: "run_unpriced" }, { choice: "skip" }] });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: false })).toEqual({ kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices: [{ choice: "run_unpriced" }] });
    // Even a huge cap does not let an unpriced review start: there is no "within the cap" without a price.
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 100, estimate: unavailable, canSkip: true }).kind).toBe("ask");
  });
});

describe("the planner's runs are priced in the estimate", () => {
  it("holds back room for BOTH planner runs of a round that may ask (the run that asks, then the run that resolves), and one for the last round, which does not ask", () => {
    expect([plannerRunsFor(2), plannerRunsFor(1), plannerRunsFor(0), plannerRunsFor(Number.NaN)]).toEqual([3, 1, 0, 0]);
    const one = estimateSecondReviewUsd(PRICES["planner-model"]!, { input: PLANNER_REVISION_TOKENS.input, maxOutput: PLANNER_REVISION_TOKENS.output });
    const both = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
    const last = priced(estimateDesignReviewUsd({ tier: "standard", models, price, rounds: 1 }));
    expect(both.breakdown.plannerUsd).toBeCloseTo(one * 3, 6);
    expect(last.breakdown.plannerUsd).toBeCloseTo(one, 6);
  });
});

describe("M5 and an unpriced run is bounded by the keys' ceilings, not by a stop function nothing called", () => {
  it("has no `designReviewSpendStop`: the dead stop was removed, and the per-slot key ceilings are the limit (tested end to end)", () => {
    expect("designReviewSpendStop" in estimateModule).toBe(false);
  });
});

describe("the approve_spend card source", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  const base = { taskId: TASK, subjectId: "dr-spend-1", project: "payments", title: "Partner ranking by region", createdAt: "2026-11-03T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, contentVersion: "v1", capUsd: 1 };
  const standard = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
  const light = priced(estimateDesignReviewUsd({ tier: "light", models, price }));

  it("makes a card whose actions are the allowed choices, as POSTs of this server, and which the card contract accepts", () => {
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: (light.usd + standard.usd) / 2, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    if (gate.kind !== "ask") throw new Error("expected an ask");
    const item = designSpendCardItem({ ...base, capUsd: (light.usd + standard.usd) / 2, gate });
    const made = cardOfItem(item);
    expect(made).toBeDefined();
    const card = made!.card;
    expect(DecisionCardSchema.safeParse(card).success).toBe(true);
    expect(card.kind).toBe("approve_spend");
    expect(card.actions.filter((a) => a.kind === "choose").map((a) => a.href)).toEqual([
      designSpendChoicePath(TASK, "lower_tier"), designSpendChoicePath(TASK, "raise_cap"), designSpendChoicePath(TASK, "skip"),
    ]);
    expect(card.actions.every((a) => a.kind === "open" ? a.method === "GET" : a.method === "POST")).toBe(true);
    // Never an approve action: a choice names what happens, none is a blanket yes.
    expect(card.actions.some((a) => a.kind === "approve")).toBe(false);
    expect(card.recommended.action).toBe("choose");
    expect(card.evidence.map((c) => c.label)).toEqual(["Estimate", "Limit for this task"]);
    expect(card.next.costUsd).toBe(standard.usd);
  });

  it("says Cost unavailable and is low risk when there is no price", () => {
    const unavailable = estimateDesignReviewUsd({ tier: "standard", models, price: () => undefined });
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: true });
    if (gate.kind !== "ask") throw new Error("expected an ask");
    const card = cardOfItem(designSpendCardItem({ ...base, capUsd: 10, gate }))!.card;
    expect(card.risk).toBe("low");
    expect(card.evidence[0]).toMatchObject({ label: "Estimate", value: "Cost unavailable", state: "unknown" });
    expect(card.next.costUsd).toBeUndefined();
    expect(card.actions.filter((a) => a.kind === "choose").map((a) => a.label)).toEqual(["Run it anyway", "Skip design review"]);
    expect(card.question).not.toMatch(/\$/u);
  });

  it("a gate with no choice left gives a card that only opens the page", () => {
    const card = cardOfItem(designSpendCardItem({ ...base, capUsd: 10, gate: { kind: "ask", why: "over_cap", estimateUsd: 250, choices: [] } }))!.card;
    expect(card.actions.map((a) => a.kind)).toEqual(["open"]);
    expect(card.recommended.action).toBe("open");
    // $250 is above the admin amount: high risk, and a high card has only "Open to decide".
    expect(card.risk).toBe("high");
  });

  it("an ordinary spend request is unchanged", () => {
    const card = cardOfItem({ kind: "approve_spend", subjectId: "spr1", taskId: TASK, project: "payments", title: "t", createdAt: base.createdAt, openPath: base.openPath, contentVersion: "v1", amountUsd: 5, scopeLabel: "this task" })!.card;
    expect(card.actions.map((a) => a.kind)).toEqual(["approve", "reject", "open"]);
  });
});


describe("money N3 (pure parts): what each reviewer's key may spend, and what a run records", () => {
  it("splits what is left under the cap between the reviewers and the merge model, rounding down so the shares never exceed it", () => {
    const standard = designReviewKeyBudgets({ capUsd: 10, spentUsd: 4, reviewers: 3, hasMergeModel: true });
    expect(standard).toEqual({ reviewerUsd: 1.5, mergeUsd: 1.5, roomUsd: 6 });
    const light = designReviewKeyBudgets({ capUsd: 10, spentUsd: 4, reviewers: 1, hasMergeModel: false });
    expect(light).toEqual({ reviewerUsd: 6, mergeUsd: 0, roomUsd: 6 });
    const odd = designReviewKeyBudgets({ capUsd: 1, spentUsd: 0, reviewers: 3, hasMergeModel: true });
    expect(odd.reviewerUsd).toBe(0.25);
    for (const [cap, spent, reviewers] of [[10, 3.3333333, 3], [7, 0.1, 5], [0.5, 0, 4]] as const) {
      const budgets = designReviewKeyBudgets({ capUsd: cap, spentUsd: spent, reviewers, hasMergeModel: true });
      expect(budgets.reviewerUsd * reviewers + budgets.mergeUsd).toBeLessThanOrEqual(budgets.roomUsd + 1e-9);
    }
  });

  it("holds back a reservation for the planner, and gives nothing when nothing is left or the input is not a number", () => {
    expect(designReviewKeyBudgets({ capUsd: 10, spentUsd: 0, reviewers: 3, hasMergeModel: false, reservedUsd: 1 })).toEqual({ reviewerUsd: 3, mergeUsd: 0, roomUsd: 9 });
    for (const bad of [{ capUsd: 10, spentUsd: 10 }, { capUsd: 10, spentUsd: 12 }, { capUsd: Number.NaN, spentUsd: 0 }, { capUsd: 10, spentUsd: Number.NaN }]) {
      expect(designReviewKeyBudgets({ ...bad, reviewers: 3, hasMergeModel: true }), JSON.stringify(bad)).toMatchObject({ reviewerUsd: 0, mergeUsd: 0, roomUsd: 0 });
    }
    expect(designReviewKeyBudgets({ capUsd: 10, spentUsd: 0, reviewers: 0, hasMergeModel: true })).toMatchObject({ reviewerUsd: 0 });
  });

  it("a run's cost is the proxy's measured spend when there is one, never 0 for an unpriced run that used tokens", () => {
    expect(recordedReviewerCost({ measuredUsd: 0.42, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0.42, source: "measured" });
    // a measured 0 is a reading, not a gap
    expect(recordedReviewerCost({ measuredUsd: 0, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0, source: "measured" });
    // the session's own figure is only a stand-in when it is above 0
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0.1, source: "session_estimate" });
    // unpriced model: the session reports 0 and nothing was measured, so the run is charged its key's whole budget
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 1.5, source: "budget_ceiling" });
    expect(recordedReviewerCost({ measuredUsd: Number.NaN, sessionUsd: Number.NaN, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 1.5, source: "budget_ceiling" });
    expect(recordedReviewerCost({ measuredUsd: -1, sessionUsd: 0, budgetUsd: 1.5, usedTokens: true }).costUsd).toBe(1.5);
    // a run that never reached the model costs nothing
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0, budgetUsd: 1.5, usedTokens: false })).toEqual({ costUsd: 0, source: "session_estimate" });
  });
});
