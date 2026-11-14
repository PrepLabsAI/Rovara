// G3 v1: the How we work UI reads server decisions; it never selects or classifies models.
import { z } from "zod";
import { ModelCompanySchema, ModelIdentifierSchema } from "./models.js";
import { StepThinkingLevelSchema as ThinkingLevelSchema } from "./agent-recipe.js";
import { NeedsConfirmationSchema } from "./needs-confirmation.js";
import { forwardReader } from "./forward-reader.js";

export * from "./stage-model-shared.js";
import {StageIdSchema,StageModelRefusalCodeSchema} from "./stage-model-shared.js";
const Revision = z.number().int().min(0);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Instant = z.string().datetime();
const Line = z.string().min(1).max(400).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text");
const SourceId = z.union([z.literal("rovara"), z.literal("personal-chatgpt"), z.string().regex(/^src_[a-z0-9]{20}$/u)]);
/** Only existing same-origin app paths, with no bearer query, fragment or encoded redirect. */
export const StageModelFixHrefSchema = z.string().max(512).regex(/^\/app\/[a-zA-Z0-9_/-]+$/u);
export const StageModelRefusalSchema = z.object({ code: StageModelRefusalCodeSchema, fixHref: StageModelFixHrefSchema.optional() }).strict();
export type StageModelRefusal = z.infer<typeof StageModelRefusalSchema>;
export const StageDifferentFromSchema = z.object({ stage: StageIdSchema, level: z.enum(["model", "vendor"]) }).strict();
export const StageModelChoiceSchema = z.object({
  model: ModelIdentifierSchema.optional(), thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  fallbackModel: ModelIdentifierSchema.optional(), differentFrom: StageDifferentFromSchema.optional(),
}).strict();
export type StageModelChoice = z.infer<typeof StageModelChoiceSchema>;
export const CompanyStageModelOverrideSchema = StageModelChoiceSchema.extend({ locked: z.boolean().default(false) }).strict();
export const STAGE_REFERENCE = { plan_check: "plan", code_review: "build", security_review: "build" } as const;
const CheckingStages = new Set<string>(Object.keys(STAGE_REFERENCE));
/** Validate structural references here; actual callability, independence and permission are server decisions. */
export const StageModelOverridesSchema = z.partialRecord(StageIdSchema, CompanyStageModelOverrideSchema).superRefine((rows, context) => {
  for (const [stage, row] of Object.entries(rows)) {
    if (row === undefined) continue;
    if (row.locked && (row.model === undefined || row.thinkingLevel === undefined)) context.addIssue({ code: "custom", path: [stage], message: "a lock requires model and thinkingLevel (null means model default)" });
    const reference = STAGE_REFERENCE[stage as keyof typeof STAGE_REFERENCE];
    if (row.differentFrom !== undefined && (!CheckingStages.has(stage) || row.differentFrom.stage !== reference)) context.addIssue({ code: "custom", path: [stage, "differentFrom"], message: "invalid stage reference" });
  }
});
export const StageModelCandidateSchema = z.object({
  model: ModelIdentifierSchema, label: Line.max(64), provider: z.string().min(1).max(128),
  company: ModelCompanySchema,
  status: z.enum(["verified", "unverified", "stale", "denied"]), checkedAt: Instant.optional(),
  blockedReason: StageModelRefusalCodeSchema.optional(),
  /** Set only on a Rovara catalog model the account is known not to be able to call (`MODEL_USABILITY`): the picker shows it disabled, with these words (by edition). Advice only; the server refuses nothing because of it. */
  unusableReason: Line.max(300).optional(),
}).strict();
export const EffectiveStageModelSchema = z.object({
  model: ModelIdentifierSchema, sourceId: SourceId, thinkingLevel: ThinkingLevelSchema.nullable(),
  decidedBy: z.enum(["rovara", "company", "project", "person"]), locked: z.boolean(),
  reason: z.enum(["COMPANY_LOCK", "PROJECT_CHOICE", "COMPANY_DEFAULT", "BUILTIN_DEFAULT", "PROJECT_SELECTION", "PROJECT_DEFAULT", "PERSONAL_PLAN_DEFAULT", "RECIPE_DEFAULT", "APPROVED_SAME_MODEL", "DEFAULT_DIFFERENT_COMPANY"]),
  /** A checking step whose default is "a different company than the step it checks" found no other company's model to use, so it runs on the same company's model. Set by the server only. */
  noOtherCompany: z.literal(true).optional(),
  /** The same, but another company's model was usable and failed (for example its account refused it), so the same company's model runs the step. Set by the server only. */
  otherCompanyFailed: z.literal(true).optional(),
}).strict();
const StageRowBase = z.object({
  stage: StageIdSchema, projectChoice: StageModelChoiceSchema.nullable(), companyDefault: StageModelChoiceSchema.nullable(),
  locked: z.boolean(), editable: z.boolean(), candidates: z.array(StageModelCandidateSchema).max(23),
  candidatesState: z.enum(["complete", "unavailable"]), candidatesReason: StageModelRefusalCodeSchema.optional(),
  notice: StageModelRefusalSchema.optional(),
});
export const StageModelRowSchema = z.union([
  StageRowBase.extend({ effective: EffectiveStageModelSchema }).strict(),
  StageRowBase.extend({ refusal: StageModelRefusalSchema }).strict(),
  StageRowBase.extend({ notApplicable: z.literal(true) }).strict(),
]);
export type StageModelRow = z.infer<typeof StageModelRowSchema>;
export const StageModelsResponseSchema = z.object({
  version: z.literal(1), checkedAt: Instant, companyRevision: Revision, projectRevision: Revision,
  process: z.object({ agentId: z.string().min(1).max(128), version: z.number().int().min(1).optional(), draftRevision: Revision.optional(), digest: Digest }).strict(),
  rankingVersion: z.literal("g3-v1"), stages: z.array(StageModelRowSchema).max(7),
}).strict().superRefine((value, context) => {
  if (new Set(value.stages.map((stage) => stage.stage)).size !== value.stages.length) context.addIssue({ code: "custom", path: ["stages"], message: "stages must be unique" });
});
export type StageModelsResponse = z.infer<typeof StageModelsResponseSchema>;
export const StageModelsResponseReaderSchema = forwardReader(StageModelsResponseSchema);
export const StageModelsQuerySchema = z.object({ draft: Revision.optional() }).strict();
export const ModelSelectionPolicyResponseSchema = z.object({ version: z.literal(1), revision: Revision, rankingVersion: z.literal("g3-v1"), stepOverrides: StageModelOverridesSchema, candidates: z.partialRecord(StageIdSchema, z.array(StageModelCandidateSchema).max(23)).optional(), /** Owner decision 2026-11-02: the checking steps whose default, while nothing is set for them, is a different company's model. Said by the server on the company page's read only. */ reviewDefaults: z.partialRecord(StageIdSchema, z.literal("different_company")).optional() }).strict();
export const ModelSelectionPolicyPutSchema = z.object({ version: z.literal(1), requestId: z.uuid(), expectedRevision: Revision, stepOverrides: StageModelOverridesSchema }).strict();
export type ModelSelectionPolicyResponse = z.infer<typeof ModelSelectionPolicyResponseSchema>;
export type ModelSelectionPolicyPut = z.infer<typeof ModelSelectionPolicyPutSchema>;
export const ModelSelectionPolicyResponseReaderSchema = forwardReader(ModelSelectionPolicyResponseSchema);
export const ModelPolicyPreviewRequestSchema = z.object({ version: z.literal(1), expectedRevision: Revision, stepOverrides: StageModelOverridesSchema, cursor: z.string().min(1).max(4096).optional() }).strict();
export const ModelPolicyPreviewResponseSchema = z.object({
  version: z.literal(1), checkedAt: Instant, policyRevision: Revision, mayBeIncomplete: z.literal(true),
  projects: z.array(z.object({ project: z.string().min(1).max(63), impact: z.enum(["unchanged", "changed", "blocked", "unavailable"]), reasonCodes: z.array(StageModelRefusalCodeSchema).max(11) }).strict()).max(5),
  nextCursor: z.string().min(1).max(4096).optional(),
}).strict();
export type ModelPolicyPreviewRequest = z.infer<typeof ModelPolicyPreviewRequestSchema>;
export type ModelPolicyPreviewResponse = z.infer<typeof ModelPolicyPreviewResponseSchema>;
export const ModelPolicyPreviewResponseReaderSchema = forwardReader(ModelPolicyPreviewResponseSchema);
/** Stage editing uses the existing recipe scale; xhigh is NOT a v1.1 stage setting. */
export const STAGE_MODEL_THINKING_LEVELS = ThinkingLevelSchema.options;
export const ModelSelectionPolicyAppliedSchema = z.object({ status:z.literal("APPLIED"),revision:Revision,requestId:z.uuid() }).strict();
export const ModelSelectionPolicyPendingSchema = NeedsConfirmationSchema.extend({ requestId:z.uuid().optional(),confirmationId:z.string().min(1).max(200).optional() }).strict();
export type ModelSelectionPolicyApplied = z.infer<typeof ModelSelectionPolicyAppliedSchema>;
export type ModelSelectionPolicyPending = z.infer<typeof ModelSelectionPolicyPendingSchema>;
export const ModelSelectionPolicyAppliedReaderSchema = forwardReader(ModelSelectionPolicyAppliedSchema);
export const ModelSelectionPolicyPendingReaderSchema = forwardReader(ModelSelectionPolicyPendingSchema);
export const STAGE_OPERATION_MAPPING = {
 UNDERSTAND:{stages:["understand"],stepKind:"plan"},
 SETUP_DRAFT:{stages:["plan"],stepKind:"plan"},
 SETUP_AGENT:{stages:["plan"],stepKind:"plan"},
 SPEC_WRITE:{stages:["plan"],stepKind:"plan"},
 PLAN:{stages:["plan"],stepKind:"plan"},
 PLAN_CRITIQUE:{stages:["plan_check"],stepKind:"plan_critic"},
 IMPLEMENT:{stages:["build"],stepKind:"build"},
 REVIEW:{stages:["code_review","security_review"],stepKind:"review"},
 CHECKS:{stages:[],stepKind:"check"},
 FEEDBACK_REVIEW:{stages:["pull_request"],stepKind:"pull_request"},
} as const;
export const STAGE_EDIT_GROUPS = [["understand","plan"],["plan_check"],["build"],["code_review","security_review"],["pull_request"]] as const;
/** Metadata only: eligibility, lock state, validation and model decisions remain server-owned. */
export const STAGE_EDIT_RULES = {
 understand:{stepKind:"plan",editGroup:"plan",reviewerSlot:null},
 plan:{stepKind:"plan",editGroup:"plan",reviewerSlot:null},
 plan_check:{stepKind:"plan_critic",editGroup:"plan_check",reviewerSlot:null},
 build:{stepKind:"build",editGroup:"build",reviewerSlot:null},
 code_review:{stepKind:"review",editGroup:"review",reviewerSlot:"code"},
 security_review:{stepKind:"review",editGroup:"review",reviewerSlot:"security"},
 pull_request:{stepKind:"pull_request",editGroup:"pull_request",reviewerSlot:null},
} as const;
/** Owner decision 2026-11-02: the one-time notice on How we work that reviews now use a model from a different company. `GET` and `POST /v1/app/org/review-default-notice`; the dismissal is the company's, made by an owner or admin and audited. */
export const ReviewDefaultNoticeAnswerSchema = z.object({ dismissed: z.boolean(), canDismiss: z.boolean() }).strict();
export const ReviewDefaultNoticeBodySchema = z.object({ action: z.literal("dismiss") }).strict();
export type ReviewDefaultNoticeAnswer = z.infer<typeof ReviewDefaultNoticeAnswerSchema>;
export const ReviewDefaultNoticeAnswerReaderSchema = forwardReader(ReviewDefaultNoticeAnswerSchema);
