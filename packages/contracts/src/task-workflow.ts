import { createHash } from "node:crypto";
import { z } from "zod";
import { ProjectCommandSchema } from "./project.js";
import { WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS, WorkflowProposedCheckInputSchema, feedbackReplacementCheckProblem } from "./workflow-check-input.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ActorIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WORKFLOW_PLAN_MAX_BYTES = 32_768;
/** The worker's refusal when a coding run leaves every repository as it was when the task started: nothing to check or publish. */
export const WORKFLOW_NO_CODE_CHANGE_MESSAGE = "the coding run left the code as it was when the task started";
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
  /** The task has checks to run (project, proposed or chosen), but the worker reported none ran. */
  noChecksConfigured: "AgentX ran none of this task's checks on the final code. Choose checks and retry, or close the task.",
  /** Every failed check could not run: the check itself is broken, so coding again would not help. */
  checksBroken: "the checks couldn't run",
  checkRunnerFailed: "AgentX couldn't run the selected checks. Retry once the check runner is working.",
  /** Review only: AgentX's rerun of the agent's own tests found one that passed before and fails now. */
  regressionFound: "A test that passed before this change fails now. Send it back to coding, or close the task.",
  repositoriesIncomplete: "AgentX couldn't find every repository in the final code. Retry coding, or close the task.",
  /** The coding run finished, but the code is still what the task started from (WORKFLOW_NO_CODE_CHANGE_MESSAGE). */
  noCodeChanged: "Coding finished, but no code changed, so there is nothing to check or open as a pull request. Retry coding, or close the task.",
  codeChangedAfterChecks: "The code changed after its checks ran. Run the checks again on the latest code.",
  startUnrecorded: "AgentX could not record where this change started. Close the task and start a new one.",
  startUnconfirmed: "AgentX could not confirm the task's starting commit on GitHub.",
  startChanged: "The code's starting point changed. Send the task back to coding or close it.",
  noCheckResults: "No required or selected optional checks ran. Configure or select at least one check, then retry.",
  planNotSaved: "The planning run finished without saving a document. Retry planning.",
  /** The saved plan is a structured document that could not be read back. */
  planUnreadable: "the plan couldn't be read",
  pullRequestChanged: "The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.",
  /** The pull request's feedback review failed; AgentX still watches the pull request for its merge. */
  feedbackReviewFailed: "I couldn't review the feedback on the pull request, so I have nothing to propose from it.",
  /** The approved fix could not be pushed to the pull request; AgentX still watches the pull request for its merge. */
  pullRequestUpdateFailed: "I couldn't push the fix to the pull request.",
  /** Shown only in a task view, never stored: the document waiting for approval failed its digest check. */
  documentUnverified: "The saved document couldn't be checked, so I stopped. Close this task and start again.",
} as const;

/** What the coder is told about tests a review-only rerun found regressed (`regressedChecks`). */
export const WORKFLOW_REGRESSION_INSTRUCTION = "These tests passed before this change and fail now. If the task intentionally changes this behaviour, update the tests to match it; otherwise fix the code.";
/** At most this many regressed tests are kept on a blocked workflow, each cut to WORKFLOW_REGRESSED_CHECK_MAX characters. */
export const WORKFLOW_REGRESSED_CHECKS_MAX = 8;
export const WORKFLOW_REGRESSED_CHECK_MAX = 120;

/** The worker's refusal when the workspace no longer holds the tree its checks and reviews passed on. */
export const WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE = "the code changed after its checks and reviews; AgentX did not publish it";

/** Why an AgentX worker refused, before running, to push a reviewed fix: it is too old to push exactly the reviewed tree. */
export const WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED = "pushing a reviewed fix needs a worker that pushes exactly the reviewed tree";

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

/** Whether a check result is of a command that could not run. A not-installed program always is, also in results recorded before `broken` existed. */
export function workflowCheckResultBroken(result: { status: string; broken?: boolean | undefined; programNotFound?: boolean | undefined }): boolean {
  return result.status === "FAILED" && (result.broken === true || result.programNotFound === true);
}

const VerificationResultsSchema = z.object({
  candidateDigest: DigestSchema,
  producer: z.string().trim().min(1).max(120),
  environmentId: z.string().trim().min(1).max(160),
  recordedAt: z.string().datetime(),
  results: z.array(z.object({
    checkId: z.string().trim().min(1).max(120),
    status: z.enum(["PASS", "FAILED", "UNKNOWN"]),
    /** The check failed because its program could not be started: it is not installed on the AgentX worker. */
    programNotFound: z.literal(true).optional(),
    /** The check's command could not run (not found, not runnable, or a script that does not parse): the code is not at fault. */
    broken: z.literal(true).optional(),
    /** The check's process never started (the worker failed to start it, EAGAIN say): nothing is wrong with it, and a retry may run it. */
    neverStarted: z.literal(true).optional(),
  }).strict()).max(100),
  /** No check was selected for this task: the candidate was validated and goes to review with no check results. */
  reviewOnly: z.boolean().optional(),
}).strict().superRefine((verification, context) => {
  if (verification.reviewOnly === true ? verification.results.length > 0 : verification.results.length === 0) {
    context.addIssue({ code: "custom", path: ["results"], message: "verification has results unless it is review only, and none when it is" });
  }
});
export type WorkflowVerificationResults = z.infer<typeof VerificationResultsSchema>;

const WorkflowVerificationRetrySchema = z.object({
  requestId: z.string().uuid(), actorId: ActorIdSchema,
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20),
  /** The approved plan's proposed checks the owner kept for this retry. Older retries: all of them. */
  selectedProposedCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(8).optional(),
  at: z.string().datetime(),
}).strict().refine(retry => new Set(retry.selectedOptionalCheckIds).size === retry.selectedOptionalCheckIds.length
  && new Set(retry.selectedProposedCheckIds ?? []).size === (retry.selectedProposedCheckIds ?? []).length,
"verification retry check IDs must be unique");

/**
 * One reviewer finding; only findings the change INTRODUCED block, PRE_EXISTING ones are advisory. A finding the reviewer
 * marks `advisory` never blocks and never goes to the coder, whatever its origin (for example a remark about something the
 * approved plan asked for, or about how well the checks cover the change).
 */
export const WorkflowReviewFindingSchema = z.object({
  text: z.string().trim().min(1).max(600),
  origin: z.enum(["INTRODUCED", "PRE_EXISTING"]),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  file: z.string().trim().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  advisory: z.boolean().optional(),
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
  const introduced = report.findings.some((finding) => findingBlocks(finding, report.role));
  if (report.status === "PASS" && introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a passing review cannot report an introduced finding" });
  if (report.status === "FINDINGS" && !introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a review with findings must report at least one introduced finding" });
});
export type WorkflowReviewReport = z.infer<typeof WorkflowReviewReportSchema>;

/** Whether a finding blocks: the change introduced it and the reviewer did not mark it advisory. */
function findingBlocks(finding: { origin?: string; advisory?: boolean | undefined } | string, role: string | undefined): boolean {
  // A security finding is never advisory: the flag is ignored on it, and only the owner's accept waives one.
  return typeof finding === "string" || (finding.origin === "INTRODUCED" && (finding.advisory !== true || role === "SECURITY"));
}

/**
 * The stable ID of a review finding: the SHA-256 of its review role, text, file and line. The same finding of the same
 * review role always has the same ID, so the owner's answer for it can be matched again later.
 */
export function workflowFindingFingerprint(role: "CRITIC" | "SECURITY", finding: { text: string; file?: string | undefined; line?: number | undefined }): string {
  return createHash("sha256").update(JSON.stringify([role, finding.text, finding.file ?? "", finding.line ?? 0]), "utf8").digest("hex");
}

/** A blocking review finding the owner accepted, for one candidate: it never blocks that candidate again. */
export const WorkflowAcceptedFindingSchema = z.object({
  candidateDigest: DigestSchema,
  role: z.enum(["CRITIC", "SECURITY"]),
  fingerprint: DigestSchema,
  text: z.string().trim().min(1).max(600),
  reason: z.string().trim().min(1).max(500),
  actorId: ActorIdSchema,
  at: z.string().datetime(),
}).strict();
export type WorkflowAcceptedFinding = z.infer<typeof WorkflowAcceptedFindingSchema>;
export const WORKFLOW_ACCEPTED_FINDINGS_MAX = 100;
/** How many findings one resolution may answer. */
export const WORKFLOW_RESOLVE_FINDINGS_MAX = 20;

type AcceptedFindingRef = { candidateDigest: string; role: string; fingerprint: string };

/** Whether the owner accepted this finding of this review role for this candidate. */
function findingAccepted(
  finding: { text?: string | undefined; file?: string | undefined; line?: number | undefined } | string, role: string | undefined,
  candidateDigest: string | undefined, accepted: readonly AcceptedFindingRef[] | undefined,
): boolean {
  if ((role !== "CRITIC" && role !== "SECURITY") || candidateDigest === undefined || accepted === undefined || accepted.length === 0) return false;
  const fingerprint = workflowFindingFingerprint(role, typeof finding === "string" ? { text: finding } : { text: finding.text ?? "", file: finding.file, line: finding.line });
  return accepted.some((entry) => entry.candidateDigest === candidateDigest && entry.role === role && entry.fingerprint === fingerprint);
}

/**
 * The findings that block a review: those the change introduced that are not marked advisory (a security finding is
 * never advisory), and, when the owner's accepted findings are given, not accepted for this review's candidate.
 * Pre-existing and advisory findings never block.
 */
export function blockingFindings(report: WorkflowReviewReport, accepted?: readonly AcceptedFindingRef[]): WorkflowReviewFinding[] {
  return report.findings.filter((finding) => findingBlocks(finding, report.role) && !findingAccepted(finding, report.role, report.candidateDigest, accepted));
}

/** Whether a review no longer holds the change back: it passed, or every finding that blocked it was accepted by the owner. */
function reviewCleared(review: WorkflowReviewReport, accepted: readonly AcceptedFindingRef[] | undefined): boolean {
  return review.status === "PASS" || (review.status === "FINDINGS" && blockingFindings(review, accepted).length === 0);
}

const WorkflowPullRequestSchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  number: z.number().int().positive(),
  url: z.string().url().max(2048),
  /** Exact GitHub head commit returned by the broker-verified publication callback. */
  /** Present on newly published workflow PRs; absent only on pre-feature persisted snapshots. */
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  /**
   * GitHub's tree for headSha, recorded with the head: merge tracking matches it, so a merge of the head GitHub has is
   * observed while a fix is being pushed or after its push failed. Absent on older records (the candidate's tree then).
   */
  headTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  /** The reviewed code the head holds: the current candidate, or an earlier one while its fix is pushed or after that push failed. */
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
/** The most checks one feedback finding may mark wrong, and the most corrected checks it may propose. */
export const WORKFLOW_FEEDBACK_REPLACEMENT_CHECKS_MAX = 8;
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
    // For an OWNER_DECISION this is the question for the owner and its options.
    summary: z.string().trim().min(1).max(2000),
    // May be empty: only an IMPLEMENT must name its changes (the worker checks that); an owner decision or a skip may name none.
    fileChanges: z.array(z.object({ repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1000),
      operation: z.enum(["MODIFY", "ADD"]), change: z.string().trim().min(1).max(4000) }).strict()).max(32),
    // May be empty: the worker, which can see the candidate tree, requires tests only for a code change in a repository that has tests.
    tests: z.array(z.object({ repositoryId: z.string().trim().min(1).max(200), path: z.string().trim().min(1).max(1000),
      operation: z.enum(["MODIFY", "ADD"]), behavior: z.string().trim().min(1).max(2000) }).strict()).max(32),
    /**
     * The task's proposed checks (by ID or label) the fix makes wrong, such as a check that looks for the exact text the
     * fix changes. Required project checks are never listed. Only from a broker that sent the task's checks.
     */
    obsoleteChecks: z.array(z.string().trim().min(1).max(80)).max(WORKFLOW_FEEDBACK_REPLACEMENT_CHECKS_MAX).optional(),
    /** Corrected checks for the fix, under the coding plan's rules for proposed checks. */
    replacementChecks: z.array(WorkflowProposedCheckInputSchema).max(WORKFLOW_FEEDBACK_REPLACEMENT_CHECKS_MAX).optional(),
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
/** The private artifact a feedback review keeps a rejected reviewer answer in, beside its report. */
export const WORKFLOW_FEEDBACK_REVIEW_ANSWER_ARTIFACT = "workflow-feedback-review-answer.txt";
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
  /** Set when the chat agent answered this reply as a question: the next step then skips it (it still counts toward the cap). */
  answeredAt: z.string().datetime().optional(),
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

/** Proves a durable worker dispatch is limited to findings and PR snapshots in its approved report. */
export function workflowFeedbackApprovalMatchesReview(
  approval: WorkflowFeedbackApprovalBinding,
  reviewInput: { bundleRefs: WorkflowFeedbackBundleRef[]; reviewRef: WorkflowFeedbackReviewRef },
): boolean {
  const { bundleRefs, reviewRef } = reviewInput;
  const sameStrings = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const selected = reviewRef.findingRefs.filter(finding => approval.selectedFindingIds.includes(finding.id));
  const selectedComments = [...new Set(selected.flatMap(finding => finding.commentIds))];
  return reviewRef.sha256 === approval.reviewDigest && reviewRef.proposalDigest === approval.proposalDigest
    && sameStrings(bundleRefs.map(bundle => bundle.sha256), approval.bundleDigests)
    && sameStrings(reviewRef.bundleDigests, approval.bundleDigests)
    && approval.selectedFindingIds.length === new Set(approval.selectedFindingIds).size
    && approval.selectedCommentIds.length === new Set(approval.selectedCommentIds).size
    && selected.length === approval.selectedFindingIds.length
    && sameStrings(selectedComments, approval.selectedCommentIds)
    && reviewRef.candidateBindings.length === bundleRefs.length
    && bundleRefs.every(bundle => bundle.candidateDigest === approval.candidateDigest && reviewRef.candidateBindings.some(candidate => candidate.repositoryId === bundle.repositoryId
      && candidate.number === bundle.number && candidate.headSha === bundle.headSha
      && candidate.candidateDigest === bundle.candidateDigest && candidate.commentSetDigest === bundle.commentSetDigest
      && candidate.bundleDigest === bundle.sha256));
}

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

const WorkflowObjectKeySchema = z.string().min(1).max(1024).refine((key) => !key.startsWith("/") && !key.split("/").includes(".."));

export const WorkflowArtifactSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["requirements", "design", "plan", "test_plan", "review_report"]),
  version: z.number().int().positive(),
  sha256: DigestSchema,
  producer: z.string().min(1).max(120),
  objectKey: WorkflowObjectKeySchema,
  createdAt: z.string().datetime(),
  /** How the document is stored: Markdown (the default for older artifacts) or a structured plan document (canonical JSON). */
  format: z.enum(["markdown", "structured"]).optional(),
  /** Structured documents only: the verified evidence (code excerpts) saved beside the document. */
  evidence: z.object({ objectKey: WorkflowObjectKeySchema, sha256: DigestSchema }).strict().optional(),
}).refine((artifact) => artifact.evidence === undefined || artifact.format === "structured", { message: "evidence belongs only to a structured document", path: ["evidence"] });
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
  /** Where the decision was made: an approval gate (the default), the owner sending blocked work back to coding, or the owner resolving review findings. */
  source: z.enum(["GATE", "SEND_BACK", "FINDINGS"]).optional(),
  at: z.string().datetime(),
}).strict();
export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;

export const WorkflowCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  command: ProjectCommandSchema,
}).strict();
export type WorkflowCheck = z.infer<typeof WorkflowCheckSchema>;
export const WORKFLOW_PROPOSED_CHECKS_MAX = 8;
/** The checks a coding plan proposed (`parseProposedChecks`), with why it proposed none or why they could not be read. */
export const WorkflowCheckProposalSchema = z.object({
  proposed: z.array(WorkflowCheckSchema).max(WORKFLOW_PROPOSED_CHECKS_MAX),
  proposalNote: z.string().min(1).max(200).optional(),
  noneReason: z.string().min(1).max(300).optional(),
}).strict();
export type WorkflowCheckProposal = z.infer<typeof WorkflowCheckProposalSchema>;
export const WorkflowCheckPolicySchema = z.object({
  required: z.array(WorkflowCheckSchema).max(64),
  optional: z.array(WorkflowCheckSchema).max(20),
  selectedOptionalIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20),
  /** Checks the current coding plan proposed; they run only once the owner approves that plan. Older snapshots: none. */
  proposed: WorkflowCheckProposalSchema.shape.proposed.default([]),
  /**
   * The proposed checks still run: the owner may remove some when retrying verification, never add one. Absent: all of
   * them. Each new plan version proposes afresh, so it is cleared with the proposal.
   */
  selectedProposedIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(WORKFLOW_PROPOSED_CHECKS_MAX).optional(),
  proposalNote: WorkflowCheckProposalSchema.shape.proposalNote,
  noneReason: WorkflowCheckProposalSchema.shape.noneReason,
}).strict().superRefine((policy, context) => {
  const ids = [...policy.required, ...policy.optional, ...policy.proposed].map((check) => check.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["optional"], message: "workflow check IDs must be unique" });
  if (policy.selectedProposedIds !== undefined && (new Set(policy.selectedProposedIds).size !== policy.selectedProposedIds.length
    || policy.selectedProposedIds.some((id) => !policy.proposed.some((check) => check.id === id)))) {
    context.addIssue({ code: "custom", path: ["selectedProposedIds"], message: "kept proposed checks must be unique and come from the approved plan" });
  }
  if (new Set(policy.selectedOptionalIds).size !== policy.selectedOptionalIds.length
    || policy.selectedOptionalIds.some((id) => !policy.optional.some((check) => check.id === id))) {
    context.addIssue({ code: "custom", path: ["selectedOptionalIds"], message: "selected optional checks must be unique and project-approved" });
  }
});
export type WorkflowCheckPolicy = z.infer<typeof WorkflowCheckPolicySchema>;
/** A check policy as it may be written or stored: `proposed` may be left out. */
export type WorkflowCheckPolicyInput = z.input<typeof WorkflowCheckPolicySchema>;

/**
 * The checks a task runs, in the worker's `readiness:<index>` order: the project's required checks, then the approved
 * plan's proposed checks the owner kept (all, unless a retry removed some) in proposal order, then the selected
 * optional checks in project order.
 */
export function workflowSelectedChecks(policy: WorkflowCheckPolicy | undefined): WorkflowCheck[] {
  if (policy === undefined) return [];
  // A task record read straight from storage and written before proposals has no `proposed`; it proposed nothing.
  const kept = policy.selectedProposedIds;
  const proposed = (policy.proposed ?? []).filter((check) => kept === undefined || kept.includes(check.id));
  return [...policy.required, ...proposed, ...policy.optional.filter((check) => policy.selectedOptionalIds.includes(check.id))];
}

/**
 * Whether a task may be verified as review only: it has a stored check policy and that policy selects no check. A task
 * with no stored policy runs the project's checks, so it is never review only.
 */
export function workflowIsReviewOnly(policy: WorkflowCheckPolicy | undefined): boolean {
  return policy !== undefined && workflowSelectedChecks(policy).length === 0;
}

/**
 * What a PR feedback reviewer is told about the task's checks, so it can list the ones its fix makes wrong: the
 * proposed checks the task runs now (the approved plan's, as earlier approved fixes changed them), the project's
 * required checks (which always run), and the repository folders a corrected check may run in.
 */
export const WorkflowFeedbackTaskChecksSchema = z.object({
  proposed: z.array(WorkflowCheckSchema).max(WORKFLOW_PROPOSED_CHECKS_MAX),
  required: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(80) }).strict()).max(64),
  /** The project's optional checks: like required ones, never dropped by a fix. */
  optional: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(80) }).strict()).max(20).optional(),
  repositoryPaths: z.array(z.string().min(1).max(512)).min(1).max(32),
}).strict();
export type WorkflowFeedbackTaskChecks = z.infer<typeof WorkflowFeedbackTaskChecksSchema>;

/**
 * The checks approved PR feedback fixes change: the task's proposed checks they make wrong, the corrected ones they add,
 * the same split by finding (for saying which fix changes what), and, in plain words, what in the proposals AgentX will
 * not apply (an approval with any problem is refused whole).
 */
export interface WorkflowFeedbackCheckChanges {
  obsolete: WorkflowCheck[];
  added: Array<{ label: string; command: WorkflowCheck["command"] }>;
  byFinding: Array<{ obsolete: WorkflowCheck[]; added: Array<{ label: string; command: WorkflowCheck["command"] }> }>;
  problems: string[];
}

/** The most corrected checks, and the most checks to drop, one review's fixes may propose in all. */
export const WORKFLOW_FEEDBACK_CHECK_CHANGES_MAX = 5;

function sameCheckCommand(a: WorkflowCheck["command"], b: WorkflowCheck["command"]): boolean {
  return a.cwd === b.cwd && a.executable === b.executable && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]);
}

type FeedbackFindingCheckInput = {
  proposedDisposition?: string | undefined;
  fixProposal?: { obsoleteChecks?: readonly string[] | undefined; replacementChecks?: readonly unknown[] | undefined } | undefined;
};

/**
 * The check changes of the given feedback findings' proposals, against the task's check policy: what Approve applies
 * for exactly these findings, so a card and the approval use this one computation. Only a fix to make (IMPLEMENT)
 * changes checks. An obsolete name is a check ID, or a label naming exactly one check; it must be a proposed check:
 * naming a project check (which always runs), a check the task does not have, or a label several checks share is a
 * problem. A proposed check the owner already unticked is not run, so naming it changes nothing. A corrected check must
 * be short and plain and follow the proposed-check rules (and, given `repositoryPaths`, run in one of those folders); it
 * is added once, unless it is the same command as a required check or a proposed check that stays. At most 5 corrected
 * checks and 5 checks to drop in all.
 */
export function workflowFeedbackCheckChanges(
  policy: WorkflowCheckPolicy | undefined,
  findings: ReadonlyArray<FeedbackFindingCheckInput>,
  repositoryPaths?: readonly string[],
): WorkflowFeedbackCheckChanges {
  const byFinding: WorkflowFeedbackCheckChanges["byFinding"] = findings.map(() => ({ obsolete: [], added: [] }));
  if (policy === undefined) return { obsolete: [], added: [], byFinding, problems: [] };
  const isFix = (finding: FeedbackFindingCheckInput) => finding.proposedDisposition === "IMPLEMENT";
  const kept = policy.selectedProposedIds;
  const proposedAll = policy.proposed ?? [];
  const running = proposedAll.filter((check) => kept === undefined || kept.includes(check.id));
  const projectChecks = [...policy.required, ...policy.optional];
  const obsolete: WorkflowCheck[] = [];
  const problems: string[] = [];
  const names = findings.flatMap((finding, index) => isFix(finding) ? (finding.fixProposal?.obsoleteChecks ?? []).map((name) => ({ name, index })) : []);
  const raws = findings.flatMap((finding, index) => isFix(finding) ? (finding.fixProposal?.replacementChecks ?? []).map((raw) => ({ raw, index })) : []);
  if (names.length > WORKFLOW_FEEDBACK_CHECK_CHANGES_MAX) problems.push(`it names more than ${WORKFLOW_FEEDBACK_CHECK_CHANGES_MAX} checks to drop`);
  if (raws.length > WORKFLOW_FEEDBACK_CHECK_CHANGES_MAX) problems.push(`it proposes more than ${WORKFLOW_FEEDBACK_CHECK_CHANGES_MAX} corrected checks`);
  const named = (name: string, checks: readonly WorkflowCheck[]) => {
    const byId = checks.filter((check) => check.id === name.trim());
    return byId.length > 0 ? byId : checks.filter((check) => check.label.trim().toLowerCase() === name.trim().toLowerCase());
  };
  for (const { name, index } of names) {
    if (named(name, projectChecks).length > 0) { problems.push("it names a project check, which always runs"); continue; }
    const matches = named(name, proposedAll);
    if (matches.length === 0) { problems.push("it names a check the task does not have"); continue; }
    if (matches.length > 1) { problems.push("it names more than one check by the same label"); continue; }
    const check = matches[0]!;
    if (running.includes(check) && !obsolete.includes(check)) {
      obsolete.push(check);
      byFinding[index]!.obsolete.push(check);
    }
  }
  const staying = [...policy.required, ...running.filter((check) => !obsolete.includes(check))];
  const added: WorkflowFeedbackCheckChanges["added"] = [];
  for (const { raw, index } of raws) {
    const problem = feedbackReplacementCheckProblem(raw, repositoryPaths);
    const parsed = WorkflowProposedCheckInputSchema.safeParse(raw);
    if (problem !== undefined || !parsed.success) {
      problems.push(problem ?? "it must have only label, cwd, executable, args and timeoutSeconds");
      continue;
    }
    const command = { cwd: parsed.data.cwd, executable: parsed.data.executable, args: parsed.data.args,
      timeoutSeconds: parsed.data.timeoutSeconds ?? WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS };
    if (staying.some((check) => sameCheckCommand(check.command, command)) || added.some((check) => sameCheckCommand(check.command, command))) continue;
    const entry = { label: parsed.data.label, command };
    added.push(entry);
    byFinding[index]!.added.push(entry);
  }
  return { obsolete, added, byFinding, problems };
}

export { workflowCheckCommandText } from "./workflow-check-input.js";

/**
 * How a proposal card and the review page say approved fixes' check changes, one finding at a time (each finding's
 * obsolete checks pair with its own corrected ones), then every corrected check's exact command and folder, which the
 * owner approves with the fix. Labels, commands and folders come made safe (and styled as code) by the caller.
 */
export function describeWorkflowCheckChanges(findings: ReadonlyArray<{ obsolete: readonly string[]; added: ReadonlyArray<{ label: string; command: string; cwd: string }> }>): string[] {
  const parts = findings.flatMap(({ obsolete, added }) => {
    const paired = Math.min(obsolete.length, added.length);
    return [
      ...obsolete.slice(0, paired).map((label, index) => `${label} → ${added[index]!.label}`),
      ...obsolete.slice(paired).map((label) => `${label} → removed`),
      ...added.slice(paired).map((check) => `adds ${check.label}`),
    ];
  });
  if (parts.length === 0) return [];
  const commands = findings.flatMap(({ added }) => added.map((check) => `Adds check ${check.label}: ${check.command} in ${check.cwd}`));
  return [`Updates checks: ${parts.join("; ")}`, ...commands, ...(commands.length === 0 ? [] : ["These commands run on the next step."])];
}

/**
 * The workflow with an approved fix's check changes in its check policy, so its checks and every later step (and later
 * feedback rounds) run the updated set: the obsolete proposed checks are removed and the corrected ones added as
 * proposed checks `feedback-<round>-<n>`. The revision is not changed; the caller stores it with the approval.
 */
export function applyWorkflowFeedbackCheckChanges(currentInput: unknown, changes: WorkflowFeedbackCheckChanges): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const policy = current.checkPolicy;
  if (policy === undefined || (changes.obsolete.length === 0 && changes.added.length === 0)) return current;
  const round = (current.feedbackDecisions ?? []).length;
  const obsoleteIds = new Set(changes.obsolete.map((check) => check.id));
  const added = changes.added.map((check, index) => ({ id: `feedback-${round}-${index + 1}`, label: check.label, command: check.command }));
  const proposed = [...policy.proposed.filter((check) => !obsoleteIds.has(check.id)), ...added];
  if (proposed.length > WORKFLOW_PROPOSED_CHECKS_MAX || policy.required.length + policy.optional.length + proposed.length > 64) {
    throw new WorkflowTransitionError("the approved fix would give the task more checks than it can run");
  }
  const selectedProposedIds = policy.selectedProposedIds === undefined ? undefined
    : [...policy.selectedProposedIds.filter((id) => !obsoleteIds.has(id)), ...added.map((check) => check.id)];
  const { selectedProposedIds: _priorSelection, ...rest } = policy;
  void _priorSelection;
  return WorkflowSnapshotSchema.parse({ ...current, checkPolicy: { ...rest, proposed, ...(selectedProposedIds === undefined ? {} : { selectedProposedIds }) } });
}

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

/** Why pushing a fix to a pull request failed: its head moved on GitHub, GitHub refused it, or the worker cannot push a reviewed fix. */
export const WORKFLOW_PULL_REQUEST_UPDATE_CAUSES = ["HEAD_MOVED", "PUSH_REFUSED", "WORKER_OUTDATED"] as const;
export type WorkflowPullRequestUpdateCause = typeof WORKFLOW_PULL_REQUEST_UPDATE_CAUSES[number];
const WorkflowPullRequestUpdateFailureSchema = z.object({
  numbers: z.array(z.number().int().positive()).min(1).max(32),
  cause: z.enum(WORKFLOW_PULL_REQUEST_UPDATE_CAUSES).optional(),
}).strict();

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
  /**
   * Review only: the tests (labels or commands, worker output, untrusted) AgentX's rerun found passed before this change
   * and fail now. Kept through a send-back so the coder hears of them; the next block or verification replaces them.
   */
  regressedChecks: z.array(z.string().trim().min(1).max(WORKFLOW_REGRESSED_CHECK_MAX)).min(1).max(WORKFLOW_REGRESSED_CHECKS_MAX).optional(),
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
  /** Blocking review findings the owner accepted, each for the candidate it was found on; the newest 100. */
  acceptedFindings: z.array(WorkflowAcceptedFindingSchema).max(WORKFLOW_ACCEPTED_FINDINGS_MAX).optional(),
  pullRequests: z.array(WorkflowPullRequestSchema).max(32).optional(),
  /** When an approved fix was last pushed to the existing pull requests. */
  pullRequestUpdatedAt: z.string().datetime().optional(),
  /** Why the latest push of a fix failed, for the owner's message: the pull requests it was for, and a plain cause when known. */
  pullRequestUpdateFailure: WorkflowPullRequestUpdateFailureSchema.optional(),
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
  // A pull request that merged while its approved fix was still being made holds earlier reviewed code: its checks and
  // reviews were recorded with that code (and its head and tree with the pull request), not with the fix's candidate.
  const mergedEarlierCode = workflow.stage === "MERGED" && workflow.candidate !== undefined
    && !(workflow.pullRequests ?? []).some((pullRequest) => pullRequest.required && pullRequest.candidateDigest === workflow.candidate?.digest);
  const atOrAfterPrReady = ["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(workflow.stage) && !mergedEarlierCode;
  if (atOrAfterPrReady) {
    const currentDigest = workflow.candidate?.digest;
    const verification = currentDigest !== undefined && workflow.verification?.candidateDigest === currentDigest ? workflow.verification : undefined;
    // Passing results, or a review-only verification of a task with no check to run.
    const checksPass = verification !== undefined && (verification.results.length > 0
      ? verification.results.every((result) => result.status === "PASS")
      : verification.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy));
    const reviewsPass = currentDigest !== undefined && (["CRITIC", "SECURITY"] as const).every((role) =>
      workflow.reviews?.some((review) => review.role === role && review.candidateDigest === currentDigest && reviewCleared(review, workflow.acceptedFindings)) === true);
    if (!checksPass) context.addIssue({ code: "custom", path: ["verification"], message: "PR readiness requires passing checks for the current candidate" });
    if (!reviewsPass) context.addIssue({ code: "custom", path: ["reviews"], message: "PR readiness requires critic and security passes for the current candidate" });
  }
  // Ready, or blocked only because AgentX gave up opening the draft pull request on its own (the owner retries it), or
  // running only while a fix is pushed to the pull requests already open.
  if (workflow.stage === "PULL_REQUEST" && workflow.state !== "READY"
    && !(workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE)
    && !(workflow.state === "RUNNING" && (workflow.pullRequests ?? []).length > 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "pull request stage must be ready" });
  }
  if (workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED") {
    const pullRequests = workflow.pullRequests ?? [];
    const required = pullRequests.filter((pullRequest) => pullRequest.required);
    // A pull request holds earlier reviewed code only after pushing its fix failed, or when it merged before the fix was pushed.
    const earlierAllowed = workflow.stage === "MERGED" || (workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed);
    if (required.length === 0 || workflow.candidate === undefined
      || (!earlierAllowed && pullRequests.some((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest))
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
  if (checks.data.reviewOnly === true && !workflowIsReviewOnly(current.checkPolicy)) {
    throw new WorkflowTransitionError("verification cannot be review only when checks were selected");
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
  const failedResults = checks.data.results.filter((result) => result.status === "FAILED");
  // Every failed check could not run: coding again would not help, so the owner is told that, not "checks failed".
  const allBroken = failedResults.length > 0 && failedResults.every(workflowCheckResultBroken);
  const candidateChanged = current.candidate?.digest !== candidate.digest;
  const { blockReason: _priorBlockReason, regressedChecks: _priorRegressions, ...withoutBlockReason } = current;
  void _priorBlockReason;
  void _priorRegressions;
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    state: passed ? "WAITING" : "BLOCKED",
    stage: passed ? "REVIEW" : "VERIFY",
    ...(passed ? {} : { blockReason: allBroken ? WORKFLOW_BLOCK_REASONS.checksBroken : "candidate checks failed or have unknown results" }),
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
  // A review also stands when the owner accepted every finding that blocked it, for this candidate.
  const complete = (["CRITIC", "SECURITY"] as const).every((role) => reviews.some((entry) => entry.role === role && reviewCleared(entry, current.acceptedFindings)));
  // The reviews that hold the change back, named as the owner knows them, whichever review was recorded last.
  const notCleared = (["CRITIC", "SECURITY"] as const).filter((role) => reviews.some((entry) => entry.role === role && !reviewCleared(entry, current.acceptedFindings)));
  const failed = notCleared.length > 0;
  const blockReason = notCleared.length === 2 ? "the code and security reviews did not pass"
    : `the ${notCleared[0] === "CRITIC" ? "code" : "security"} review did not pass`;
  const { blockReason: _priorBlockReason, ...withoutBlockReason } = current;
  void _priorBlockReason;
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    stage: complete ? "PULL_REQUEST" : "REVIEW",
    state: complete ? "READY" : failed ? "BLOCKED" : "WAITING",
    ...(complete ? {} : failed ? { blockReason } : {}),
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
  // A merge is tracked from the first pull request on, in every stage after it opened (an approved fix being coded,
  // checked, reviewed or pushed included), until the task is closed.
  if (!observation.success || current.pullRequests === undefined || current.pullRequests.length === 0 || current.stage === "CLOSED") {
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
  return withPullRequestsObserved(current, pullRequests, now);
}

/**
 * Records the tree GitHub reports for the head of a pull request recorded without one (an earlier release), when that
 * head is the one recorded and its tree is the reviewed code the pull request was opened with. It is a fact about code
 * already recorded, so the revision stays: an owner's pending decision on this revision is still current.
 */
export function recordWorkflowPullRequestHeadTrees(currentInput: unknown, trees: ReadonlyArray<{ repositoryId: string; number: number; headSha: string; headTreeSha: string }>, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const pullRequests = (current.pullRequests ?? []).map((pullRequest) => {
    const tree = trees.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
    if (tree === undefined) return pullRequest;
    if (pullRequest.headTreeSha !== undefined || pullRequest.headSha !== tree.headSha || !/^[a-f0-9]{40}$/.test(tree.headTreeSha)
      || pullRequest.candidateDigest !== current.candidate?.digest
      || current.candidate.repositories.find((repository) => repository.repositoryId === pullRequest.repositoryId)?.treeSha !== tree.headTreeSha) {
      throw new WorkflowTransitionError("pull request head tree does not match its recorded head and reviewed code");
    }
    return { ...pullRequest, headTreeSha: tree.headTreeSha };
  });
  if (trees.some((tree) => !pullRequests.some((pullRequest) => pullRequest.repositoryId === tree.repositoryId && pullRequest.number === tree.number))) {
    throw new WorkflowTransitionError("pull request head tree names no recorded pull request");
  }
  return WorkflowSnapshotSchema.parse({ ...current, pullRequests, updatedAt: now });
}

/** Whether the task follows its pull requests only for their merge: an approved fix is being made or pushed, or its push failed. */
export function workflowFollowsOnlyMerge(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason">): boolean {
  return (workflow.stage !== "WAIT_FOR_MERGE" && workflow.stage !== "MERGED")
    || (workflow.state === "BLOCKED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed);
}

/**
 * The task once its pull requests are as observed: complete when every required one merged; otherwise a task that follows
 * them only for their merge stays where it is, and one waiting for the merge waits on.
 */
function withPullRequestsObserved(current: WorkflowSnapshot, pullRequests: WorkflowPullRequest[], now: string): WorkflowSnapshot {
  const complete = pullRequests.filter((pullRequest) => pullRequest.required).every((pullRequest) => pullRequest.state === "MERGED");
  const keep = !complete && workflowFollowsOnlyMerge(current);
  const { outcome: _priorOutcome, ...withoutPriorOutcome } = current;
  void _priorOutcome;
  return WorkflowSnapshotSchema.parse({
    ...(keep ? current : withoutPriorOutcome),
    revision: current.revision + 1,
    stage: complete ? "MERGED" : keep ? current.stage : "WAIT_FOR_MERGE",
    state: complete ? "COMPLETE" : keep ? current.state : "WAITING",
    ...(complete ? { outcome: "MERGED" as const } : {}),
    pullRequests,
    updatedAt: now,
  });
}

/**
 * GitHub merged a pull request at the approved fix AgentX pushed to it, before AgentX recorded that push (its result was
 * late, lost or failed after the push): the head GitHub merged holds exactly the fix's reviewed tree. The pull request is
 * recorded with that head and the fix's code, merged.
 */
export function observeWorkflowPullRequestMergedWithFix(currentInput: unknown, input: { repositoryId: string; number: number; headSha: string; headTreeSha: string; observedAt: string }, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const candidate = current.candidate;
  // Only a fix whose checks and reviews passed is pushed: while it is pushed, or after its push failed.
  const pushed = current.stage === "PULL_REQUEST" || (current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed);
  if (!/^[a-f0-9]{40}$/.test(input.headSha) || candidate === undefined || !pushed
    || candidate.repositories.find((repository) => repository.repositoryId === input.repositoryId)?.treeSha !== input.headTreeSha
    || !stalePullRequests(current).some((pullRequest) => pullRequest.repositoryId === input.repositoryId && pullRequest.number === input.number)) {
    throw new WorkflowTransitionError("merged pull request does not hold the reviewed fix");
  }
  const pullRequests = (current.pullRequests ?? []).map((pullRequest) => pullRequest.repositoryId === input.repositoryId && pullRequest.number === input.number
    ? { ...pullRequest, headSha: input.headSha, headTreeSha: input.headTreeSha, candidateDigest: candidate.digest, state: "MERGED" as const, observedAt: input.observedAt }
    : pullRequest);
  return withPullRequestsObserved(current, pullRequests, now);
}

/** The open pull requests that still hold earlier reviewed code than the current candidate: an approved fix is due on them. */
function stalePullRequests(workflow: WorkflowSnapshot): WorkflowPullRequest[] {
  const candidate = workflow.candidate;
  if (candidate === undefined) return [];
  return (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.candidateDigest !== candidate.digest
    && (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN")
    && candidate.repositories.some((repository) => repository.repositoryId === pullRequest.repositoryId));
}

/** Whether a fix whose checks and reviews passed is due on the pull requests already open, instead of opening new ones. */
export function workflowPullRequestUpdateDue(workflow: WorkflowSnapshot): boolean {
  return workflow.stage === "PULL_REQUEST" && stalePullRequests(workflow).length > 0;
}

/** The pull request a fix is pushed to next: the first by repository that still holds earlier code. */
export function nextWorkflowPullRequestUpdate(workflow: WorkflowSnapshot): WorkflowPullRequest | undefined {
  return [...stalePullRequests(workflow)].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))[0];
}

/** AgentX starts pushing the fix whose checks and reviews passed to the pull requests already open. */
export function startWorkflowPullRequestUpdate(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "PULL_REQUEST" || current.state !== "READY" || !workflowPullRequestUpdateDue(current)) {
    throw new WorkflowTransitionError("workflow has no reviewed fix to push to its pull requests");
  }
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "RUNNING", updatedAt: now });
}

/**
 * The fix was pushed: each updated pull request now holds the current candidate, as GitHub confirmed (its head commit, and
 * that commit's tree, which must be the reviewed tree). Once every open pull request holds it the task waits for the merge
 * again, its feedback round finished (the owner's decisions are kept); until then the next push is due. A task blocked
 * because its push was taken for failed records the push the same way once GitHub shows it landed.
 */
export function recordWorkflowPullRequestUpdate(currentInput: unknown, input: { updates: ReadonlyArray<{ repositoryId: string; number: number; headSha: string; headTreeSha: string }>; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const updates = z.array(z.object({
    repositoryId: z.string().trim().min(1).max(200), number: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/), headTreeSha: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict()).min(1).max(32).safeParse(input.updates);
  const candidate = current.candidate;
  // Or the push was taken for failed but landed: GitHub shows it later, and the blocked task records it.
  const pushFailed = current.stage === "WAIT_FOR_MERGE" && current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed;
  if (!updates.success || !((current.stage === "PULL_REQUEST" && current.state === "RUNNING") || pushFailed) || candidate === undefined
    || updates.data.some((update) => candidate.repositories.find((repository) => repository.repositoryId === update.repositoryId)?.treeSha !== update.headTreeSha
      || !stalePullRequests(current).some((pullRequest) => pullRequest.repositoryId === update.repositoryId && pullRequest.number === update.number))) {
    throw new WorkflowTransitionError("pull request update does not match the reviewed fix being pushed");
  }
  const pullRequests = (current.pullRequests ?? []).map((pullRequest) => {
    const update = updates.data.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
    return update === undefined ? pullRequest
      : { ...pullRequest, headSha: update.headSha, headTreeSha: update.headTreeSha, candidateDigest: candidate.digest, state: "OPEN" as const };
  });
  if (stalePullRequests({ ...current, pullRequests }).length > 0) {
    // A blocked task stays blocked for the pull requests its fix has not reached.
    return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, ...(pushFailed ? {} : { state: "READY" }), pullRequests, updatedAt: input.now });
  }
  const { blockReason: _blockReason, pullRequestUpdateFailure: _failure, feedbackReview, feedbackDispatchApproval: _approval, ...rest } = current;
  void _blockReason;
  void _failure;
  void _approval;
  const history = [...(current.feedbackReviewHistory ?? [])];
  const report = feedbackReview?.reviewRef;
  if (report !== undefined && !history.some((entry) => entry.sha256 === report.sha256)) history.push(report);
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests,
    ...(history.length === 0 ? {} : { feedbackReviewHistory: history.slice(-100) }),
    pullRequestUpdatedAt: input.now, updatedAt: input.now,
  });
}

/**
 * Pushing the fix failed (or could not start): the task waits for the merge, blocked, with the pull requests it was for and
 * a plain cause when known. Each pull request keeps the head and reviewed code it had, which merge tracking matches.
 */
export function blockWorkflowPullRequestUpdate(currentInput: unknown, input: { numbers: readonly number[]; cause?: WorkflowPullRequestUpdateCause | undefined; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const failure = WorkflowPullRequestUpdateFailureSchema.safeParse({ numbers: [...input.numbers], ...(input.cause === undefined ? {} : { cause: input.cause }) });
  if (!failure.success || current.stage !== "PULL_REQUEST" || (current.state !== "READY" && current.state !== "RUNNING") || (current.pullRequests ?? []).length === 0) {
    throw new WorkflowTransitionError("workflow is not pushing a fix to its pull requests");
  }
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "BLOCKED",
    blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed, pullRequestUpdateFailure: failure.data, updatedAt: input.now,
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
      || !current.candidate.repositories.some(r => r.repositoryId === b.repositoryId && r.treeSha === b.headTreeSha)
      || !current.pullRequests?.some(pr => pr.repositoryId === b.repositoryId && pr.number === b.number
        && pr.headSha === b.headSha && pr.candidateDigest === b.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
    throw new WorkflowTransitionError("collected feedback does not match the current linked PR set");
  }
  const previousReport = current.feedbackReview?.reviewRef;
  const history = [...(current.feedbackReviewHistory ?? [])];
  if (previousReport && !history.some(r => r.sha256 === previousReport.sha256)) history.push(previousReport);
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedback: undefined,
    feedbackReview: collected.data, feedbackReviewHistory: history, feedbackDispatchApproval: undefined, updatedAt: now });
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
      || !current.candidate?.repositories.some(repo => repo.repositoryId === bundle.repositoryId && repo.treeSha === bundle.headTreeSha)
      || !current.pullRequests?.some(pr => pr.repositoryId === bundle.repositoryId && pr.number === bundle.number
        && pr.headSha === bundle.headSha && pr.candidateDigest === bundle.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
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
    || !current.candidate?.repositories.some(repo => repo.repositoryId === bundle.repositoryId && repo.treeSha === bundle.headTreeSha)
    || !current.pullRequests?.some(pr => pr.repositoryId === bundle.repositoryId && pr.number === bundle.number
      && pr.headSha === bundle.headSha && pr.candidateDigest === bundle.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))) {
    throw new WorkflowTransitionError("feedback critic report includes a bundle outside the current linked candidates");
  }
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "WAITING",
    feedbackReview: { ...review.data, threadObservations: current.feedbackReview.threadObservations }, updatedAt: now });
}

/**
 * The owner asks AgentX to review the same PR comments again after the review failed, timed out or was interrupted.
 * Allowed only while the task waits for merge with that report (any report but a complete one) pending: the review goes back to COLLECTING on the same bundles (the failed report
 * is kept in the history), so the feedback dispatcher starts a new read-only review. A complete report, another
 * report, or a task that moved on is refused.
 */
export function retryWorkflowFeedbackReview(currentInput: unknown, input: {
  reviewDigest: string; actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" }; now: string;
}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  if (input.actor.role !== "TASK_OWNER" || input.actor.actorId !== current.ownerId) {
    throw new WorkflowTransitionError("only the task owner can retry the PR feedback review");
  }
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || review === undefined || review.status !== "PENDING"
    || review.reviewRef.status === "COMPLETE" || review.reviewRef.sha256 !== input.reviewDigest) {
    throw new WorkflowTransitionError("this PR feedback review is not a failed review waiting for a retry");
  }
  const history = [...(current.feedbackReviewHistory ?? [])];
  if (!history.some(ref => ref.sha256 === review.reviewRef.sha256)) history.push(review.reviewRef);
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1,
    feedbackReview: { status: "COLLECTING", bundleRefs: review.bundleRefs, threadObservations: review.threadObservations ?? [] },
    feedbackReviewHistory: history, updatedAt: input.now });
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
      && current.candidate.repositories.some(repo => repo.repositoryId === b.repositoryId && repo.treeSha === b.headTreeSha)
      && current.pullRequests?.some(pr => pr.repositoryId === b.repositoryId && pr.number === b.number
        && pr.headSha === b.headSha && pr.candidateDigest === b.candidateDigest && (pr.state === "OPEN" || pr.state === "UNKNOWN")))
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
  // A pull request recorded without its head's tree (an earlier release) keeps the reviewed tree it was opened with: once
  // the fix is coded the candidate is the fix, so a merge of the reviewed head would no longer be recognised.
  const pullRequests = input.decision !== "APPROVE" ? current.pullRequests : current.pullRequests?.map(pr => pr.headTreeSha !== undefined
    || pr.candidateDigest !== current.candidate?.digest ? pr
    : { ...pr, headTreeSha: current.candidate.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha });
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, ...(pullRequests === undefined ? {} : { pullRequests }),
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

export function createWorkflowSnapshot(input: { taskId: string; ownerId: string; now: string; path?: WorkflowPath; checkPolicy?: WorkflowCheckPolicyInput }): WorkflowSnapshot {
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
  input: { expectedRevision: number; artifact: WorkflowArtifact; now: string; proposal?: WorkflowCheckProposal },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const artifact = WorkflowArtifactSchema.safeParse(input.artifact);
  if (!artifact.success) throw new WorkflowTransitionError("workflow artifact is invalid");
  const proposal = input.proposal === undefined ? undefined : WorkflowCheckProposalSchema.safeParse(input.proposal);
  if (proposal !== undefined && !proposal.success) throw new WorkflowTransitionError("proposed checks are invalid");
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  const expectedType = current.path === "QUICK" || current.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan"
    : current.reviewPhase === "REQUIREMENTS" ? "requirements" : "design";
  if (current.stage !== "PLAN" || current.state !== "RUNNING" || artifact.data.type !== expectedType) {
    throw new WorkflowTransitionError("the current workflow phase is not expecting this artifact");
  }
  if (proposal !== undefined && expectedType !== "plan") throw new WorkflowTransitionError("only a coding plan can propose checks");
  // A new document version clears the previous version's proposal and optional choice, then takes its own proposal. A
  // task stored without a check policy runs the project's checks, so a proposal is ignored there.
  const policy: WorkflowCheckPolicyInput | undefined = current.checkPolicy === undefined ? undefined : {
    required: current.checkPolicy.required, optional: current.checkPolicy.optional, selectedOptionalIds: [], proposed: [],
    ...(proposal === undefined ? {} : proposal.data),
  };
  const next = WorkflowSnapshotSchema.parse({
    ...current,
    revision: current.revision + 1,
    stage: "PLAN_REVIEW",
    state: "WAITING",
    artifacts: [...current.artifacts, artifact.data],
    ...(policy === undefined ? {} : { checkPolicy: policy }),
    updatedAt: input.now,
  });
  return next;
}

/** Blocks the current step with `reason`; `regressedChecks` names the tests a review-only rerun found regressed. */
export function blockWorkflow(currentInput: unknown, reason: string, now: string, detail: { regressedChecks?: readonly string[] } = {}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const { regressedChecks: _prior, ...withoutRegressions } = current;
  void _prior;
  return WorkflowSnapshotSchema.parse({
    ...withoutRegressions, revision: current.revision + 1, state: "BLOCKED", blockReason: reason.slice(0, 500), updatedAt: now,
    ...(detail.regressedChecks === undefined || detail.regressedChecks.length === 0 ? {} : { regressedChecks: detail.regressedChecks }),
  });
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
 * failed, a review-only task's verification stopped (it has no check to retry), coding itself stopped, or the change is
 * ready to publish (for example, its code changed after its checks).
 */
export function workflowSendBackOffered(workflow: {
  stage: string; state: string; blockReason?: string | undefined; pullRequests?: readonly unknown[] | undefined;
  checkPolicy?: WorkflowCheckPolicy | undefined;
  candidate?: { digest?: string } | undefined;
  reviews?: ReadonlyArray<{ candidateDigest?: string; role?: string; findings?: ReadonlyArray<{ text?: string; file?: string | undefined; line?: number | undefined; origin?: string; advisory?: boolean | undefined } | string> | undefined }> | undefined;
  acceptedFindings?: ReadonlyArray<{ candidateDigest: string; role: string; fingerprint: string }> | undefined;
  verification?: { candidateDigest?: string; results?: ReadonlyArray<{ status: string; broken?: boolean | undefined; programNotFound?: boolean | undefined }> | undefined } | undefined;
}): boolean {
  if (!sendBackAllowedFrom(workflow)) return false;
  // Only evidence about the current code counts: a review or check of older code describes code that is gone.
  const current = workflow.candidate?.digest;
  if (workflow.stage === "REVIEW") {
    return current !== undefined && workflow.reviews?.some((review) => review.candidateDigest === current
      && review.findings?.some((finding) => findingBlocks(finding, review.role)
        && !findingAccepted(finding, review.role, review.candidateDigest, workflow.acceptedFindings))) === true;
  }
  if (workflow.stage === "VERIFY") {
    // Review only: a rerun of the agent's own tests regressed, and no result was recorded for it.
    if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.regressionFound) return true;
    // Review only: there is no check to retry, so coding again is the way on, except from rewritten history.
    if (workflowIsReviewOnly(workflow.checkPolicy)) return workflow.blockReason !== WORKFLOW_HISTORY_REWRITTEN_MESSAGE;
    return current !== undefined && workflow.verification?.candidateDigest === current
      && workflow.verification.results?.some((result) => result.status === "FAILED" && !workflowCheckResultBroken(result)) === true;
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
  input: { requestId: string; actorId: string; reason: string; now: string; source?: "SEND_BACK" | "FINDINGS" },
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
    actorRole: "TASK_OWNER", reason: input.reason.trim().slice(0, 500), source: input.source ?? "SEND_BACK", at: input.now,
  });
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({
    ...unblocked, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY",
    decisions: [...current.decisions, decision], updatedAt: input.now,
  });
}

const REVIEW_ROLE_NAMES = { CRITIC: "code review", SECURITY: "security review" } as const;

/**
 * One problem a send-back asks the coder to fix. `text` from a review, or naming a regressed test, is untrusted output.
 * `regressed`: a test that passed before this change and fails now (WORKFLOW_REGRESSION_INSTRUCTION says what to do).
 */
export interface WorkflowSendBackProblem { source: "code review" | "security review" | "check"; text: string; regressed?: true }

/** A review finding as a send-back problem: its text, then "(file:line)" when the reviewer named where. */
export function workflowFindingProblem(role: "CRITIC" | "SECURITY", finding: { text: string; file?: string | undefined; line?: number | undefined }): WorkflowSendBackProblem {
  const where = finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`;
  return { source: REVIEW_ROLE_NAMES[role], text: `${finding.text}${where}` };
}

/**
 * The problems a send-back asks the coder to fix, about the current code only: each review finding the change
 * introduced, as "text (file:line)", each selected check that failed, as "<label> failed", and each test a review-only
 * rerun found regressed, as "<test> passed before this change and fails now". Pre-existing findings, and reviews or
 * checks of older code, are left out.
 */
export function sendBackProblems(workflow: WorkflowSnapshot): WorkflowSendBackProblem[] {
  const regressed = (workflow.regressedChecks ?? []).map((test) => ({ source: "check" as const, text: `${test} passed before this change and fails now`, regressed: true as const }));
  const current = workflow.candidate?.digest;
  if (current === undefined) return regressed;
  const findings = (workflow.reviews ?? []).filter((review) => review.candidateDigest === current).flatMap((review) => blockingFindings(review, workflow.acceptedFindings)
    .map((finding) => workflowFindingProblem(review.role, finding)));
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  const failed = workflow.verification?.candidateDigest !== current ? [] : workflow.verification.results.filter((result) => result.status === "FAILED" && !workflowCheckResultBroken(result))
    .map((result) => ({ source: "check" as const, text: `${checks.find((check) => check.id === result.checkId)?.label ?? result.checkId} failed` }));
  return [...findings, ...failed, ...regressed];
}

/** The problems as plain lines, "- [code review] text (file:line)" and "- check <label> failed", for people to read. */
export function sendBackInstructions(workflow: WorkflowSnapshot): string {
  const problems = sendBackProblems(workflow);
  const lines = problems.map((problem) => problem.source === "check" ? `- check ${problem.text}` : `- [${problem.source}] ${problem.text}`);
  if (problems.some((problem) => problem.regressed === true)) lines.push(WORKFLOW_REGRESSION_INSTRUCTION);
  return lines.length > 0 ? lines.join("\n") : "- No check or review problems were recorded; follow the owner note.";
}

/** A blocking review finding as the owner sees it, to accept or send back: `findingId` is its fingerprint. */
export interface WorkflowOpenFinding { findingId: string; role: "CRITIC" | "SECURITY"; text: string; file?: string; line?: number }

/**
 * The blocking review findings of the current code the owner has not accepted yet, in review order (code review, then
 * security review), each once. Pre-existing and advisory findings, and those of reviews of older code, are not listed.
 */
export function openReviewFindings(workflow: WorkflowSnapshot): WorkflowOpenFinding[] {
  const current = workflow.candidate?.digest;
  if (current === undefined) return [];
  const open = new Map<string, WorkflowOpenFinding>();
  for (const role of ["CRITIC", "SECURITY"] as const) {
    for (const review of (workflow.reviews ?? []).filter((entry) => entry.role === role && entry.candidateDigest === current)) {
      for (const finding of blockingFindings(review, workflow.acceptedFindings)) {
        const findingId = workflowFindingFingerprint(role, finding);
        if (!open.has(findingId)) {
          open.set(findingId, { findingId, role, text: finding.text, ...(finding.file === undefined ? {} : { file: finding.file }), ...(finding.line === undefined ? {} : { line: finding.line }) });
        }
      }
    }
  }
  return [...open.values()];
}

/** Whether the owner accepted this finding of this review role for the workflow's current candidate. */
export function workflowFindingAccepted(
  workflow: Pick<WorkflowSnapshot, "candidate" | "acceptedFindings">, role: "CRITIC" | "SECURITY",
  finding: { text: string; file?: string | undefined; line?: number | undefined },
): boolean {
  return findingAccepted(finding, role, workflow.candidate?.digest, workflow.acceptedFindings);
}

/** Whether Slack offers Resolve findings: the reviews are blocked and a finding the change introduced is still open. */
export function workflowResolveFindingsOffered(workflow: WorkflowSnapshot): boolean {
  return workflow.stage === "REVIEW" && workflow.state === "BLOCKED" && openReviewFindings(workflow).length > 0;
}

/** The owner's answer for one finding: accept it with a reason (1 to 500 characters), or send it to coding with optional instructions (up to 1,000). */
export const WorkflowFindingResolutionSchema = z.object({
  findingId: DigestSchema,
  action: z.enum(["ACCEPT", "FIX"]),
  note: z.string().trim().max(1_000, "instructions are at most 1,000 characters"),
}).strict().superRefine((resolution, context) => {
  if (resolution.action === "ACCEPT" && resolution.note === "") context.addIssue({ code: "custom", path: ["note"], message: "give a reason for each finding you accept" });
  if (resolution.action === "ACCEPT" && resolution.note.length > 500) context.addIssue({ code: "custom", path: ["note"], message: "a reason is at most 500 characters" });
});
export type WorkflowFindingResolution = z.infer<typeof WorkflowFindingResolutionSchema>;

/** The resolution of every blocking finding, at the workflow revision and candidate the owner saw. */
export const WorkflowResolveFindingsInputSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  candidateDigest: DigestSchema,
  resolutions: z.array(WorkflowFindingResolutionSchema).min(1, "choose what to do with each blocking finding")
    .max(WORKFLOW_RESOLVE_FINDINGS_MAX, `resolve at most ${WORKFLOW_RESOLVE_FINDINGS_MAX} findings at once`),
}).strict();
export type WorkflowResolveFindingsInput = z.infer<typeof WorkflowResolveFindingsInputSchema>;

/**
 * The owner resolves every blocking review finding of the current code: each is accepted with a reason (recorded for
 * this candidate, so it never blocks it again) or sent to coding. Owner only, at the exact revision and candidate. Any
 * fix returns the task to coding (the accepted ones are recorded as well); with every finding accepted and no other
 * review problem the change is ready for its pull request. A repeated request ID changes nothing.
 */
export function resolveWorkflowReviewFindings(
  currentInput: unknown,
  rawInput: unknown,
  actor: { actorId: string },
  options: { now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (!ActorIdSchema.safeParse(actor.actorId).success || actor.actorId !== current.ownerId) {
    throw new WorkflowTransitionError("only the task owner can resolve review findings");
  }
  const parsed = WorkflowResolveFindingsInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new WorkflowTransitionError(parsed.error.issues[0]?.message ?? "the review finding resolution is invalid");
  const input = parsed.data;
  const prior = current.decisions.find((decision) => decision.requestId === input.requestId);
  if (prior !== undefined) {
    if (prior.source === "FINDINGS" && prior.workflowRevision === input.expectedRevision && prior.actorId === actor.actorId) return current;
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.stage !== "REVIEW" || current.state !== "BLOCKED" || current.candidate === undefined) {
    throw new WorkflowTransitionError("there are no blocked review findings to resolve");
  }
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.candidate.digest !== input.candidateDigest) throw new WorkflowTransitionError("the candidate changed; refresh the task and try again");
  const open = openReviewFindings(current);
  if (open.length === 0) throw new WorkflowTransitionError("there are no blocking review findings to resolve");
  if (open.length > WORKFLOW_RESOLVE_FINDINGS_MAX) {
    throw new WorkflowTransitionError(`there are ${open.length} blocking findings and AgentX resolves at most ${WORKFLOW_RESOLVE_FINDINGS_MAX} at once; send the change back to coding instead`);
  }
  const answered = new Set<string>();
  for (const resolution of input.resolutions) {
    if (!open.some((finding) => finding.findingId === resolution.findingId)) throw new WorkflowTransitionError("a finding in this request is not a current blocking finding; refresh the task and try again");
    if (answered.has(resolution.findingId)) throw new WorkflowTransitionError("each finding can be answered only once");
    answered.add(resolution.findingId);
  }
  if (open.some((finding) => !answered.has(finding.findingId))) throw new WorkflowTransitionError("choose what to do with every blocking finding");
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");

  const candidateDigest = current.candidate.digest;
  const accepts = input.resolutions.filter((resolution) => resolution.action === "ACCEPT").map((resolution): WorkflowAcceptedFinding => {
    const finding = open.find((entry) => entry.findingId === resolution.findingId)!;
    return { candidateDigest, role: finding.role, fingerprint: finding.findingId, text: finding.text, reason: resolution.note, actorId: actor.actorId, at: options.now };
  });
  const fixes = input.resolutions.length - accepts.length;
  const acceptedFindings = [...(current.acceptedFindings ?? []), ...accepts].slice(-WORKFLOW_ACCEPTED_FINDINGS_MAX);
  const summary = `${accepts.length} accepted, ${fixes} to fix`;
  const withAccepted = WorkflowSnapshotSchema.parse({ ...current, acceptedFindings });
  if (fixes > 0) {
    return returnWorkflowToImplementation(withAccepted, { requestId: input.requestId, actorId: actor.actorId, reason: summary, now: options.now, source: "FINDINGS" });
  }
  const decision = WorkflowDecisionSchema.parse({
    requestId: input.requestId, workflowRevision: current.revision, decision: "APPROVE", actorId: actor.actorId,
    actorRole: "TASK_OWNER", reason: summary, source: "FINDINGS", at: options.now,
  });
  const reviewsClear = (["CRITIC", "SECURITY"] as const).every((role) => (current.reviews ?? []).some((review) =>
    review.role === role && review.candidateDigest === candidateDigest && reviewCleared(review, acceptedFindings)));
  const { blockReason, ...unblocked } = withAccepted;
  return WorkflowSnapshotSchema.parse({
    ...(reviewsClear ? unblocked : withAccepted), revision: current.revision + 1,
    ...(reviewsClear ? { stage: "PULL_REQUEST", state: "READY" } : { blockReason }),
    decisions: [...current.decisions, decision], updatedAt: options.now,
  });
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
