import { z } from "zod";
import { WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_PROPOSED_CHECKS_MAX, WorkflowCheckProposalSchema, WorkflowFeedbackApprovalBindingSchema, WorkflowReviewBaseSchema } from "./task-workflow.js";
import { ProjectCommandSchema, StoredProjectDefinitionSchema } from "./project.js";
import { ModelSelectionSchema, type ModelSelection } from "./models.js";

export const AGENTX_PROTOCOL_VERSION = 1 as const;

/**
 * Optional invocation fields that this build's worker parses and an older one does not (spec 053).
 * Worker payload schemas are strict, and a running EC2 worker keeps its image until the idle reaper
 * stops it, so an older worker rejects an invocation that carries one of these. A worker reports the
 * list on GET /ping, and the eval runner image release records it beside the image, so the control
 * plane sends such a field only to a build that lists it.
 */
export const WORKER_INVOCATION_FEATURES = ["model.thinkingLevel", "task.readiness", "task.workflowMode", "task.workflowReview", "task.workflowChecks", "task.workflowFeedbackReview", "task.workflowFeedbackApproval", "publish.reportChecks", "task.workflowBase", "publish.candidateTree", "publish.workflowBase", "task.workflowReviewChecks", "task.structuredPlans", "task.workflowReviewPlan", "task.workflowPullRequestUpdate", "task.codeAnchors", "task.workflowReviewFeedback"] as const;
export type WorkerInvocationFeature = (typeof WORKER_INVOCATION_FEATURES)[number];
/** The field on /ping that carries WORKER_INVOCATION_FEATURES; absent on a worker built before it. */
export const WORKER_PING_FEATURES_FIELD = "invocationFeatures";

/** The model as a build with `features` can parse it: the thinking level only where it is listed. */
export function modelSelectionFor(model: ModelSelection, features: readonly string[]): ModelSelection {
  if (model.thinkingLevel === undefined || features.includes("model.thinkingLevel")) return model;
  return { provider: model.provider, modelId: model.modelId };
}

/**
 * What the code and security reviewers are told about the checks: the checks AgentX ran on the change (labels and
 * commands as text, shown to reviewers as untrusted data), or that the change is review only, with the plan's reason.
 * At most the project's required (64) and optional (20) checks plus the plan's proposed ones.
 */
export const WorkflowReviewChecksSchema = z.object({
  reviewOnly: z.boolean(),
  checks: z.array(z.object({ label: z.string().min(1).max(80), command: z.string().min(1).max(1_024) }).strict()).max(64 + 20 + WORKFLOW_PROPOSED_CHECKS_MAX),
  noneReason: WorkflowCheckProposalSchema.shape.noneReason,
}).strict().superRefine((value, context) => {
  if (value.reviewOnly && value.checks.length > 0) context.addIssue({ code: "custom", path: ["checks"], message: "a review-only change ran no checks" });
  if (!value.reviewOnly && value.noneReason !== undefined) context.addIssue({ code: "custom", path: ["noneReason"], message: "a reason for no checks is only for a review-only change" });
});
export type WorkflowReviewChecks = z.infer<typeof WorkflowReviewChecksSchema>;

/**
 * The coding plan the owner approved, as the reviewers read it: its Markdown copy (with AgentX's recommended answers),
 * cut to fit, and the digest of the approved artifact. Shown to reviewers as untrusted data.
 */
export const WorkflowReviewPlanSchema = z.object({
  markdown: z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= WORKFLOW_PLAN_MAX_BYTES, `plan exceeds ${WORKFLOW_PLAN_MAX_BYTES} UTF-8 bytes`),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WorkflowReviewPlan = z.infer<typeof WorkflowReviewPlanSchema>;

/** The most owner-approved PR feedback findings the reviewers are shown, and the most bytes they take as JSON. */
export const WORKFLOW_REVIEW_FEEDBACK_MAX = 20;
export const WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES = 32_768;

/**
 * The fixes the owner approved from pull request feedback since the plan, as the reviewers read them: each approved
 * finding's proposed fix (its summary and file changes) and the owner's note on that decision. Shown to reviewers as
 * untrusted data, with the rule that these changes supersede the plan where they differ.
 */
export const WorkflowReviewFeedbackSchema = z.array(z.object({
  summary: z.string().trim().min(1).max(2_000),
  fileChanges: z.array(z.object({
    repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1_000), change: z.string().trim().min(1).max(4_000),
  }).strict()).max(32),
  ownerNote: z.string().trim().min(1).max(2_000).optional(),
}).strict()).min(1).max(WORKFLOW_REVIEW_FEEDBACK_MAX)
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES, `approved feedback exceeds ${WORKFLOW_REVIEW_FEEDBACK_MAX_BYTES} UTF-8 bytes`);
export type WorkflowReviewFeedback = z.infer<typeof WorkflowReviewFeedbackSchema>;

const InvocationBaseSchema = z.object({
  protocolVersion: z.literal(AGENTX_PROTOCOL_VERSION),
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  fence: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  callbackCapability: z.string().min(32).max(8_192),
});

export const WorkerInvocationSchema = z.discriminatedUnion("kind", [
  InvocationBaseSchema.extend({
    kind: z.literal("prepare"),
    payload: z.object({ project: StoredProjectDefinitionSchema, repositoryGrant: z.string().min(1) }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("task"),
    payload: z
      .object({
        conversationId: z.string().uuid(),
        prompt: z.string().min(1).max(65_536),
        /** The control plane's record that this conversation already owns a saved session. */
        conversationStarted: z.boolean().optional(),
        /** The broker-selected tool boundary for the current native workflow stage (spec 056). */
        workflowMode: z.enum(["PLAN", "IMPLEMENT", "REVIEW", "CHECKS", "FEEDBACK_REVIEW"]).optional(),
        /**
         * The document a planning run writes in the Full path (a Quick plan has none). The worker uses it to read the
         * planner's answer as that kind of plan. Sent only to a worker whose /ping lists "task.structuredPlans"; an older
         * worker is sent the run without it.
         */
        workflowPhase: z.enum(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]).optional(),
        /**
         * The broker asked this planning run for a structured plan (spec 061). Only then does the worker check the answer
         * and ask once more when it cannot be read. Sent only to a worker whose /ping lists "task.structuredPlans".
         */
        planFormat: z.literal("structured").optional(),
        workflowFeedbackReview: z.object({ taskId: z.string().uuid(), workflowRevision: z.number().int().positive(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
        workflowFeedbackApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
        /**
         * The task's pinned base commit per repository (the workflow's reviewBase). The worker records it in the
         * candidate and reviewers see the diff from it. Sent only to a worker whose /ping lists "task.workflowBase".
         */
        workflowBase: WorkflowReviewBaseSchema.optional(),
        /**
         * The checks that ran on the candidate under review, or that it is review only, for the reviewers' prompt.
         * Review operations only. Sent only to a worker whose /ping lists "task.workflowReviewChecks"; an older worker
         * is sent the review without it and reviews as before, without that section.
         */
        workflowReviewChecks: WorkflowReviewChecksSchema.optional(),
        /**
         * The coding plan the owner approved, for the reviewers' prompt. Review operations only. Sent only to a worker
         * whose /ping lists "task.workflowReviewPlan"; an older worker is sent the review without it.
         */
        workflowReviewPlan: WorkflowReviewPlanSchema.optional(),
        /**
         * The fixes the owner approved from pull request feedback since the plan, for the reviewers' prompt. Review
         * operations only. Sent only to a worker whose /ping lists "task.workflowReviewFeedback"; an older worker is sent
         * the review without it.
         */
        workflowReviewFeedback: WorkflowReviewFeedbackSchema.optional(),
        model: ModelSelectionSchema.optional(),
        modelSelectionDiagnostic: z.string().min(1).max(512).optional(),
        /**
         * Spec 051 (P-1): the project's current readiness commands, which the worker reruns when the agent finishes.
         * Optional: a payload from a broker built before it has none, and the worker falls back to the agent's own
         * test commands. Sent only to a worker whose /ping lists "task.readiness". The limit is the project's own.
         */
        readiness: z.array(ProjectCommandSchema).max(64).optional(),
      })
      .strict().superRefine((payload, context) => {
        if ((payload.workflowMode === "FEEDBACK_REVIEW") !== (payload.workflowFeedbackReview !== undefined)) {
          context.addIssue({ code: "custom", path: ["workflowFeedbackReview"], message: "feedback review mode requires its exact task workflow binding" });
        }
        if (payload.workflowPhase !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["workflowPhase"], message: "the document a run writes requires planning mode" });
        }
        if (payload.planFormat !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["planFormat"], message: "the plan format requires planning mode" });
        }
        if (payload.workflowReviewChecks !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewChecks"], message: "the checks reviewers are told about require review mode" });
        }
        if (payload.workflowReviewPlan !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewPlan"], message: "the approved plan reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewFeedback !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewFeedback"], message: "the approved feedback reviewers are shown requires review mode" });
        }
        if (payload.workflowFeedbackApproval !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowFeedbackApproval"], message: "feedback approval binding requires implementation mode" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("publish"),
    payload: z
      .object({
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        title: z.string().min(1).max(256),
        body: z
          .string()
          .refine((value) => !value.includes("\0"), "body contains a NUL character")
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= 32_768,
            "body exceeds 32768 UTF-8 bytes",
          )
          .optional(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        repositoryGrant: z.string().min(1),
        mode: z.enum(["create", "replace", "revert"]).default("create"),
        targetPullRequestNumber: z.number().int().positive().optional(),
        revertCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
        /**
         * Spec 051 (D-7, P-2): the broker opens a draft pull request with a checks section when a check fails, so the
         * worker publishes despite a failing readiness check and reports its checks with the pull request callback.
         * Without it (a broker built before it), a failing check still refuses the publication, as before. Sent only
         * to a worker whose /ping lists "publish.reportChecks".
         */
        reportChecks: z.literal(true).optional(),
        /**
         * The tree the task's checks and reviews passed on. The worker publishes exactly this tree on the task's base and
         * refuses before pushing when the workspace no longer matches it. Sent only to a worker whose /ping lists
         * "publish.candidateTree"; never dropped for an older one.
         */
        candidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * The base commit the broker pinned for the task in this repository: the published commit's only parent, in
         * place of the commit the workspace's (agent-writable) preparation manifest records. Only with candidateTreeSha.
         * Sent only to a worker whose /ping lists "publish.workflowBase"; never dropped for an older one.
         */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.mode === "create" && (value.targetPullRequestNumber !== undefined || value.revertCommit !== undefined)) {
          context.addIssue({ code: "custom", message: "create mode must not target another pull request" });
        }
        if ((value.mode === "replace" || value.mode === "revert") && value.targetPullRequestNumber === undefined) {
          context.addIssue({ code: "custom", message: `${value.mode} mode requires targetPullRequestNumber` });
        }
        if (value.mode === "revert" && value.revertCommit === undefined) {
          context.addIssue({ code: "custom", message: "revert mode requires revertCommit" });
        }
        if (value.mode !== "revert" && value.revertCommit !== undefined) {
          context.addIssue({ code: "custom", message: "revertCommit is allowed only in revert mode" });
        }
        if (value.mode !== "create" && value.candidateTreeSha !== undefined) {
          context.addIssue({ code: "custom", message: "candidateTreeSha is allowed only in create mode" });
        }
        if (value.workflowBaseCommit !== undefined && value.candidateTreeSha === undefined) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit is allowed only with candidateTreeSha" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("maintain"),
    payload: z
      .object({
        action: z.enum(["append", "sync"]),
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        pullRequestNumber: z.number().int().positive(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        baseBranch: z.string().min(1).max(255),
        expectedHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
        repositoryGrant: z.string().min(1),
        /**
         * A workflow task's fix to its pull request: the tree the fix's checks and reviews passed on. The worker pushes
         * exactly this tree, runs no readiness checks again, and refuses before pushing when the workspace no longer
         * matches it. Sent only to a worker whose /ping lists "task.workflowPullRequestUpdate".
         */
        workflowCandidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /** The base commit the broker pinned for the task in this repository; it must be in the workspace's history. Always and only with workflowCandidateTreeSha. */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.workflowCandidateTreeSha !== undefined && value.action !== "append") {
          context.addIssue({ code: "custom", message: "workflowCandidateTreeSha is allowed only with append" });
        }
        // A reviewed fix is pushed only with the task's base, so its base ancestry is always checked.
        if ((value.workflowBaseCommit === undefined) !== (value.workflowCandidateTreeSha === undefined)) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit and workflowCandidateTreeSha go together" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("cancel"),
    payload: z.object({ targetOperationId: z.string().uuid() }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("resume"), payload: z.object({}).strict() }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("close"), payload: z.object({}).strict() }).strict(),
]);

export const WorkerAcknowledgementSchema = z
  .object({ accepted: z.boolean(), operationId: z.string().uuid(), status: z.string().min(1) })
  .strict();

export type WorkerInvocation = z.infer<typeof WorkerInvocationSchema>;
