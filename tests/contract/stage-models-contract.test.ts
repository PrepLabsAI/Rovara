import { describe, expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/stage-models.js";
const model = { provider: "anthropic", modelId: "claude-sonnet-4" };
const at = "2026-10-29T21:00:00.000Z";
const choice = { model, thinkingLevel: "high", differentFrom: { stage: "build", level: "model" } };
const stage = { stage: "code_review", projectChoice: choice, companyDefault: null, locked: false, editable: true, candidates: [], candidatesState: "complete", effective: { model, sourceId: "rovara", thinkingLevel: "high", decidedBy: "project", reason: "PROJECT_CHOICE", locked: false } };
const view = { version: 1, checkedAt: at, companyRevision: 0, projectRevision: 1, process: { agentId: "rovara-code", version: 2, digest: "a".repeat(64) }, rankingVersion: "g3-v1", stages: [stage] };
describe("G3 v1 shared browser contracts", () => {
 it("reads the flat effective shape with existing thinking levels and distinct stages", () => {
  expect(contracts.StageModelsResponseSchema.parse(view)).toEqual(view);
  expect(contracts.STAGE_IDS).toEqual(["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"]);
 });
 it("refuses mixed effective/refusal, duplicate stages, unknown fields and unbounded lists", () => {
  for (const value of [{ ...view, stages: [stage, stage] }, { ...view, stages: [{ ...stage, refusal: { code: "MODEL_NOT_VERIFIED" } }] }, { ...view, secret: "do-not-accept" }, { ...view, stages: [{ ...stage, candidates: Array(24).fill({ model, label: "Model", provider: "anthropic", company: "anthropic", status: "verified", checkedAt: at }) }] }]) expect(contracts.StageModelsResponseSchema.safeParse(value).success).toBe(false);
 });
 it("supports fixed refusals and a separate draft stale code", () => {
  const rest = Object.fromEntries(Object.entries(stage).filter(([key]) => key !== "effective"));
  expect(contracts.StageModelsResponseSchema.safeParse({ ...view, stages: [{ ...rest, refusal: { code: "LOCK_UNSATISFIABLE", fixHref: "/app/admin/how-we-work" } }] }).success).toBe(true);
  expect(contracts.StageModelRefusalCodeSchema.safeParse("DRAFT_STALE").success).toBe(true);
  expect(contracts.StageModelRefusalCodeSchema.safeParse("provider says raw error").success).toBe(false);
 });
 it("rejects external or executable remediation links", () => {
  for (const fixHref of ["https://evil.test", "//evil.test", "javascript:alert(1)", "/app/admin?token=secret"]) expect(contracts.StageModelRefusalSchema.safeParse({ code: "MODEL_NOT_VERIFIED", fixHref }).success).toBe(false);
 });
 it("validates company policy reads/writes with revision, lock completeness and no forged authority", () => {
  const policy = { version: 1, revision: 0, rankingVersion: "g3-v1", stepOverrides: { build: { model, thinkingLevel: null, locked: true } } };
  expect(contracts.ModelSelectionPolicyResponseSchema.safeParse(policy).success).toBe(true);
  const body = { version: 1, requestId: "e09bc654-d227-48df-b523-69f0046a9af2", expectedRevision: 0, stepOverrides: policy.stepOverrides };
  expect(contracts.ModelSelectionPolicyPutSchema.safeParse(body).success).toBe(true);
  for (const bad of [{ ...body, orgId: "foreign" }, { ...body, expectedRevision: -1 }, { ...body, stepOverrides: { build: { locked: true } } }, { ...body, stepOverrides: { unknown: {} } }]) expect(contracts.ModelSelectionPolicyPutSchema.safeParse(bad).success).toBe(false);
 });
 it("keeps preview paged with incomplete notice and no counts", () => {
  const page = { version: 1, checkedAt: at, policyRevision: 0, mayBeIncomplete: true, projects: [{ project: "web", impact: "blocked", reasonCodes: ["MODEL_NOT_VERIFIED"] }], nextCursor: "opaque" };
  expect(contracts.ModelPolicyPreviewResponseSchema.safeParse(page).success).toBe(true);
  expect(contracts.ModelPolicyPreviewResponseSchema.safeParse({ ...page, total: 1 }).success).toBe(false);
 });
 it("represents default fallback visibility without accepting raw reasons", () => {
  const fallback = { stage: "build", used: "anthropic/claude-sonnet-4", wanted: null, reasonCode: "DEFAULT_MODEL_UNAVAILABLE" };
  expect(contracts.ModelFallbackSchema.safeParse(fallback).success).toBe(true);
  expect(contracts.ModelFallbackSchema.safeParse({ ...fallback, reasonCode: "a provider exception" }).success).toBe(false);
 });
});

it("exports company candidates, applied and shared sole-owner confirmation bodies", () => {
 const candidate={model,label:"Sonnet",provider:"anthropic",company:"anthropic",status:"verified",checkedAt:at};
 expect(contracts.ModelSelectionPolicyResponseSchema.safeParse({version:1,revision:0,rankingVersion:"g3-v1",stepOverrides:{},candidates:{build:[candidate]}}).success).toBe(true);
 expect(contracts.ModelSelectionPolicyAppliedSchema.parse({status:"APPLIED",revision:1,requestId:"e09bc654-d227-48df-b523-69f0046a9af2"})).toHaveProperty("revision",1);
 const body={status:"NEEDS_CONFIRMATION",code:"REAUTH_REQUIRED",confirmUrl:"https://example.test/app/confirm",changes:["Removes a lock"],soleOwner:{available:false,availableAt:at,reasonCode:"COOL_OFF"}};
 expect(contracts.ModelSelectionPolicyPendingSchema.safeParse(body).success).toBe(true);
});
it("exports browser-safe mapping/edit groups without widening the recipe thinking scale",()=>{
 expect(contracts.STAGE_OPERATION_MAPPING.REVIEW.stages).toEqual(["code_review","security_review"]);
 expect(contracts.STAGE_EDIT_RULES.code_review.editGroup).toBe("review");
 expect(contracts.STAGE_EDIT_RULES.security_review.editGroup).toBe("review");
 expect(contracts.STAGE_MODEL_THINKING_LEVELS).toEqual(["off","minimal","low","medium","high"]);
});

it("does not silently widen stage thinking beyond the recipe schema",()=>{expect(contracts.StageModelChoiceSchema.safeParse({model,thinkingLevel:"xhigh"}).success).toBe(false);});

it("keeps every edit group aligned and exports the policy reference pairs",()=>{
 expect(contracts.STAGE_EDIT_GROUPS).toContainEqual(["understand","plan"]);
 for(const group of contracts.STAGE_EDIT_GROUPS) expect(new Set(group.map(stage=>contracts.STAGE_EDIT_RULES[stage].editGroup)).size).toBe(1);
 expect(contracts.STAGE_REFERENCE).toEqual({plan_check:"plan",code_review:"build",security_review:"build"});
});

it("keeps fallback history in the canonical task and nested session task contract",async()=>{
 const {DeveloperTaskViewSchema}=await import("../../packages/contracts/src/developer-tasks.js");
 const fallback={stage:"build",used:"anthropic/claude-sonnet-4",wanted:null,reasonCode:"DEFAULT_MODEL_UNAVAILABLE"};
 const task={taskId:"11111111-1111-4111-8111-111111111111",title:"Work",project:"payments",status:"RUNNING",startingRevision:1,client:"test",shared:false,createdAt:"2026-10-29T00:00:00Z",updatedAt:"2026-10-29T00:00:00Z",events:[]};
 expect(DeveloperTaskViewSchema.parse({...task,modelFallbacks:[fallback]}).modelFallbacks).toEqual([fallback]);
 expect(DeveloperTaskViewSchema.safeParse(task).success).toBe(true);
 for(const modelFallbacks of [[{...fallback,reasonCode:"raw provider exception"}],[{...fallback,sourceBinding:"private"}],Array(65).fill(fallback)]) expect(DeveloperTaskViewSchema.safeParse({...task,modelFallbacks}).success).toBe(false);
 const {SessionStepTaskResponseSchema}=await import("../../packages/contracts/src/session-views.js");
 expect(SessionStepTaskResponseSchema.parse({task:{...task,modelFallbacks:[fallback]}}).task.modelFallbacks).toEqual([fallback]);
});
