import { createHash } from "node:crypto";
import { z } from "zod";
import { ProjectCommandSchema } from "./project.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ActorIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WORKFLOW_PLAN_MAX_BYTES = 32_768;
/** Shown to the owner when the code no longer descends from the commit the task started from. */
export const WORKFLOW_HISTORY_REWRITTEN_MESSAGE = "The change history was rewritten past where this task started, so AgentX can't compare it. Ask for the change again in a new task.";

/** Shown to the owner when AgentX gave up starting the reviews on its own; Retry reviews starts them. */
export const WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE = "AgentX couldn't start the reviews automatically. Use Retry reviews to try again.";
/** Shown to the owner when a review run did not return exactly one code review and one security review. */
export const WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE = "The reviews didn't return one code review and one security review. Use Retry reviews to run them again.";
/** Shown to the owner when AgentX gave up opening the draft pull request on its own; Retry opening the pull request starts it. */
export const WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE = "AgentX couldn't open the pull request automatically. Use Retry opening the pull request to try again.";

/**
 * Why the broker stopped a step, written for the task owner: Slack shows these word for word. Any other block reason
 * is internal and is replaced by a plain sentence before it reaches the owner.
 */
export const WORKFLOW_BLOCK_REASONS = {
  checksUnconfirmed: "AgentX couldn't confirm the selected checks ran on the final code. Choose checks and retry.",
  checkRetryStale: "This check run no longer matches the task's current step. Use the latest update in the thread.",
  checkReportUnreadable: "AgentX couldn't read the check results for the final code. Choose checks and retry.",
  noChecksConfigured: "No checks ran: this project has no required checks and the task selected no optional checks. Configure or select at least one check, then retry.",
  checkRunnerFailed: "AgentX couldn't run the selected checks. Retry once the check runner is working.",
  repositoriesIncomplete: "AgentX couldn't find every repository in the final code. Retry coding, or close the task.",
  codeChangedAfterChecks: "The code changed after its checks ran. Run the checks again on the latest code.",
  startUnrecorded: "AgentX could not record where this change started. Close the task and start a new one.",
  startUnconfirmed: "AgentX could not confirm the task's starting commit on GitHub.",
  startChanged: "The code's starting point changed. Send the task back to coding or close it.",
  noCheckResults: "No required or selected optional checks ran. Configure or select at least one check, then retry.",
  planNotSaved: "The planning run finished without saving a document. Retry planning.",
  pullRequestChanged: "The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.",
  /** Shown only in a task view, never stored: the document waiting for approval failed its digest check. */
  documentUnverified: "The saved document couldn't be checked, so I stopped. Close this task and start again.",
} as const;

/** The worker's refusal when the workspace no longer holds the tree its checks and reviews passed on. */
export const WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE = "the code changed after its checks and reviews; AgentX did not publish it";

/** Whether the owner may ask AgentX to open the draft pull request again: it is ready, or AgentX gave up on its own. */
export function workflowPublicationRetryable(workflow: { stage: string; state: string; blockReason?: string | undefined }): boolean {
  return workflow.stage === "PULL_REQUEST"
    && (workflow.state === "READY" || (workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE));
}

/** Whether a review of the current code saw only part of the change: its diff was too large to show in full. */
export function workflowReviewsSawPartialDiff(workflow: { candidate?: { digest: string } | undefined; reviews?: ReadonlyArray<{ candidateDigest: string; partialDiff?: boolean | undefined }> | undefined }): boolean {
  const current = workflow.candidate?.digest;
  return (workflow.reviews ?? []).some((review) => review.partialDiff === true && (current === undefined || review.candidateDigest === current));
}

/** Sparse due-time index over workflow dispatch rows, oldest due first, so rows not yet due never hide due ones. */
export const WORKFLOW_DISPATCH_DUE_INDEX = {
  name: "workflow-dispatch-due",
  partitionKey: "dispatchDuePk",
  sortKey: "dispatchDueSk",
} as const;

/**
 * A request ID derived only from its namespace and parts, so every retry of the same intent (a recovered
 * dispatch, a repeated Slack delivery) reaches the broker's idempotency check with the same key. It is a
 * SHA-256 of the JSON array, laid out as a UUID (version 5 and variant 8 nibbles) so request schemas accept it.
 */
export function workflowRequestId(namespace: string, ...parts: ReadonlyArray<string | number>): string {
  const digest = createHash("sha256").update(JSON.stringify([namespace, ...parts]), "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const CandidateRepositorySchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** The commit the task started from; reviewers see the diff from it to `treeSha`. */
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
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

const WorkflowVerificationRetrySchema = z.object({
  requestId: z.string().uuid(), actorId: ActorIdSchema,
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20),
  at: z.string().datetime(),
}).strict().refine(retry => new Set(retry.selectedOptionalCheckIds).size === retry.selectedOptionalCheckIds.length,
  "verification retry check IDs must be unique");

/** One reviewer finding; only findings the change INTRODUCED block, PRE_EXISTING ones are advisory. */
export const WorkflowReviewFindingSchema = z.object({
  text: z.string().trim().min(1).max(600),
  origin: z.enum(["INTRODUCED", "PRE_EXISTING"]),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  file: z.string().trim().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
}).strict();
export type WorkflowReviewFinding = z.infer<typeof WorkflowReviewFindingSchema>;

/** Safe machine-readable reasons a review did not qualify; every view of a review (MCP included) uses this list. */
export const WORKFLOW_REVIEW_FAILURE_REASONS = [
  "RESPONSE_MISSING", "RESPONSE_TOO_LARGE", "INVALID_JSON", "INVALID_SHAPE", "TIMEOUT", "INTERRUPTED", "CANDIDATE_CHANGED",
  "SESSION_FAILED", "USAGE_UNAVAILABLE", "BASE_UNAVAILABLE", "DIFF_UNAVAILABLE",
] as const;

export const WorkflowReviewReportSchema = z.object({
  operationId: z.string().uuid(),
  candidateDigest: DigestSchema,
  role: z.enum(["CRITIC", "SECURITY"]),
  provider: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(120),
  status: z.enum(["PASS", "FINDINGS", "FAILED", "INTERRUPTED", "UNKNOWN"]),
  /** Safe machine-readable reason a review did not qualify; never includes model output. */
  failureReason: z.enum(WORKFLOW_REVIEW_FAILURE_REASONS).optional(),
  /**
   * Reports stored before structured findings hold plain strings (up to 50, each up to 1,000 characters).
   * They read as INTRODUCED so they keep blocking, bounded to the new limits so a stored snapshot stays readable.
   */
  findings: z.preprocess(
    (value) => Array.isArray(value) && value.length > 20 && value.every((entry) => typeof entry === "string") ? value.slice(0, 20) : value,
    z.array(z.preprocess((value) => typeof value === "string" ? { text: value.trim().slice(0, 600), origin: "INTRODUCED" } : value, WorkflowReviewFindingSchema)).max(20)),
  readOnly: z.literal(true),
  recordedAt: z.string().datetime(),
  /** The base-to-candidate diff the reviewer saw was cut to fit its limit: the review covered only part of the change. */
  partialDiff: z.literal(true).optional(),
}).strict().superRefine((report, context) => {
  const introduced = report.findings.some((finding) => finding.origin === "INTRODUCED");
  if (report.status === "PASS" && introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a passing review cannot report an introduced finding" });
  if (report.status === "FINDINGS" && !introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a review with findings must report at least one introduced finding" });
});
export type WorkflowReviewReport = z.infer<typeof WorkflowReviewReportSchema>;

/** The findings that block a review: those the change introduced. Pre-existing findings are advisory. */
export function blockingFindings(report: WorkflowReviewReport): WorkflowReviewFinding[] {
  return report.findings.filter((finding) => finding.origin === "INTRODUCED");
}

const WorkflowPullRequestSchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  number: z.number().int().positive(),
  url: z.string().url().max(2048),
  /** Exact GitHub head commit returned by the broker-verified publication callback. */
  /** Present on newly published workflow PRs; absent only on pre-feature persisted snapshots. */
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  candidateDigest: DigestSchema,
  required: z.boolean(),
  state: z.enum(["UNKNOWN", "OPEN", "CLOSED", "MERGED"]),
  observedAt: z.string().datetime().optional(),
}).strict();
export type WorkflowPullRequest = z.infer<typeof WorkflowPullRequestSchema>;

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
  number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** GitHub's immutable tree for headSha; this maps a publication commit to the checked candidate tree. */
  headTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), candidateDigest: DigestSchema,
  commentSetDigest: DigestSchema,
  producer: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(120), recordedAt: z.string().datetime(),
  comments: z.array(FeedbackCommentRefSchema).max(128),
}).strict().refine(b => new Set(b.comments.map(c => c.id)).size === b.comments.length, "comment IDs must be unique within a bundle");
export const WorkflowFeedbackBundleRefSchema = WorkflowFeedbackBundleMetadataSchema.safeExtend({
  sha256: DigestSchema, objectKey: FeedbackObjectKeySchema,
}).refine(b => b.objectKey.includes(b.sha256), "feedback artifact key must contain its content digest");
export type WorkflowFeedbackBundleRef = z.infer<typeof WorkflowFeedbackBundleRefSchema>;
export const WorkflowFeedbackBundleCommentsSchema = z.array(FeedbackCommentRefSchema.extend({ body: z.string().max(1_000_000) })).max(128)
  .refine(comments => new Set(comments.map(comment => comment.id)).size === comments.length, "comment IDs must be unique within a bundle");
export const WorkflowFeedbackBundleSchema = WorkflowFeedbackBundleMetadataSchema.safeExtend({
  comments: WorkflowFeedbackBundleCommentsSchema,
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
  fixProposal: z.object({
    summary: z.string().trim().min(1).max(2000),
    fileChanges: z.array(z.object({ repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1000),
      operation: z.enum(["MODIFY", "ADD"]), change: z.string().trim().min(1).max(4000) }).strict()).min(1).max(32),
    tests: z.array(z.object({ repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1000),
      operation: z.enum(["MODIFY", "ADD"]), behavior: z.string().trim().min(1).max(2000) }).strict()).min(1).max(32),
  }).strict().optional(),
}).strict();
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
  slack: z.object({
    teamId: z.string().regex(/^[TE][A-Z0-9]{2,31}$/), channelId: z.string().regex(/^[CG][A-Z0-9]{2,31}$/),
    threadTs: z.string().regex(/^\d{10}\.\d{6}$/), userId: z.string().regex(/^[UW][A-Z0-9]{2,31}$/),
    messageTs: z.string().regex(/^\d{10}\.\d{6}$/), eventId: FeedbackIdSchema,
  }).strict().optional(),
}).strict().superRefine((note, context) => {
  if (note.source === "THREAD_REPLY" && note.slack === undefined) {
    context.addIssue({ code: "custom", path: ["slack"], message: "Slack thread notes require verified message provenance" });
  }
});
export type WorkflowFeedbackNote = z.infer<typeof WorkflowFeedbackNoteSchema>;
/** A reply longer than this is kept truncated, and marked so. */
export const WORKFLOW_THREAD_NOTE_MAX_CHARS = 2_000;
/** The most thread replies one task keeps; later ones are refused. */
export const WORKFLOW_THREAD_NOTES_MAX = 200;
/**
 * A reply anyone posted in a Slack-started task's thread: input for the task's next step, never a
 * decision. Stored beside the task (`NOTE#<messageTs>`); it never changes the task's workflow.
 */
export const WorkflowThreadNoteSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().uuid(), slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,31}$/), isOwner: z.boolean(),
  teamId: z.string(), channelId: z.string(), threadTs: z.string().regex(/^\d{10}\.\d{6}$/), messageTs: z.string().regex(/^\d{10}\.\d{6}$/), eventId: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(WORKFLOW_THREAD_NOTE_MAX_CHARS), truncated: z.boolean(), receivedAt: z.string().datetime(), workflowRevision: z.number().int().positive(),
}).strict();
export type WorkflowThreadNote = z.infer<typeof WorkflowThreadNoteSchema>;
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

/** Immutable owner approval carried to the worker and checked again at worker start. */
export const WorkflowFeedbackApprovalBindingSchema = z.object({
  taskId: z.string().uuid(), requestId: z.string().uuid(), ownerId: ActorIdSchema,
  decisionWorkflowRevision: z.number().int().positive(), activeWorkflowRevision: z.number().int().positive(),
  reviewDigest: DigestSchema, proposalDigest: DigestSchema, bundleDigests: z.array(DigestSchema).min(1).max(32),
  candidateDigest: DigestSchema, selectedFindingIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  selectedCommentIds: z.array(z.string().min(1).max(128)).min(1).max(200),
}).strict();
export type WorkflowFeedbackApprovalBinding = z.infer<typeof WorkflowFeedbackApprovalBindingSchema>;
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
  /** Where the decision was made: an approval gate (the default), or the owner sending blocked work back to coding. */
  source: z.enum(["GATE", "SEND_BACK"]).optional(),
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

const WorkflowCanvasLineageSchema = z.object({
  key: z.string().trim().min(1).max(256), stage: WorkflowStageSchema,
  workflowRevision: z.number().int().positive(), artifactId: z.string().trim().min(1).max(128),
  artifactRef: FeedbackObjectKeySchema, artifactDigest: DigestSchema,
  state: z.enum(["PREPARED", "CREATE_OUTCOME_UNKNOWN", "CREATE_FAILED", "CREATED"]),
  canvasId: z.string().regex(/^F[A-Z0-9]{8,}$/).optional(), permalink: z.string().url().max(2048).optional(),
  createdAt: z.string().datetime(), errorCategory: z.string().regex(/^[a-z_]{1,64}$/).optional(),
}).strict().superRefine((record, context) => {
  if (record.state === "CREATED" && record.canvasId === undefined) {
    context.addIssue({ code: "custom", message: "created Canvas lineage requires its exact Slack ID" });
  }
  if (record.state !== "CREATED" && record.canvasId !== undefined) {
    context.addIssue({ code: "custom", message: "unconfirmed Canvas creation cannot claim a Canvas ID" });
  }
});
export type WorkflowCanvasLineage = z.infer<typeof WorkflowCanvasLineageSchema>;

const WorkflowCanvasCloseoutSchema = z.object({
  status: z.enum(["ARCHIVE_PENDING", "COMPLETE"]),
  terminalState: z.enum(["MERGED", "CLOSED", "CANCELLED"]),
  manifestDigest: DigestSchema,
  manifestRef: FeedbackObjectKeySchema,
  preparedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  canvases: z.array(z.object({
    lineageKey: z.string().trim().min(1).max(256), canvasId: z.string().regex(/^F[A-Z0-9]{8,}$/),
    status: z.enum(["PENDING", "DELETED", "UNKNOWN"]), attempts: z.number().int().nonnegative().max(1000),
    attemptedAt: z.string().datetime().optional(), errorCategory: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  }).strict()).max(100),
}).strict().superRefine((closeout, context) => {
  if (!closeout.manifestRef.includes(closeout.manifestDigest)) context.addIssue({ code: "custom", message: "closeout manifest key must include its digest" });
  if (new Set(closeout.canvases.map((canvas) => canvas.lineageKey)).size !== closeout.canvases.length
    || new Set(closeout.canvases.map((canvas) => canvas.canvasId)).size !== closeout.canvases.length) {
    context.addIssue({ code: "custom", message: "closeout Canvas identities must be unique" });
  }
  if (closeout.status === "COMPLETE" && (closeout.completedAt === undefined || closeout.canvases.some((canvas) => canvas.status !== "DELETED"))) {
    context.addIssue({ code: "custom", message: "closeout is complete only after every Canvas deletion is confirmed" });
  }
  if (closeout.status === "ARCHIVE_PENDING" && closeout.completedAt !== undefined) {
    context.addIssue({ code: "custom", message: "pending closeout cannot have a completion time" });
  }
});
export type WorkflowCanvasCloseout = z.infer<typeof WorkflowCanvasCloseoutSchema>;

const WorkflowCanvasCloseoutAttemptSchema = z.object({
  status: z.literal("ARCHIVE_PENDING"), workflowRevision: z.number().int().positive(),
  terminalState: z.enum(["MERGED", "CLOSED", "CANCELLED"]),
  reason: z.enum(["canvas_artifact_binding_failed", "canvas_lineage_unresolved", "manifest_binding_changed", "manifest_integrity_failed",
    "artifact_unavailable", "artifact_digest_mismatch", "manifest_write_failed", "manifest_pointer_write_failed", "manifest_unavailable",
    "attempt_checkpoint_failed", "outcome_checkpoint_failed", "closeout_attempt_write_failed", "manifest_preparation_pending"]),
  attempts: z.number().int().positive().max(1000), updatedAt: z.string().datetime(),
  candidateManifestDigest: DigestSchema.optional(), candidateManifestRef: FeedbackObjectKeySchema.optional(), candidatePreparedAt: z.string().datetime().optional(),
}).strict().superRefine((attempt, context) => {
  if ((attempt.candidateManifestDigest === undefined) !== (attempt.candidateManifestRef === undefined)) {
    context.addIssue({ code: "custom", message: "closeout attempt candidate digest and reference must be stored together" });
  }
  if (attempt.candidateManifestRef !== undefined && !attempt.candidateManifestRef.includes(attempt.candidateManifestDigest!)) {
    context.addIssue({ code: "custom", message: "closeout attempt key must include its candidate digest" });
  }
  if ((attempt.candidateManifestDigest === undefined) !== (attempt.candidatePreparedAt === undefined)) {
    context.addIssue({ code: "custom", message: "candidate manifest preparation time requires its digest" });
  }
});
export type WorkflowCanvasCloseoutAttempt = z.infer<typeof WorkflowCanvasCloseoutAttemptSchema>;

/** Each repository's base commit: the workflow's pinned reviewBase, a task's prepared base, a worker's workflowBase. */
export const WorkflowReviewBaseSchema = z.array(z.object({
  repositoryId: z.string().trim().min(1).max(200),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict()).min(1).max(32).refine((base) => new Set(base.map((entry) => entry.repositoryId)).size === base.length,
  "base repositories must be unique");

const WorkflowSnapshotShapeSchema = z.object({
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
  verificationRetries: z.array(WorkflowVerificationRetrySchema).max(100).optional(),
  candidate: CandidateManifestSchema.optional(),
  /** Each repository's base commit, pinned by the first verified candidate; later candidates must keep it. */
  reviewBase: WorkflowReviewBaseSchema.optional(),
  verification: VerificationResultsSchema.optional(),
  reviews: z.array(WorkflowReviewReportSchema).max(2).optional(),
  pullRequests: z.array(WorkflowPullRequestSchema).max(32).optional(),
  feedbackReview: WorkflowFeedbackReviewSchema.optional(),
  feedbackReviewHistory: z.array(WorkflowFeedbackReviewRefSchema).max(100).optional(),
  feedbackDecisions: z.array(WorkflowFeedbackDecisionSchema).max(100).optional(),
  feedbackDispatchApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
  feedbackNotes: z.array(WorkflowFeedbackNoteSchema).max(100).optional(),
  canvasLineage: z.array(WorkflowCanvasLineageSchema).max(100).optional(),
  canvasLineageVersion: z.number().int().nonnegative().optional(),
  canvasCloseout: WorkflowCanvasCloseoutSchema.optional(),
  canvasCloseoutAttempt: WorkflowCanvasCloseoutAttemptSchema.optional(),
}).superRefine((workflow, context) => {
  const taskMetadata = { feedbackReview: workflow.feedbackReview, feedbackDecisions: workflow.feedbackDecisions, feedbackDispatchApproval: workflow.feedbackDispatchApproval, feedbackNotes: workflow.feedbackNotes, feedbackReviewHistory: workflow.feedbackReviewHistory, verificationRetries: workflow.verificationRetries, canvasLineage: workflow.canvasLineage, canvasCloseout: workflow.canvasCloseout, canvasCloseoutAttempt: workflow.canvasCloseoutAttempt };
  if (Buffer.byteLength(JSON.stringify(taskMetadata), "utf8") > 262_144) {
    context.addIssue({ code: "custom", message: "workflow metadata exceeds the task snapshot storage budget" });
  }
  if (new Set((workflow.canvasLineage ?? []).map((canvas) => canvas.key)).size !== (workflow.canvasLineage ?? []).length) {
    context.addIssue({ code: "custom", path: ["canvasLineage"], message: "Canvas lineage keys must be unique" });
  }
  if (workflow.canvasLineage?.some((canvas) => !workflow.artifacts.some((artifact) => artifact.id === canvas.artifactId
    && artifact.objectKey === canvas.artifactRef && artifact.sha256 === canvas.artifactDigest))) {
    context.addIssue({ code: "custom", path: ["canvasLineage"], message: "Canvas lineage must reference a workflow artifact" });
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
  // Ready, or blocked only because AgentX gave up opening the draft pull request on its own (the owner retries it).
  if (workflow.stage === "PULL_REQUEST" && workflow.state !== "READY"
    && !(workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE)) {
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
});

/**
 * A workflow as a task view shows it. Besides every stored shape, a view may show an approval as blocked when its
 * saved document failed its digest check (`WORKFLOW_BLOCK_REASONS.documentUnverified`); that state is never stored.
 */
export const WorkflowSnapshotViewSchema = WorkflowSnapshotShapeSchema;

/** A workflow as it is stored and transitioned. */
export const WorkflowSnapshotSchema = WorkflowSnapshotShapeSchema.superRefine((workflow, context) => {
  // Nothing runs while a document waits for its owner, and a closed task is done: neither is ever stored blocked.
  if (workflow.state === "BLOCKED" && (workflow.stage === "PLAN_REVIEW" || workflow.stage === "CLOSED")) {
    context.addIssue({ code: "custom", path: ["state"], message: "an approval waiting for its owner or a closed task cannot be blocked" });
  }
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;
/** Each repository's pinned base commit, as the workflow stores it and the worker receives it. */
export type WorkflowReviewBase = z.infer<typeof WorkflowReviewBaseSchema>;

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
  if (current.reviewBase !== undefined && candidate.repositories.some((repository) =>
    current.reviewBase?.find((entry) => entry.repositoryId === repository.repositoryId)?.baseCommitSha !== repository.baseCommitSha
      || repository.baseCommitSha === undefined)) {
    throw new WorkflowTransitionError("candidate base commit changed after it was pinned");
  }
  const reviewBase = current.reviewBase ?? (candidate.repositories.every((repository) => repository.baseCommitSha !== undefined)
    ? candidate.repositories.map((repository) => ({ repositoryId: repository.repositoryId, baseCommitSha: repository.baseCommitSha as string }))
    : undefined);
  const passed = checks.data.results.every((result) => result.status === "PASS");
  const candidateChanged = current.candidate?.digest !== candidate.digest;
  const { blockReason: _priorBlockReason, ...withoutBlockReason } = current;
  void _priorBlockReason;
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    state: passed ? "WAITING" : "BLOCKED",
    stage: passed ? "REVIEW" : "VERIFY",
    ...(passed ? {} : { blockReason: "candidate checks failed or have unknown results" }),
    candidate,
    ...(reviewBase === undefined ? {} : { reviewBase }),
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
  void _priorBlockReason;
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
export function registerWorkflowPullRequest(currentInput: unknown, pullRequestInput: Omit<WorkflowPullRequest, "state" | "observedAt" | "headSha"> & { headSha: string }, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const parsed = WorkflowPullRequestSchema.omit({ state: true, observedAt: true }).extend({ headSha: z.string().regex(/^[a-f0-9]{40}$/) }).safeParse(pullRequestInput);
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

/** The owner's retry after AgentX gave up opening the draft pull request: ready to publish again. */
export function unblockWorkflowPublication(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "PULL_REQUEST" || current.state !== "BLOCKED" || current.blockReason !== WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE) {
    throw new WorkflowTransitionError("workflow is not waiting for a pull request retry");
  }
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({ ...unblocked, revision: current.revision + 1, state: "READY", updatedAt: now });
}

/** Where the owner may send the change back to coding: a blocked step after the plan, or a change ready to publish. */
function sendBackAllowedFrom(workflow: { stage: string; state: string; blockReason?: string | undefined; pullRequests?: readonly unknown[] | undefined }): boolean {
  if (["IMPLEMENT", "VERIFY", "REVIEW"].includes(workflow.stage)) return workflow.state === "BLOCKED";
  return workflowPublicationRetryable(workflow) && (workflow.pullRequests?.length ?? 0) === 0;
}

/**
 * Whether Slack offers Send back to coding: the reviews found a problem the change introduced, a selected check
 * failed, coding itself stopped, or the change is ready to publish (for example, its code changed after its checks).
 */
export function workflowSendBackOffered(workflow: {
  stage: string; state: string; blockReason?: string | undefined; pullRequests?: readonly unknown[] | undefined;
  candidate?: { digest?: string } | undefined;
  reviews?: ReadonlyArray<{ candidateDigest?: string; findings?: ReadonlyArray<{ origin?: string } | string> | undefined }> | undefined;
  verification?: { candidateDigest?: string; results?: ReadonlyArray<{ status: string }> | undefined } | undefined;
}): boolean {
  if (!sendBackAllowedFrom(workflow)) return false;
  // Only evidence about the current code counts: a review or check of older code describes code that is gone.
  const current = workflow.candidate?.digest;
  if (workflow.stage === "REVIEW") {
    return current !== undefined && workflow.reviews?.some((review) => review.candidateDigest === current
      && review.findings?.some((finding) => typeof finding === "string" || finding.origin === "INTRODUCED")) === true;
  }
  if (workflow.stage === "VERIFY") {
    return current !== undefined && workflow.verification?.candidateDigest === current
      && workflow.verification.results?.some((result) => result.status === "FAILED") === true;
  }
  return true;
}

/**
 * The owner sends blocked work (or a change ready to publish) back to coding. Only the task owner may; it records a
 * REQUEST_CHANGES decision with source SEND_BACK. The candidate, its checks and its reviews stay until the next
 * coding run's candidate replaces them. A pull request AgentX already opened for part of the change would be left
 * on old code, so that is refused.
 */
export function returnWorkflowToImplementation(
  currentInput: unknown,
  input: { requestId: string; actorId: string; reason: string; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (!ActorIdSchema.safeParse(input.actorId).success || input.actorId !== current.ownerId) {
    throw new WorkflowTransitionError("only the task owner can send this work back to coding");
  }
  if (current.stage === "PULL_REQUEST" && (current.pullRequests?.length ?? 0) > 0) {
    throw new WorkflowTransitionError("a pull request is already open for part of this change; close the task or finish it on GitHub");
  }
  if (!sendBackAllowedFrom(current)) throw new WorkflowTransitionError("this work is not blocked or ready to publish, so it cannot be sent back to coding");
  if (current.decisions.some((decision) => decision.requestId === input.requestId)) {
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  const decision = WorkflowDecisionSchema.parse({
    requestId: input.requestId, workflowRevision: current.revision, decision: "REQUEST_CHANGES", actorId: input.actorId,
    actorRole: "TASK_OWNER", reason: input.reason.trim().slice(0, 500), source: "SEND_BACK", at: input.now,
  });
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({
    ...unblocked, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY",
    decisions: [...current.decisions, decision], updatedAt: input.now,
  });
}

const REVIEW_ROLE_NAMES = { CRITIC: "code review", SECURITY: "security review" } as const;

/** One problem a send-back asks the coder to fix. `text` from a review is reviewer output: untrusted. */
export interface WorkflowSendBackProblem { source: "code review" | "security review" | "check"; text: string }

/**
 * The problems a send-back asks the coder to fix, about the current code only: each review finding the change
 * introduced, as "text (file:line)", and each selected check that failed, as "<label> failed". Pre-existing findings,
 * and reviews or checks of older code, are left out.
 */
export function sendBackProblems(workflow: WorkflowSnapshot): WorkflowSendBackProblem[] {
  const current = workflow.candidate?.digest;
  if (current === undefined) return [];
  const findings = (workflow.reviews ?? []).filter((review) => review.candidateDigest === current).flatMap((review) => blockingFindings(review).map((finding) => {
    const where = finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`;
    return { source: REVIEW_ROLE_NAMES[review.role], text: `${finding.text}${where}` };
  }));
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  const failed = workflow.verification?.candidateDigest !== current ? [] : workflow.verification.results.filter((result) => result.status === "FAILED")
    .map((result) => ({ source: "check" as const, text: `${checks.find((check) => check.id === result.checkId)?.label ?? result.checkId} failed` }));
  return [...findings, ...failed];
}

/** The problems as plain lines, "- [code review] text (file:line)" and "- check <label> failed", for people to read. */
export function sendBackInstructions(workflow: WorkflowSnapshot): string {
  const problems = sendBackProblems(workflow).map((problem) => problem.source === "check" ? `- check ${problem.text}` : `- [${problem.source}] ${problem.text}`);
  return problems.length > 0 ? problems.join("\n") : "- No check or review problems were recorded; follow the owner note.";
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
  const codingPlanApproval = request.data.decision === "APPROVE"
    && (current.path === "QUICK" || current.reviewPhase === "IMPLEMENTATION_PLAN");
  if (codingPlanApproval && (current.checkPolicy?.required.length ?? 0) === 0 && selectedOptionalCheckIds.length === 0) {
    throw new WorkflowTransitionError("select at least one check before approving the coding plan");
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
