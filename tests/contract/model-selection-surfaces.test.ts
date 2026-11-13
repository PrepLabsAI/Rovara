// What the owner and a tool see of the per-step model setting: the page (everything a model says about itself is escaped), the plain lines for the terminal and an AI tool, and the MCP tool that only reads.
import { describe, expect, it, vi } from "vitest";
import { ModelSelectionBodySchema, ModelSelectionStateSchema, modelSelectionLines, type ModelSelectionState } from "@rovara-code/contracts";
import { renderModelSelection } from "../../packages/core/src/core/local-pages/models-page.js";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/index.js";

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
const context = { base: "/s/token", nonce: "nonce", sessionId: "sid", formToken: () => "ft-token" };

describe("the models page", () => {
  const page = renderModelSelection(context, state);

  it("shows each step with the model it would run on, why, its price, and a form for each group of steps that share a setting", () => {
    expect(page).toContain("The model each step uses");
    expect(page).toContain("Understand the request and Plan");
    expect(page).toContain("the same model as the step it checks");
    expect(page).toContain("$3.00 in, $15.00 out per million tokens");
    expect(page).toContain("No model can be called on this computer.");
    expect(page).toContain("instead of openai/gpt-5 because the first choice could not be used");
    // One group of steps is one form: the plan steps, the plan check, the build, the two reviews, the pull request.
    expect([...page.matchAll(/name="op" value="set"/g)]).toHaveLength(5);
    expect(page).toContain("No run limit is held");
    // The form for a group carries the revision it was drawn at and a signed token, and is posted under the page's own session.
    expect(page).toContain('action="/s/token/models/act"');
    expect(page).toContain('name="revision" value="3"');
    expect(page).toContain('name="ft" value="ft-token"');
  });

  it("draws a model's name as text, never as markup, wherever it appears", () => {
    expect(page).not.toContain("<script");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("refused lately");
    expect(page).toContain("no price");
  });

  it("offers a way back to the default only for a step that has a setting, and says when a held limit rules out an unpriced model", () => {
    expect([...page.matchAll(/name="op" value="clear"/g)]).toHaveLength(1);
    const held = renderModelSelection(context, { ...state, runLimit: { enforced: true } });
    expect(held).toContain("a model with no price cannot be used");
  });
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

describe("agentx_get_model_selection", () => {
  const tool = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_model_selection")!;

  it("is a read: it asks the control plane for the setting and says what each step uses, what it costs, and where the owner changes it", async () => {
    const client = { getModelSelection: vi.fn(async () => state) };
    const result = await tool.handler({ client } as never, {}, {} as never);
    expect(client.getModelSelection).toHaveBeenCalledTimes(1);
    expect(result.structured).toMatchObject({ checking_default: "install-model", run_limit_held: false, revision: 3 });
    const steps = (result.structured as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps).toHaveLength(7);
    expect(steps[0]).toMatchObject({ step: "understand", set_by_owner: true, thinking: "high", price_usd_per_million: { input: 3, output: 15 } });
    expect(steps[2]).toMatchObject({ step: "plan_check", set_by_owner: false, same_model_as_checked: true });
    expect(steps[4]).toMatchObject({ step: "code_review", problem: "No model can be called on this computer." });
    expect(steps[4]).not.toHaveProperty("model");
    expect(steps[5]).toMatchObject({ fell_back_from: "anthropic/claude-opus-4-5" });
    expect(result.text).toContain("plan check: anthropic:claude-sonnet-4-5");
    expect(result.text).toContain("rovara open models");
  });

  it("takes no input and says that it only reads", () => {
    expect(Object.keys(tool.inputSchema)).toEqual([]);
    expect(tool.description).toContain("only reads");
    expect(tool.description).toContain("never through a tool");
  });
});
