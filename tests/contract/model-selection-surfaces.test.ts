// What the owner and a tool see of the per-step model setting: the plain lines for the terminal and an AI tool, and what a page may send.
import { describe, expect, it } from "vitest";
import { ModelSelectionBodySchema, ModelSelectionStateSchema, modelSelectionLines, type ModelSelectionState } from "@agentx/contracts";

const ref = (provider: string, modelId: string) => ({ provider, modelId });
const effective = (model: ReturnType<typeof ref>, extra: Record<string, unknown> = {}) => ({ model, thinkingLevel: null, reason: "BUILTIN_DEFAULT" as const, sameModelAsChecked: false, priceUsdPerMillion: { input: 3, output: 15, source: "catalog" as const }, ...extra });
const HOSTILE = ref("company-gateway", "<script>alert(1)</script>");
const state: ModelSelectionState = ModelSelectionStateSchema.parse({
  version: 1, revision: 3, reviewDefault: "install-model", runLimit: { enforced: false }, install: ref("anthropic", "claude-sonnet-4-5"),
  steps: [
    { stage: "understand", setting: { model: HOSTILE, thinkingLevel: "high" }, effective: effective(HOSTILE, { reason: "COMPANY_DEFAULT", thinkingLevel: "high" }) },
    { stage: "plan", setting: { model: HOSTILE, thinkingLevel: "high" }, effective: effective(HOSTILE, { reason: "COMPANY_DEFAULT", thinkingLevel: "high" }) },
    { stage: "plan_check", setting: null, effective: effective(ref("anthropic", "claude-sonnet-4-5"), { reason: "INSTALL_MODEL", sameModelAsChecked: true }) },
    { stage: "build", setting: null, effective: effective(ref("anthropic", "claude-sonnet-4-5"), { fallback: { stage: "build", used: "anthropic/claude-sonnet-4-5", wanted: "openai/gpt-5", reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } }) },
    { stage: "code_review", setting: null, refusal: { code: "NO_MODEL", words: "No model can be called on this computer." } },
    { stage: "security_review", setting: null, effective: effective(ref("openai", "gpt-5"), { fallback: { stage: "security_review", used: "openai/gpt-5", wanted: "anthropic/claude-opus-4-5", reasonCode: "CONFIGURED_FALLBACK" } }) },
    { stage: "pull_request", setting: null, effective: effective(ref("anthropic", "claude-sonnet-4-5")) },
  ],
  models: [
    { model: HOSTILE, company: "other", label: "gateway", priced: false, usable: false },
    { model: ref("anthropic", "claude-sonnet-4-5"), company: "anthropic", label: "sonnet", priced: true, priceUsdPerMillion: { input: 3, output: 15, source: "catalog" }, usable: true },
  ],
});

describe("the plain lines", () => {
  it("say, for each step, the model, who decided, thinking, a fallback and the price, and what a checking step nobody set does", () => {
    const lines = modelSelectionLines(state);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("understand: company-gateway:<script>alert(1)</script> (set by you, thinking high; $3.00 in, $15.00 out per million tokens)");
    expect(lines[2]).toContain("plan check: anthropic:claude-sonnet-4-5 (default, the same model as the step it checks;");
    expect(lines[4]).toBe("code review: no model can be used (No model can be called on this computer.)");
    expect(lines[5]).toContain("fell back from anthropic/claude-opus-4-5");
    expect(lines[7]).toBe("Checking steps nobody set use this install's model.");
    expect(lines[8]).toContain("a model with no price can be used");
    expect(modelSelectionLines({ ...state, reviewDefault: "different-company", runLimit: { enforced: true } }).slice(-2)).toEqual([
      "Checking steps nobody set use the strongest model of a different AI company than the step they check.", "A run limit is held, so a model with no price is not used.",
    ]);
  });

  it("read a state from a newer server that adds a stage or a reason as plain text, and never print a control character", () => {
    const newer = { ...state, steps: [{ stage: "deploy\u0007", setting: null, effective: { ...effective(ref("a\nb", "c\u001b[31m")), reason: "SOMETHING_NEW" } }] };
    const [line] = modelSelectionLines(newer);
    expect(line).toBe("deploy : a b:c [31m (default; $3.00 in, $15.00 out per million tokens)");
    expect(line).not.toMatch(/\p{Cc}/u);
  });
});

describe("what a page may send", () => {
  it("is a set, a clear or the review default, each naming the revision it was drawn at, and nothing else", () => {
    expect(ModelSelectionBodySchema.safeParse({ action: "set", stage: "plan", choice: { model: ref("openai", "gpt-5"), thinkingLevel: "low" }, expectedRevision: 2 }).success).toBe(true);
    expect(ModelSelectionBodySchema.safeParse({ action: "clear", stage: "build", expectedRevision: 0 }).success).toBe(true);
    expect(ModelSelectionBodySchema.safeParse({ action: "review-default", value: "different-company", expectedRevision: 1 }).success).toBe(true);
    for (const bad of [
      { action: "set", stage: "plan", choice: {}, expectedRevision: -1 }, { action: "set", stage: "plan", choice: { locked: true }, expectedRevision: 0 }, { action: "set", stage: "deploy", choice: {}, expectedRevision: 0 },
      { action: "clear", stage: "plan" }, { action: "review-default", value: "anything", expectedRevision: 0 }, { action: "set", stage: "plan", choice: { thinkingLevel: "xhigh" }, expectedRevision: 0 },
      { action: "set", stage: "plan", choice: { model: ref("openai", "gpt-5") }, expectedRevision: 0, extra: true },
    ]) expect(ModelSelectionBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
