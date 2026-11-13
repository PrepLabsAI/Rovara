import { describe, expect, it } from "vitest";
import { resolveStageModel, STAGE_OPERATION_MAPPING } from "../../packages/core/src/core/model-selection/resolver.js";
import type { StageModelInput } from "../../packages/core/src/core/model-selection/resolver.js";
const build = { provider: "anthropic", modelId: "claude-sonnet-4" };
const other = { provider: "anthropic", modelId: "claude-opus-4" };
const base = (): StageModelInput => ({ orgId: "org_a", stage: "build", sourcesRevision: 2, candidates: [build, other].map((model) => ({ model, sourceId: "rovara", enabled: true, inEffectiveOrder: true, evidence: { orgId: "org_a", sourcesRevision: 2, kind: "rovara_catalog" } })), forbidden: [], approved: [build, other], builtinDefault: build });
describe("one stage-model resolver", () => {
 it("keeps project choice above company default and lock above project", () => {
  const input = { ...base(), projectChoice: { model: other }, companyDefault: { model: build } };
  expect(resolveStageModel(input)).toMatchObject({ kind: "resolved", model: other, reason: "PROJECT_CHOICE" });
  expect(resolveStageModel({ ...input, companyLock: { model: build } })).toMatchObject({ kind: "resolved", model: build, reason: "COMPANY_LOCK" });
 });
 it("ranks Slack selection below company default but above registered default", () => {
  expect(resolveStageModel({ ...base(), projectSelection: other, companyDefault: { model: build } })).toMatchObject({ model: build, reason: "COMPANY_DEFAULT" });
  expect(resolveStageModel({ ...base(), projectSelection: other, projectDefault: build })).toMatchObject({ model: other, reason: "PROJECT_SELECTION" });
 });
 it("refuses an unavailable explicit choice instead of a verified default", () => {
  const input = { ...base(), projectChoice: { model: other }, deniedModels: [other] };
  expect(resolveStageModel(input)).toEqual({ kind: "refusal", code: "MODEL_NOT_VERIFIED" });
  expect(resolveStageModel({ ...input, companyLock: { model: other } })).toEqual({ kind: "refusal", code: "LOCK_UNSATISFIABLE" });
 });
 it("accepts source-level evidence with exact org/revision binding, without TTL", () => {
  expect(resolveStageModel(base())).toMatchObject({ kind: "resolved", model: build });
  for (const evidence of [{ orgId: "org_b", sourcesRevision: 2, kind: "rovara_catalog" }, { orgId: "org_a", sourcesRevision: 1, kind: "rovara_catalog" }, undefined]) {
   const input = base(); input.candidates = [{ ...input.candidates[0]!, evidence } as StageModelInput["candidates"][number]];
   expect(resolveStageModel({ ...input, projectChoice: { model: build } })).toMatchObject({ kind: "refusal", code: "MODEL_NOT_VERIFIED" });
  }
 });
 it("requires model independence even across route aliases; no implicit same-model exception", () => {
  const input = { ...base(), stage: "code_review" as const, referenceModel: build };
  expect(resolveStageModel(input)).toMatchObject({ kind: "resolved", model: other });
  expect(resolveStageModel({ ...input, candidates: input.candidates.slice(0, 1) })).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
  expect(resolveStageModel({ ...input, projectChoice: { model: build } })).toEqual({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
 });
 it("requires an exact server-approved same-model tuple and retains cross-vendor constraints", () => {
  const input = { ...base(), stage: "plan_check" as const, referenceModel: build, projectChoice: { model: build }, sameModelApproval: { model: build, referenceModel: build } };
  expect(resolveStageModel(input)).toMatchObject({ kind: "resolved", reason: "APPROVED_SAME_MODEL" });
  expect(resolveStageModel({ ...input, requireDifferentVendor: true })).toMatchObject({ kind: "refusal", code: "DIFFERENT_FROM_UNSATISFIABLE" });
 });
 it("allows configured verified fallback only with visible provenance", () => {
  const result = resolveStageModel({ ...base(), projectChoice: { model: build, fallbackModel: other }, deniedModels: [build] });
  expect(result).toMatchObject({ kind: "resolved", model: other, fallback: { stage: "build", used: "anthropic/claude-opus-4", wanted: "anthropic/claude-sonnet-4", reasonCode: "CONFIGURED_FALLBACK" } });
 });
 it("default-only fallback retains a visible reason; forbidden candidates never run", () => {
  const input = { ...base(), deniedModels: [build], defaultFallbacks: [other] };
  expect(resolveStageModel(input)).toMatchObject({ kind: "resolved", model: other, fallback: { reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } });
  expect(resolveStageModel({ ...input, forbidden: [other] })).toMatchObject({ kind: "refusal" });
 });
 it("exports the mode mapping including model-free checks and shared review slots", () => {
  expect(STAGE_OPERATION_MAPPING.UNDERSTAND).toEqual({ stages: ["understand"], stepKind: "plan" });
  expect(STAGE_OPERATION_MAPPING.SETUP_DRAFT).toEqual({ stages: ["plan"], stepKind: "plan" });
  expect(STAGE_OPERATION_MAPPING.CHECKS.stages).toEqual([]);
  expect(STAGE_OPERATION_MAPPING.REVIEW.stages).toEqual(["code_review", "security_review"]);
  expect(STAGE_OPERATION_MAPPING.FEEDBACK_REVIEW).toEqual({ stages: ["pull_request"], stepKind: "pull_request" });
 });
});

it("preserves the owner-approved default-only same-model path with visible fallback, never an explicit choice", () => {
 const input = { ...base(), stage: "plan_check" as const, referenceModel: build, candidates: base().candidates.slice(0, 1), allowLegacyDefaultFallback: true };
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved", model:build, fallback:{reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}});
 expect(resolveStageModel({...input,projectChoice:{model:build}})).toEqual({kind:"refusal",code:"DIFFERENT_FROM_UNSATISFIABLE"});
});

it("inherits stage fields independently, with explicit null overriding company effort",()=>{
 const input={...base(),companyDefault:{model:build,thinkingLevel:"high" as const},projectChoice:{thinkingLevel:"low" as const}};
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved",model:build,thinkingLevel:"low",reason:"COMPANY_DEFAULT"});
 expect(resolveStageModel({...input,projectChoice:{model:other}})).toMatchObject({kind:"resolved",model:other,thinkingLevel:"high"});
 expect(resolveStageModel({...input,projectChoice:{thinkingLevel:null}})).toMatchObject({kind:"resolved",model:build,thinkingLevel:null});
 expect(resolveStageModel({...input,companyLock:{model:build,thinkingLevel:"high"}})).toMatchObject({kind:"resolved",model:build,thinkingLevel:"high",locked:true});
});
it("applies metadata-only review constraints to automatic selection",()=>{
 expect(resolveStageModel({...base(),stage:"code_review",referenceModel:build,projectChoice:{differentFrom:{stage:"build",level:"vendor"}}})).toEqual({kind:"refusal",code:"DIFFERENT_FROM_UNSATISFIABLE"});
});
it("keeps a metadata-only configured fallback when the inherited exact choice is unavailable",()=>{
 expect(resolveStageModel({...base(),companyDefault:{model:build},projectChoice:{fallbackModel:other},deniedModels:[build]})).toMatchObject({kind:"resolved",model:other,fallback:{reasonCode:"CONFIGURED_FALLBACK"}});
});

it("preserves a verified personal-plan default below explicit choices and company policy",()=>{
 const input={...base(),defaultPreferred:other,projectDefault:build};
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved",model:other,reason:"PERSONAL_PLAN_DEFAULT"});
 expect(resolveStageModel({...input,companyDefault:{model:build}})).toMatchObject({kind:"resolved",model:build,reason:"COMPANY_DEFAULT"});
 expect(resolveStageModel({...input,projectChoice:{model:build}})).toMatchObject({kind:"resolved",model:build,reason:"PROJECT_CHOICE"});
 expect(resolveStageModel({...input,deniedModels:[other],defaultFallbacks:[build]})).toMatchObject({kind:"resolved",model:build,fallback:{reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}});
});

it("preserves the existing reviewer retry ranking across a refused capability tier",()=>{
 const models=["claude-fable-5-1","claude-fable-5","claude-opus-5-5","claude-sonnet-4-6"].map(modelId=>({provider:"anthropic",modelId}));
 const input={...base(),stage:"plan_check" as const,approved:models,referenceModel:models[3],deniedModels:[models[0]!],candidates:models.map(model=>({...base().candidates[0]!,model}))};
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved",model:models[2]});
});

it("preserves the last default attempt on the verified reference with visible fallback only",()=>{
 const input={...base(),stage:"plan_check" as const,referenceModel:build,allowLegacyDefaultFallback:true,defaultLastAttempt:true};
 expect(resolveStageModel(input)).toMatchObject({kind:"resolved",model:build,reason:"BUILTIN_DEFAULT",fallback:{reasonCode:"DEFAULT_MODEL_UNAVAILABLE"}});
 expect(resolveStageModel({...input,deniedModels:[build]})).toMatchObject({kind:"resolved",model:other});
 expect(resolveStageModel({...input,projectChoice:{model:other}})).toMatchObject({kind:"resolved",model:other});
 expect(resolveStageModel({...input,requireDifferentVendor:true})).toMatchObject({kind:"refusal"});
});
