import { createHash } from "node:crypto";
import { z } from "zod";
import { ProjectCommandSchema } from "./project.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ActorIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WORKFLOW_PLAN_MAX_BYTES = 32_768;

const CandidateRepositorySchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type CandidateRepository = z.infer<typeof CandidateRepositorySchema>;

export const CandidateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  repositories: z.array(CandidateRepositorySchema).min(1).max(32),
  digest: DigestSchema,
}).strict().superRefine((manifest, context) => {
  const sorted = [...manifest.repositories].sort((a, b) => a.repositoryId < b.repositoryId ? -1 : a.repositoryId > b.repositoryId ? 1 : 0);
  if (new Set(sorted.map((repository) => repository.repositoryId)).size !== sorted.length) {
    context.addIssue({ code: "custom", path: ["repositories"], message: "candidate repository identities must be unique" });
  }
  const canonical = JSON.stringify({ schemaVersion: 1, repositories: sorted });
  const digest = createHash("sha256").update(canonical).digest("hex");
  if (digest !== manifest.digest) context.addIssue({ code: "custom", path: ["digest"], message: "candidate digest does not match its canonical repository manifest" });
});
export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;

const VerificationResultsSchema = z.object({
  candidateDigest: DigestSchema,
  producer: z.string().trim().min(1).max(120),
  environmentId: z.string().trim().min(1).max(160),
  recordedAt: z.string().datetime(),
  results: z.array(z.object({
    checkId: z.string().trim().min(1).max(120),
    status: z.enum(["PASS", "FAILED", "UNKNOWN"]),
  }).strict()).min(1).max(100),
}).strict();
export type WorkflowVerificationResults = z.infer<typeof VerificationResultsSchema>;

export const WorkflowReviewReportSchema = z.object({
  operationId: z.string().uuid(),
  candidateDigest: DigestSchema,
  role: z.enum(["CRITIC", "SECURITY"]),
  provider: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(120),
  status: z.enum(["PASS", "FINDINGS", "FAILED", "INTERRUPTED", "UNKNOWN"]),
  findings: z.array(z.string().trim().min(1).max(1000)).max(50),
  readOnly: z.literal(true),
  recordedAt: z.string().datetime(),
}).strict();
export type WorkflowReviewReport = z.infer<typeof WorkflowReviewReportSchema>;

const WorkflowPullRequestSchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  number: z.number().int().positive(),
  url: z.string().url().max(2048),
  candidateDigest: DigestSchema,
  required: z.boolean(),
  state: z.enum(["UNKNOWN", "OPEN", "CLOSED", "MERGED"]),
  observedAt: z.string().datetime().optional(),
}).strict();
export type WorkflowPullRequest = z.infer<typeof WorkflowPullRequestSchema>;

const WorkflowFeedbackSchema = z.object({
  feedbackId: DigestSchema,
  repositoryId: z.string().trim().min(1).max(200),
  number: z.number().int().positive(),
  candidateDigest: DigestSchema,
  comments: z.array(z.object({ id: z.string().trim().min(1).max(80), url: z.string().url().max(2048), author: z.string().trim().min(1).max(100), body: z.string().max(8_000), updatedAt: z.string().datetime().optional() }).strict()).min(1).max(20),
  proposedPlan: z.string().trim().min(1).max(2_000),
  planDigest: DigestSchema,
  status: z.enum(["PENDING", "APPROVED", "DISMISSED"]),
  recordedAt: z.string().datetime(),
}).strict();
export type WorkflowFeedback = z.infer<typeof WorkflowFeedbackSchema>;

/** References contain bounded provenance and source identities, never comment/report bodies. */
const FeedbackIdSchema = z.string().trim().min(1).max(128);
const FeedbackObjectKeySchema = z.string().min(1).max(1024).refine(key => !key.startsWith("/") && !key.split("/").includes(".."));
const FeedbackCommentRefSchema = z.object({
  id: FeedbackIdSchema, threadId: FeedbackIdSchema.optional(),
  kind: z.enum(["REVIEW", "REVIEW_COMMENT", "DISCUSSION"]),
  url: z.string().url().max(2048), author: z.string().trim().min(1).max(100),
  updatedAt: z.string().datetime(), bodyDigest: DigestSchema, bodyBytes: z.number().int().nonnegative().max(1_000_000),
  path: z.string().max(1024).optional(), line: z.number().int().positive().optional(),
}).strict();
const WorkflowFeedbackBundleMetadataSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().uuid(), repositoryId: z.string().trim().min(1).max(200),
  number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/), candidateDigest: DigestSchema,
  commentSetDigest: DigestSchema,
  producer: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(120), recordedAt: z.string().datetime(),
  comments: z.array(FeedbackCommentRefSchema).max(128),
}).strict().refine(b => new Set(b.comments.map(c => c.id)).size === b.comments.length, "comment IDs must be unique within a bundle");
export const WorkflowFeedbackBundleRefSchema = WorkflowFeedbackBundleMetadataSchema.safeExtend({
  sha256: DigestSchema, objectKey: FeedbackObjectKeySchema,
}).refine(b => b.objectKey.includes(b.sha256), "feedback artifact key must contain its content digest");
export type WorkflowFeedbackBundleRef = z.infer<typeof WorkflowFeedbackBundleRefSchema>;
export const WorkflowFeedbackBundleSchema = WorkflowFeedbackBundleMetadataSchema.safeExtend({
  comments: z.array(FeedbackCommentRefSchema.extend({ body: z.string().max(1_000_000) })).max(128),
  sourceDeliveryIds: z.array(FeedbackIdSchema).max(100),
}).superRefine((bundle, context) => {
  if (createHash("sha256").update(JSON.stringify(bundle.comments), "utf8").digest("hex") !== bundle.commentSetDigest) {
    context.addIssue({ code: "custom", path: ["commentSetDigest"], message: "comment set does not match its digest" });
  }
  bundle.comments.forEach((comment, index) => {
    if (createHash("sha256").update(comment.body, "utf8").digest("hex") !== comment.bodyDigest
      || Buffer.byteLength(comment.body, "utf8") !== comment.bodyBytes) {
      context.addIssue({ code: "custom", path: ["comments", index], message: "comment body does not match its digest and byte metadata" });
    }
  });
});
export type WorkflowFeedbackBundle = z.infer<typeof WorkflowFeedbackBundleSchema>;
export const WorkflowFeedbackPrioritySchema = z.enum(["MUST_FIX", "SHOULD_FIX", "OPTIONAL"]);
export const WorkflowFeedbackAssessmentSchema = z.enum(["ACTIONABLE", "ALREADY_ADDRESSED", "STALE", "TECHNICALLY_INCORRECT", "OUT_OF_SCOPE", "CONFLICTING", "NEEDS_OWNER_DECISION"]);
export const WorkflowFeedbackFindingRefSchema = z.object({
  id: FeedbackIdSchema, bundleDigest: DigestSchema,
  commentIds: z.array(FeedbackIdSchema).min(1).max(128).refine(ids => new Set(ids).size === ids.length),
  priority: WorkflowFeedbackPrioritySchema, assessment: WorkflowFeedbackAssessmentSchema, recommended: z.boolean(),
}).strict();
export type WorkflowFeedbackFindingRef = z.infer<typeof WorkflowFeedbackFindingRefSchema>;
export const WorkflowFeedbackFindingSchema = WorkflowFeedbackFindingRefSchema.extend({
  evidence: z.array(z.object({ source: z.string().trim().min(1).max(100), reference: z.string().trim().min(1).max(2048) }).strict()).min(1).max(50),
  rationale: z.string().trim().min(1).max(16_000),
  confidence: z.object({ level: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]), reason: z.string().trim().min(1).max(2000) }).strict(),
  proposedDisposition: z.enum(["IMPLEMENT", "SKIP", "OWNER_DECISION"]),
});
export type WorkflowFeedbackFinding = z.infer<typeof WorkflowFeedbackFindingSchema>;
const WorkflowFeedbackCandidateBindingSchema = z.object({
  repositoryId: z.string().trim().min(1).max(200), number: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), candidateDigest: DigestSchema,
  commentSetDigest: DigestSchema, bundleDigest: DigestSchema,
}).strict();
const WorkflowFeedbackReviewMetadataSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().uuid(),
  workflowRevision: z.number().int().positive(), operationMode: z.literal("FEEDBACK_REVIEW"),
  qualification: z.literal("AI_GENERATED_ADVISORY"),
  proposalDigest: DigestSchema, taskRequirementsDigest: DigestSchema,
  candidateBindings: z.array(WorkflowFeedbackCandidateBindingSchema).min(1).max(32),
  operationId: z.string().uuid(),
  provider: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(120),
  status: z.enum(["COMPLETE", "BLOCKED", "FAILED", "INTERRUPTED", "UNKNOWN"]),
  blockReason: z.string().trim().min(1).max(1000).optional(),
  bundleDigests: z.array(DigestSchema).min(1).max(32).refine(ids => new Set(ids).size === ids.length),
  findingRefs: z.array(WorkflowFeedbackFindingRefSchema).max(128), recordedAt: z.string().datetime(),
}).strict().refine(r => new Set(r.findingRefs.map(f => f.id)).size === r.findingRefs.length, "finding IDs must be unique")
  .refine(r => r.findingRefs.every(f => r.bundleDigests.includes(f.bundleDigest)), "findings must name one input bundle")
  .refine(r => new Set(r.candidateBindings.map(binding => `${binding.repositoryId}:${binding.number}`)).size === r.candidateBindings.length
    && r.candidateBindings.length === r.bundleDigests.length
    && r.bundleDigests.every(digest => r.candidateBindings.some(binding => binding.bundleDigest === digest)),
  "review candidate bindings must match every input bundle exactly")
  .refine(r => r.status === "COMPLETE" ? r.blockReason === undefined : r.blockReason !== undefined,
    "incomplete reviews must explain why they are blocked");
export const WorkflowFeedbackReviewRefSchema = WorkflowFeedbackReviewMetadataSchema.safeExtend({
  sha256: DigestSchema, objectKey: FeedbackObjectKeySchema,
}).refine(r => r.objectKey.includes(r.sha256), "review artifact key must contain its content digest");
export type WorkflowFeedbackReviewRef = z.infer<typeof WorkflowFeedbackReviewRefSchema>;
export const WorkflowFeedbackReviewReportSchema = WorkflowFeedbackReviewMetadataSchema.safeExtend({
  findings: z.array(WorkflowFeedbackFindingSchema).max(128),
}).superRefine((report, context) => {
  if (report.findings.length !== report.findingRefs.length || report.findings.some((finding, index) =>
    JSON.stringify(WorkflowFeedbackFindingRefSchema.strip().parse(finding)) !== JSON.stringify(report.findingRefs[index]))) {
    context.addIssue({ code: "custom", message: "report findings must exactly match their immutable references" });
  }
});
export type WorkflowFeedbackReviewReport = z.infer<typeof WorkflowFeedbackReviewReportSchema>;
export const WorkflowFeedbackNoteSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), actorId: ActorIdSchema,
  source: z.enum(["THREAD_REPLY", "REQUEST_CHANGES", "DISMISS"]), sourceId: FeedbackIdSchema,
  text: z.string().trim().min(1).max(2000), at: z.string().datetime(),
}).strict();
export type WorkflowFeedbackNote = z.infer<typeof WorkflowFeedbackNoteSchema>;
export const WorkflowFeedbackDecisionSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), workflowRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "DISMISS"]), actorId: ActorIdSchema, actorRole: z.literal("TASK_OWNER"),
  reviewDigest: DigestSchema, proposalDigest: DigestSchema, bundleDigests: z.array(DigestSchema).min(1).max(32),
  selectedFindingIds: z.array(FeedbackIdSchema).max(128), selectedCommentIds: z.array(FeedbackIdSchema).max(4096),
  candidates: z.array(WorkflowFeedbackCandidateBindingSchema).max(32), ownerNote: z.string().trim().min(1).max(2000).optional(), at: z.string().datetime(),
}).strict().superRefine((decision, context) => {
  if (new Set(decision.selectedFindingIds).size !== decision.selectedFindingIds.length
    || new Set(decision.selectedCommentIds).size !== decision.selectedCommentIds.length
    || new Set(decision.bundleDigests).size !== decision.bundleDigests.length
    || (decision.decision === "APPROVE" && (!decision.selectedFindingIds.length || !decision.selectedCommentIds.length || !decision.candidates.length))
    || (decision.decision !== "APPROVE" && (decision.ownerNote === undefined || decision.selectedFindingIds.length > 0 || decision.selectedCommentIds.length > 0 || decision.candidates.length > 0))) {
    context.addIssue({ code: "custom", message: "feedback decision selection or reason is invalid" });
  }
});
export type WorkflowFeedbackDecision = z.infer<typeof WorkflowFeedbackDecisionSchema>;
const ReviewedWorkflowFeedbackSchema = z.object({
  bundleRefs: z.array(WorkflowFeedbackBundleRefSchema).min(1).max(32), reviewRef: WorkflowFeedbackReviewRefSchema,
  status: z.enum(["PENDING", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
}).strict().superRefine((review, context) => {
  const digests = review.bundleRefs.map(b => b.sha256);
  const prIds = review.bundleRefs.map(b => `${b.repositoryId}:${b.number}`);
  if (new Set(digests).size !== digests.length || new Set(prIds).size !== prIds.length
    || digests.length !== review.reviewRef.bundleDigests.length || !digests.every(d => review.reviewRef.bundleDigests.includes(d))
    || review.bundleRefs.some(b => b.taskId !== review.reviewRef.taskId)) {
    context.addIssue({ code: "custom", message: "review inputs must match the unique task PR bundle set" });
  }
  for (const bundle of review.bundleRefs) {
    const binding = review.reviewRef.candidateBindings.find(candidate => candidate.bundleDigest === bundle.sha256);
    if (binding === undefined || binding.repositoryId !== bundle.repositoryId || binding.number !== bundle.number
      || binding.headSha !== bundle.headSha || binding.candidateDigest !== bundle.candidateDigest
      || binding.commentSetDigest !== bundle.commentSetDigest) {
      context.addIssue({ code: "custom", message: "review candidate bindings must match each immutable bundle" });
    }
    const findings = review.reviewRef.findingRefs.filter(f => f.bundleDigest === bundle.sha256);
    const ids = findings.flatMap(f => f.commentIds);
    if (ids.some(id => !bundle.comments.some(c => c.id === id))
      || (review.reviewRef.status === "COMPLETE" && bundle.comments.some(c => !ids.includes(c.id)))) {
      context.addIssue({ code: "custom", message: "review must account for every comment within exactly one PR candidate" });
    }
  }
});

export const WorkflowFeedbackThreadObservationSchema = z.object({
  repositoryId: z.string().min(1).max(200), number: z.number().int().positive(),
  threadId: FeedbackIdSchema, resolved: z.boolean(),
  comments: z.array(z.object({ id: FeedbackIdSchema, updatedAt: z.string().datetime(), bodyDigest: DigestSchema }).strict()).max(128),
  eligibleCommentIds: z.array(FeedbackIdSchema).max(128),
}).strict();
export type WorkflowFeedbackThreadObservation = z.infer<typeof WorkflowFeedbackThreadObservationSchema>;
const FeedbackThreadObservationsSchema = z.array(WorkflowFeedbackThreadObservationSchema).max(4096);
const WorkflowFeedbackReviewSchema = z.union([
  z.object({ status: z.literal("COLLECTING"), bundleRefs: z.array(WorkflowFeedbackBundleRefSchema).min(1).max(32),
    threadObservations: FeedbackThreadObservationsSchema,
    reviewRef: z.undefined().optional(),
  }).strict().superRefine((review, ctx) => {
    if (new Set(review.bundleRefs.map(b => `${b.repositoryId}:${b.number}`)).size !== review.bundleRefs.length) {
      ctx.addIssue({ code: "custom", message: "collected bundles must name unique PRs" });
    }
  }),
  ReviewedWorkflowFeedbackSchema.safeExtend({ threadObservations: FeedbackThreadObservationsSchema.optional() }),
]);

/** Creates AgentX's canonical candidate identity; callers cannot supply or override its digest. */
export function createCandidateManifest(input: readonly CandidateRepository[]): CandidateManifest {
  const repositories = z.array(CandidateRepositorySchema).min(1).max(32).safeParse(input);
  if (!repositories.success) throw new WorkflowTransitionError("candidate repository identity is invalid");
  const sorted = [...repositories.data].sort((a, b) => a.repositoryId < b.repositoryId ? -1 : a.repositoryId > b.repositoryId ? 1 : 0);
  if (new Set(sorted.map((repository) => repository.repositoryId)).size !== sorted.length) {
    throw new WorkflowTransitionError("candidate repository identities must be unique");
  }
  const canonical = JSON.stringify({ schemaVersion: 1, repositories: sorted });
  return CandidateManifestSchema.parse({
    schemaVersion: 1,
    repositories: sorted,
    digest: createHash("sha256").update(canonical).digest("hex"),
  });
}

export const WorkflowStageSchema = z.enum([
  "PLAN",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "VERIFY",
  "REVIEW",
  "PULL_REQUEST",
  "WAIT_FOR_MERGE",
  "MERGED",
  "CLOSED",
]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const WorkflowStateSchema = z.enum(["READY", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const WorkflowArtifactSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["requirements", "design", "plan", "test_plan", "review_report"]),
  version: z.number().int().positive(),
  sha256: DigestSchema,
  producer: z.string().min(1).max(120),
  objectKey: z.string().min(1).max(1024).refine((key) => !key.startsWith("/") && !key.split("/").includes("..")),
  createdAt: z.string().datetime(),
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

export const WorkflowDecisionSchema = z.object({
  requestId: z.string().uuid(),
  workflowRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]),
  actorId: ActorIdSchema,
  actorRole: z.enum(["TASK_OWNER", "PROJECT_ADMIN"]),
  reason: z.string().trim().min(1).max(500),
  artifactDigest: DigestSchema.optional(),
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
  at: z.string().datetime(),
}).strict();
export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;

const WorkflowCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  command: ProjectCommandSchema,
}).strict();
export const WorkflowCheckPolicySchema = z.object({
  required: z.array(WorkflowCheckSchema).max(64),
  optional: z.array(WorkflowCheckSchema).max(20),
  selectedOptionalIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20),
}).strict().superRefine((policy, context) => {
  const ids = [...policy.required, ...policy.optional].map((check) => check.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["optional"], message: "workflow check IDs must be unique" });
  if (new Set(policy.selectedOptionalIds).size !== policy.selectedOptionalIds.length
    || policy.selectedOptionalIds.some((id) => !policy.optional.some((check) => check.id === id))) {
    context.addIssue({ code: "custom", path: ["selectedOptionalIds"], message: "selected optional checks must be unique and project-approved" });
  }
});
export type WorkflowCheckPolicy = z.infer<typeof WorkflowCheckPolicySchema>;

export const WorkflowPathSchema = z.enum(["QUICK", "FULL"]);
export const WorkflowReviewPhaseSchema = z.enum(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]);
export type WorkflowPath = z.infer<typeof WorkflowPathSchema>;
export type WorkflowReviewPhase = z.infer<typeof WorkflowReviewPhaseSchema>;

export const WorkflowSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  definitionId: z.literal("agentx-task-to-pr"),
  definitionVersion: z.literal("1.0.0"),
  taskId: z.string().uuid(),
  ownerId: ActorIdSchema,
  path: WorkflowPathSchema.default("QUICK"),
  reviewPhase: WorkflowReviewPhaseSchema.optional(),
  revision: z.number().int().positive(),
  stage: WorkflowStageSchema,
  state: WorkflowStateSchema,
  blockReason: z.string().max(500).optional(),
  outcome: z.enum(["PASSED", "SKIPPED", "CHANGES_REQUESTED", "REJECTED", "MERGED", "CLOSED"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  artifacts: z.array(WorkflowArtifactSchema).max(100),
  decisions: z.array(WorkflowDecisionSchema).max(100),
  checkPolicy: WorkflowCheckPolicySchema.optional(),
  candidate: CandidateManifestSchema.optional(),
  verification: VerificationResultsSchema.optional(),
  reviews: z.array(WorkflowReviewReportSchema).max(2).optional(),
  pullRequests: z.array(WorkflowPullRequestSchema).max(32).optional(),
  feedback: WorkflowFeedbackSchema.optional(),
  feedbackReview: WorkflowFeedbackReviewSchema.optional(),
  feedbackReviewHistory: z.array(WorkflowFeedbackReviewRefSchema).max(100).optional(),
  feedbackDecisions: z.array(WorkflowFeedbackDecisionSchema).max(100).optional(),
  feedbackNotes: z.array(WorkflowFeedbackNoteSchema).max(100).optional(),
}).superRefine((workflow, context) => {
  const feedbackMetadata = { feedbackReview: workflow.feedbackReview, feedbackDecisions: workflow.feedbackDecisions, feedbackNotes: workflow.feedbackNotes, feedbackReviewHistory: workflow.feedbackReviewHistory };
  if (Buffer.byteLength(JSON.stringify(feedbackMetadata), "utf8") > 262_144) {
    context.addIssue({ code: "custom", message: "feedback metadata exceeds the task snapshot storage budget" });
  }
  if (workflow.feedbackReview?.reviewRef?.taskId !== undefined && workflow.feedbackReview.reviewRef.taskId !== workflow.taskId) {
    context.addIssue({ code: "custom", message: "feedback review must belong to this task" });
  }
  if (workflow.feedbackReview?.bundleRefs.some(b => b.taskId !== workflow.taskId)) {
    context.addIssue({ code: "custom", message: "collected bundles must belong to this task" });
  }
  if (workflow.path === "FULL" && workflow.reviewPhase === undefined) {
    context.addIssue({ code: "custom", path: ["reviewPhase"], message: "full workflow must name the current approval phase" });
  }
  const atOrAfterPrReady = ["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(workflow.stage);
  if (atOrAfterPrReady) {
    const currentDigest = workflow.candidate?.digest;
    const checksPass = currentDigest !== undefined && workflow.verification?.candidateDigest === currentDigest
      && workflow.verification.results.length > 0
      && workflow.verification.results.every((result) => result.status === "PASS");
    const reviewsPass = currentDigest !== undefined && (["CRITIC", "SECURITY"] as const).every((role) =>
      workflow.reviews?.some((review) => review.role === role && review.status === "PASS" && review.candidateDigest === currentDigest) === true);
    if (!checksPass) context.addIssue({ code: "custom", path: ["verification"], message: "PR readiness requires passing checks for the current candidate" });
    if (!reviewsPass) context.addIssue({ code: "custom", path: ["reviews"], message: "PR readiness requires critic and security passes for the current candidate" });
  }
  if (workflow.stage === "PULL_REQUEST" && workflow.state !== "READY") {
    context.addIssue({ code: "custom", path: ["state"], message: "pull request stage must be ready" });
  }
  if (workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED") {
    const pullRequests = workflow.pullRequests ?? [];
    const required = pullRequests.filter((pullRequest) => pullRequest.required);
    if (required.length === 0 || workflow.candidate === undefined
      || pullRequests.some((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest)
      || workflow.candidate.repositories.some((repository) => !required.some((pullRequest) => pullRequest.repositoryId === repository.repositoryId))) {
      context.addIssue({ code: "custom", path: ["pullRequests"], message: "merge tracking requires candidate-bound required pull requests" });
    }
    if (workflow.stage === "MERGED" && (workflow.state !== "COMPLETE" || workflow.outcome !== "MERGED"
      || required.some((pullRequest) => pullRequest.state !== "MERGED"))) {
      context.addIssue({ code: "custom", path: ["pullRequests"], message: "merged stage requires every required pull request to be observed merged" });
    }
  }
  if (workflow.feedback?.status === "PENDING" && (!workflow.pullRequests?.some((pullRequest) => pullRequest.repositoryId === workflow.feedback?.repositoryId
    && pullRequest.number === workflow.feedback.number && pullRequest.candidateDigest === workflow.feedback.candidateDigest)
    || workflow.candidate?.digest !== workflow.feedback.candidateDigest)) {
    context.addIssue({ code: "custom", path: ["feedback"], message: "PR feedback must match a current candidate pull request" });
  }
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

export const WorkflowDecisionRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]),
  reason: z.string().trim().min(1).max(500),
  artifactDigest: DigestSchema.optional(),
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
}).strict().refine((request) => request.artifactDigest !== undefined, { message: "a workflow decision must name the current artifact digest", path: ["artifactDigest"] })
  .superRefine((request, context) => {
    if (request.selectedOptionalCheckIds !== undefined && new Set(request.selectedOptionalCheckIds).size !== request.selectedOptionalCheckIds.length) {
      context.addIssue({ code: "custom", path: ["selectedOptionalCheckIds"], message: "selected optional checks must be unique" });
    }
  });
export type WorkflowDecisionRequest = z.infer<typeof WorkflowDecisionRequestSchema>;

export const WorkflowFeedbackDecisionRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  candidateDigest: DigestSchema,
  feedbackId: DigestSchema,
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
}).strict();
export type WorkflowFeedbackDecisionRequest = z.infer<typeof WorkflowFeedbackDecisionRequestSchema>;

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

function validatedCandidate(input: unknown): CandidateManifest {
  const parsed = CandidateManifestSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowTransitionError("candidate manifest is invalid");
  const recomputed = createCandidateManifest(parsed.data.repositories);
  if (recomputed.digest !== parsed.data.digest) throw new WorkflowTransitionError("candidate manifest digest is invalid");
  return recomputed;
}

export function recordWorkflowVerification(
  currentInput: unknown,
  input: { candidate: CandidateManifest; checks: WorkflowVerificationResults; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "VERIFY" || (current.state !== "BLOCKED" && current.state !== "WAITING")) {
    throw new WorkflowTransitionError("workflow is not waiting for candidate verification");
  }
  const candidate = validatedCandidate(input.candidate);
  const checks = VerificationResultsSchema.safeParse(input.checks);
  if (!checks.success || checks.data.candidateDigest !== candidate.digest) {
    throw new WorkflowTransitionError("verification results do not match the current candidate");
  }
  const passed = checks.data.results.every((result) => result.status === "PASS");
  const candidateChanged = current.candidate?.digest !== candidate.digest;
  const { blockReason: _priorBlockReason, ...withoutBlockReason } = current;
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    state: passed ? "WAITING" : "BLOCKED",
    stage: passed ? "REVIEW" : "VERIFY",
    ...(passed ? {} : { blockReason: "candidate checks failed or have unknown results" }),
    candidate,
    verification: checks.data,
    // A new candidate invalidates every prior review report.
    reviews: candidateChanged ? [] : current.reviews ?? [],
    updatedAt: input.now,
  });
}

export function submitWorkflowReview(currentInput: unknown, reportInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const report = WorkflowReviewReportSchema.safeParse(reportInput);
  if (!report.success || current.stage !== "REVIEW" || current.candidate === undefined || current.verification === undefined) {
    throw new WorkflowTransitionError("workflow is not ready to record candidate reviews");
  }
  if (report.data.candidateDigest !== current.candidate.digest || current.verification.candidateDigest !== current.candidate.digest) {
    throw new WorkflowTransitionError("review report does not match the current verified candidate");
  }
  const reviews = [...(current.reviews ?? []).filter((entry) => entry.role !== report.data.role), report.data];
  const complete = (["CRITIC", "SECURITY"] as const).every((role) => reviews.some((entry) => entry.role === role && entry.status === "PASS"));
  const failed = reviews.some((entry) => entry.status !== "PASS");
  const { blockReason: _priorBlockReason, ...withoutBlockReason } = current;
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    stage: complete ? "PULL_REQUEST" : "REVIEW",
    state: complete ? "READY" : failed ? "BLOCKED" : "WAITING",
    ...(complete ? {} : failed ? { blockReason: `the ${report.data.role.toLowerCase()} review did not pass` } : {}),
    reviews,
    updatedAt: now,
  });
}

export function recordExpectedWorkflowPullRequests(currentInput: unknown, pullRequestsInput: readonly Omit<WorkflowPullRequest, "state" | "observedAt">[], now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const parsed = z.array(WorkflowPullRequestSchema.omit({ state: true, observedAt: true }))
    .min(1).max(32)
    .refine((pullRequests) => pullRequests.some((pullRequest) => pullRequest.required), "at least one pull request must be required")
    .safeParse(pullRequestsInput);
  if (!parsed.success || current.stage !== "PULL_REQUEST" || current.state !== "READY" || current.candidate === undefined) {
    throw new WorkflowTransitionError("workflow is not ready to record its expected pull requests");
  }
  const repositories = new Set<string>();
  for (const pullRequest of parsed.data) {
    if (repositories.has(pullRequest.repositoryId) || pullRequest.candidateDigest !== current.candidate.digest
      || !current.candidate.repositories.some((repository) => repository.repositoryId === pullRequest.repositoryId)) {
      throw new WorkflowTransitionError("pull request set does not match the current candidate repositories");
    }
    repositories.add(pullRequest.repositoryId);
  }
  return WorkflowSnapshotSchema.parse({
    ...current,
    revision: current.revision + 1,
    stage: "WAIT_FOR_MERGE",
    state: "WAITING",
    pullRequests: parsed.data.map((pullRequest) => ({ ...pullRequest, state: "UNKNOWN" })),
    updatedAt: now,
  });
}

/** Adds each successfully created candidate PR; multi-repository workflows wait until the full candidate set exists. */
export function registerWorkflowPullRequest(currentInput: unknown, pullRequestInput: Omit<WorkflowPullRequest, "state" | "observedAt">, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const parsed = WorkflowPullRequestSchema.omit({ state: true, observedAt: true }).safeParse(pullRequestInput);
  if (!parsed.success || current.stage !== "PULL_REQUEST" || current.state !== "READY" || current.candidate === undefined
    || parsed.data.candidateDigest !== current.candidate.digest
    || !current.candidate.repositories.some((repository) => repository.repositoryId === parsed.data.repositoryId)
    || parsed.data.required !== true) {
    throw new WorkflowTransitionError("pull request does not match the ready workflow candidate");
  }
  const existing = current.pullRequests ?? [];
  if (existing.some((entry) => entry.repositoryId === parsed.data.repositoryId || entry.number === parsed.data.number)) {
    throw new WorkflowTransitionError("workflow already has a pull request for this repository or number");
  }
  const pullRequests = [...existing, { ...parsed.data, state: "UNKNOWN" as const }];
  const completeSet = current.candidate.repositories.every((repository) => pullRequests.some((entry) => entry.required && entry.repositoryId === repository.repositoryId));
  return WorkflowSnapshotSchema.parse({
    ...current,
    revision: current.revision + 1,
    stage: completeSet ? "WAIT_FOR_MERGE" : "PULL_REQUEST",
    state: completeSet ? "WAITING" : "READY",
    pullRequests,
    updatedAt: now,
  });
}

export function observeWorkflowPullRequest(currentInput: unknown, observationInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const observation = z.object({
    repositoryId: z.string().trim().min(1).max(200),
    number: z.number().int().positive(),
    candidateDigest: DigestSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED", "UNKNOWN"]),
    source: z.literal("GITHUB_API"),
    observedAt: z.string().datetime(),
  }).strict().safeParse(observationInput);
  if (!observation.success || (current.stage !== "WAIT_FOR_MERGE" && current.stage !== "MERGED") || current.pullRequests === undefined) {
    throw new WorkflowTransitionError("workflow is not waiting for GitHub pull request observations");
  }
  const existing = current.pullRequests.find((pullRequest) => pullRequest.repositoryId === observation.data.repositoryId
    && pullRequest.number === observation.data.number);
  if (existing === undefined || existing.candidateDigest !== observation.data.candidateDigest) {
    throw new WorkflowTransitionError("GitHub observation does not match an expected candidate pull request");
  }
  const pullRequests = current.pullRequests.map((pullRequest) => pullRequest === existing
    ? { ...pullRequest, state: observation.data.state, observedAt: observation.data.observedAt }
    : pullRequest);
  const complete = pullRequests.filter((pullRequest) => pullRequest.required).every((pullRequest) => pullRequest.state === "MERGED");
  const { outcome: _priorOutcome, ...withoutPriorOutcome } = current;
  return WorkflowSnapshotSchema.parse({
    ...withoutPriorOutcome,
    revision: current.revision + 1,
    stage: complete ? "MERGED" : "WAIT_FOR_MERGE",
    state: complete ? "COMPLETE" : "WAITING",
    ...(complete ? { outcome: "MERGED" as const } : {}),
    pullRequests,
    updatedAt: now,
  });
}

/** Records untrusted PR comments against the linked PR and current candidate; comments never start code. */
export function requestWorkflowFeedback(currentInput: unknown, input: {
  feedbackId: string;
  repositoryId: string;
  number: number;
  candidateDigest: string;
  comments: WorkflowFeedback["comments"];
  proposedPlan: string;
}, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.candidate?.digest !== input.candidateDigest
    || !current.pullRequests?.some((pullRequest) => pullRequest.repositoryId === input.repositoryId && pullRequest.number === input.number
      && pullRequest.candidateDigest === input.candidateDigest && pullRequest.state !== "MERGED")) {
    throw new WorkflowTransitionError("PR feedback does not match an open pull request on the current candidate");
  }
  const plan = input.proposedPlan.trim();
  const feedback = WorkflowFeedbackSchema.parse({ ...input, proposedPlan: plan, planDigest: createHash("sha256").update(plan, "utf8").digest("hex"), status: "PENDING", recordedAt: now });
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedback, updatedAt: now });
}

/** Invalidates a pending approval when the exact linked GitHub comment is deleted. */
export function dismissDeletedWorkflowFeedback(currentInput: unknown, commentId: string, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.feedback?.status !== "PENDING" || !current.feedback.comments.some((comment) => comment.id === commentId)) return current;
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedback: { ...current.feedback, status: "DISMISSED" }, updatedAt: now });
}

/** Approves or dismisses the exact feedback set and plan. Only an owner approval can start code work. */
export function decideWorkflowFeedback(currentInput: unknown, input: {
  requestId: string;
  expectedRevision: number;
  candidateDigest: string;
  feedbackId: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
}, actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" }, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const requestId = z.string().uuid().safeParse(input.requestId);
  const actorId = ActorIdSchema.safeParse(actor.actorId);
  const feedback = current.feedback;
  if (!requestId.success || !actorId.success || actor.role !== "TASK_OWNER" || actor.actorId !== current.ownerId) {
    throw new WorkflowTransitionError("only the task owner can decide PR feedback");
  }
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.revision !== input.expectedRevision
    || feedback === undefined || feedback.status !== "PENDING" || feedback.feedbackId !== input.feedbackId
    || feedback.candidateDigest !== input.candidateDigest || current.candidate?.digest !== input.candidateDigest) {
    throw new WorkflowTransitionError("PR feedback approval is stale or no longer pending");
  }
  if (current.decisions.some((decision) => decision.requestId === input.requestId)) throw new WorkflowTransitionError("PR feedback decision request ID was already used");
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  const decision = WorkflowDecisionSchema.parse({
    requestId: input.requestId, workflowRevision: current.revision,
    decision: input.decision, actorId: actor.actorId, actorRole: "TASK_OWNER",
    reason: input.decision === "APPROVE" ? "Approved the proposed fix for the linked PR feedback." : "Dismissed the proposed fix for the linked PR feedback.",
    artifactDigest: feedback.planDigest, at: now,
  });
  if (input.decision === "REQUEST_CHANGES") return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, feedback: { ...feedback, status: "DISMISSED" }, decisions: [...current.decisions, decision], updatedAt: now,
  });
  const { candidate: _candidate, verification: _verification, reviews: _reviews, pullRequests: _pullRequests, outcome: _outcome, blockReason: _blockReason, ...remaining } = current;
  return WorkflowSnapshotSchema.parse({
    ...remaining, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY",
    feedback: { ...feedback, status: "APPROVED" }, decisions: [...current.decisions, decision], updatedAt: now,
  });
}

/** Saves recoverable review input without inventing an independent report or code authority. */
export function collectWorkflowFeedbackBundles(currentInput: unknown, input: {
  bundleRefs: unknown; threadObservations: unknown;
}, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const collected = WorkflowFeedbackReviewSchema.safeParse({ ...input, status: "COLLECTING" });
  if (!collected.success || collected.data.status !== "COLLECTING"
    || current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING"
    || current.pullRequests?.some(pr => (pr.state === "OPEN" || pr.state === "UNKNOWN")
      && !collected.data.bundleRefs.some(b => b.repositoryId === pr.repositoryId && b.number === pr.number))
    || collected.data.bundleRefs.some(b => b.taskId !== current.taskId || b.candidateDigest !== current.candidate?.digest
      || !current.candidate.repositories.some(r => r.repositoryId === b.repositoryId && r.commitSha === b.headSha)
      || !current.pullRequests?.some(pr => pr.repositoryId === b.repositoryId && pr.number === b.number
        && pr.candidateDigest === b.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
    throw new WorkflowTransitionError("collected feedback does not match the current linked PR set");
  }
  const previousReport = current.feedbackReview?.reviewRef;
  const history = [...(current.feedbackReviewHistory ?? [])];
  if (previousReport && !history.some(r => r.sha256 === previousReport.sha256)) history.push(previousReport);
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedback: undefined,
    feedbackReview: collected.data, feedbackReviewHistory: history, updatedAt: now });
}

/** Registers immutable reconciled inputs and a separate AI advisory report; never starts code. */
export function requestWorkflowFeedbackReview(currentInput: unknown, input: { bundleRefs: unknown; reviewRef: unknown }, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = ReviewedWorkflowFeedbackSchema.safeParse({ bundleRefs: input.bundleRefs, reviewRef: input.reviewRef, status: "PENDING" });
  if (!review.success || current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING"
    || review.data.reviewRef.taskId !== current.taskId
    || (review.data.reviewRef.status === "COMPLETE" && current.pullRequests?.some(pr =>
      (pr.state === "OPEN" || pr.state === "UNKNOWN") && !review.data.bundleRefs.some(bundle =>
        bundle.repositoryId === pr.repositoryId && bundle.number === pr.number)))
    || review.data.bundleRefs.some(bundle =>
      bundle.taskId !== current.taskId || bundle.candidateDigest !== current.candidate?.digest
      || !current.candidate?.repositories.some(repo => repo.repositoryId === bundle.repositoryId && repo.commitSha === bundle.headSha)
      || !current.pullRequests?.some(pr => pr.repositoryId === bundle.repositoryId && pr.number === bundle.number
        && pr.candidateDigest === bundle.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
    throw new WorkflowTransitionError("feedback review does not match current linked PR candidates or comment set");
  }
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedbackReview: { ...review.data, threadObservations: current.feedbackReview?.threadObservations }, updatedAt: now });
}

/** Completes the broker-dispatched critic operation for the exact collecting revision. */
export function completeWorkflowFeedbackReview(currentInput: unknown, input: {
  expectedRevision: number; taskId: string; candidateDigest: string; operationId: string;
  bundleRefs: unknown; reviewRef: unknown;
}, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = ReviewedWorkflowFeedbackSchema.safeParse({ bundleRefs: input.bundleRefs, reviewRef: input.reviewRef, status: "PENDING" });
  if (!review.success) throw new WorkflowTransitionError("feedback critic report metadata is invalid");
  if (current.revision !== input.expectedRevision || current.taskId !== input.taskId
    || current.stage !== "WAIT_FOR_MERGE" || current.state !== "RUNNING"
    || current.candidate?.digest !== input.candidateDigest || current.feedbackReview?.status !== "COLLECTING") {
    throw new WorkflowTransitionError("feedback critic report is stale for the current task revision or candidate");
  }
  if (!review.success || review.data.reviewRef.operationId !== input.operationId || review.data.reviewRef.taskId !== current.taskId) {
    throw new WorkflowTransitionError("feedback critic report does not belong to the active operation and task");
  }
  if (review.data.bundleRefs.length !== current.feedbackReview.bundleRefs.length
    || current.feedbackReview.bundleRefs.some(bundle => !review.data.bundleRefs.some(ref => ref.sha256 === bundle.sha256 && ref.objectKey === bundle.objectKey))) {
    throw new WorkflowTransitionError("feedback critic report does not use the exact collected bundle set");
  }
  if (review.data.bundleRefs.some(bundle => bundle.taskId !== current.taskId || bundle.candidateDigest !== input.candidateDigest
    || !current.candidate?.repositories.some(repo => repo.repositoryId === bundle.repositoryId && repo.commitSha === bundle.headSha)
    || !current.pullRequests?.some(pr => pr.repositoryId === bundle.repositoryId && pr.number === bundle.number
      && pr.candidateDigest === bundle.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
    throw new WorkflowTransitionError("feedback critic report includes a bundle outside the current linked candidates");
  }
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "WAITING",
    feedbackReview: { ...review.data, threadObservations: current.feedbackReview.threadObservations }, updatedAt: now });
}

/** Requires fresh bindings supplied by the reconciler; dispatch must independently reconcile again. */
export function decideWorkflowFeedbackFindings(currentInput: unknown, input: {
  requestId: string; expectedRevision: number; reviewDigest: string; proposalDigest: string;
  bundleDigests: string[]; selectedFindingIds: string[]; decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS"; ownerNote?: string;
}, actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" }, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  if (actor.role !== "TASK_OWNER" || actor.actorId !== current.ownerId || !ActorIdSchema.safeParse(actor.actorId).success) {
    throw new WorkflowTransitionError("only the task owner can decide PR feedback findings");
  }
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.revision !== input.expectedRevision
    || review === undefined || review.status !== "PENDING" || (input.decision === "APPROVE" && review.reviewRef.status !== "COMPLETE")
    || (review.reviewRef.status === "COMPLETE" && current.pullRequests?.some(pr =>
      (pr.state === "OPEN" || pr.state === "UNKNOWN") && !review.bundleRefs.some(bundle =>
        bundle.repositoryId === pr.repositoryId && bundle.number === pr.number)))
    || review.reviewRef.sha256 !== input.reviewDigest || review.reviewRef.proposalDigest !== input.proposalDigest
    || input.bundleDigests.length !== review.bundleRefs.length || new Set(input.bundleDigests).size !== input.bundleDigests.length
    || !review.bundleRefs.every(b => input.bundleDigests.includes(b.sha256) && b.candidateDigest === current.candidate?.digest
      && current.candidate.repositories.some(repo => repo.repositoryId === b.repositoryId && repo.commitSha === b.headSha)
      && current.pullRequests?.some(pr => pr.repositoryId === b.repositoryId && pr.number === b.number
        && pr.candidateDigest === b.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))
    || current.decisions.some(d => d.requestId === input.requestId)
    || current.feedbackDecisions?.some(d => d.requestId === input.requestId)) {
    throw new WorkflowTransitionError("feedback finding decision is stale, incomplete or already used");
  }
  const selected = review.reviewRef.findingRefs.filter(f => input.selectedFindingIds.includes(f.id));
  if (selected.length !== input.selectedFindingIds.length) throw new WorkflowTransitionError("feedback finding selection is invalid");
  const affected = review.bundleRefs.filter(b => selected.some(f => f.bundleDigest === b.sha256));
  const decision = WorkflowFeedbackDecisionSchema.safeParse({
    schemaVersion: 1, requestId: input.requestId, workflowRevision: current.revision,
    decision: input.decision, actorId: actor.actorId, actorRole: "TASK_OWNER", reviewDigest: input.reviewDigest,
    proposalDigest: input.proposalDigest, bundleDigests: input.bundleDigests, selectedFindingIds: input.selectedFindingIds,
    selectedCommentIds: [...new Set(selected.flatMap(f => f.commentIds))],
    candidates: affected.map(b => ({ repositoryId: b.repositoryId, number: b.number, headSha: b.headSha,
      candidateDigest: b.candidateDigest, commentSetDigest: b.commentSetDigest, bundleDigest: b.sha256 })),
    ...(input.ownerNote === undefined ? {} : { ownerNote: input.ownerNote }), at: now,
  });
  if (!decision.success) throw new WorkflowTransitionError("feedback finding decision is invalid");
  const notes = current.feedbackNotes ?? [];
  const feedbackNotes = input.decision === "APPROVE" ? notes : [...notes, WorkflowFeedbackNoteSchema.parse({
    schemaVersion: 1, requestId: input.requestId, actorId: actor.actorId, source: input.decision,
    sourceId: input.requestId, text: input.ownerNote, at: now,
  })];
  // Retain source PR identities and the old candidate for reconciliation; new verification invalidates its evidence.
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1,
    ...(input.decision === "APPROVE" ? { stage: "IMPLEMENT", state: "READY" } : {}),
    feedbackReview: { ...review, status: input.decision === "APPROVE" ? "APPROVED" : input.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "DISMISSED" },
    feedbackDecisions: [...(current.feedbackDecisions ?? []), decision.data], feedbackNotes, updatedAt: now,
  });
}

function validSnapshot(input: unknown): WorkflowSnapshot {
  const parsed = WorkflowSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowTransitionError("workflow snapshot is invalid");
  return parsed.data;
}

export function createWorkflowSnapshot(input: { taskId: string; ownerId: string; now: string; path?: WorkflowPath; checkPolicy?: WorkflowCheckPolicy }): WorkflowSnapshot {
  const parsed = WorkflowSnapshotSchema.safeParse({
    schemaVersion: 1,
    definitionId: "agentx-task-to-pr",
    definitionVersion: "1.0.0",
    taskId: input.taskId,
    ownerId: input.ownerId,
    path: input.path ?? "QUICK",
    ...(input.path === "FULL" ? { reviewPhase: "REQUIREMENTS" as const } : {}),
    revision: 1,
    stage: "PLAN",
    state: "RUNNING",
    createdAt: input.now,
    updatedAt: input.now,
    artifacts: [],
    decisions: [],
    ...(input.checkPolicy === undefined ? {} : { checkPolicy: input.checkPolicy }),
  });
  if (!parsed.success) throw new WorkflowTransitionError("workflow initialization is invalid");
  return parsed.data;
}

export function submitWorkflowArtifact(
  currentInput: unknown,
  input: { expectedRevision: number; artifact: WorkflowArtifact; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const artifact = WorkflowArtifactSchema.safeParse(input.artifact);
  if (!artifact.success) throw new WorkflowTransitionError("workflow artifact is invalid");
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  const expectedType = current.path === "QUICK" || current.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan"
    : current.reviewPhase === "REQUIREMENTS" ? "requirements" : "design";
  if (current.stage !== "PLAN" || current.state !== "RUNNING" || artifact.data.type !== expectedType) {
    throw new WorkflowTransitionError("the current workflow phase is not expecting this artifact");
  }
  const next = WorkflowSnapshotSchema.parse({
    ...current,
    revision: current.revision + 1,
    stage: "PLAN_REVIEW",
    state: "WAITING",
    artifacts: [...current.artifacts, artifact.data],
    ...(current.checkPolicy === undefined ? {} : { checkPolicy: { ...current.checkPolicy, selectedOptionalIds: [] } }),
    updatedAt: input.now,
  });
  return next;
}

export function blockWorkflow(currentInput: unknown, reason: string, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "BLOCKED", blockReason: reason.slice(0, 500), updatedAt: now });
}

export function decideWorkflow(
  currentInput: unknown,
  requestInput: unknown,
  actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" },
  options: { now: string; allowedSkipStages: readonly WorkflowStage[] },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const request = WorkflowDecisionRequestSchema.safeParse(requestInput);
  const actorId = ActorIdSchema.safeParse(actor.actorId);
  if (!request.success || !actorId.success) throw new WorkflowTransitionError("workflow decision is invalid");

  const prior = current.decisions.find((decision) => decision.requestId === request.data.requestId);
  if (prior !== undefined) {
    const selectedOptionalCheckIds = request.data.selectedOptionalCheckIds ?? current.checkPolicy?.selectedOptionalIds ?? [];
    const duplicate = prior.workflowRevision === request.data.expectedRevision
      && prior.decision === request.data.decision
      && prior.actorId === actor.actorId
      && prior.reason === request.data.reason
      && prior.artifactDigest === request.data.artifactDigest
      && JSON.stringify(prior.selectedOptionalCheckIds ?? []) === JSON.stringify(selectedOptionalCheckIds);
    if (duplicate) return current;
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.revision !== request.data.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.stage !== "PLAN_REVIEW" || current.state !== "WAITING") {
    throw new WorkflowTransitionError("workflow is not waiting for a plan decision");
  }
  const selectedOptionalCheckIds = request.data.selectedOptionalCheckIds ?? current.checkPolicy?.selectedOptionalIds ?? [];
  if (current.checkPolicy !== undefined && selectedOptionalCheckIds.some((id) => !current.checkPolicy?.optional.some((check) => check.id === id))) {
    throw new WorkflowTransitionError("decision selected an optional check not approved by project policy");
  }
  if (actor.role === "TASK_OWNER" && actor.actorId !== current.ownerId) {
    throw new WorkflowTransitionError("only the task owner may decide this workflow stage");
  }
  const currentPlan = current.artifacts.filter((artifact) => artifact.type === (current.path === "QUICK" || current.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan" : current.reviewPhase === "REQUIREMENTS" ? "requirements" : "design")).at(-1);
  if (currentPlan === undefined || request.data.artifactDigest !== currentPlan.sha256) {
    throw new WorkflowTransitionError("decision must name the current plan digest");
  }
  if (request.data.decision === "SKIP" && !options.allowedSkipStages.includes(current.stage)) {
    throw new WorkflowTransitionError("workflow policy does not allow skipping this stage");
  }

  const decision = WorkflowDecisionSchema.parse({
    requestId: request.data.requestId,
    workflowRevision: current.revision,
    decision: request.data.decision,
    actorId: actor.actorId,
    actorRole: actor.role,
    reason: request.data.reason,
    ...(request.data.artifactDigest === undefined ? {} : { artifactDigest: request.data.artifactDigest }),
    ...(current.checkPolicy === undefined ? {} : { selectedOptionalCheckIds }),
    at: options.now,
  });
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");

  const nextFullPhase = current.path === "FULL" && request.data.decision === "APPROVE"
    ? current.reviewPhase === "REQUIREMENTS" ? "DESIGN" as const
      : current.reviewPhase === "DESIGN" ? "IMPLEMENTATION_PLAN" as const : undefined
    : undefined;
  const nextStage: WorkflowStage = request.data.decision === "REJECT" ? "CLOSED"
    : request.data.decision === "REQUEST_CHANGES" ? "PLAN"
      : nextFullPhase !== undefined ? "PLAN" : "IMPLEMENT";
  const outcome = request.data.decision === "APPROVE" && nextFullPhase === undefined ? "PASSED"
    : request.data.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED"
      : request.data.decision === "REJECT" ? "REJECTED"
        : request.data.decision === "SKIP" ? "SKIPPED" : undefined;
  return WorkflowSnapshotSchema.parse({
    ...current,
    revision: current.revision + 1,
    stage: nextStage,
    state: request.data.decision === "REJECT" ? "COMPLETE" : "READY",
    ...(nextFullPhase === undefined ? {} : { reviewPhase: nextFullPhase }),
    ...(outcome === undefined ? {} : { outcome }),
    updatedAt: options.now,
    decisions: [...current.decisions, decision],
    ...(current.checkPolicy === undefined ? {} : { checkPolicy: { ...current.checkPolicy, selectedOptionalIds: selectedOptionalCheckIds } }),
  });
}
