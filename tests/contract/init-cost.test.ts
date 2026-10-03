// Spec 048 FR-023, FR-024 and FR-082: the default models are all priced, every model offered as a
// choice is priced or says "price not on file", and the budget default is the estimate plus 20%.
import { describe, expect, it } from "vitest";
import { CLASSIFIER_MODEL_CHOICES, DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, ORCHESTRATOR_MODEL_CHOICES, WORKER_MODEL_CHOICES } from "../../packages/cli/src/init/answers.js";
import { budgetWhy, estimateMonthlyCost, modelPriceLabel, PRICE_NOT_ON_FILE, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import type { ModelRole } from "../../packages/cli/src/init/prerequisites.js";

const DEFAULTS = { orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL };
const pricedOrLabelled = (role: ModelRole, choice: { value: string; label: string }) =>
  modelPriceLabel(role, choice.value) !== PRICE_NOT_ON_FILE || choice.label.includes(PRICE_NOT_ON_FILE);

describe("model prices", () => {
  it("FR-024: prices every default model, the coding model included", () => {
    const estimate = estimateMonthlyCost(DEFAULTS);
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.lines.slice(-3).map((line) => [line.item, line.usd])).toEqual([
      ["Main model (Claude Sonnet 4.6)", 25], ["Safety check model (Claude Haiku 4.5)", 2.5], ["Coding model (Claude Sonnet 4.6)", 75],
    ]);
    expect(estimate.totalUsd).toBe(211.13);
  });

  it("FR-082: every model offered as a choice has a price or says price not on file", () => {
    for (const choice of ORCHESTRATOR_MODEL_CHOICES) expect(pricedOrLabelled("orchestrator", choice)).toBe(true);
    for (const choice of CLASSIFIER_MODEL_CHOICES) expect(pricedOrLabelled("classifier", choice)).toBe(true);
    for (const choice of WORKER_MODEL_CHOICES) expect(pricedOrLabelled("worker", choice)).toBe(true);
    for (const [role, id] of Object.entries(DEFAULTS) as Array<[ModelRole, string]>) expect(modelPriceLabel(role, id)).not.toBe(PRICE_NOT_ON_FILE);
  });

  it("FR-082: the check fails for a choice with no price and no label", () => {
    expect(pricedOrLabelled("worker", { value: "us.anthropic.claude-opus-4-1-20250805-v1:0", label: "Claude Opus 4.1" })).toBe(false);
    expect(pricedOrLabelled("worker", { value: "us.anthropic.claude-opus-4-1-20250805-v1:0", label: `Claude Opus 4.1 (${PRICE_NOT_ON_FILE})` })).toBe(true);
  });

  it("labels prices the way the choices show them", () => {
    expect(modelPriceLabel("orchestrator", DEFAULT_ORCHESTRATOR_MODEL)).toBe("about $0.025 a turn");
    expect(modelPriceLabel("classifier", DEFAULT_CLASSIFIER_MODEL)).toBe("about $0.0025 a check");
    expect(modelPriceLabel("worker", DEFAULT_WORKER_MODEL)).toBe("about $0.75 a coding session");
    expect(modelPriceLabel("orchestrator", DEFAULT_ORCHESTRATOR_MODEL, "openrouter")).toBe(PRICE_NOT_ON_FILE);
  });
});

describe("the budget default", () => {
  it("FR-023: is the estimate plus 20%, rounded up to a whole $10", () => {
    expect(suggestedBudgetUsd(estimateMonthlyCost(DEFAULTS))).toBe(260);
    expect(suggestedBudgetUsd({ lines: [], totalUsd: 0, unpriced: [] })).toBe(10);
    expect(suggestedBudgetUsd({ lines: [], totalUsd: 100, unpriced: [] })).toBe(120);
  });

  it("an unpriced model is named, left out of the total, and noted in the budget help", () => {
    const estimate = estimateMonthlyCost({ ...DEFAULTS, worker: "us.anthropic.claude-opus-4-1-20250805-v1:0" });
    expect(estimate.lines.at(-1)).toEqual({ item: "Coding model (us.anthropic.claude-opus-4-1-20250805-v1:0)", usd: undefined, basis: "not priced: price not on file for us.anthropic.claude-opus-4-1-20250805-v1:0" });
    expect(estimate.totalUsd).toBe(136.13);
    expect(suggestedBudgetUsd(estimate)).toBe(170);
    expect(budgetWhy(estimate)).toBe("AgentX's estimate is about $136.13 a month, not counting Coding model (us.anthropic.claude-opus-4-1-20250805-v1:0), whose price is not on file. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.");
  });
});
