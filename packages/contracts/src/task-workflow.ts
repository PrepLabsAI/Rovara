import { z } from "zod";
import { sha256Hex } from "./web-hash.js";
import { readerOf, type ForwardReader } from "./forward-reader.js";
import { FixSourceSchema, RiskAssessmentSchema, UNDERSTAND_ANSWER_PENDING_MESSAGE, UNDERSTAND_TIMED_OUT_MESSAGE, WorkflowCritiqueSchema, WorkflowFixRoundsSchema, WorkflowIntentSchema, CI_FIX_PROBLEMS_MAX, UNDERSTAND_UNREADABLE_MESSAGE, WorkflowBranchSyncSchema, SYNC_FAILURES_MAX, FEEDBACK_AUTONOMY_ACTOR_ID, FEEDBACK_STOPPED_REASON, FeedbackCiFailuresSchema, WorkflowFeedbackAutonomySchema } from "./rovara-code.js";
import { StepIdSchema, CODING_STEP_KINDS, ReviewerSchema, OnFindingsSchema, MAX_RECIPE_STEPS } from "./agent-recipe.js";
import { ProjectCommandSchema } from "./project.js";
import { E2E_PROJECT_CHECK_ID, E2EWorkflowProgressSchema } from "./e2e.js";
import { WorkflowDependencyApprovalSchema, WorkItemProgressV1Schema } from "./workflow-dependencies.js";
import { NO_CODE_CHANGED_REASON, NoChangeFindingsSchema } from "./no-change-findings.js";
import { CheckKindSchema } from "./evidence.js";
import { WorkflowDesignReviewSchema } from "./design-review.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ActorIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const WORKFLOW_PLAN_MAX_BYTES = 32_768;

/** Shown to the owner when AgentX gave up opening the draft pull request on its own; Retry opening the pull request starts it. */
/** S2: every reason a step was not started because its owner may no longer have work started for them begins with these words (the broker's messages, and the one place the schema recognises them). */
export const WORKFLOW_NOT_RUN_PREFIX = "Rovara didn't start";
export const isStepNotRunReason = (reason: string | undefined): boolean => reason !== undefined && reason.startsWith(WORKFLOW_NOT_RUN_PREFIX);

export const WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE = "AgentX couldn't open the pull request automatically. Use Retry opening the pull request to try again.";

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
  noCodeChanged: NO_CODE_CHANGED_REASON,
  /** A review stopped before it started: the base commit's rule files could not be checked against the commit's own ids (WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE). */
  ruleFilesUnverified: "AgentX couldn't verify the base rule files, so the review did not run. Retry the review, or close the task.",
  /** The same stop for Understand and the plan check (Cloud only), which are not reviews. */
  stepRuleFilesUnverified: "AgentX couldn't verify the base rule files, so this step did not run. Retry it, or close the task.",
  /**
   * Understand or Plan stopped because the owner's live message asked for a change outside what was approved (WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE). Retry plans again with the message, and the
   * new plan is what the owner approves before anything is built.
   */
  liveSteerReapproval: "A live message from the owner asks for a change outside what was approved, so this step stopped. Choose Retry: Rovara plans again with that message, and you approve the new plan before anything is built.",
  /**
   * The same stop at Coding for a task whose plan cannot take the change in (a custom sequence, an open pull request or a fix round: `workflowReviseOffered` is false). Retry coding and Send back both keep the
   * approved plan, so the words say what the ways do: the run's changes stay in the workspace unchecked (a stopped coding run keeps its working tree: pinned by tests/integration/worker-cancelled-implement-keeps-work.test.ts), Retry continues the approved plan from the current code without the change, and a new task is how to include it.
   */
  liveSteerReapprovalCoding: "A live message from the owner asks for a change outside the approved plan, so coding stopped. What the run changed so far is still in the workspace but was not checked. Retry coding continues the approved plan from the current code without that change. To include the change, close this task and start a new task that asks for it.",
  /**
   * The same stop at Coding for a task whose plan can take the change in (`workflowReviseOffered`): the card and the page offer Revise the plan, which plans again with the owner's message and asks the
   * owner to approve the revised plan before coding continues; Retry coding still builds the approved plan without it.
   */
  liveSteerReapprovalRevise: "A live message from the owner asks for a change outside the approved plan, so coding stopped. What the run changed so far is still in the workspace but was not checked. Choose Revise the plan (in the task's Slack thread or on the task page): Rovara plans again with that change, and you approve the revised plan before coding continues. Or choose Retry coding to continue the approved plan from the current code without that change.",
  /** A step that only reads the code could not first stop the programs earlier work left running (WORKFLOW_LEFTOVER_PROCESSES_MESSAGE). */
  leftoverProcesses: "AgentX couldn't stop the programs left running from earlier work, so this step did not run.",
  /** The checks' fresh dev container ran its setup commands and they changed the project's files (WORKFLOW_SETUP_CHANGED_FILES_MESSAGE); the files are left as they are. */
  setupChangedFiles: "The dev container's setup changed the project's files, so the checks did not run. Look at what its setup commands change, then retry, or close the task.",
  /** An approved PR feedback fix left every repository's code as its open pull request holds it: nothing was pushed. */
  fixChangedNothing: "The approved fix didn't change any code, so nothing was pushed.",
  codeChangedAfterChecks: "The code changed after its checks ran. Run the checks again on the latest code.",
  startUnrecorded: "AgentX could not record where this change started. Close the task and start a new one.",
  startUnconfirmed: "AgentX could not confirm the task's starting commit on GitHub.",
  startChanged: "The code's starting point changed. Send the task back to coding or close it.",
  noCheckResults: "No required or selected optional checks ran. Configure or select at least one check, then retry.",
  planNotSaved: "The planning run finished without saving a document. Retry planning.",
  /** The saved plan is a structured document that could not be read back. */
  planUnreadable: "the plan couldn't be read",
  /** Plan 6 Task 8: the plan check's answer had no block Rovara could read. */
  planCheckUnreadable: "Rovara couldn't read the plan check's answer.",
  /** Plan 6 Task 8: the plan check or the revision after it could not be started, however often it was tried. */
  planCheckNotStarted: "Rovara couldn't start the plan check.",
  planRevisionNotStarted: "Rovara couldn't start revising the plan after its check.",
  pullRequestChanged: "The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.",
  /** A required pull request was closed on GitHub without merging; reopened, it is followed again. */
  pullRequestClosed: "The pull request was closed on GitHub without merging. Reopen it there, or close this task.",
  /** The pull request's feedback review failed; AgentX still watches the pull request for its merge. */
  feedbackReviewFailed: "I couldn't review the feedback on the pull request, so I have nothing to propose from it.",
  /** The approved fix could not be pushed to the pull request; AgentX still watches the pull request for its merge. */
  pullRequestUpdateFailed: "I couldn't push the fix to the pull request.",
  /** Shown only in a task view, never stored: the document waiting for approval failed its digest check. */
  documentUnverified: "The saved document couldn't be checked, so I stopped. Close this task and start again.",
  /** Plan 3, Task 32: a step ran out of its run's budget and a spend request is open; approving it retries the step. */
  budgetPaused: "Paused: this task needs more AI budget. I've asked for it.",
  /** Rovara Code version 2: Understand's answer could not be read, even after one more try. */
  understandUnreadable: UNDERSTAND_UNREADABLE_MESSAGE,
  /** Rovara Code version 2: the request needs no code change, and closing a task as answered is not available yet. */
  understandAnswerPending: UNDERSTAND_ANSWER_PENDING_MESSAGE,
  /** Rovara Code version 2: Understand never came back in time, so the task was ended. */
  understandTimedOut: UNDERSTAND_TIMED_OUT_MESSAGE,
  /** Rovara Code version 2: the dispatch could not start Understand, or the plan step after it, within its attempts. */
  understandNotStarted: "I couldn't start reading your request. Retry it.",
  planNotStarted: "I couldn't start the plan. Retry planning.",
  /** Rovara Code version 2: Understand chose the Full path, but a Full start would not be admitted on the budgets that are left. */
  understandFullNotAdmitted: "I chose the Full path for this task, but there isn't enough AI budget left to start a Full plan. Raise the budget, then retry.",
} as const;

/** At most this many regressed tests are kept on a blocked workflow, each cut to WORKFLOW_REGRESSED_CHECK_MAX characters. */
export const WORKFLOW_REGRESSED_CHECKS_MAX = 8;

export const WORKFLOW_REGRESSED_CHECK_MAX = 120;

export const CandidateRepositorySchema = z.object({
  repositoryId: z.string().trim().min(1).max(200),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** The commit the task started from; reviewers see the diff from it to `treeSha`. */
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
}).strict();

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
  const digest = sha256Hex(canonical);
  if (digest !== manifest.digest) context.addIssue({ code: "custom", path: ["digest"], message: "candidate digest does not match its canonical repository manifest" });
});

export const VerificationResultsSchema = z.object({
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

export const WorkflowVerificationRetrySchema = z.object({
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

/**
 * The sentence a review report carries when its reviewer's model call failed and left it with no answer: the model-call monitor's fixed shape (a failure class, an allow-listed error token, a status, a request id and an
 * attempt number), never the provider's text. The broker reads it with the plan check's rule for a model the account can't use.
 */
export const WORKFLOW_REVIEW_MODEL_FAILURE_PATTERN = /^the model call failed: [A-Za-z0-9 ._:-]{1,250}$/u;

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
  /** Rovara Code v2: the code reviewer's own risk level for this change (one of three words; the security review states none). Kept only on a 1.1.0 task. */
  risk: z.enum(["low", "medium", "high"]).optional(),
  /** The reviewer's model call failed and the review has no answer: why, as a fixed sentence (see `WORKFLOW_REVIEW_MODEL_FAILURE_PATTERN`). The model that failed is this report's provider and version. Optional, so reports stored before it parse. */
  modelFailure: z.string().max(300).regex(WORKFLOW_REVIEW_MODEL_FAILURE_PATTERN).optional(),
}).strict().superRefine((report, context) => {
  if (report.risk !== undefined && report.role !== "CRITIC") context.addIssue({ code: "custom", path: ["risk"], message: "only the code review states a risk level" });
  const introduced = report.findings.some((finding) => findingBlocks(finding, report.role));
  if (report.status === "PASS" && introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a passing review cannot report an introduced finding" });
  if (report.status === "FINDINGS" && !introduced) context.addIssue({ code: "custom", path: ["findings"], message: "a review with findings must report at least one introduced finding" });
});

export type WorkflowReviewReport = z.infer<typeof WorkflowReviewReportSchema>;

export function findingBlocks(finding: { origin?: string; advisory?: boolean | undefined } | string, role: string | undefined): boolean {
  // A security finding is never advisory: the flag is ignored on it, and only the owner's accept waives one.
  return typeof finding === "string" || (finding.origin === "INTRODUCED" && (finding.advisory !== true || role === "SECURITY"));
}

/**
 * The stable ID of a review finding: the SHA-256 of its review role, text, file and line. The same finding of the same
 * review role always has the same ID, so the owner's answer for it can be matched again later.
 */
export function workflowFindingFingerprint(role: "CRITIC" | "SECURITY", finding: { text: string; file?: string | undefined; line?: number | undefined }): string {
  return sha256Hex(JSON.stringify([role, finding.text, finding.file ?? "", finding.line ?? 0]));
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

export const WORKFLOW_ACCEPTED_FINDINGS_MAX = 100;

export type AcceptedFindingRef = { candidateDigest: string; role: string; fingerprint: string };

export function findingAccepted(
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

export function reviewCleared(review: WorkflowReviewReport, accepted: readonly AcceptedFindingRef[] | undefined): boolean {
  return review.status === "PASS" || (review.status === "FINDINGS" && blockingFindings(review, accepted).length === 0);
}

/**
 * SR-1 (switch `cr`, `on` only): the second review's blocking findings for one candidate, kept IN the workflow so that nothing which reads the workflow can clear them by accident: accepting the first review's
 * findings does not clear this block, and each of these findings is accepted (or sent to coding) by the owner the same way a first review's is. Absent unless an `on` second review blocked.
 */
export const WORKFLOW_SECOND_REVIEW_LINE_MAX = 10_000_000;

export const WorkflowSecondReviewBlockSchema = z.object({
  candidateDigest: DigestSchema,
  findings: z.array(z.object({ text: z.string().trim().min(1).max(600), file: z.string().max(500).optional(), line: z.number().int().positive().max(WORKFLOW_SECOND_REVIEW_LINE_MAX).optional() }).strict()).min(1).max(20),
}).strict();
export type WorkflowSecondReviewBlock = z.infer<typeof WorkflowSecondReviewBlockSchema>;

/** A review finding as the block keeps it, always within the block's own limits (a model's absurd line number or long path can never make the workflow unreadable): the line is left out when it is over the cap, the path and text are cut. */
export function secondReviewBlockFinding(finding: { text: string; file?: string | undefined; line?: number | undefined }): { text: string; file?: string; line?: number } {
  return { text: finding.text.slice(0, 600), ...(finding.file === undefined ? {} : { file: finding.file.slice(0, 500) }),
    ...(finding.line === undefined || finding.line > WORKFLOW_SECOND_REVIEW_LINE_MAX ? {} : { line: finding.line }) };
}

/** The second review's findings the owner has not accepted yet, for the code the workflow holds NOW. Role `CRITIC` is the namespace they are accepted under (a second review is a code review). */
export function openSecondReviewFindings(workflow: { candidate?: { digest: string } | undefined; acceptedFindings?: readonly AcceptedFindingRef[] | undefined; secondReviewBlock?: { candidateDigest: string; findings: ReadonlyArray<{ text: string; file?: string | undefined; line?: number | undefined }> } | undefined }): Array<{ text: string; file?: string | undefined; line?: number | undefined }> {
  const block = workflow.secondReviewBlock;
  const current = workflow.candidate?.digest;
  if (block === undefined || current === undefined || block.candidateDigest !== current) return [];
  return block.findings.filter((finding) => !findingAccepted(finding, "CRITIC", current, workflow.acceptedFindings));
}

export const WorkflowPullRequestSchema = z.object({
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
  /** Plan 6: the head this pull request had before Rovara merged the base branch into it (a sync); allowed on both definition versions. */
  syncedFrom: z.string().regex(/^[a-f0-9]{40}$/).optional(),
}).strict();

export const FeedbackIdSchema = z.string().trim().min(1).max(128);

export const FeedbackObjectKeySchema = z.string().min(1).max(1024).refine(key => !key.startsWith("/") && !key.split("/").includes(".."));

export const FeedbackCommentRefSchema = z.object({
  id: FeedbackIdSchema, threadId: FeedbackIdSchema.optional(),
  kind: z.enum(["REVIEW", "REVIEW_COMMENT", "DISCUSSION"]),
  url: z.string().url().max(2048), author: z.string().trim().min(1).max(100),
  updatedAt: z.string().datetime(), bodyDigest: DigestSchema, bodyBytes: z.number().int().nonnegative().max(1_000_000),
  path: z.string().max(1024).optional(), line: z.number().int().positive().optional(),
}).strict();

export const WorkflowFeedbackBundleMetadataSchema = z.object({
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

export const WorkflowFeedbackPrioritySchema = z.enum(["MUST_FIX", "SHOULD_FIX", "OPTIONAL"]);

export const WorkflowFeedbackAssessmentSchema = z.enum(["ACTIONABLE", "ALREADY_ADDRESSED", "STALE", "TECHNICALLY_INCORRECT", "OUT_OF_SCOPE", "CONFLICTING", "NEEDS_OWNER_DECISION"]);

export const WorkflowFeedbackFindingRefSchema = z.object({
  id: FeedbackIdSchema, bundleDigest: DigestSchema,
  commentIds: z.array(FeedbackIdSchema).min(1).max(128).refine(ids => new Set(ids).size === ids.length),
  priority: WorkflowFeedbackPrioritySchema, assessment: WorkflowFeedbackAssessmentSchema, recommended: z.boolean(),
}).strict();

export const WorkflowFeedbackCandidateBindingSchema = z.object({
  repositoryId: z.string().trim().min(1).max(200), number: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), candidateDigest: DigestSchema,
  commentSetDigest: DigestSchema, bundleDigest: DigestSchema,
}).strict();

export const WorkflowFeedbackReviewMetadataSchema = z.object({
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

export const WorkflowFeedbackDecisionSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), workflowRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "DISMISS"]),
  // A person's id is 64 hex characters; Rovara's own automatic decision (Plan 6 Task 16) is recorded under "rovara" with the autonomy it was made under, never as the owner's.
  actorId: z.union([ActorIdSchema, z.literal(FEEDBACK_AUTONOMY_ACTOR_ID)]), actorRole: z.enum(["TASK_OWNER", "ROVARA_AUTONOMY"]),
  reviewDigest: DigestSchema, proposalDigest: DigestSchema, bundleDigests: z.array(DigestSchema).min(1).max(32),
  selectedFindingIds: z.array(FeedbackIdSchema).max(128), selectedCommentIds: z.array(FeedbackIdSchema).max(4096),
  candidates: z.array(WorkflowFeedbackCandidateBindingSchema).max(32), ownerNote: z.string().trim().min(1).max(2000).optional(), at: z.string().datetime(),
  autonomy: WorkflowFeedbackAutonomySchema.optional(),
  /** The failing checks the card showed when this was decided (they are part of what the decision is bound to). */
  ciFailures: FeedbackCiFailuresSchema.optional(),
}).strict().superRefine((decision, context) => {
  const byRovara = decision.actorRole === "ROVARA_AUTONOMY";
  if (byRovara !== (decision.actorId === FEEDBACK_AUTONOMY_ACTOR_ID) || byRovara !== (decision.autonomy !== undefined) || (byRovara && decision.decision !== "APPROVE")) {
    context.addIssue({ code: "custom", message: "an automatic decision is Rovara's own, carries its autonomy and can only approve" });
  }
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
  /** Present only when Rovara decided the round itself (Plan 6 Task 16): the autonomy and recipe it was decided under, checked again when the worker starts. */
  autonomy: WorkflowFeedbackAutonomySchema.optional(),
  /** The digest of the failing checks the card showed, when it showed any. */
  ciFailuresDigest: DigestSchema.optional(),
}).strict();

export const ReviewedWorkflowFeedbackSchema = z.object({
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

export const FeedbackThreadObservationsSchema = z.array(WorkflowFeedbackThreadObservationSchema).max(4096);

/**
 * Which pull request comments the agent was shown, round by round (lessons capture: who steered a task through the pull request feedback flow).
 * A round lists, for each pull request, the ids of EVERY comment collected for the agent: the selected ones and the rest, review bodies, whole threads and replies.
 * `incomplete`: some round could not be recorded (the list is full, or a round was collected before this record existed), so the set cannot be taken as the whole.
 */
export const FEEDBACK_SHOWN_MAX_ROUNDS = 100;
export const FEEDBACK_SHOWN_MAX_IDS = 800;
export const WorkflowFeedbackShownSchema = z.object({
  rounds: z.array(z.object({
    at: z.string().datetime(),
    /** `at` of a comment: when the host last changed it (epoch milliseconds), as the agent was shown it. A comment edited since it was written reads differently from one never edited. */
    pulls: z.array(z.object({
      repositoryId: z.string().trim().min(1).max(200), number: z.number().int().positive(),
      comments: z.array(z.object({
        id: FeedbackIdSchema, at: z.number().int().nonnegative(),
        /** Whether the host records an edit of the comment (GraphQL `lastEditedAt`): false = never edited, true = edited, absent = the host did not say. Only `false` proves a review body is its author's own words. */
        edited: z.boolean().optional(),
      }).strict()).max(FEEDBACK_SHOWN_MAX_IDS),
    }).strict()).max(32),
  }).strict()).max(FEEDBACK_SHOWN_MAX_ROUNDS),
  incomplete: z.literal(true).optional(),
}).strict();

export const WorkflowFeedbackReviewSchema = z.union([
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

export const WorkflowStageSchema = z.enum([
  "UNDERSTAND",
  "PLAN",
  "PLAN_CRITIQUE",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "VERIFY",
  "REVIEW",
  "PULL_REQUEST",
  "WAIT_FOR_MERGE",
  "MERGED",
  "CLOSED",
]);

export const WorkflowStateSchema = z.enum(["READY", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"]);

/** One step of a workflow program: the same step kinds a coding recipe has, in the order the engine follows them. */
export const WorkflowProgramStepSchema = z.object({
  id: StepIdSchema,
  kind: z.enum(CODING_STEP_KINDS),
  /** Review steps only: which reviews this step runs. */
  reviewers: z.array(ReviewerSchema).min(1).max(2).optional(),
  /** Review steps only: where findings go back to (an earlier build step), and how many review rounds before the step blocks. */
  onFindings: OnFindingsSchema.optional(),
}).strict();

/**
 * The step order a custom coding recipe hands to the workflow engine. Rovara Code's own order is the engine's built-in
 * path and has no program. A check step is the checks run on the build before it; a check anywhere else was already
 * recorded with its build, so the engine passes over it.
 */
export const WorkflowProgramSchema = z.object({
  steps: z.array(WorkflowProgramStepSchema).min(1).max(MAX_RECIPE_STEPS),
}).strict().superRefine((program, context) => {
  const steps = program.steps;
  const problem = (message: string, index?: number) => context.addIssue({ code: "custom", path: index === undefined ? ["steps"] : ["steps", index], message });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) problem("step ids must be unique");
  steps.forEach((step, index) => {
    if (step.kind === "plan" && index !== 0) problem("a plan step can only come first", index);
    if (step.kind === "plan_critic" && (index !== 1 || steps[0]?.kind !== "plan")) problem("a plan check step can only come directly after the plan step", index);
    if (step.kind === "pull_request" && index !== steps.length - 1) problem("a pull request step can only come last", index);
    if (step.kind === "review") {
      if (step.reviewers === undefined) problem("a review step needs its reviewers", index);
      else if (new Set(step.reviewers).size !== step.reviewers.length) problem("reviewers must be unique", index);
    } else if (step.reviewers !== undefined || step.onFindings !== undefined) {
      problem("only a review step has reviewers or an onFindings", index);
    }
    if (step.onFindings !== undefined) {
      const target = steps.findIndex((candidate) => candidate.id === step.onFindings?.backTo);
      if (target < 0 || target >= index || steps[target]?.kind !== "build") problem("onFindings must go back to an earlier build step", index);
    }
  });
  if (steps.find((step) => step.kind !== "plan" && step.kind !== "plan_critic")?.kind !== "build") problem("the first step after the plan must be a build step");
  if (steps.some((step) => step.kind === "pull_request")) {
    const after = steps.slice(steps.findLastIndex((step) => step.kind === "build") + 1);
    if (!after.some((step) => step.kind === "check") || !after.some((step) => step.kind === "review" && step.reviewers?.includes("code") === true && step.reviewers.includes("security"))) {
      problem("a pull request step needs a check step and a review step with both reviewers after the last build step");
    }
  }
});

export const WorkflowObjectKeySchema = z.string().min(1).max(1024).refine((key) => !key.startsWith("/") && !key.split("/").includes(".."));

export const WorkflowArtifactSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["requirements", "design", "plan", "test_plan", "review_report", "answer"]),
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

export const WORKFLOW_DECISION_ANSWERS_MAX = 20;

export const WORKFLOW_DECISION_COMMENTS_MAX = 25;

export const PlanDecisionIdSchema = z.string().regex(/^d[1-9][0-9]?$/);

export const PlanOptionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);

export const WorkflowAnswerSchema = z.object({ decisionId: PlanDecisionIdSchema, optionId: PlanOptionIdSchema }).strict();

/**
 * The broker's own actor for automatic fixing (AUTOFIX): a fixed identity that is nobody's account. Decisions it records carry `actorRole: "AGENTX"`; such a decision can only be
 * REQUEST_CHANGES with source AUTO_FIX or AUTO_RETRY (see `WorkflowDecisionSchema`), so it can never be an approval, a skip, a rejection or a publication.
 * (Web-safe file: `sha256Hex` gives the same digest as node:crypto's sha256 of the same UTF-8 text.)
 */
export const WORKFLOW_AGENTX_ACTOR_ID = sha256Hex("agentx:automatic-fix:v1");
/** The stages an automatic action can be recorded for (the same stages the owner's Retry and Send back buttons belong to). */
export const WORKFLOW_AUTO_STAGES = ["PLAN", "IMPLEMENT", "VERIFY", "REVIEW"] as const;
/** At most this many automatic send backs to coding per approved plan version (decisions since the plan's last APPROVE). */
export const WORKFLOW_AUTO_SEND_BACK_LIMIT = 2;
/** At most this many automatic retries of one stage for one candidate. */
export const WORKFLOW_AUTO_RETRY_LIMIT = 1;
/** At most this many automatic actions (send backs and retries together) in one task, however many plan versions it has. */
export const WORKFLOW_AUTO_ACTION_LIMIT = 6;
/** What an automatic decision was for: the stage it acted on and, when there was one, the candidate that stage had produced. */
export const WorkflowAutoActionSchema = z.object({ stage: z.enum(WORKFLOW_AUTO_STAGES), candidateDigest: DigestSchema.optional() }).strict();

export const WorkflowDecisionSchema = z.object({
  requestId: z.string().uuid(),
  workflowRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]),
  actorId: ActorIdSchema,
  /** `AGENTX` is the broker acting by itself (automatic fixing); only with source AUTO_FIX or AUTO_RETRY, and never for an approval. */
  actorRole: z.enum(["TASK_OWNER", "PROJECT_ADMIN", "AGENTX"]),
  reason: z.string().trim().min(1).max(500),
  artifactDigest: DigestSchema.optional(),
  /** The exact dependency graph covered by this whole-plan approval. */
  workBreakdownDigest: DigestSchema.optional(),
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
  /**
   * Where the decision was made: an approval gate (the default), the owner sending blocked work back to coding, or the owner resolving review findings; or the broker by itself
   * sending blocked work back to coding (AUTO_FIX) or retrying a stage (AUTO_RETRY).
   */
  source: z.enum(["GATE", "SEND_BACK", "FINDINGS", "AUTO_FIX", "AUTO_RETRY"]).optional(),
  /** Automatic decisions only: the stage (and candidate) the automatic action was for. The automatic limits are counted from these. */
  auto: WorkflowAutoActionSchema.optional(),
  /** Plan decisions: the owner's answers that differ from AgentX's recommended ones, in the plan's decision order. */
  answerOverrides: z.array(WorkflowAnswerSchema).min(1).max(WORKFLOW_DECISION_ANSWERS_MAX).optional(),
  /** How many page comments the decision sent along (their IDs are in the decision's detail item). */
  commentsIncluded: z.number().int().min(0).max(WORKFLOW_DECISION_COMMENTS_MAX).optional(),
  /** Made on the task page; absent for Slack, MCP and older decisions. */
  via: z.literal("PAGE").optional(),
  /** Rovara Code v2: a REJECT of a plan that said no change is needed, which ends the task Answered instead of Closed. */
  closedAs: z.literal("ANSWERED").optional(),
  at: z.string().datetime(),
}).strict();

/**
 * A decision as the workflow stores it: the shape above plus the rules for the AGENTX actor. A separate schema because a refined object cannot be `.omit()`ted or `.extend()`ed,
 * and clients and tests derive older shapes from the plain one.
 */
export const WorkflowDecisionRecordSchema = WorkflowDecisionSchema.superRefine((decision, context) => {
  const automatic = decision.source === "AUTO_FIX" || decision.source === "AUTO_RETRY";
  if (automatic !== (decision.actorRole === "AGENTX")) {
    context.addIssue({ code: "custom", path: ["actorRole"], message: "the AGENTX actor makes automatic decisions, and only it does" });
  }
  if (decision.actorRole === "AGENTX" && decision.actorId !== WORKFLOW_AGENTX_ACTOR_ID) {
    context.addIssue({ code: "custom", path: ["actorId"], message: "an automatic decision is made by the AgentX actor" });
  }
  if (automatic) {
    // An automatic decision can only ask for a change: it carries no approval, no document, no choice of checks and no owner answers.
    if (decision.decision !== "REQUEST_CHANGES") context.addIssue({ code: "custom", path: ["decision"], message: "an automatic decision can only be REQUEST_CHANGES" });
    if (decision.auto === undefined) context.addIssue({ code: "custom", path: ["auto"], message: "an automatic decision names its stage" });
    if (decision.artifactDigest !== undefined || decision.workBreakdownDigest !== undefined || decision.selectedOptionalCheckIds !== undefined
      || decision.answerOverrides !== undefined || decision.commentsIncluded !== undefined || decision.via !== undefined) {
      context.addIssue({ code: "custom", message: "an automatic decision carries nothing an approval carries" });
    }
  } else if (decision.auto !== undefined) {
    context.addIssue({ code: "custom", path: ["auto"], message: "only an automatic decision names an automatic stage" });
  }
});

export const WorkflowCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  command: ProjectCommandSchema,
  /** What the check is for; the setup agent proposes it and a maintainer confirms it. Absent reads as `other`. */
  kind: CheckKindSchema.optional(),
}).strict().refine((check) => check.id !== E2E_PROJECT_CHECK_ID, "project-e2e is reserved for trusted E2E aggregation");

export type WorkflowCheck = z.infer<typeof WorkflowCheckSchema>;

export const WORKFLOW_PROPOSED_CHECKS_MAX = 8;

/** The checks a coding plan proposed (`parseProposedChecks`), with why it proposed none or why they could not be read. */
export const WorkflowCheckProposalSchema = z.object({
  proposed: z.array(WorkflowCheckSchema).max(WORKFLOW_PROPOSED_CHECKS_MAX),
  proposalNote: z.string().min(1).max(200).optional(),
  noneReason: z.string().min(1).max(300).optional(),
}).strict();

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

export const WorkflowPathSchema = z.enum(["QUICK", "FULL"]);
/** The definition versions a stored snapshot may have: Rovara Code v1 (today's engine) and v2. */
export const WORKFLOW_DEFINITION_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type WorkflowDefinitionVersion = (typeof WORKFLOW_DEFINITION_VERSIONS)[number];

export const WorkflowReviewPhaseSchema = z.enum(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]);

export const WorkflowCanvasLineageSchema = z.object({
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

export const WorkflowCanvasCloseoutSchema = z.object({
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

export const WorkflowCanvasCloseoutAttemptSchema = z.object({
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

/** Each repository's base commit: the workflow's pinned reviewBase, a task's prepared base, a worker's workflowBase. */
export const WorkflowReviewBaseSchema = z.array(z.object({
  repositoryId: z.string().trim().min(1).max(200),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict()).min(1).max(32).refine((base) => new Set(base.map((entry) => entry.repositoryId)).size === base.length,
  "base repositories must be unique");

export const PROGRAM_ROUNDS_MAX = 100;

/** Why pushing a fix to a pull request failed: its head moved on GitHub, GitHub refused it, or the worker cannot push a reviewed fix. */
/** What the worker says when a conflict round's tree would drop what the base branch brought (Plan 6 Task 17): the cause `BASE_CHANGES_DROPPED` is told from it. */
export const WORKFLOW_FIX_DROPS_BASE_CHANGES = "the fix would drop changes the base branch made";
export const WORKFLOW_PULL_REQUEST_UPDATE_CAUSES = ["HEAD_MOVED", "PUSH_REFUSED", "WORKER_OUTDATED", "BASE_CHANGES_DROPPED"] as const;

export const WorkflowPullRequestUpdateFailureSchema = z.object({
  numbers: z.array(z.number().int().positive()).min(1).max(32),
  cause: z.enum(WORKFLOW_PULL_REQUEST_UPDATE_CAUSES).optional(),
}).strict();

/** The task snapshot's storage budget for its workflow metadata (the feedback, canvas and dependency records), in bytes of JSON. */
export const WORKFLOW_METADATA_BUDGET_BYTES = 262_144;
/** The bytes of JSON the metadata of a workflow takes against `WORKFLOW_METADATA_BUDGET_BYTES`. One definition, so a writer can measure a record before adding it. */
export function workflowMetadataBytes(workflow: { [K in "feedbackReview" | "feedbackDecisions" | "feedbackDispatchApproval" | "feedbackNotes" | "feedbackReviewHistory" | "feedbackShown" | "feedbackThreadObservations" | "verificationRetries" | "canvasLineage" | "canvasCloseout" | "canvasCloseoutAttempt" | "workflowDependenciesApproval" | "workflowDependenciesOperationId" | "workflowDependenciesProgress"]?: unknown }): number {
  const taskMetadata = { feedbackReview: workflow.feedbackReview, feedbackDecisions: workflow.feedbackDecisions, feedbackDispatchApproval: workflow.feedbackDispatchApproval, feedbackNotes: workflow.feedbackNotes, feedbackReviewHistory: workflow.feedbackReviewHistory, feedbackShown: workflow.feedbackShown, feedbackThreadObservations: workflow.feedbackThreadObservations, verificationRetries: workflow.verificationRetries, canvasLineage: workflow.canvasLineage, canvasCloseout: workflow.canvasCloseout, canvasCloseoutAttempt: workflow.canvasCloseoutAttempt, workflowDependenciesApproval: workflow.workflowDependenciesApproval, workflowDependenciesOperationId: workflow.workflowDependenciesOperationId, workflowDependenciesProgress: workflow.workflowDependenciesProgress };
  return new TextEncoder().encode(JSON.stringify(taskMetadata)).length;
}

export const WorkflowSnapshotShapeSchema = z.object({
  schemaVersion: z.literal(1),
  definitionId: z.literal("agentx-task-to-pr"),
  /** "1.1.0" (Rovara Code v2) alone may hold the stages UNDERSTAND and PLAN_CRITIQUE, the outcome ANSWERED, and `intent`, `critique` and `risk`. */
  definitionVersion: z.enum(WORKFLOW_DEFINITION_VERSIONS),
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
  /**
   * A coding run that ended with no code change: the commands the agent ran, what they printed and the agent's own conclusion, redacted and bounded (`NoChangeFindingsSchema`), kept while the step is
   * blocked with `noCodeChanged` and shown with it. Absent from an older worker's result and from every other block.
   */
  noChangeFindings: NoChangeFindingsSchema.optional(),
  outcome: z.enum(["PASSED", "SKIPPED", "CHANGES_REQUESTED", "REJECTED", "MERGED", "CLOSED", "ANSWERED"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  artifacts: z.array(WorkflowArtifactSchema).max(100),
  decisions: z.array(WorkflowDecisionRecordSchema).max(100),
  checkPolicy: WorkflowCheckPolicySchema.optional(),
  /** Frozen E2E references. Results remain separately qualified by the broker. */
  e2e: E2EWorkflowProgressSchema.optional(),
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
  /**
   * The review threads as last seen when there was nothing to review (feedback only in resolved threads), so a later reply
   * in a thread seen resolved counts as new feedback. A collected review keeps its own observations instead.
   */
  feedbackThreadObservations: FeedbackThreadObservationsSchema.optional(),
  feedbackReviewHistory: z.array(WorkflowFeedbackReviewRefSchema).max(100).optional(),
  feedbackDecisions: z.array(WorkflowFeedbackDecisionSchema).max(100).optional(),
  feedbackDispatchApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
  /** Rovara Code v2: the failing checks added to the owner's feedback card while it waits (Plan 6 Task 16); moved into the decision once decided. */
  feedbackCiFailures: FeedbackCiFailuresSchema.optional(),
  feedbackNotes: z.array(WorkflowFeedbackNoteSchema).max(100).optional(),
  /** The comments the agent was shown in every feedback round (lessons capture); see `WorkflowFeedbackShownSchema`. */
  feedbackShown: WorkflowFeedbackShownSchema.optional(),
  canvasLineage: z.array(WorkflowCanvasLineageSchema).max(100).optional(),
  canvasLineageVersion: z.number().int().nonnegative().optional(),
  canvasCloseout: WorkflowCanvasCloseoutSchema.optional(),
  canvasCloseoutAttempt: WorkflowCanvasCloseoutAttemptSchema.optional(),
  workflowDependenciesApproval: WorkflowDependencyApprovalSchema.optional(),
  /** Broker-authored pointer to the accepted operation for the current approved graph attempt; never exposed in task views. */
  workflowDependenciesOperationId: z.string().uuid().optional(),
  workflowDependenciesProgress: z.array(WorkItemProgressV1Schema).max(32).optional(),
  /** A custom coding sequence the engine follows; absent for Rovara Code's own path. */
  program: WorkflowProgramSchema.optional(),
  /** The program step the workflow is at (or, before its first step, the plan step); only with a program. */
  programStepId: StepIdSchema.optional(),
  /** How many review rounds each review step has finished, so a step that keeps finding problems blocks at its `maxRounds`. */
  programRounds: z.record(StepIdSchema, z.number().int().min(1).max(PROGRAM_ROUNDS_MAX)).optional(),
  /** Rovara Code v2 (1.1.0 only): what Understand made of the request, the questions asked and the answers. */
  intent: WorkflowIntentSchema.optional(),
  /** Rovara Code v2 (1.1.0 only): the plan critic's points. */
  critique: WorkflowCritiqueSchema.optional(),
  /** Design review stage (DR6; 1.1.0 and the Full path only): the fresh-context reviewers' record for the task's design, beside `critique`. Absent when design review is off. */
  designReview: WorkflowDesignReviewSchema.optional(),
  /** Rovara Code v2 (1.1.0 only): the risk level of the pull request's code. */
  risk: RiskAssessmentSchema.optional(),
  /** Both versions: how many fix rounds of each kind ran, and which kind the round now running is. */
  fixRounds: WorkflowFixRoundsSchema.optional(),
  /** SR-1 (switch `cr`, `on`): the second review's blocking findings for one candidate; see `WorkflowSecondReviewBlockSchema`. */
  secondReviewBlock: WorkflowSecondReviewBlockSchema.optional(),
  fixSource: FixSourceSchema.optional(),
  /** Both versions: the names of the failing checks the fix now running is for (at most five, one line each); present only with `fixSource`. */
  fixProblems: z.array(z.string().trim().min(1).max(200)).min(1).max(CI_FIX_PROBLEMS_MAX).optional(),
  /**
   * Both versions: a person told Rovara to go on with a CI fix it was waiting to be told about (Retry). It names the heads of the open pull requests that were failing when they said it, and only a
   * failure on one of those heads is covered. The next CI fix round starts whatever the autonomy and the rounds used (that one round is not counted), and clears it.
   */
  ciFixApproved: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(32).optional(),
  /**
   * Both versions (Plan 6 Task 17): Rovara is merging the base branch into one pull request's branch. WAIT_FOR_MERGE/READY while the merge is queued, WAIT_FOR_MERGE/RUNNING while the worker
   * runs it. It names the head the merge is for: a head that is no longer that one (a person pushed) stops it.
   */
  branchSync: WorkflowBranchSyncSchema.optional(),
  /** S2: a queued step is waiting for Slack to answer the access check (an outage). `revision` is the workflow revision it waits at, so a later step never inherits the note. Set and cleared by the dispatcher; the page says "Waiting for Slack". */
  accessCheckWaitSince: z.object({ revision: z.number().int().positive(), since: z.string().datetime() }).strict().optional(),
  /**
   * Both versions (Plan 6 Task 17): the commit of the base branch whose merge conflicted, while a conflict round resolves it. The round's fix is pushed as a merge commit with this commit as its second
   * parent. Present only with `fixSource: "conflict"`.
   */
  conflictBase: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  /** Both versions: a person told Rovara to go on with a conflict it asked about (Retry): the heads of the open pull requests then. The merge it starts uses it up. */
  conflictApproved: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(32).optional(),
  /** Both versions: how many times a merge of the base failed on this head (a head a person pushes starts the count again). Rovara stops at `SYNC_FAILURES_MAX`. */
  syncFailures: z.object({
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    /** Real failures of the merge (its checks failed, Git refused): at `SYNC_FAILURES_MAX` Rovara stops trying this head. */
    count: z.number().int().min(0).max(SYNC_FAILURES_MAX),
    /** Failures that were not the merge's (GitHub, a lost machine): never a stop, but each doubles the wait before the next try. */
    transient: z.number().int().min(1).max(1000).optional(),
    retryAfter: z.string().datetime().optional(),
  }).strict().optional(),
}).superRefine((workflow, context) => {
  if (workflow.definitionVersion === "1.0.0") {
    if (workflow.stage === "UNDERSTAND" || workflow.stage === "PLAN_CRITIQUE") {
      context.addIssue({ code: "custom", path: ["stage"], message: "this stage needs definition version 1.1.0" });
    }
    if (workflow.outcome === "ANSWERED") context.addIssue({ code: "custom", path: ["outcome"], message: "this outcome needs definition version 1.1.0" });
    if (workflow.artifacts.some((artifact) => artifact.type === "answer")) context.addIssue({ code: "custom", path: ["artifacts"], message: "an answer needs definition version 1.1.0" });
    for (const field of ["intent", "critique", "risk", "designReview"] as const) {
      if (workflow[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `${field} needs definition version 1.1.0` });
    }
    if (workflow.program?.steps.some((step) => step.kind === "plan_critic") === true) {
      context.addIssue({ code: "custom", path: ["program"], message: "a plan check step needs definition version 1.1.0" });
    }
    if (workflow.reviews?.some((review) => review.risk !== undefined) === true) context.addIssue({ code: "custom", path: ["reviews"], message: "a review's risk level needs definition version 1.1.0" });
  }
  if (workflow.designReview !== undefined) {
    if (workflow.path !== "FULL") context.addIssue({ code: "custom", path: ["designReview"], message: "design review runs on the Full path" });
    if (new TextEncoder().encode(JSON.stringify(workflow.designReview)).length > 150_000) context.addIssue({ code: "custom", path: ["designReview"], message: "the design review record is too large to keep" });
  }
  if (workflow.fixProblems !== undefined && workflow.fixSource === undefined) {
    context.addIssue({ code: "custom", path: ["fixProblems"], message: "the problems a fix is for need the fix's source" });
  }
  if (workflow.conflictBase !== undefined && workflow.fixSource !== "conflict") {
    context.addIssue({ code: "custom", path: ["conflictBase"], message: "the base commit of a conflict is kept only while a conflict round runs" });
  }
  if (workflow.branchSync !== undefined && !(workflow.stage === "WAIT_FOR_MERGE" && (workflow.state === "READY" || workflow.state === "RUNNING"))) {
    context.addIssue({ code: "custom", path: ["branchSync"], message: "a merge of the base branch is queued or running only while waiting for the merge" });
  }
  if (workflow.program === undefined) {
    if (workflow.programStepId !== undefined || workflow.programRounds !== undefined) {
      context.addIssue({ code: "custom", path: ["program"], message: "a program position needs its program" });
    }
  } else {
    if (workflow.programStepId !== undefined && !workflow.program.steps.some((step) => step.id === workflow.programStepId)) {
      context.addIssue({ code: "custom", path: ["programStepId"], message: "the program position must be a step of the program" });
    }
    if (Object.keys(workflow.programRounds ?? {}).some((id) => workflow.program?.steps.find((step) => step.id === id)?.kind !== "review")) {
      context.addIssue({ code: "custom", path: ["programRounds"], message: "review rounds are counted only for review steps of the program" });
    }
  }
  if (workflowMetadataBytes(workflow) > WORKFLOW_METADATA_BUDGET_BYTES) {
    context.addIssue({ code: "custom", message: "workflow metadata exceeds the task snapshot storage budget" });
  }
  const dependencyApproval = workflow.workflowDependenciesApproval;
  if (workflow.workflowDependenciesOperationId !== undefined && dependencyApproval === undefined) {
    context.addIssue({ code: "custom", path: ["workflowDependenciesOperationId"], message: "the current graph operation must reference a retained graph approval" });
  }
  if (dependencyApproval !== undefined) {
    if (!workflow.artifacts.some((artifact) => artifact.type === "plan" && artifact.sha256 === dependencyApproval.artifactDigest)
      || !workflow.decisions.some((decision) => decision.workflowRevision === dependencyApproval.workflowRevision
        && decision.actorId === dependencyApproval.actorId && decision.artifactDigest === dependencyApproval.artifactDigest
        && decision.workBreakdownDigest === dependencyApproval.graphDigest && decision.decision === "APPROVE")) {
      context.addIssue({ code: "custom", path: ["workflowDependenciesApproval"], message: "work breakdown approval must match a whole-plan decision and its artifact" });
    }
  }
  if (workflow.workflowDependenciesProgress !== undefined) {
    if (dependencyApproval === undefined || workflow.workflowDependenciesProgress.some((progress) => progress.graphDigest !== dependencyApproval.graphDigest
      || progress.runId !== dependencyApproval.runId)) {
      context.addIssue({ code: "custom", path: ["workflowDependenciesProgress"], message: "work item progress must match the current approved graph run" });
    }
    const sequences = workflow.workflowDependenciesProgress.map((progress) => progress.sequence);
    if (new Set(sequences).size !== sequences.length) context.addIssue({ code: "custom", path: ["workflowDependenciesProgress"], message: "work item progress sequence numbers must be unique" });
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
    if (openSecondReviewFindings(workflow).length > 0) context.addIssue({ code: "custom", path: ["secondReviewBlock"], message: "PR readiness requires every blocking finding of the second review to be resolved" });
  }
  // Ready, or blocked only because AgentX gave up opening the draft pull request on its own (the owner retries it), or
  // running only while a fix is pushed to the pull requests already open.
  if (workflow.stage === "PULL_REQUEST" && workflow.state !== "READY"
    && !(workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE || isStepNotRunReason(workflow.blockReason)))
    && !(workflow.state === "RUNNING" && (workflow.pullRequests ?? []).length > 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "pull request stage must be ready" });
  }
  if (workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED") {
    const pullRequests = workflow.pullRequests ?? [];
    const required = pullRequests.filter((pullRequest) => pullRequest.required);
    // A pull request holds earlier reviewed code only after pushing its fix failed (or was stopped because the autonomy was lowered), or when it merged before the fix was pushed.
    const earlierAllowed = workflow.stage === "MERGED" || (workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed || workflow.blockReason === FEEDBACK_STOPPED_REASON || isStepNotRunReason(workflow.blockReason)));
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

/**
 * A workflow as a client that sends `x-agentx-task-view: 2` reads it, tolerant of a newer server. A stage or outcome it does not know reads as
 * "unknown" (a missing one is still an error), `definitionVersion` is any string, and fields it does not know are kept. Derived from the strict
 * shape, so the two cannot drift apart. `WorkflowSnapshotReaderShape` is for a view that adds fields of its own.
 */
export const WorkflowSnapshotReaderShape = {
  ...Object.fromEntries(Object.entries(WorkflowSnapshotShapeSchema.shape).map(([key, field]) => [key, readerOf(field as z.ZodType)])),
  definitionVersion: z.string().min(1).max(32),
  // `readerOf` hands a field with a default, or a literal, back unchanged, so a value a newer server added would fail the whole read: these two read it as "unknown".
  definitionId: z.string().transform((value): "agentx-task-to-pr" | "unknown" => (value === "agentx-task-to-pr" ? value : "unknown")),
  path: z.string().optional().transform((value): z.infer<typeof WorkflowPathSchema> | "unknown" => (value === undefined ? "QUICK" : (WorkflowPathSchema.options as readonly string[]).includes(value) ? value as z.infer<typeof WorkflowPathSchema> : "unknown")),
};
export type WorkflowSnapshotReader = ForwardReader<Omit<z.output<typeof WorkflowSnapshotShapeSchema>, "definitionVersion"> & { definitionVersion: string }>;
export const WorkflowSnapshotReaderSchema = z.looseObject(WorkflowSnapshotReaderShape) as unknown as z.ZodType<WorkflowSnapshotReader>;
