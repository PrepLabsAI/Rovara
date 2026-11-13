// Owner decision 2026-11-02 (option A): the review steps (plan check, code review, security review) that nobody has set default to the strongest usable model of a different company than the step they check.
// One test per rule.
import { describe, expect, it } from "vitest";
import { resolveStageModel, type StageModelInput } from "../../packages/core/src/core/model-selection/resolver.js";
import { candidatesOf } from "../../packages/core/src/core/second-review/model-ranking.js";
import { reviewDefaultExtras, STAGE_POOL_MAX } from "../../packages/core/src/core/model-selection/review-default-pool.js";
import { EffectiveStageModelSchema } from "../../packages/contracts/src/stage-models.js";

const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4" };
const opus = { provider: "anthropic", modelId: "claude-opus-4" };
const gpt = { provider: "openai", modelId: "gpt-5" };
const gemini = { provider: "google", modelId: "gemini-2.5-pro" };
const REVIEWS = ["code_review", "security_review", "plan_check"] as const;
const row = (model: { provider: string; modelId: string }, sourceId = "rovara") => ({ model, sourceId, enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "rovara_catalog" as const } });
const input = (stage: StageModelInput["stage"], models = [sonnet, opus, gpt, gemini], more: Partial<StageModelInput> = {}): StageModelInput => ({
  orgId: "org_a", stage, sourcesRevision: 2, candidates: models.map((model) => row(model)), forbidden: [], builtinDefault: sonnet, referenceModel: sonnet, allowLegacyDefaultFallback: true, reviewDefaultDifferentCompany: true, ...more,
});

describe("rule 1: a review nobody has set defaults to the strongest usable model of a different company", () => {
  for (const stage of REVIEWS) {
    it(`${stage}: picks the strongest other-company model by the existing ranking, not the stronger same-company one`, () => {
      // opus (same company as the builder) outranks gpt-5 and gemini in the ranking, but it is not another company's.
      expect(resolveStageModel(input(stage))).toMatchObject({ kind: "resolved", model: gpt, reason: "DEFAULT_DIFFERENT_COMPANY" });
      expect(resolveStageModel(input(stage))).not.toHaveProperty("noOtherCompany");
    });
  }
  it("takes the next company's model when the strongest is not usable (denied by an earlier try)", () => {
    expect(resolveStageModel(input("code_review", undefined, { deniedModels: [gpt] }))).toMatchObject({ kind: "resolved", model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
  });
  it("keeps the last-attempt rule: after the allowed tries the builder's own model still reviews, with its visible fallback", () => {
    expect(resolveStageModel(input("code_review", undefined, { defaultLastAttempt: true }))).toMatchObject({ kind: "resolved", model: sonnet, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" }, otherCompanyFailed: true });
  });
  it("a build step is untouched (the default is for steps that check another step)", () => {
    expect(resolveStageModel({ ...input("code_review"), stage: "build", referenceModel: undefined })).toMatchObject({ kind: "resolved", reason: "BUILTIN_DEFAULT" });
  });
});

describe("the fallback note names the model that was asked for, never the model that ran (QA-06)", () => {
  const unusableOpus = { ...row(opus), accountCannotUse: true as const };
  for (const stage of REVIEWS) {
    it(`${stage}: the preferred other model is not callable on this account, so the builder's model checks and the note says the preferred model was unavailable`, () => {
      const result = resolveStageModel(input(stage, [sonnet], { candidates: [row(sonnet), unusableOpus] }));
      expect(result).toMatchObject({ kind: "resolved", model: sonnet, fallback: { used: "anthropic/claude-sonnet-4", wanted: "anthropic/claude-opus-4", reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
    });
  }
  it("the same model on a source that cannot serve it, replaced by the same model on one that can: the note names no model", () => {
    const source = { model: sonnet, sourceId: "src_aaaaaaaaaaaaaaaaaaaa", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "tested_bedrock_role" as const } };
    const result = resolveStageModel({ ...input("code_review", [sonnet]), stage: "build" as const, referenceModel: undefined, candidates: [{ ...row(sonnet), accountCannotUse: true as const }, source] });
    expect(result).toMatchObject({ kind: "resolved", model: sonnet, sourceId: "src_aaaaaaaaaaaaaaaaaaaa", fallback: { used: "anthropic/claude-sonnet-4", wanted: null } });
  });
  it("with no other model asked for at all, the note names none (the page says \"the preferred model\") rather than the model that ran", () => {
    const result = resolveStageModel(input("code_review", [sonnet]));
    expect(result).toMatchObject({ kind: "resolved", model: sonnet, fallback: { used: "anthropic/claude-sonnet-4", wanted: null } });
  });
});

describe("rule 2: no other company's model is usable, so today's behaviour stands and says so", () => {
  for (const stage of REVIEWS) {
    it(`${stage}: the same company's other model, marked noOtherCompany, never a refusal`, () => {
      const result = resolveStageModel(input(stage, [sonnet, opus]));
      expect(result).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT", noOtherCompany: true });
    });
  }
  it("only the builder's own model is usable: the old same-model fallback, marked and with its fallback record", () => {
    expect(resolveStageModel(input("code_review", [sonnet]))).toMatchObject({ kind: "resolved", model: sonnet, noOtherCompany: true, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
  });
  it("a model of an unrecognised company is below the floor, so it never wins by default; the builder's own model stands, marked", () => {
    const strange = { provider: "acme", modelId: "mystery-1" };
    expect(resolveStageModel(input("code_review", [sonnet, strange]))).toMatchObject({ kind: "resolved", model: sonnet, noOtherCompany: true, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
  });
  it("without the legacy fallback (publish-time validation) a weak other-company model is still accepted, so the default never refuses what was accepted before", () => {
    const strange = { provider: "acme", modelId: "mystery-1" };
    expect(resolveStageModel(input("code_review", [sonnet, strange], { allowLegacyDefaultFallback: false }))).toMatchObject({ kind: "resolved", model: strange });
  });
  it("the contract carries the flag to the page", () => {
    const shape = { model: opus, sourceId: "rovara", thinkingLevel: null, decidedBy: "rovara", locked: false, reason: "BUILTIN_DEFAULT", noOtherCompany: true };
    expect(EffectiveStageModelSchema.safeParse(shape).success).toBe(true);
    expect(EffectiveStageModelSchema.safeParse({ ...shape, noOtherCompany: false }).success).toBe(false);
    expect(EffectiveStageModelSchema.safeParse({ ...shape, reason: "DEFAULT_DIFFERENT_COMPANY" }).success).toBe(true);
  });
});

describe("rule 4: explicit choices, forbidden models and approved lists", () => {
  it("never overrides a company lock, a project choice, a company default or a recipe default", () => {
    const sameCompany = { model: opus };
    expect(resolveStageModel(input("code_review", undefined, { companyLock: { model: opus, thinkingLevel: null } }))).toMatchObject({ model: opus, reason: "COMPANY_LOCK", locked: true });
    expect(resolveStageModel(input("code_review", undefined, { projectChoice: sameCompany }))).toMatchObject({ model: opus, reason: "PROJECT_CHOICE" });
    expect(resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany }))).toMatchObject({ model: opus, reason: "COMPANY_DEFAULT" });
    expect(resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany, companyDefaultOrigin: "recipe" }))).toMatchObject({ model: opus, reason: "RECIPE_DEFAULT" });
    for (const result of [resolveStageModel(input("code_review", undefined, { projectChoice: sameCompany })), resolveStageModel(input("code_review", undefined, { companyDefault: sameCompany }))]) expect(result).not.toHaveProperty("noOtherCompany");
  });
  it("an explicit different-model rule (the way back to today's behaviour) keeps picking by model, not by company", () => {
    const explicitModelLevel = { differentFrom: { stage: "build" as const, level: "model" as const } };
    // With only Claude models, the default would say "no other company" and mark it; the explicit model-level rule picks the same model without the default's reason or note.
    for (const rule of [{ projectChoice: explicitModelLevel }, { companyDefault: explicitModelLevel }]) {
      const result = resolveStageModel(input("code_review", [sonnet, opus], rule));
      expect(result).toMatchObject({ kind: "resolved", model: opus, reason: "BUILTIN_DEFAULT" });
      expect(result).not.toHaveProperty("noOtherCompany");
    }
  });
  it("among frontier models the step prefers a different company from the one it checks, even over a cheaper model of its own (the explicit model-level rule picks the same way)", () => {
    const bedrockSonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-5" }, bedrockOpus = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5" }, gpt55 = { provider: "openai", modelId: "gpt-5.5" };
    const rule = { projectChoice: { differentFrom: { stage: "build" as const, level: "model" as const } }, referenceModel: bedrockSonnet };
    expect(resolveStageModel(input("code_review", [bedrockSonnet, bedrockOpus, gpt55], rule))).toMatchObject({ kind: "resolved", model: gpt55 });
    expect(resolveStageModel(input("code_review", [bedrockSonnet, bedrockOpus], rule))).toMatchObject({ kind: "resolved", model: bedrockOpus });
  });
  it("an explicit vendor rule or the company guardrail still refuses instead of falling back", () => {
    const vendor = { differentFrom: { stage: "build" as const, level: "vendor" as const } };
    expect(resolveStageModel(input("code_review", [sonnet, opus], { projectChoice: vendor }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
    expect(resolveStageModel(input("code_review", [sonnet, opus], { requireDifferentVendor: true }))).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
  });
  it("the company guardrail is a rule, not the default: its pick keeps the ordinary reason", () => {
    expect(resolveStageModel(input("code_review", undefined, { requireDifferentVendor: true }))).toMatchObject({ kind: "resolved", model: gpt, reason: "BUILTIN_DEFAULT" });
  });
  it("a forbidden other-company model is never the default; the next company's, then the same company's, is", () => {
    expect(resolveStageModel(input("code_review", undefined, { forbidden: [gpt] }))).toMatchObject({ model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
    expect(resolveStageModel(input("code_review", undefined, { forbidden: [gpt, gemini] }))).toMatchObject({ model: opus, noOtherCompany: true });
  });
  it("the project's approved list limits the default to approved models", () => {
    expect(resolveStageModel(input("code_review", undefined, { approved: [sonnet, opus, gemini] }))).toMatchObject({ model: gemini, reason: "DEFAULT_DIFFERENT_COMPANY" });
    expect(resolveStageModel(input("code_review", undefined, { approved: [sonnet, opus] }))).toMatchObject({ model: opus, noOtherCompany: true });
  });
  it("a model without source evidence is not usable, so it is never the default", () => {
    const unverified = input("code_review");
    unverified.candidates = unverified.candidates.map((candidate) => (candidate.model.modelId === "gpt-5" ? { ...candidate, evidence: undefined } : candidate));
    expect(resolveStageModel(unverified)).toMatchObject({ model: gemini });
  });
});

describe("rule 5: the models the company can use reach the stage pool, within its limit", () => {
  const ids = (list: ReadonlyArray<{ provider: string; modelId: string }>) => list.map((model) => `${model.provider}/${model.modelId}`);
  it("adds the strongest few of each company, strongest first, and nothing forbidden or unapproved", () => {
    const servable = [sonnet, opus, gpt, gemini, { provider: "openai", modelId: "gpt-5-mini" }];
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set(), size: 0 }))).toEqual(["openai/gpt-5", "anthropic/claude-opus-4", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]);
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [gpt], have: new Set(), size: 0 }))).not.toContain("openai/gpt-5");
    expect(ids(reviewDefaultExtras({ servable, approved: [sonnet, gemini], forbidden: [], have: new Set(), size: 0 }))).toEqual(["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]);
  });
  it("LP-11 / M2: an OpenRouter ':batch' variant is never added to the pool or used by a plan check, even when it is listed first and shares a canonical name with the plain model", () => {
    const batch = { provider: "openrouter", modelId: "openai/gpt-5.2:batch" }, plain = { provider: "openrouter", modelId: "openai/gpt-5.2" };
    expect(ids(reviewDefaultExtras({ servable: [batch], approved: undefined, forbidden: [], have: new Set(), size: 0 }))).toEqual([]);
    const extras = ids(reviewDefaultExtras({ servable: [batch, plain], approved: undefined, forbidden: [], have: new Set(), size: 0 }));
    // Positive control: the plain model is still added, so the pool was read.
    expect(extras).toContain("openrouter/openai/gpt-5.2");
    expect(extras).not.toContain("openrouter/openai/gpt-5.2:batch");
    expect(ids(candidatesOf({ forbidden: [] }, [batch, plain]))).toEqual(["openrouter/openai/gpt-5.2"]);
    expect(candidatesOf({ forbidden: [] }, [batch])).toEqual([]);
  });
  it("never grows the pool past its limit, and keeps every company's strongest when room is short", () => {
    const servable = [opus, sonnet, gpt, gemini];
    const have = new Set(Array.from({ length: STAGE_POOL_MAX - 2 }, (_, index) => `m${String(index)}`));
    expect(ids(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have, size: STAGE_POOL_MAX - 2 }))).toEqual(["openai/gpt-5", "anthropic/claude-opus-4"]);
    expect(reviewDefaultExtras({ servable, approved: undefined, forbidden: [], have: new Set(Array.from({ length: STAGE_POOL_MAX }, (_, index) => `m${String(index)}`)), size: STAGE_POOL_MAX })).toEqual([]);
  });
  it("takes at most three of one company, so one company's long list cannot crowd the others out", () => {
    const many = ["gpt-5", "gpt-5-1", "gpt-5-2", "gpt-5-3", "gpt-5-4"].map((modelId) => ({ provider: "openai", modelId }));
    const added = reviewDefaultExtras({ servable: [...many, gemini], approved: undefined, forbidden: [], have: new Set(), size: 0 });
    expect(added.filter((model) => model.provider === "openai")).toHaveLength(3);
    expect(added).toContainEqual(gemini);
  });
  it("does not re-add a model the pool already holds", () => {
    expect(ids(reviewDefaultExtras({ servable: [gpt], approved: undefined, forbidden: [], have: new Set(["gpt-5"]), size: 1 }))).toEqual([]);
  });
});
