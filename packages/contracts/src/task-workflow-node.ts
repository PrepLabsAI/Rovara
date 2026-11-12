import { SECOND_REVIEW_BLOCK_REASON } from "./second-review.js";
import { DigestSchema } from "./workflow-dependencies.js";
import {
  ANSWER_EVERY_QUESTION_MESSAGE, INTENT_ANSWER_MAX_CHARS, INTENT_ANSWER_SOURCES, INTENT_QUESTIONS_MAX, INTENT_RESTATEMENT_MAX, IntentAnswerSchema, IntentAssessmentSchema, UNDERSTAND_ROUNDS_MAX, UNDERSTAND_TIMED_OUT_MESSAGE, CI_FIX_PROBLEMS_MAX, CI_FIX_ROUNDS_MAX, CONFLICT_ROUNDS_MAX, FEEDBACK_AUTO_ROUNDS_MAX, ciFixUnrelatedMessage, isCiFixBlockReason, isBranchSyncBlockReason, isBranchConflictAskReason, CONFLICT_PATHS_MAX, SYNC_FAILURES_MAX, SYNC_BACKOFF_MINUTES, isBranchSyncGiveUpReason, type BranchSyncReason, type WorkflowBranchSync, intentAssessmentDuplicateIds, intentAssumptionLine, plainAnswerText, PLAN_CRITIC_REVISIONS_MAX, PlanCritiqueSchema, type PlanCritique, type WorkflowCritique, type IntentAnswer, type IntentAssessment, type NoChangeNeeded, type WorkflowIntent, type FixSource, type WorkflowFixRounds, FEEDBACK_AUTONOMY_ACTOR_ID, FEEDBACK_CI_CHECKS_MAX, WorkflowFeedbackAutonomySchema, type FeedbackCiFailures, type WorkflowFeedbackAutonomy,
} from "./rovara-code.js";
import { INTENT_NOT_WAITING_MESSAGE } from "./errors.js";
import { designReviewActive, designReviewAwaitsDesign, rearmedDesignReview, workflowIsDesignReviewing } from "./design-review-state.js";
import { redactText } from "./redaction.js";
import type { WorkflowFeedbackShownSchema, WorkflowAcceptedFindingSchema, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackReviewRefSchema, WorkflowFeedbackApprovalBindingSchema, WorkflowFeedbackThreadObservationSchema, WorkflowStageSchema, WorkflowStateSchema, WorkflowProgramSchema, WorkflowCheckPolicySchema, WorkflowPathSchema, WorkflowReviewPhaseSchema, WorkflowCanvasLineageSchema, WorkflowCanvasCloseoutSchema, WorkflowCanvasCloseoutAttemptSchema, WORKFLOW_PULL_REQUEST_UPDATE_CAUSES, WorkflowReviewBaseSchema} from "./task-workflow.js";
import { BASE_MERGED_RETRIES_PER_DAY, BASE_MERGED_RETRY_REASON, WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_AUTO_ACTION_LIMIT, WORKFLOW_AUTO_RETRY_LIMIT, WORKFLOW_AUTO_SEND_BACK_LIMIT, type WORKFLOW_AUTO_STAGES, WorkflowDecisionRecordSchema } from "./task-workflow.js";
import { FEEDBACK_SHOWN_MAX_ROUNDS, FEEDBACK_SHOWN_MAX_IDS, WORKFLOW_METADATA_BUDGET_BYTES, workflowMetadataBytes, openSecondReviewFindings, ActorIdSchema, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, isStepNotRunReason, CandidateRepositorySchema, CandidateManifestSchema, VerificationResultsSchema, WorkflowPullRequestSchema, FeedbackCommentRefSchema, WorkflowFeedbackBundleMetadataSchema, FeedbackIdSchema, WorkflowFeedbackFindingRefSchema, WorkflowFeedbackReviewMetadataSchema, WorkflowFeedbackNoteSchema, WorkflowFeedbackDecisionSchema, WorkflowArtifactSchema, WorkflowDecisionSchema, WorkflowCheckProposalSchema, WorkflowCheckSchema, WORKFLOW_PROPOSED_CHECKS_MAX, type WorkflowCheck, type WorkflowCheckPolicy, WorkflowSnapshotShapeSchema, WorkflowAnswerSchema, WORKFLOW_DECISION_ANSWERS_MAX, WORKFLOW_DECISION_COMMENTS_MAX, workflowIsReviewOnly, WORKFLOW_BLOCK_REASONS, WorkflowReviewReportSchema, reviewCleared, PROGRAM_ROUNDS_MAX, WorkflowPullRequestUpdateFailureSchema, WorkflowFeedbackReviewSchema, ReviewedWorkflowFeedbackSchema, findingBlocks, findingAccepted, blockingFindings, workflowFindingFingerprint, WORKFLOW_ACCEPTED_FINDINGS_MAX , type WorkflowDefinitionVersion } from "./task-workflow.js";
import { isRunLimitBlockReason } from "./run-estimate.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkflowProposedCheckInputSchema, feedbackReplacementCheckProblem, WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS } from "./workflow-check-input.js";
import { E2EQualifiedRoundSchema } from "./e2e.js";
import { isNoCodeChangedReason, type NoChangeFindings } from "./no-change-findings.js";

export interface WorkflowOwnerAuthority { actorId: string; ownerIds: readonly string[] }

export function workflowOwnerAuthorized(legacyOwnerId: string, actorId: string, authority?: WorkflowOwnerAuthority): boolean {
  if (!ActorIdSchema.safeParse(actorId).success) return false;
  if (authority === undefined) return actorId === legacyOwnerId;
  return authority.actorId === actorId
    && authority.ownerIds.length > 0
    && authority.ownerIds.every((ownerId) => ActorIdSchema.safeParse(ownerId).success)
    && new Set(authority.ownerIds).size === authority.ownerIds.length
    && authority.ownerIds.includes(actorId);
}

/** The worker's refusal when a coding run leaves every repository as it was when the task started: nothing to check or publish. */
export const WORKFLOW_NO_CODE_CHANGE_MESSAGE = "the coding run left the code as it was when the task started";

/** The worker's one fixed reason when a base commit was sent but its rule files could not be checked against the commit's own object ids. */
export const WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE = "couldn't verify the base rule files";

/**
 * The worker's one fixed reason when a step that only reads the workspace (the reviews, the plan check, Understand, the PR feedback review) could not first stop every program and container the
 * earlier work left running. The step reads nothing over live programs; the reason carries no detail from the failure.
 */
export const WORKFLOW_LEFTOVER_PROCESSES_MESSAGE = "couldn't stop the programs left running from earlier work";

/** The worker's one fixed reason when the checks' fresh dev container ran its setup and that changed the project's files: the checks are not run on code nobody wrote or reviewed. */
export const WORKFLOW_SETUP_CHANGED_FILES_MESSAGE = "the dev container's setup changed the project's files";

/** Shown to the owner when the code no longer descends from the commit the task started from. */
export const WORKFLOW_HISTORY_REWRITTEN_MESSAGE = "The change history was rewritten past where this task started, so AgentX can't compare it. Ask for the change again in a new task.";

/** Shown to the owner when AgentX gave up starting the reviews on its own; Retry reviews starts them. */
export const WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE = "AgentX couldn't start the reviews automatically. Use Retry reviews to try again.";

/** Shown to the owner when AgentX gave up starting a custom sequence's next coding step on its own; Retry coding starts it. */
export const WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE = "AgentX couldn't start the next coding step automatically. Use Retry coding to try again.";

/** Shown to the owner when a review run did not return exactly one code review and one security review. */
export const WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE = "The reviews didn't return one code review and one security review. Use Retry reviews to run them again.";

/**
 * Why the broker stopped a step, written for the task owner: Slack shows these word for word. Any other block reason
 * is internal and is replaced by a plain sentence before it reaches the owner.
 */
/**
 * How the block reason of a CHECKS dispatch that refused an application round begins, so the owner's actions can tell them apart. A refused round (the
 * candidate's build source, its manifest or its runtime inputs are not usable) is fixed by sending the task back to coding. A selection that is no longer
 * the approved one (a runtime row or the approved setup changed) is fixed by approving the plan again against what is ready now, which retrying the checks does.
 */
export const WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX = "The approved browser and API checks could not be started: ";

/**
 * A runtime-state refusal: the registered runtime cannot carry the round now (no READY row of the plan's kind, a row that expires before the round could end, no installed
 * host). Only an administrator qualifying the runtime again fixes it, and then one retry approves the plan again and dispatches. The remedy comes first (the block reason
 * keeps its first 500 characters); send-back to coding is never offered for it.
 */
export const WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX = "The approved browser and API checks cannot run on the runtime as it is now. An administrator must qualify the runtime again, then retry the checks to approve the plan again. Why: ";

/**
 * The code that opens the reason of a runtime refusal when the runtime's qualification has expired (or would before the round could end): it is `runtime-expired: ...` where the generic
 * reasons say only that no runtime is READY, so an owner and an operator can tell "qualify it again" from "never qualified" (evaluation fix RUN-3).
 */
export const E2E_RUNTIME_EXPIRED_CODE = "runtime-expired" as const;

/**
 * The code of a group that did not run (or could not be trusted) because the runner's environment (its kernel release or architecture) is no longer the one the runtime was qualified on
 * (HARDEN-C I-4). The worker ends the group with exactly this code before it builds a host; the broker opens the reason of a group an older worker ran anyway with it. Infrastructure
 * only: send-back to coding is never offered, and an administrator qualifies the runtime again.
 */
export const E2E_RUNTIME_ENVIRONMENT_DRIFTED_CODE = "runtime-environment-drifted" as const;

/**
 * How the block reason of a CHECKS round begins when the broker could not confirm every admitted group (`admitted E2E evidence is incomplete or unknown (<group>: <reason>; ...)`).
 * For a group the app host or the worker ended with one of its fixed codes, the reason after the group's id is exactly that code.
 */
export const WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX = "admitted E2E evidence is incomplete or unknown";

/**
 * The codes a group of a browser and API round can end with that the candidate itself causes (RUN-2): the app did not build, stopped right after it started, did not answer its health
 * check, or its seed failed. New code can fix these, so Send back to coding is offered for them. Every other code is Rovara's or the environment's (or says nothing about who is at fault).
 */
export const E2E_APPLICATION_SEND_BACK_CODES = ["build-failed", "app-exited", "app-unhealthy", "seed-failed"] as const;

/** One group's entry in the block reason: its id (plan-derived, never worker text) then the group's code, or the worker's one fixed phrase for evidence over the cap. */
const EVIDENCE_GROUP_CODE = /^[A-Za-z0-9._-]{1,80}: ([a-z][a-z0-9-]{0,62}|evidence too large)$/u;

/**
 * The group codes in the block reason of an incomplete round, in group order, or undefined when the reason is not that block or any group's entry is not exactly `group: code`. A group
 * whose reason is anything else (a sentence the collector wrote, text from the worker) makes the whole reason unreadable, so nothing is offered on a guess. A reason the broker cut on
 * whole entries (`cutEvidenceReason`) ends with the marker entry "…": the entries before it are read, the marker is not a code, and only a last entry may be one.
 */
export function workflowApplicationEvidenceCodes(blockReason: string | undefined): readonly string[] | undefined {
  const open = `${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (`;
  if (blockReason === undefined || !blockReason.startsWith(open) || !blockReason.endsWith(")")) return undefined;
  const codes: string[] = [];
  const entries = blockReason.slice(open.length, -1).split("; ");
  for (const [index, entry] of entries.entries()) {
    if (entry === "…" && index === entries.length - 1 && codes.length > 0) break;
    const code = EVIDENCE_GROUP_CODE.exec(entry)?.[1];
    if (code === undefined) return undefined;
    codes.push(code);
  }
  return codes;
}

/**
 * Cuts the reason a block keeps (the groups' `id: code` entries joined with "; ") to at most `max` characters on whole entries, ending with "; …", a marker that is not a code (the parser
 * reads the entries before it, and what Send back depends on is those parsed codes, never the text). A reason that fits is unchanged; one whose first entry alone is over the limit is cut as plain text, as it always was.
 */
export function cutEvidenceReason(reason: string, max: number): string {
  if (reason.length <= max) return reason;
  const marker = "; …";
  const kept: string[] = [];
  let length = 0;
  for (const entry of reason.split("; ")) {
    const next = length + (kept.length === 0 ? 0 : 2) + entry.length;
    if (next + marker.length > max) break;
    kept.push(entry);
    length = next;
  }
  return kept.length === 0 ? reason.slice(0, max) : `${kept.join("; ")}${marker}`;
}

/**
 * Whether a retry re-admits an approved browser and API round (a required round with an approved selection): it runs no project check of its own, so a task with none can retry it
 * with no check chosen. The retry route and the Slack form both read this.
 */
export function workflowReadmitsApplicationRound(workflow: { e2e?: { required?: boolean | undefined; applicationSelection?: unknown } | undefined }): boolean {
  return workflow.e2e?.required === true && workflow.e2e.applicationSelection !== undefined;
}

/**
 * The distinct codes among a round's groups that the candidate causes (see `E2E_APPLICATION_SEND_BACK_CODES`), in group order; empty when the reason is unreadable or holds none. A round
 * that also ended other groups with infrastructure codes still has these (the owner chose to offer Send back for them: the change needs new code either way, and the next round re-runs
 * every group).
 */
function evidenceCandidateCodes(blockReason: string | undefined): string[] {
  return [...new Set(workflowApplicationEvidenceCodes(blockReason) ?? [])].filter((code) => (E2E_APPLICATION_SEND_BACK_CODES as readonly string[]).includes(code));
}

/** The approved plan itself can no longer be approved (portable criteria, a target with no source-owned identity): the task goes back to plan review, where Request changes is the way on. */
export const WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX = "The approved browser and API plan can no longer run as written. Request changes and submit a corrected plan before coding resumes. Why: ";

/**
 * AUTOREQUALIFY (AR-3): the approved selection differs from the runtime rows READY now only because the test machine was renewed (the same profile, binding and capabilities at a newer
 * generation), with the plan, setup, targets and test accounts unchanged. Unlike the other selection changes, Rovara's own retry (AUTOFIX, once) approves the plan again against the renewed
 * rows; the owner's retry does the same. It is a block reason prefix so that the policy and the page can tell it apart from a change that needs a person.
 */
export const WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX = "The test machine was renewed, so the approved browser and API checks need approving again against it. Retry the checks to do that. What changed: ";
export const WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX = "The approved browser and API checks can no longer run as approved. Retry the checks to approve the plan again against what is ready now. What changed: ";

/**
 * A test account the plan was approved with has a newer registered definition (the setup was approved again, or the definition expired and was written again). The way on is
 * the same re-approval as for a requalified runtime: one retry approves the plan again against the accounts that are registered now.
 */
export const WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX = "The test accounts changed; approve the checks again. What changed: ";

/** What the coder is told about tests a review-only rerun found regressed (`regressedChecks`). */
export const WORKFLOW_REGRESSION_INSTRUCTION = "These tests passed before this change and fail now. If the task intentionally changes this behaviour, update the tests to match it; otherwise fix the code.";

/** The worker's refusal when the workspace no longer holds the tree its checks and reviews passed on. */
export const WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE = "the code changed after its checks and reviews; AgentX did not publish it";

/** Exact broker-owned reason for a required-E2E candidate blocked only because its source export is absent. */
export const WORKFLOW_MISSING_COMMITTED_SOURCE_EXPORT_REASON = "the final candidate has no first-party committed source export";

/** Why an AgentX worker refused, before running, to push a reviewed fix: it is too old to push exactly the reviewed tree. */
export const WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED = "pushing a reviewed fix needs a worker that pushes exactly the reviewed tree";

/**
 * Whether a blocked verification is the block of an approved browser and API round that a retry can fix: the approved selection changed, the runtime was unusable until
 * an administrator qualified it again, or the round was refused. One retry approves the plan again (Slack and the task page both offer it); a task whose block is
 * anything else is retried through its checks instead.
 */
export function workflowApplicationRetryOffered(workflow: { stage: string; state: string; blockReason?: string | undefined;
  e2e?: { required?: boolean | undefined; applicationSelection?: unknown } | undefined }): boolean {
  return workflow.stage === "VERIFY" && workflow.state === "BLOCKED" && workflow.e2e?.required === true && workflow.e2e.applicationSelection !== undefined
    && [WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX]
      .some((prefix) => workflow.blockReason?.startsWith(prefix) === true);
}

/** Whether the owner may ask AgentX to open the draft pull request again: it is ready, or AgentX gave up on its own. */
export function workflowPublicationRetryable(workflow: { stage: string; state: string; blockReason?: string | undefined }): boolean {
  return workflow.stage === "PULL_REQUEST"
    && (workflow.state === "READY" || (workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE || isStepNotRunReason(workflow.blockReason))));
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

export type CandidateRepository = z.infer<typeof CandidateRepositorySchema>;

export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;

/** Whether a check result is of a command that could not run. A not-installed program always is, also in results recorded before `broken` existed. */
export function workflowCheckResultBroken(result: { status: string; broken?: boolean | undefined; programNotFound?: boolean | undefined }): boolean {
  return result.status === "FAILED" && (result.broken === true || result.programNotFound === true);
}

export type WorkflowVerificationResults = z.infer<typeof VerificationResultsSchema>;

export type WorkflowAcceptedFinding = z.infer<typeof WorkflowAcceptedFindingSchema>;

/** How many findings one resolution may answer. */
export const WORKFLOW_RESOLVE_FINDINGS_MAX = 20;

export type WorkflowPullRequest = z.infer<typeof WorkflowPullRequestSchema>;

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

export type WorkflowFeedbackNote = z.infer<typeof WorkflowFeedbackNoteSchema>;

/** A reply longer than this is kept truncated, and marked so. */
export const WORKFLOW_THREAD_NOTE_MAX_CHARS = 2_000;

/** The most thread replies one task keeps; later ones are refused. */
export const WORKFLOW_THREAD_NOTES_MAX = 200;

/**
 * A reply anyone posted in a Slack-started task's thread: input for the task's next step, never a
 * decision. Stored beside the task (`NOTE#<messageTs>`); it never changes the task's workflow.
 */
export const SlackNoteSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("slack").optional(),
  taskId: z.string().uuid(), slackUserId: z.string().regex(/^[UW][A-Z0-9]{2,31}$/), isOwner: z.boolean(),
  teamId: z.string(), channelId: z.string(), threadTs: z.string().regex(/^\d{10}\.\d{6}$/), messageTs: z.string().regex(/^\d{10}\.\d{6}$/), eventId: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(WORKFLOW_THREAD_NOTE_MAX_CHARS), truncated: z.boolean(), receivedAt: z.string().datetime(), workflowRevision: z.number().int().positive(),
  /** Set when the chat agent answered this reply as a question: the next step then skips it (it still counts toward the cap). */
  answeredAt: z.string().datetime().optional(),
}).strict();

/**
 * A message a person sent to the agent from a session (Plan 5 Task 11a), stored beside the task at `NOTE#<messageId>` and read by the same steps as a Slack reply. It is
 * input for the next step, never a decision. `text` is already cleaned and redacted; `settledAt` is set once the session has been told that a step took it.
 */
export const AppNoteSchema = z.object({
  schemaVersion: z.literal(1), source: z.enum(["app", "linear"]),
  taskId: z.string().uuid(), developerId: ActorIdSchema, name: z.string().min(1).max(320), isOwner: z.boolean(),
  sessionId: z.string().min(1).max(64), messageId: z.string().regex(/^msg_[0-9a-z]{20}$/),
  text: z.string().trim().min(1).max(WORKFLOW_THREAD_NOTE_MAX_CHARS), truncated: z.boolean(), receivedAt: z.string().datetime(), workflowRevision: z.number().int().positive(),
  answeredAt: z.string().datetime().optional(),
  settledAt: z.string().datetime().optional(),
  /** Set when the message was also given live to a running step's session (live steer): the next step shows it as already given, not as a fresh message. */
  liveDeliveredAt: z.string().datetime().optional(),
}).strict();

export type SlackNote = z.infer<typeof SlackNoteSchema>;

export type AppNote = z.infer<typeof AppNoteSchema>;

/** What a task keeps as input for its next step: a Slack thread reply (`source` absent or `"slack"`) or a message from a session; both count toward `WORKFLOW_THREAD_NOTES_MAX`. */
export const WorkflowThreadNoteSchema = z.union([SlackNoteSchema, AppNoteSchema]);

export type WorkflowThreadNote = z.infer<typeof WorkflowThreadNoteSchema>;

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

export type WorkflowFeedbackThreadObservation = z.infer<typeof WorkflowFeedbackThreadObservationSchema>;
export type WorkflowFeedbackShown = z.infer<typeof WorkflowFeedbackShownSchema>;

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

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export type WorkflowProgram = z.infer<typeof WorkflowProgramSchema>;

export type WorkflowProgramStep = WorkflowProgram["steps"][number];

/** The reviews a workflow's current step asks for: the review step's reviewers, or both when there is no program. */
export function workflowReviewRoles(workflow: { program?: WorkflowProgram | undefined; programStepId?: string | undefined }): Array<"CRITIC" | "SECURITY"> {
  const step = workflow.program?.steps.find((candidate) => candidate.id === workflow.programStepId);
  if (step?.kind !== "review" || step.reviewers === undefined) return ["CRITIC", "SECURITY"];
  return (["CRITIC", "SECURITY"] as const).filter((role) => step.reviewers?.includes(role === "CRITIC" ? "code" : "security") === true);
}

/** Why a review step blocked, named as the owner knows the reviews: the one that did not pass, or both. */
function reviewNotPassedReason(roles: ReadonlyArray<"CRITIC" | "SECURITY">): string {
  return roles.length === 2 ? "the code and security reviews did not pass" : `the ${roles[0] === "CRITIC" ? "code" : "security"} review did not pass`;
}

const PROGRAM_STAGE_OF_STEP: Record<WorkflowProgramStep["kind"], WorkflowStage> = {
  plan: "PLAN", plan_critic: "PLAN_CRITIQUE", build: "IMPLEMENT", check: "VERIFY", review: "REVIEW", pull_request: "PULL_REQUEST",
};

function programIndex(program: WorkflowProgram, id: string | undefined): number {
  if (id === undefined) return -1;
  const index = program.steps.findIndex((step) => step.id === id);
  if (index < 0) throw new WorkflowTransitionError(`the workflow program has no step "${id}"`);
  return index;
}

/**
 * The step the engine runs after the one at `index`: a plan step never repeats, the plan check (Rovara Code version 2) is skipped because the engine runs it
 * between the plan and its approval and not as a step to move to afterwards, and a check not right after a build was recorded with its build.
 */
function programStepAfter(program: WorkflowProgram, index: number): WorkflowProgramStep | undefined {
  for (let next = index + 1; next < program.steps.length; next += 1) {
    const step = program.steps[next]!;
    if (step.kind === "plan" || step.kind === "plan_critic" || (step.kind === "check" && program.steps[next - 1]?.kind !== "build")) continue;
    return step;
  }
  return undefined;
}

export type ProgramMove = { kind: "step"; step: WorkflowProgramStep } | { kind: "end" } | { kind: "blocked"; reason: string };

/**
 * Where a program goes from step `currentId` (undefined: before its first step): the next step when it is `done`, or,
 * after a review that had `findings`, back to `onFindings.backTo` until `round` (the review rounds so far, this one
 * included) reaches `maxRounds`; then the step blocks with the review reason (for `failedRoles`, else the step's reviewers).
 */
export function nextProgramStep(
  program: WorkflowProgram, currentId: string | undefined, outcome: "done" | "findings", round = 0, failedRoles?: ReadonlyArray<"CRITIC" | "SECURITY">,
): ProgramMove {
  const index = programIndex(program, currentId);
  if (outcome === "done") {
    const next = programStepAfter(program, index);
    return next === undefined ? { kind: "end" } : { kind: "step", step: next };
  }
  const current = program.steps[index];
  if (current?.kind !== "review") throw new WorkflowTransitionError("only a review step has findings to send back");
  const onFindings = current.onFindings;
  const target = onFindings === undefined ? undefined : program.steps.find((step) => step.id === onFindings.backTo);
  if (onFindings === undefined || target === undefined || round >= onFindings.maxRounds) {
    return { kind: "blocked", reason: reviewNotPassedReason(failedRoles ?? workflowReviewRoles({ program, programStepId: current.id })) };
  }
  return { kind: "step", step: target };
}

/**
 * The stage after the current one: `defaultNext` (the engine's own next stage) without a program; with one, the next
 * program step's stage and id, or `complete` when the program has no step left.
 */
export function advanceStage(
  current: { program?: WorkflowProgram | undefined; programStepId?: string | undefined }, defaultNext: WorkflowStage,
): { stage: WorkflowStage; programStepId?: string; complete?: true } {
  if (current.program === undefined) return { stage: defaultNext };
  const move = nextProgramStep(current.program, current.programStepId, "done");
  return move.kind === "step" ? { stage: PROGRAM_STAGE_OF_STEP[move.step.kind], programStepId: move.step.id } : { stage: "CLOSED", complete: true };
}

/** The state a workflow takes on arriving at a program step by itself: coding and the pull request are ready, checks and reviews wait to be run. */
const PROGRAM_ARRIVAL_STATE: Partial<Record<WorkflowStage, WorkflowState>> = { IMPLEMENT: "READY", VERIFY: "WAITING", REVIEW: "WAITING", PULL_REQUEST: "READY", CLOSED: "COMPLETE" };

/**
 * The snapshot fields a program move sets: its stage, state and step, and (when the program ends) the passed outcome.
 * Arriving at a review step forgets the reviews that step runs again, so a stale report never stands in for a new one.
 */
function programArrival(current: WorkflowSnapshot, move: { stage: WorkflowStage; programStepId?: string; complete?: true }, candidateChanged = false): Record<string, unknown> {
  const program = current.program;
  const step = program?.steps.find((candidate) => candidate.id === move.programStepId);
  const arrivingRoles = step?.kind === "review" && program !== undefined ? workflowReviewRoles({ program, programStepId: step.id }) : [];
  return {
    stage: move.stage, state: PROGRAM_ARRIVAL_STATE[move.stage] ?? "READY",
    ...(move.programStepId === undefined ? {} : { programStepId: move.programStepId }),
    ...(move.complete === true ? { outcome: "PASSED" } : {}),
    ...(step?.kind === "review" ? { reviews: candidateChanged ? [] : (current.reviews ?? []).filter((review) => !arrivingRoles.includes(review.role)) } : {}),
  };
}

/** The last build step at or before `index` (the first build step when there is none): where coding picks up again. */
function programBuildAtOrBefore(program: WorkflowProgram, index: number): WorkflowProgramStep {
  for (let at = Math.min(index, program.steps.length - 1); at >= 0; at -= 1) if (program.steps[at]?.kind === "build") return program.steps[at]!;
  return program.steps.find((step) => step.kind === "build")!;
}

/** Where owner-sent work goes back to: a blocked review's `backTo`, else the last build at or before the step the workflow is at. */
function programSendBackStep(program: WorkflowProgram, currentId: string | undefined): WorkflowProgramStep {
  const index = programIndex(program, currentId);
  const current = program.steps[index];
  const backTo = current?.kind === "review" ? current.onFindings?.backTo : undefined;
  return (backTo === undefined ? undefined : program.steps.find((step) => step.id === backTo)) ?? programBuildAtOrBefore(program, index);
}

/** Where a workflow with a program stands while its checks are recorded: the check step after its build, else the build. Nothing without a program. */
export function workflowVerificationPosition(workflow: { program?: WorkflowProgram | undefined; programStepId?: string | undefined }): { programStepId?: string } {
  return workflow.program === undefined ? {} : { programStepId: programVerifyStepId(workflow.program, workflow.programStepId) };
}

/** The step a workflow is at while its checks are recorded: the check step right after the build it is at, else that build. */
function programVerifyStepId(program: WorkflowProgram, currentId: string | undefined): string {
  const index = programIndex(program, currentId);
  const step = program.steps[index];
  const origin = step?.kind === "check" ? step : step?.kind === "build" ? step : programBuildAtOrBefore(program, index);
  const originIndex = program.steps.indexOf(origin);
  const check = origin.kind === "build" && program.steps[originIndex + 1]?.kind === "check" ? program.steps[originIndex + 1] : undefined;
  return (check ?? origin).id;
}

export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;

export type WorkflowCheckProposal = z.infer<typeof WorkflowCheckProposalSchema>;

/** A check policy as it may be written or stored: `proposed` may be left out. */
export type WorkflowCheckPolicyInput = z.input<typeof WorkflowCheckPolicySchema>;

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

export type WorkflowPath = z.infer<typeof WorkflowPathSchema>;

export type WorkflowReviewPhase = z.infer<typeof WorkflowReviewPhaseSchema>;

export type WorkflowCanvasLineage = z.infer<typeof WorkflowCanvasLineageSchema>;

export type WorkflowCanvasCloseout = z.infer<typeof WorkflowCanvasCloseoutSchema>;

export type WorkflowCanvasCloseoutAttempt = z.infer<typeof WorkflowCanvasCloseoutAttemptSchema>;

export type WorkflowPullRequestUpdateCause = typeof WORKFLOW_PULL_REQUEST_UPDATE_CAUSES[number];

/** A workflow as it is stored and transitioned. */
export const WorkflowSnapshotSchema = WorkflowSnapshotShapeSchema.superRefine((workflow, context) => {
  // Nothing runs while a document waits for its owner, and a closed task is done: neither is ever stored blocked.
  if (workflow.state === "BLOCKED" && (workflow.stage === "PLAN_REVIEW" || workflow.stage === "CLOSED")) {
    context.addIssue({ code: "custom", path: ["state"], message: "an approval waiting for its owner or a closed task cannot be blocked" });
  }
  // Until the broker's trusted aggregate gate is wired, ordinary worker verification cannot
  // advance a required E2E task into review or publication.
  const qualifiedRound = workflow.e2e?.qualifiedRound;
  if (qualifiedRound !== undefined && (workflow.e2e?.required !== true || workflow.candidate?.digest !== qualifiedRound.candidateDigest
    || workflow.verification?.candidateDigest !== qualifiedRound.candidateDigest || workflow.e2e.currentRoundId !== qualifiedRound.roundId
    || workflow.e2e.currentGroupRunIds.length !== qualifiedRound.groupRunIds.length
    || workflow.e2e.currentGroupRunIds.some((runId, index) => runId !== qualifiedRound.groupRunIds[index])
    || workflow.e2e.contractDigest !== qualifiedRound.contractDigest || workflow.e2e.policyDigest !== qualifiedRound.policyDigest
    || workflow.e2e.bundleDigest !== qualifiedRound.bundleDigest || workflow.e2e.executionPlanDigest !== qualifiedRound.executionPlanDigest)) {
    context.addIssue({ code: "custom", path: ["e2e", "qualifiedRound"], message: "trusted E2E qualification must bind the current candidate, contract, plan, and round" });
  }
  if (workflow.e2e?.required === true && (workflow.stage === "REVIEW" || workflow.stage === "PULL_REQUEST" || workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED")
    && (qualifiedRound === undefined || workflow.candidate?.digest !== qualifiedRound.candidateDigest)) {
    context.addIssue({ code: "custom", path: ["stage"], message: "required E2E awaits trusted aggregate verification" });
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
  workBreakdownDigest: DigestSchema.optional(),
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
  /** The task page: the owner's answer to every decision of the plan, and whether they opened it. */
  answers: z.array(WorkflowAnswerSchema.extend({ opened: z.boolean() }).strict()).max(WORKFLOW_DECISION_ANSWERS_MAX).optional(),
  /** The task page: the open comments the owner chose to send, in the order the next step sees them. */
  includedCommentIds: z.array(z.string().uuid()).max(WORKFLOW_DECISION_COMMENTS_MAX).optional(),
  /** Rovara Code v2: with REJECT, on a plan that says no change is needed: end the task Answered ("Close as answered"). */
  closeAsAnswered: z.literal(true).optional(),
  /**
   * QA6-12: approving a coding plan sets the task's run limit to the plan's proposed limit. The task page shows "current limit, proposed limit" and sends the proposed one here, as the
   * amount the person agreed to spend up to; the broker refuses the approval if it would set another one. Absent (Slack, tools): the approval is as it was.
   */
  acknowledgedRunLimitUsd: z.number().nonnegative().max(100_000).optional(),
}).strict().refine((request) => request.artifactDigest !== undefined, { message: "a workflow decision must name the current artifact digest", path: ["artifactDigest"] })
  .superRefine((request, context) => {
    if (request.selectedOptionalCheckIds !== undefined && new Set(request.selectedOptionalCheckIds).size !== request.selectedOptionalCheckIds.length) {
      context.addIssue({ code: "custom", path: ["selectedOptionalCheckIds"], message: "selected optional checks must be unique" });
    }
    if (request.answers !== undefined && new Set(request.answers.map((answer) => answer.decisionId)).size !== request.answers.length) {
      context.addIssue({ code: "custom", path: ["answers"], message: "each decision can be answered only once" });
    }
    if (request.includedCommentIds !== undefined && new Set(request.includedCommentIds).size !== request.includedCommentIds.length) {
      context.addIssue({ code: "custom", path: ["includedCommentIds"], message: "each comment can be included only once" });
    }
    if (request.closeAsAnswered === true && request.decision !== "REJECT") {
      context.addIssue({ code: "custom", path: ["closeAsAnswered"], message: "only closing a plan can close it as answered" });
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
  input: { candidate: CandidateManifest; checks: WorkflowVerificationResults; now: string; e2eQualification?: unknown },
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
  const e2eRequired = current.e2e?.required === true;
  const e2eQualification = input.e2eQualification === undefined ? undefined : E2EQualifiedRoundSchema.parse(input.e2eQualification);
  const e2eQualified = !e2eRequired || e2eQualification !== undefined && e2eQualification.candidateDigest === candidate.digest
    && current.e2e?.currentRoundId === e2eQualification.roundId
    && current.e2e.contractDigest === e2eQualification.contractDigest && current.e2e.policyDigest === e2eQualification.policyDigest
    && current.e2e.bundleDigest === e2eQualification.bundleDigest && current.e2e.executionPlanDigest === e2eQualification.executionPlanDigest
    && current.e2e.currentGroupRunIds.length === e2eQualification.groupRunIds.length
    && current.e2e.currentGroupRunIds.every((runId, index) => runId === e2eQualification.groupRunIds[index]);
  const failedResults = checks.data.results.filter((result) => result.status === "FAILED");
  // Every failed check could not run: coding again would not help, so the owner is told that, not "checks failed".
  const allBroken = failedResults.length > 0 && failedResults.every(workflowCheckResultBroken);
  const candidateChanged = current.candidate?.digest !== candidate.digest;
  const { blockReason: _priorBlockReason, regressedChecks: _priorRegressions, ...withoutBlockReason } = current;
  void _priorBlockReason;
  void _priorRegressions;
  const { qualifiedRound: _priorQualifiedRound, ...unqualifiedE2E } = current.e2e ?? {};
  void _priorQualifiedRound;
  // A program places the workflow: on its check step (or the build's own step) while the checks stand, and past that
  // step once they pass, on to the program's next step (which may be another build, a review, the pull request or its end).
  const program = current.program;
  const verifyStepId = program === undefined ? undefined : programVerifyStepId(program, current.programStepId);
  const move = program === undefined || verifyStepId === undefined || !(passed && e2eQualified) ? undefined : nextProgramStep(program, verifyStepId, "done");
  const placed = program === undefined ? undefined
    : move === undefined ? { programStepId: verifyStepId }
      : move.kind === "step" ? programArrival({ ...current, candidate, reviews: candidateChanged ? [] : current.reviews ?? [] }, { stage: PROGRAM_STAGE_OF_STEP[move.step.kind], programStepId: move.step.id }, candidateChanged)
        : programArrival(current, { stage: "CLOSED", complete: true });
  return WorkflowSnapshotSchema.parse({
    ...withoutBlockReason,
    revision: current.revision + 1,
    state: passed && e2eQualified ? "WAITING" : passed ? "WAITING" : "BLOCKED",
    stage: passed && e2eQualified ? "REVIEW" : "VERIFY",
    ...(passed ? {} : { blockReason: allBroken ? WORKFLOW_BLOCK_REASONS.checksBroken : "candidate checks failed or have unknown results" }),
    candidate,
    ...(reviewBase === undefined ? {} : { reviewBase }),
    verification: checks.data,
    ...(current.e2e === undefined ? {} : { e2e: { ...unqualifiedE2E, ...(e2eRequired && passed && e2eQualified && e2eQualification !== undefined ? { qualifiedRound: e2eQualification } : {}) } }),
    // A new candidate invalidates every prior review report.
    reviews: candidateChanged ? [] : current.reviews ?? [],
    updatedAt: input.now,
    ...placed,
  });
}

/**
 * A coding step of a program ends and another coding step follows it, so the code is not checked yet (a first build
 * may leave tests that fail on purpose): the workflow is ready for the next build, with no candidate recorded. A build
 * followed by checks, a review, the pull request or the program's end records its candidate and checks instead
 * (`recordWorkflowVerification`).
 */
export function completeWorkflowBuild(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const program = current.program;
  if (program === undefined) throw new WorkflowTransitionError("this workflow has no program to follow");
  if (current.stage !== "IMPLEMENT" || (current.state !== "READY" && current.state !== "RUNNING")) throw new WorkflowTransitionError("workflow is not at a coding step");
  if (program.steps[programIndex(program, current.programStepId)]?.kind !== "build") throw new WorkflowTransitionError("the program is not at a build step");
  const move = nextProgramStep(program, current.programStepId, "done");
  if (move.kind !== "step" || move.step.kind !== "build") throw new WorkflowTransitionError("this build step is followed by checks; its candidate is recorded with them");
  // The reviews belong to the code the next build is about to change: its prompt must not carry their findings as problems.
  const { blockReason: _blockReason, reviews: _reviews, ...withoutBlockReason } = current;
  void _blockReason; void _reviews;
  return WorkflowSnapshotSchema.parse({ ...withoutBlockReason, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY", programStepId: move.step.id, updatedAt: now });
}

/**
 * Records one review of the current code. `options.secondReviewBlocks` (SR-1, switch `cr`, `on`): a second review by another AI company blocked this code. When every review this step asked for has cleared, that
 * block decides the move instead: without a program the step stays blocked with the second review's reason, and in a program the move is "findings" (back to the step the review sends findings to, the round counted,
 * or blocked when the rounds are spent), exactly as a first review's findings would move it.
 */
export function submitWorkflowReview(currentInput: unknown, reportInput: unknown, now: string, options: { secondReviewBlocks?: boolean } = {}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const report = WorkflowReviewReportSchema.safeParse(reportInput);
  if (!report.success || current.stage !== "REVIEW" || current.candidate === undefined || current.verification === undefined) {
    throw new WorkflowTransitionError("workflow is not ready to record candidate reviews");
  }
  if (report.data.candidateDigest !== current.candidate.digest || current.verification.candidateDigest !== current.candidate.digest) {
    throw new WorkflowTransitionError("review report does not match the current verified candidate");
  }
  // The reviews this step asks for: both without a program, the review step's own reviewers with one.
  const roles = workflowReviewRoles(current);
  if (current.program !== undefined && !roles.includes(report.data.role)) throw new WorkflowTransitionError("review report is not one this step asked for");
  // A risk level is a version 2 thing: a version 1 task keeps the review as it was, without one.
  const { risk: _risk, ...withoutRisk } = report.data;
  void _risk;
  const stored = current.definitionVersion === "1.1.0" ? report.data : withoutRisk;
  const reviews = [...(current.reviews ?? []).filter((entry) => entry.role !== report.data.role), stored];
  // A review also stands when the owner accepted every finding that blocked it, for this candidate.
  const firstClear = roles.every((role) => reviews.some((entry) => entry.role === role && reviewCleared(entry, current.acceptedFindings)));
  const heldBySecond = options.secondReviewBlocks === true && firstClear;
  const complete = firstClear && !heldBySecond;
  // The reviews that hold the change back, named as the owner knows them, whichever review was recorded last.
  const notCleared = roles.filter((role) => reviews.some((entry) => entry.role === role && !reviewCleared(entry, current.acceptedFindings)));
  const failed = notCleared.length > 0 || heldBySecond;
  const blockReason = heldBySecond ? SECOND_REVIEW_BLOCK_REASON : reviewNotPassedReason(notCleared);
  const { blockReason: _priorBlockReason, ...withoutBlockReason } = current;
  void _priorBlockReason;
  const program = current.program;
  // With a program, once every review the step asked for is in, the outcome picks the next step: findings go back to
  // coding (until the step's rounds are spent), a pass goes on to the step after it. An unfinished review (a timeout, an
  // unreadable answer) is no round at all: the step stays blocked for the owner to retry, as it does without a program.
  const allIn = program !== undefined && roles.every((role) => reviews.some((entry) => entry.role === role));
  const findingsOnly = failed && notCleared.every((role) => reviews.some((entry) => entry.role === role && entry.status === "FINDINGS"));
  if (program !== undefined && allIn && current.programStepId !== undefined && (complete || findingsOnly)) {
    const rounds = { ...(current.programRounds ?? {}), [current.programStepId]: Math.min((current.programRounds?.[current.programStepId] ?? 0) + 1, PROGRAM_ROUNDS_MAX) };
    const move = complete ? nextProgramStep(program, current.programStepId, "done") : nextProgramStep(program, current.programStepId, "findings", rounds[current.programStepId], heldBySecond ? ["CRITIC"] : notCleared);
    const base = { ...withoutBlockReason, revision: current.revision + 1, reviews, programRounds: rounds, updatedAt: now };
    if (move.kind === "blocked") return WorkflowSnapshotSchema.parse({ ...base, stage: "REVIEW", state: "BLOCKED", blockReason: heldBySecond ? SECOND_REVIEW_BLOCK_REASON : move.reason });
    const placed = move.kind === "end" ? programArrival({ ...current, reviews }, { stage: "CLOSED", complete: true })
      : programArrival({ ...current, reviews }, { stage: PROGRAM_STAGE_OF_STEP[move.step.kind], programStepId: move.step.id });
    return WorkflowSnapshotSchema.parse({ ...base, ...placed });
  }
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
    /** Where the observation came from: `GITHUB_API` (Cloud's webhook path) or `CODE_HOST` (any code host's adapter, polled). */
    source: z.enum(["GITHUB_API", "CODE_HOST"]),
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

/** Whether the task follows its pull requests only for their merge: an approved fix is being made or pushed, its push failed, or a person is to retry its CI fix. */
export function workflowFollowsOnlyMerge(workflow: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason"> & { branchSync?: WorkflowBranchSync | undefined }): boolean {
  return (workflow.stage !== "WAIT_FOR_MERGE" && workflow.stage !== "MERGED")
    // Plan 6 Task 17: while the base branch is merged into the branch, its push moves the head: only a merge is followed until the result is recorded.
    || (workflow.stage === "WAIT_FOR_MERGE" && workflow.branchSync !== undefined)
    || (workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed
      // Plan 6 Task 15: a task waiting for a person to retry its CI fix keeps waiting: an observation of the pull request must not read the block away, and comments wait for the Retry.
      // Plan 6 Task 17: so does one waiting for a person to update the branch on GitHub.
      || isCiFixBlockReason(workflow.blockReason) || isBranchSyncBlockReason(workflow.blockReason)));
}

/**
 * The task once its pull requests are as observed: complete when every required one merged; otherwise a task that follows
 * them only for their merge stays where it is, one whose required pull request was closed without merging stops (until it
 * is reopened), and one waiting for the merge waits on.
 */
function withPullRequestsObserved(current: WorkflowSnapshot, pullRequests: WorkflowPullRequest[], now: string): WorkflowSnapshot {
  const complete = pullRequests.filter((pullRequest) => pullRequest.required).every((pullRequest) => pullRequest.state === "MERGED");
  const keep = !complete && workflowFollowsOnlyMerge(current);
  const closed = !complete && !keep && pullRequests.some((pullRequest) => pullRequest.required && pullRequest.state === "CLOSED");
  const { outcome: _priorOutcome, ...withoutPriorOutcome } = current;
  void _priorOutcome;
  // Waiting again (a closed pull request reopened) carries no reason to stop.
  const { blockReason: _priorReason, ...unblocked } = withoutPriorOutcome;
  void _priorReason;
  const reopened = !keep && !closed && current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestClosed;
  return WorkflowSnapshotSchema.parse({
    ...(complete ? withoutFix(keep ? current : reopened ? unblocked : withoutPriorOutcome) : keep ? current : reopened ? unblocked : withoutPriorOutcome),
    revision: current.revision + 1,
    stage: complete ? "MERGED" : keep ? current.stage : "WAIT_FOR_MERGE",
    state: complete ? "COMPLETE" : keep ? current.state : closed ? "BLOCKED" : "WAITING",
    ...(closed ? { blockReason: WORKFLOW_BLOCK_REASONS.pullRequestClosed } : {}),
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
 * Every open pull request already holds the current candidate (its digest and, per repository, its tree): a merge of the base that was checked and reviewed again (decision 67b), or a fix whose push
 * landed before its result. There is nothing to push, so the task waits for the merge, its fix round finished and any publication block lifted. Allowed where a publication step stands: PULL_REQUEST/READY,
 * or the owner's Retry at a publication block. Refused when a merge of the base is marked, when no pull request is open, or when any open one holds other code.
 */
export function holdWorkflowCandidateOnPullRequests(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const candidate = current.candidate;
  const open = (current.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN");
  if (candidate === undefined || !workflowPublicationRetryable(current) || current.branchSync !== undefined || open.length === 0
    || !open.every((pullRequest) => pullRequest.candidateDigest === candidate.digest
      && pullRequest.headTreeSha !== undefined && pullRequest.headTreeSha === candidate.repositories.find((repository) => repository.repositoryId === pullRequest.repositoryId)?.treeSha)) {
    throw new WorkflowTransitionError("the pull requests do not all hold the workflow's candidate");
  }
  const { blockReason: _blockReason, pullRequestUpdateFailure: _failure, ...unblocked } = current;
  void _blockReason;
  void _failure;
  return WorkflowSnapshotSchema.parse({ ...withoutFix(unblocked), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING", updatedAt: now });
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
    // A fix changes the code: what a person approved before a clean merge of the base is no longer what the pull request holds, so the record of that merge goes (Plan 6 Task 17).
    if (update === undefined) return pullRequest;
    const { syncedFrom: _syncedFrom, ...rest } = pullRequest;
    void _syncedFrom;
    return { ...rest, headSha: update.headSha, headTreeSha: update.headTreeSha, candidateDigest: candidate.digest, state: "OPEN" as const };
  });
  if (stalePullRequests({ ...current, pullRequests }).length > 0) {
    // A blocked task stays blocked for the pull requests its fix has not reached.
    return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, ...(pushFailed ? {} : { state: "READY" }), pullRequests, updatedAt: input.now });
  }
  const { blockReason: _blockReason, pullRequestUpdateFailure: _failure, feedbackReview, feedbackDispatchApproval: _approval, ...restWithFix } = current;
  void _blockReason;
  void _failure;
  void _approval;
  const rest = withoutFix(restWithFix);
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
    ...withoutFix(current), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "BLOCKED",
    blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed, pullRequestUpdateFailure: failure.data, updatedAt: input.now,
  });
}

/** A snapshot without the marks of a fix in flight (the fix is over: pushed, given up or merged past). */
function withoutFix(workflow: WorkflowSnapshot): WorkflowSnapshot {
  const { fixSource: _source, fixProblems: _problems, conflictBase: _conflictBase, ...rest } = workflow;
  void _source;
  void _problems;
  void _conflictBase;
  return rest;
}

const FIX_ROUND_KEYS = { ci: "ci", conflict: "conflict", feedback: "feedbackAuto" } as const satisfies Record<FixSource, keyof WorkflowFixRounds>;
const FIX_ROUNDS_MAX = { ci: CI_FIX_ROUNDS_MAX, conflict: CONFLICT_ROUNDS_MAX, feedbackAuto: FEEDBACK_AUTO_ROUNDS_MAX } as const satisfies Record<keyof WorkflowFixRounds, number>;

/** How many fix rounds of each kind have run (none when the workflow has never fixed anything). */
export function workflowFixRounds(workflow: Pick<WorkflowSnapshot, "fixRounds">): WorkflowFixRounds {
  return workflow.fixRounds ?? { ci: 0, conflict: 0, feedbackAuto: 0 };
}

/** How many rounds of this kind are left before the cap. */
export function workflowFixRoundsLeft(workflow: Pick<WorkflowSnapshot, "fixRounds">, source: FixSource): number {
  const key = FIX_ROUND_KEYS[source];
  return Math.max(0, FIX_ROUNDS_MAX[key] - workflowFixRounds(workflow)[key]);
}

/** Whether the owner's feedback card is being prepared or waits for them (it blocks every automatic action). */
function ownerCardOpen(workflow: WorkflowSnapshot): boolean {
  return workflow.feedbackReview?.status === "PENDING" || workflow.feedbackReview?.status === "COLLECTING";
}

/**
 * Rovara Code (Plan 6 Task 15): a fix to the open pull requests starts, with no one deciding it: WAIT_FOR_MERGE/WAITING becomes IMPLEMENT/READY, marked with its source (`ci`, `conflict` or
 * `feedback`) and the names of what is being fixed, and counted in `fixRounds`. The build it goes back to is the program's last build, as for an approved feedback fix, and the review rounds
 * of the earlier code are not counted against this one. A round counts unless `count` is false (a person told Rovara to go on after its rounds ran out). Refused while the owner's card waits,
 * while a fix is already under way, and when the source's rounds are used up. Both definition versions may be fixed.
 */
export function startWorkflowFix(currentInput: unknown, input: { source: FixSource; problems: readonly string[]; now: string; count?: boolean }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.candidate === undefined || current.fixSource !== undefined) {
    throw new WorkflowTransitionError("the workflow is not waiting for the merge with nothing being fixed");
  }
  if (ownerCardOpen(current)) throw new WorkflowTransitionError("the owner's feedback card is waiting, so nothing is fixed on its own");
  if (!(current.pullRequests ?? []).some((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN")) {
    throw new WorkflowTransitionError("the workflow has no open pull request to fix");
  }
  const key = FIX_ROUND_KEYS[input.source];
  const rounds = workflowFixRounds(current);
  const counted = input.count !== false;
  if (counted && rounds[key] >= FIX_ROUNDS_MAX[key]) throw new WorkflowTransitionError("the rounds of this kind of fix are used up");
  const problems = z.array(z.string().trim().min(1).max(200)).max(CI_FIX_PROBLEMS_MAX).safeParse(input.problems);
  if (!problems.success) throw new WorkflowTransitionError("the problems a fix is for are invalid");
  const candidate = current.candidate;
  // A pull request recorded without its head's tree keeps the reviewed tree it was opened with: once the fix is coded the candidate is the fix.
  const pullRequests = current.pullRequests?.map((pullRequest) => pullRequest.headTreeSha !== undefined || pullRequest.candidateDigest !== candidate.digest ? pullRequest
    : { ...pullRequest, headTreeSha: candidate.repositories.find((repository) => repository.repositoryId === pullRequest.repositoryId)?.treeSha });
  const { blockReason: _blockReason, ciFixApproved: _approved, programRounds: _rounds, ...rest } = current;
  void _blockReason;
  void _approved;
  void _rounds;
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY",
    ...(pullRequests === undefined ? {} : { pullRequests }),
    ...(current.program === undefined ? {} : { programStepId: programBuildAtOrBefore(current.program, current.program.steps.length - 1).id }),
    fixSource: input.source, ...(problems.data.length === 0 ? {} : { fixProblems: problems.data }),
    fixRounds: counted ? { ...rounds, [key]: rounds[key] + 1 } : rounds, updatedAt: input.now,
  });
}

/** How many fix rounds of every kind have begun: the number a milestone about a round is filed under. */
export function workflowFixRoundsBegun(workflow: Pick<WorkflowSnapshot, "fixRounds">): number {
  const rounds = workflowFixRounds(workflow);
  return rounds.ci + rounds.conflict + rounds.feedbackAuto;
}

/**
 * A fix that has not started its coding run stops because the pull request is no longer as Rovara left it (a person pushed to it): IMPLEMENT/READY becomes WAIT_FOR_MERGE/WAITING again, the marks
 * of the fix dropped. The round stays counted: it was begun. The code, checks and reviews are those the pull request was opened with, so the task is as it was.
 */
export function abandonWorkflowFix(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "IMPLEMENT" || current.state !== "READY" || current.fixSource === undefined) throw new WorkflowTransitionError("no fix is waiting to start");
  return WorkflowSnapshotSchema.parse({ ...withoutFix(current), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING", updatedAt: now });
}

/**
 * A round Rovara decided itself (Plan 6 Task 16) stops where it is, with `reason`, because the autonomy it ran under was lowered: the workflow is blocked at the step it was at, so nothing more is run,
 * paid for or pushed. Before the push (PULL_REQUEST, which only a ready fix may be at) it waits for the merge, blocked, with the pull requests as they were, the fix's marks gone. The rounds stay counted.
 */
export function stopWorkflowFeedbackRound(currentInput: unknown, reason: string, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.fixSource !== "feedback" || current.feedbackDecisions?.at(-1)?.actorRole !== "ROVARA_AUTONOMY") throw new WorkflowTransitionError("no round Rovara decided itself is running");
  if (current.stage !== "PULL_REQUEST") return blockWorkflow(current, reason, now);
  return WorkflowSnapshotSchema.parse({ ...withoutFix(current), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: reason.slice(0, 500), updatedAt: now });
}

/**
 * S2: a step Rovara was about to start for the task's owner is refused because that person lost their place in the project (or the project was archived). Nothing is run or paid for, and the
 * task says why. IMPLEMENT/READY of a fix round (CI, conflict or review comments) becomes WAIT_FOR_MERGE/BLOCKED with the fix's marks gone (the round stays counted); IMPLEMENT/READY of a
 * custom sequence's next coding step becomes IMPLEMENT/BLOCKED; any other step that was about to start (a PR-feedback critic, planning, checks, reviews, the pull request) becomes BLOCKED at its own stage. A person takes over.
 */
export function stopWorkflowStepNotRun(currentInput: unknown, reason: string, now: string): WorkflowSnapshot {
  // The "waiting for Slack" note ends with the wait, whichever way the step stops.
  const { accessCheckWaitSince: _wait, ...current } = validSnapshot(currentInput);
  void _wait;
  const text = reason.slice(0, 500);
  if (current.stage === "IMPLEMENT" && current.state === "READY") {
    if (current.fixSource !== undefined) return WorkflowSnapshotSchema.parse({ ...withoutFix(current), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: text, updatedAt: now });
    return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "BLOCKED", blockReason: text, updatedAt: now });
  }
  // A task paused for budget or a run limit stays blocked where it is, with the plain reason in place of the pause's text (the spend approval stays recorded; Retry or a take-over goes on from here).
  if (current.state === "BLOCKED" && (current.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused || isRunLimitBlockReason(current.blockReason))) {
    return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, blockReason: text, updatedAt: now });
  }
  // Any other step waiting to start (planning, checks, reviews, the pull request, a branch merge, a plan check): blocked where it stands.
  if (current.state === "READY" || current.state === "WAITING" || current.state === "RUNNING") {
    if (current.stage === "CLOSED" || current.stage === "MERGED") throw new WorkflowTransitionError("no step is waiting to start");
    const { branchSync: _branchSync, ...rest } = current;
    void _branchSync;
    // A push of a fix to pull requests already open is blocked where tracking keeps them: waiting for the merge.
    const pushing = current.stage === "PULL_REQUEST" && (current.pullRequests ?? []).length > 0;
    return WorkflowSnapshotSchema.parse({ ...(pushing ? withoutFix(rest) : rest), revision: current.revision + 1, ...(pushing ? { stage: "WAIT_FOR_MERGE" } : {}), state: "BLOCKED", blockReason: text, updatedAt: now });
  }
  throw new WorkflowTransitionError("no step is waiting to start");
}

/**
 * S2 (review H4): the way back from `stopWorkflowStepNotRun` at the merge wait. A person with access presses Retry: WAIT_FOR_MERGE/BLOCKED with a "Rovara didn't start" reason becomes WAITING again, so the next CI,
 * conflict or review-comment event drives Rovara as before (the rounds already used stay counted). Refused for any other block.
 */
export function resumeWorkflowAfterNotRun(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "BLOCKED" || !isStepNotRunReason(current.blockReason)) {
    throw new WorkflowTransitionError("the workflow is not waiting for a step that was not started to be retried");
  }
  const { blockReason: _blockReason, ...rest } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, state: "WAITING", updatedAt: now });
}

/**
 * A CI fix round stops with a plain reason a person has to act on: Rovara was told to wait (suggest), the rounds are used up, or the round changed nothing. WAIT_FOR_MERGE/WAITING (or the fix
 * itself, IMPLEMENT/RUNNING) becomes WAIT_FOR_MERGE/BLOCKED with `reason`, which must be one of the CI fix texts; the fix's marks are dropped. The pull requests stay followed.
 */
export function blockWorkflowCiFix(currentInput: unknown, input: { reason: string; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const waiting = current.stage === "WAIT_FOR_MERGE" && current.state === "WAITING";
  const fixing = current.stage === "IMPLEMENT" && current.fixSource === "ci" && (current.state === "RUNNING" || current.state === "READY");
  if (!isCiFixBlockReason(input.reason) || (!waiting && !fixing)) throw new WorkflowTransitionError("the workflow is not at a place a CI fix can stop");
  return WorkflowSnapshotSchema.parse({ ...withoutFix(current), revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: input.reason.slice(0, 500), updatedAt: input.now });
}

/** A CI fix round that changed nothing: the failure is not this change's, so a person is asked to look (and the round stays counted). */
export function endWorkflowCiFixUnrelated(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "IMPLEMENT" || current.fixSource !== "ci") throw new WorkflowTransitionError("the workflow is not fixing CI");
  return blockWorkflowCiFix(current, { reason: ciFixUnrelatedMessage(current.fixProblems?.[0] ?? "a check"), now });
}

/**
 * The owner's Retry of a CI fix that waited for a person (Rovara was told to suggest, the three rounds are used up, or a round changed nothing): WAIT_FOR_MERGE/BLOCKED becomes WAITING with
 * the go-ahead recorded for the heads the open pull requests hold now, so the next CI fix round, for a failure on one of them, starts whatever the autonomy. The rounds already used stay counted:
 * one Retry is one round more (see `startWorkflowFix`'s `count`), never three.
 */
export function retryWorkflowCiFix(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "BLOCKED" || !isCiFixBlockReason(current.blockReason)) {
    throw new WorkflowTransitionError("the workflow is not waiting for a CI fix to be retried");
  }
  const { blockReason: _blockReason, ...rest } = current;
  void _blockReason;
  const heads = [...new Set((current.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN").flatMap((pullRequest) => pullRequest.headSha === undefined ? [] : [pullRequest.headSha]))];
  if (heads.length === 0) throw new WorkflowTransitionError("no open pull request has a recorded head to give a go-ahead for");
  return WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, state: "WAITING", ciFixApproved: heads, updatedAt: now });
}

// ---- keeping the branch up to date (Plan 6 Task 17)

const openPullRequestOf = (workflow: WorkflowSnapshot, repositoryId: string, number: number): WorkflowPullRequest | undefined =>
  (workflow.pullRequests ?? []).find((pullRequest) => pullRequest.repositoryId === repositoryId && pullRequest.number === number && (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN"));

/**
 * Rovara decides to merge the base branch into one pull request's branch: WAIT_FOR_MERGE/WAITING becomes WAIT_FOR_MERGE/READY, marked with the pull request, the head the merge is for (the head
 * the workflow recorded) and why. Refused while the owner's card waits, while a fix or another merge is under way, and for a pull request that is not open or has no recorded head.
 */
export function startWorkflowBranchSync(currentInput: unknown, input: { repositoryId: string; number: number; reason: BranchSyncReason; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || current.fixSource !== undefined || current.branchSync !== undefined) {
    throw new WorkflowTransitionError("the workflow is not waiting for the merge with nothing being changed");
  }
  if (ownerCardOpen(current)) throw new WorkflowTransitionError("the owner's feedback card is waiting, so nothing is merged on its own");
  const pullRequest = openPullRequestOf(current, input.repositoryId, input.number);
  if (pullRequest?.headSha === undefined) throw new WorkflowTransitionError("the pull request is not open, or has no recorded head");
  // A person's go-ahead for this head (Retry after the ask) is used by the merge it starts.
  const approved = current.conflictApproved?.includes(pullRequest.headSha) === true;
  const { conflictApproved: _approved, ...rest } = current;
  void _approved;
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, state: "READY", updatedAt: input.now,
    branchSync: { repositoryId: input.repositoryId, number: input.number, expectedHeadCommit: pullRequest.headSha, reason: input.reason, ...(approved ? { approved: true as const } : {}) },
  });
}

/**
 * The owner's Retry of the ask (the branch conflicts and Rovara is set to suggest): WAIT_FOR_MERGE/BLOCKED becomes WAITING with a go-ahead for the heads the open pull requests hold now. The rounds
 * already used stay counted; the next conflict decision for one of those heads starts the merge whatever the autonomy. Also the Retry of a merge that failed for real twice: one more try.
 */
export function retryWorkflowBranchSync(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const ask = isBranchConflictAskReason(current.blockReason);
  const giveUp = isBranchSyncGiveUpReason(current.blockReason);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "BLOCKED" || (!ask && !giveUp)) {
    throw new WorkflowTransitionError("the workflow is not waiting for a conflict to be retried");
  }
  const { blockReason: _blockReason, ...rest } = current;
  void _blockReason;
  if (giveUp) {
    // After the merge failed for real twice: one more try, and a failure of it stops again.
    const head = current.syncFailures?.headSha;
    if (head === undefined) throw new WorkflowTransitionError("no head is recorded for the merge that failed");
    return WorkflowSnapshotSchema.parse({ ...rest, syncFailures: { headSha: head, count: Math.max(0, SYNC_FAILURES_MAX - 1) }, revision: current.revision + 1, state: "WAITING", updatedAt: now });
  }
  const heads = [...new Set((current.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN").flatMap((pullRequest) => pullRequest.headSha === undefined ? [] : [pullRequest.headSha]))];
  if (heads.length === 0) throw new WorkflowTransitionError("no open pull request has a recorded head to give a go-ahead for");
  return WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, state: "WAITING", conflictApproved: heads, updatedAt: now });
}

/** The merge of the base branch is accepted by a worker: READY becomes RUNNING. */
export function startWorkflowBranchSyncRun(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "READY" || current.branchSync === undefined) throw new WorkflowTransitionError("no merge of the base branch is waiting to start");
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "RUNNING", updatedAt: now });
}

/** A merge of the base branch that pushed nothing (it did not start, was not needed, failed, or the branch moved): the task waits for the merge again, as it was. */
export function endWorkflowBranchSync(currentInput: unknown, now: string, options: { failed?: "real" | "transient" } = {}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || (current.state !== "READY" && current.state !== "RUNNING") || current.branchSync === undefined) throw new WorkflowTransitionError("no merge of the base branch is under way");
  const { branchSync, syncFailures: prior, ...rest } = current;
  // A merge that failed is counted for the head it was for (a different head starts again). A failure of the merge itself counts toward the stop; one that is not (GitHub, a lost machine) only
  // delays the next try, by twice as long each time.
  const head = branchSync.expectedHeadCommit;
  const same = prior?.headSha === head ? prior : undefined;
  const transient = options.failed === "transient" ? (same?.transient ?? 0) + 1 : same?.transient;
  const failures = options.failed === undefined ? prior : {
    headSha: head,
    count: Math.min(SYNC_FAILURES_MAX, (same?.count ?? 0) + (options.failed === "real" ? 1 : 0)),
    ...(transient === undefined ? {} : { transient: Math.min(1000, transient) }),
    ...(options.failed === "transient"
      ? { retryAfter: new Date(Date.parse(now) + Math.min(SYNC_BACKOFF_MINUTES.max, SYNC_BACKOFF_MINUTES.first * 2 ** Math.min(20, transient! - 1)) * 60_000).toISOString() }
      : same?.retryAfter === undefined ? {} : { retryAfter: same.retryAfter }),
  };
  return WorkflowSnapshotSchema.parse({ ...rest, ...(failures === undefined ? {} : { syncFailures: failures }), revision: current.revision + 1, state: "WAITING", updatedAt: now });
}

/**
 * Keeping the branch up to date stops with a plain reason for a person to act on (the branch still conflicts after the conflict rounds, or the base changed CI workflow files, which Rovara cannot
 * push): WAIT_FOR_MERGE/BLOCKED with `reason`, which must be one of the two texts. The pull requests stay followed for the merge.
 */
export function blockWorkflowBranchSync(currentInput: unknown, input: { reason: string; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const waiting = current.stage === "WAIT_FOR_MERGE" && (current.state === "WAITING" || current.state === "READY" || current.state === "RUNNING");
  if (!isBranchSyncBlockReason(input.reason) || !waiting) throw new WorkflowTransitionError("the workflow is not at a place keeping the branch up to date can stop");
  const { branchSync: _branchSync, ...rest } = current;
  void _branchSync;
  return WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, state: "BLOCKED", blockReason: input.reason.slice(0, 500), updatedAt: input.now });
}

/**
 * The merge of the base branch conflicted (nothing was pushed; the worker left the merge's files in the workspace): a conflict round begins. The task is back to waiting for the merge and a fix of
 * source `conflict` starts, counted, with the first conflicting files by name. Refused when the conflict rounds are used up (the caller stops instead).
 */
export function recordWorkflowSyncConflict(currentInput: unknown, input: { paths: readonly string[]; baseCommit: string; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "RUNNING" || current.branchSync === undefined) throw new WorkflowTransitionError("no merge of the base branch is running");
  if (workflowFixRoundsLeft(current, "conflict") === 0) throw new WorkflowTransitionError("the rounds of this kind of fix are used up");
  const { branchSync: _branchSync, ...rest } = current;
  void _branchSync;
  const waiting = WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, state: "WAITING", updatedAt: input.now });
  const names = input.paths.slice(0, CONFLICT_PATHS_MAX).map((path) => redactText(path.replace(/[\p{Cc}\p{Cf}]/gu, " ")).replace(/\s+/gu, " ").trim().slice(0, 200)).filter((name) => name !== "");
  if (!/^[a-f0-9]{40}$/.test(input.baseCommit)) throw new WorkflowTransitionError("the base commit of the conflict is invalid");
  const started = startWorkflowFix(waiting, { source: "conflict", problems: names.slice(0, CI_FIX_PROBLEMS_MAX), now: input.now });
  // The round's reviewers see the diff against the base commit whose merge conflicted: a change of the base that the fix took back shows in it. (The pull request keeps its candidate on the old base until the fix lands.)
  const repositoryId = current.branchSync.repositoryId;
  const reviewBase = (current.reviewBase ?? current.candidate?.repositories.flatMap((repository) => repository.baseCommitSha === undefined ? [] : [{ repositoryId: repository.repositoryId, baseCommitSha: repository.baseCommitSha }]))
    ?.map((entry) => entry.repositoryId === repositoryId ? { ...entry, baseCommitSha: input.baseCommit } : entry);
  return WorkflowSnapshotSchema.parse({ ...started, conflictBase: input.baseCommit, ...(reviewBase === undefined || reviewBase.length === 0 ? {} : { reviewBase }) });
}

/**
 * The base branch is merged into a pull request's branch and the merge is on GitHub. The pull request holds the merge, and the candidate is the same change on the new base: its repository entry has the
 * merge commit, its tree and the new base commit, so the next review and the next fix see only Rovara's change (Finding 8). Everything bound to the old candidate's digest (checks, reviews, accepted
 * findings, risk, the pull requests that held it) is renamed to the new one here; the caller that makes a merge of the base a NEW CANDIDATE (decision 67b) drops the checks, reviews and accepted findings again, so
 * a merge is checked and reviewed before the task waits for it. Two ways to get here:
 * - a clean merge, which the worker pushed (WAIT_FOR_MERGE/RUNNING with the merge marked): `previousHeadSha` is the head before it, and the pull request's `syncedFrom` names the head before the run of
 *   clean merges, so a person's approval of that head can carry (the rule is Task 19's). The reviewed tree is the merge's;
 * - a conflict round's fix, which was pushed as a merge commit and recorded as any fix (`recordWorkflowPullRequestUpdate`): the pull request already holds the head. It was code Rovara wrote, so
 *   nothing carries an approval, and `syncedFrom` is not set.
 */
export function recordWorkflowBranchSync(currentInput: unknown, input: { repositoryId: string; number: number; headSha: string; headTreeSha: string; baseCommitSha: string; previousHeadSha?: string; unverified?: boolean; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const sha = z.string().regex(/^[a-f0-9]{40}$/);
  if (![input.headSha, input.headTreeSha, input.baseCommitSha, ...(input.previousHeadSha === undefined ? [] : [input.previousHeadSha])].every((value) => sha.safeParse(value).success)) {
    throw new WorkflowTransitionError("the merge of the base branch names an invalid commit");
  }
  const candidate = current.candidate;
  const pullRequest = (current.pullRequests ?? []).find((entry) => entry.repositoryId === input.repositoryId && entry.number === input.number);
  const entry = candidate?.repositories.find((repository) => repository.repositoryId === input.repositoryId);
  if (candidate === undefined || pullRequest === undefined || entry === undefined || (pullRequest.state !== "OPEN" && pullRequest.state !== "UNKNOWN")) {
    throw new WorkflowTransitionError("the merge of the base branch names no open pull request of the workflow's candidate");
  }
  const clean = current.stage === "WAIT_FOR_MERGE" && current.state === "RUNNING" && current.branchSync?.repositoryId === input.repositoryId && current.branchSync.number === input.number;
  const afterFix = !clean && ((current.stage === "WAIT_FOR_MERGE" && current.state === "WAITING") || (current.stage === "PULL_REQUEST" && current.state === "READY"));
  if (clean) {
    if (input.previousHeadSha === undefined || pullRequest.headSha !== input.previousHeadSha || input.headSha === input.previousHeadSha || current.branchSync?.expectedHeadCommit !== input.previousHeadSha) {
      throw new WorkflowTransitionError("the merge of the base branch is not on the head the workflow recorded");
    }
  } else if (!afterFix || pullRequest.headSha !== input.headSha || pullRequest.headTreeSha !== input.headTreeSha || entry.treeSha !== input.headTreeSha || pullRequest.candidateDigest !== candidate.digest) {
    throw new WorkflowTransitionError("the pull request does not hold the fix the merge of the base branch resolved");
  }
  const renewed = createCandidateManifest(candidate.repositories.map((repository) => repository.repositoryId === input.repositoryId
    ? { repositoryId: repository.repositoryId, commitSha: input.headSha, treeSha: input.headTreeSha, baseCommitSha: input.baseCommitSha } : repository));
  const rekey = <T extends { candidateDigest: string }>(entries: readonly T[] | undefined): T[] | undefined =>
    entries?.map((entry_) => entry_.candidateDigest === candidate.digest ? { ...entry_, candidateDigest: renewed.digest } : entry_);
  const pullRequests = (current.pullRequests ?? []).map((entry_) => {
    if (entry_ !== pullRequest) return entry_.candidateDigest === candidate.digest ? { ...entry_, candidateDigest: renewed.digest } : entry_;
    const { syncedFrom: priorSyncedFrom, ...rest } = entry_;
    return { ...rest, headSha: input.headSha, headTreeSha: input.headTreeSha, candidateDigest: renewed.digest,
      // `unverified`: the worker's result was lost, so nothing proves Rovara's checks passed on the merged head, and no earlier head is kept for an approval to carry from.
      ...(clean && input.unverified !== true ? { syncedFrom: priorSyncedFrom ?? input.previousHeadSha! } : {}) };
  });
  const reviewBase = renewed.repositories.every((repository) => repository.baseCommitSha !== undefined)
    ? renewed.repositories.map((repository) => ({ repositoryId: repository.repositoryId, baseCommitSha: repository.baseCommitSha as string })) : current.reviewBase;
  const { branchSync: _branchSync, syncFailures: _failures, ...rest } = current;
  void _branchSync;
  void _failures;
  const verification = current.verification?.candidateDigest === candidate.digest ? { ...current.verification, candidateDigest: renewed.digest } : current.verification;
  const reviews = rekey(current.reviews);
  const acceptedFindings = rekey(current.acceptedFindings);
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, state: clean ? "WAITING" : current.state, candidate: renewed,
    ...(reviewBase === undefined ? {} : { reviewBase }),
    ...(verification === undefined ? {} : { verification }), ...(reviews === undefined ? {} : { reviews }), ...(acceptedFindings === undefined ? {} : { acceptedFindings }),
    ...(current.risk === undefined ? {} : { risk: current.risk.candidateDigest === candidate.digest ? { ...current.risk, candidateDigest: renewed.digest } : current.risk }),
    pullRequests, pullRequestUpdatedAt: input.now, updatedAt: input.now,
  });
}

/** Saves recoverable review input without inventing an independent report or code authority. */
export function collectWorkflowFeedbackBundles(currentInput: unknown, input: {
  bundleRefs: unknown; threadObservations: unknown;
  /** Per pull request, which of its comments the host records an edit of (`false` = never edited). Comments not listed are unknown. Lessons capture only; absent or malformed means nothing is known. */
  edits?: ReadonlyArray<{ repositoryId: string; number: number; edits: Readonly<Record<string, boolean>> }>;
}, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const collected = WorkflowFeedbackReviewSchema.safeParse({ bundleRefs: input.bundleRefs, threadObservations: input.threadObservations, status: "COLLECTING" });
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
  const next = { ...current, revision: current.revision + 1, feedback: undefined,
    feedbackReview: collected.data, feedbackReviewHistory: history,
    feedbackDispatchApproval: undefined, feedbackCiFailures: undefined, updatedAt: now };
  return WorkflowSnapshotSchema.parse({ ...next, feedbackShown: feedbackShownAfter(current, next, collected.data.bundleRefs, collected.data.threadObservations, now, input.edits) });
}

/**
 * The record of which pull request comments the agent was shown, with this round added. Every comment of every collected bundle, and every comment of the threads seen with them (replies included),
 * counts as shown, not only the ones the owner later selects. A round that cannot be recorded in full (the list is full, or an earlier round was collected before this record existed) marks the whole
 * record `incomplete`, and a reader then takes the task as steered by someone unnamed.
 */
function feedbackShownAfter(
  current: WorkflowSnapshot, next: Parameters<typeof workflowMetadataBytes>[0], bundleRefs: readonly WorkflowFeedbackBundleRef[], threadObservations: readonly WorkflowFeedbackThreadObservation[], now: string,
  edits: ReadonlyArray<{ repositoryId: string; number: number; edits: Readonly<Record<string, boolean>> }> | undefined,
): WorkflowFeedbackShown {
  const prior = current.feedbackShown;
  const earlierUnrecorded = prior === undefined && (current.feedbackReview !== undefined || (current.feedbackReviewHistory ?? []).length > 0);
  const byPull = new Map<string, { repositoryId: string; number: number; comments: Map<string, { id: string; at: number; edited?: boolean }> }>();
  const add = (repositoryId: string, number: number, id: string, updatedAt: string): void => {
    const key = `${repositoryId}\u0000${number}`;
    const entry = byPull.get(key) ?? { repositoryId, number, comments: new Map() };
    const at = Date.parse(updatedAt);
    const edited = (edits ?? []).find(item => item.repositoryId === repositoryId && item.number === number)?.edits[id];
    entry.comments.set(`${id}\u0000${at}`, { id, at: Number.isFinite(at) && at >= 0 ? Math.floor(at) : 0, ...(typeof edited === "boolean" ? { edited } : {}) });
    byPull.set(key, entry);
  };
  for (const bundle of bundleRefs) for (const comment of bundle.comments) add(bundle.repositoryId, bundle.number, comment.id, comment.updatedAt);
  for (const thread of threadObservations) for (const comment of thread.comments) add(thread.repositoryId, thread.number, comment.id, comment.updatedAt);
  const pulls = [...byPull.values()].map(entry => ({ repositoryId: entry.repositoryId, number: entry.number, comments: [...entry.comments.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.at - b.at)) }));
  const used = (prior?.rounds ?? []).reduce((sum, round) => sum + round.pulls.reduce((inner, pull) => inner + pull.comments.length, 0), 0);
  const adding = pulls.reduce((sum, pull) => sum + pull.comments.length, 0);
  const rounds = [...(prior?.rounds ?? [])];
  const wasIncomplete = prior?.incomplete === true || earlierUnrecorded;
  const full = pulls.length > 32 || rounds.length >= FEEDBACK_SHOWN_MAX_ROUNDS || used + adding > FEEDBACK_SHOWN_MAX_IDS || pulls.some(pull => pull.comments.length > FEEDBACK_SHOWN_MAX_IDS);
  if (!full) {
    // A large pull request must not push the task snapshot over its metadata budget (that would stop feedback collection, a core flow): when this round would not fit, it is not added and the record
    // is marked incomplete. If even the record as it stands does not fit with the mark, the rounds go and only the mark stays.
    const withRound = { rounds: [...rounds, { at: now, pulls }], ...(wasIncomplete ? { incomplete: true as const } : {}) };
    if (workflowMetadataBytes({ ...next, feedbackShown: withRound }) <= WORKFLOW_METADATA_BUDGET_BYTES) return withRound;
  }
  const marked = { rounds, incomplete: true as const };
  return workflowMetadataBytes({ ...next, feedbackShown: marked }) <= WORKFLOW_METADATA_BUDGET_BYTES ? marked : { rounds: [], incomplete: true as const };
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
}, authority?: WorkflowOwnerAuthority): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  if (input.actor.role !== "TASK_OWNER" || !workflowOwnerAuthorized(current.ownerId, input.actor.actorId, authority)) {
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

/** The digest of a set of failing checks' names (sorted, so the order they were seen in does not matter). */
export function feedbackCiFailuresDigest(checks: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(checks)].sort()), "utf8").digest("hex");
}

/** The failing checks the owner's card shows: only while a complete review waits for a decision. */
export function feedbackCardCiFailures(workflow: Pick<WorkflowSnapshot, "feedbackReview" | "feedbackCiFailures">): FeedbackCiFailures | undefined {
  const review = workflow.feedbackReview;
  return review?.status === "PENDING" && review.reviewRef.status === "COMPLETE" ? workflow.feedbackCiFailures : undefined;
}

/**
 * CI fails (or stops failing) while the owner's feedback card waits (Plan 6 Task 16): the failing checks are added to the card, or taken off it. Nothing is fixed by this; it changes what the
 * decision is bound to (the workflow's revision moves, so a decision made against the card as it was is refused), and the decision that follows carries the failures into the same round. Only
 * while the card waits: after a decision nothing is added. No names clears the card's failures. A change that is no change is refused.
 */
export function recordWorkflowFeedbackCiFailures(currentInput: unknown, input: { checks: readonly string[]; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  if (current.stage !== "WAIT_FOR_MERGE" || current.state !== "WAITING" || review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE") {
    throw new WorkflowTransitionError("no feedback card is waiting for a decision");
  }
  const names = z.array(z.string().trim().min(1).max(200)).max(FEEDBACK_CI_CHECKS_MAX).safeParse([...new Set(input.checks)].sort());
  if (!names.success) throw new WorkflowTransitionError("the failing checks are invalid");
  if (names.data.length === 0) {
    if (current.feedbackCiFailures === undefined) throw new WorkflowTransitionError("the card names no failing checks");
    const { feedbackCiFailures: _cleared, ...rest } = current;
    void _cleared;
    return WorkflowSnapshotSchema.parse({ ...rest, revision: current.revision + 1, updatedAt: input.now });
  }
  const digest = feedbackCiFailuresDigest(names.data);
  if (current.feedbackCiFailures?.digest === digest) throw new WorkflowTransitionError("the card already names these failing checks");
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, feedbackCiFailures: { checks: names.data, digest, evidenceRevision: current.revision + 1 }, updatedAt: input.now });
}

/** Who decides a feedback round: the task's owner, or Rovara itself under the autonomy its recipe gives (only its own approval of an actionable round, counted). */
export type WorkflowFeedbackActor =
  | { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" }
  | { actorId: typeof FEEDBACK_AUTONOMY_ACTOR_ID; role: "ROVARA_AUTONOMY"; autonomy: WorkflowFeedbackAutonomy };

/**
 * Requires fresh bindings supplied by the reconciler; dispatch must independently reconcile again.
 * Rovara's own decision (`ROVARA_AUTONOMY`, Plan 6 Task 16) can only approve, with no note, under `FEEDBACK_AUTO_ROUNDS_MAX`: it counts as a round, marks the fix as a feedback fix, and does not carry
 * the earlier code's review rounds over. A person's decision is never counted.
 */
export function decideWorkflowFeedbackFindings(currentInput: unknown, input: {
  requestId: string; expectedRevision: number; reviewDigest: string; proposalDigest: string;
  bundleDigests: string[]; selectedFindingIds: string[]; decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS"; ownerNote?: string;
}, actor: WorkflowFeedbackActor, now: string, authority?: WorkflowOwnerAuthority): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  const byRovara = actor.role === "ROVARA_AUTONOMY";
  if (actor.role === "ROVARA_AUTONOMY") {
    if (actor.actorId !== FEEDBACK_AUTONOMY_ACTOR_ID || input.decision !== "APPROVE" || input.ownerNote !== undefined || workflowFixRoundsLeft(current, "feedback") <= 0
      || WorkflowFeedbackAutonomySchema.safeParse(actor.autonomy).success === false) {
      throw new WorkflowTransitionError("Rovara can only approve a feedback round on its own, with the rounds it has left");
    }
  } else if (actor.role !== "TASK_OWNER" || !workflowOwnerAuthorized(current.ownerId, actor.actorId, authority)) {
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
    decision: input.decision, actorId: actor.actorId, actorRole: actor.role === "ROVARA_AUTONOMY" ? "ROVARA_AUTONOMY" : "TASK_OWNER", reviewDigest: input.reviewDigest,
    proposalDigest: input.proposalDigest, bundleDigests: input.bundleDigests, selectedFindingIds: input.selectedFindingIds,
    selectedCommentIds: [...new Set(selected.flatMap(f => f.commentIds))],
    candidates: affected.map(b => ({ repositoryId: b.repositoryId, number: b.number, headSha: b.headSha,
      candidateDigest: b.candidateDigest, commentSetDigest: b.commentSetDigest, bundleDigest: b.sha256 })),
    ...(input.ownerNote === undefined ? {} : { ownerNote: input.ownerNote }), at: now,
    ...(actor.role === "ROVARA_AUTONOMY" ? { autonomy: actor.autonomy } : {}),
    ...(feedbackCardCiFailures(current) === undefined ? {} : { ciFailures: feedbackCardCiFailures(current) }),
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
  // Rovara's own round is a fix like the others: it is marked, counted, and starts its review rounds from none (the third would otherwise block on the engine's never-reset counter).
  const { programRounds: _rounds, feedbackCiFailures: _ci, ...base } = current;
  void _rounds;
  void _ci;
  const rounds = workflowFixRounds(current);
  return WorkflowSnapshotSchema.parse({ ...(byRovara ? base : { ...current, feedbackCiFailures: undefined }), revision: current.revision + 1, ...(pullRequests === undefined ? {} : { pullRequests }),
    ...(input.decision === "APPROVE" ? { stage: "IMPLEMENT", state: "READY",
      // A fix to an open pull request goes through the program's last build, then its checks and reviews again.
      ...(current.program === undefined ? {} : { programStepId: programBuildAtOrBefore(current.program, current.program.steps.length - 1).id }) } : {}),
    ...(byRovara ? { fixSource: "feedback" as const, fixRounds: { ...rounds, feedbackAuto: rounds.feedbackAuto + 1 } } : {}),
    feedbackReview: { ...review, status: input.decision === "APPROVE" ? "APPROVED" : input.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "DISMISSED" },
    feedbackDecisions: [...(current.feedbackDecisions ?? []), decision.data], feedbackNotes, updatedAt: now,
  });
}

function validSnapshot(input: unknown): WorkflowSnapshot {
  const parsed = WorkflowSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowTransitionError("workflow snapshot is invalid");
  return parsed.data;
}

/**
 * A new workflow. A Rovara Code version 2 task (`definitionVersion: "1.1.0"`) passes `understand: true` and starts at UNDERSTAND/READY: Understand reads the
 * intent before any plan is written. `pathFrom` says who chose the path (the request, Understand, or a hand-off) and is kept on `intent`; a version 1 task
 * has neither (its snapshot refuses `intent`).
 */
export function createWorkflowSnapshot(input: { taskId: string; ownerId: string; now: string; path?: WorkflowPath; checkPolicy?: WorkflowCheckPolicyInput; program?: WorkflowProgram; definitionVersion?: WorkflowDefinitionVersion; understand?: boolean; pathFrom?: WorkflowIntent["pathFrom"] }): WorkflowSnapshot {
  const understand = input.understand === true;
  if ((understand || input.pathFrom !== undefined) && input.definitionVersion !== "1.1.0") throw new WorkflowTransitionError("only a version 1.1.0 workflow understands the intent first");
  const parsed = WorkflowSnapshotSchema.safeParse({
    schemaVersion: 1,
    definitionId: "agentx-task-to-pr",
    definitionVersion: input.definitionVersion ?? "1.0.0",
    taskId: input.taskId,
    ownerId: input.ownerId,
    path: input.path ?? "QUICK",
    ...(input.path === "FULL" ? { reviewPhase: "REQUIREMENTS" as const } : {}),
    revision: 1,
    stage: understand ? "UNDERSTAND" : "PLAN",
    state: understand ? "READY" : "RUNNING",
    ...(understand || input.pathFrom !== undefined ? { intent: { rounds: 0, pathFrom: input.pathFrom ?? "understand", answers: [] } } : {}),
    createdAt: input.now,
    updatedAt: input.now,
    artifacts: [],
    decisions: [],
    ...(input.checkPolicy === undefined ? {} : { checkPolicy: input.checkPolicy }),
    ...(input.program === undefined ? {} : {
      program: input.program,
      ...(input.program.steps[0]?.kind === "plan" ? { programStepId: input.program.steps[0].id } : {}),
    }),
  });
  if (!parsed.success) throw new WorkflowTransitionError("workflow initialization is invalid");
  return parsed.data;
}

/**
 * Rovara Code version 2: Understand runs (the first time, again after a person answered, or after a retry): UNDERSTAND/READY or BLOCKED becomes RUNNING. The task must be a 1.1.0 workflow.
 */
export function startWorkflowUnderstand(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.definitionVersion !== "1.1.0" || current.stage !== "UNDERSTAND" || (current.state !== "READY" && current.state !== "BLOCKED")) {
    throw new WorkflowTransitionError("the workflow is not ready to understand the request");
  }
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({ ...unblocked, revision: current.revision + 1, state: "RUNNING", updatedAt: now });
}

/** Rovara Code version 2: the plan step runs after Understand: PLAN/READY becomes RUNNING. */
export function startWorkflowPlanAfterUnderstand(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.definitionVersion !== "1.1.0" || current.stage !== "PLAN" || current.state !== "READY") throw new WorkflowTransitionError("the workflow is not ready to plan");
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "RUNNING", updatedAt: now });
}

/**
 * A version 1.0.0 task (Understand off: the start named the path and the request went straight to planning): the plan step runs again after the owner asked for changes, PLAN/READY becomes RUNNING.
 * There is no assessment to plan from; the planner is given the request and the owner's words instead.
 */
export function startWorkflowPlanWithoutUnderstand(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.definitionVersion !== "1.0.0" || current.stage !== "PLAN" || current.state !== "READY") throw new WorkflowTransitionError("the workflow is not ready to plan");
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "RUNNING", updatedAt: now });
}

/**
 * What Understand found, recorded (`assessment` is the broker's checked, redacted copy of the model's answer; it is checked here once more):
 * - `ready` goes to PLAN/READY, with the path (a path the request gave wins; a Full path asks for requirements first);
 * - `questions` wait for a person at UNDERSTAND/WAITING while fewer than UNDERSTAND_ROUNDS_MAX rounds were asked; a round after that is treated as `ready`, each question
 *   turned into the assumption it would have been answered with;
 * - `answer` (a question that needs no code change) ends the task Answered: `answerWorkflowIntent`.
 */
export function recordIntentAssessment(currentInput: unknown, input: { expectedRevision: number; assessment: unknown; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.definitionVersion !== "1.1.0" || current.stage !== "UNDERSTAND" || current.state !== "RUNNING" || current.intent === undefined) {
    throw new WorkflowTransitionError("the workflow is not understanding the request");
  }
  const parsed = IntentAssessmentSchema.safeParse(input.assessment);
  if (!parsed.success || intentAssessmentDuplicateIds(parsed.data).length > 0) throw new WorkflowTransitionError("the assessment is invalid");
  const assessment: IntentAssessment = parsed.data;
  const intent = current.intent;
  // A question that needs no code change ends the task Answered, and that move keeps the answer's artifact: it is `answerWorkflowIntent`, not this.
  if (assessment.kind === "answer") throw new WorkflowTransitionError("an answer ends the task: record it with answerWorkflowIntent");
  if (assessment.kind === "questions" && intent.rounds < UNDERSTAND_ROUNDS_MAX) {
    return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "WAITING", intent: { ...intent, rounds: intent.rounds + 1, assessment }, updatedAt: input.now });
  }
  const ready: Extract<IntentAssessment, { kind: "ready" }> = assessment.kind === "ready" ? assessment
    : { kind: "ready", path: current.path, restatement: assessment.restatement, assumptions: assessment.questions.map(intentAssumptionLine) };
  // The request's path (or a hand-off's) wins over Understand's.
  const path = intent.pathFrom === "understand" ? ready.path : current.path;
  const { reviewPhase: _reviewPhase, ...withoutPhase } = current;
  void _reviewPhase;
  return WorkflowSnapshotSchema.parse({
    ...withoutPhase, revision: current.revision + 1, stage: "PLAN", state: "READY", path,
    ...(path === "FULL" ? { reviewPhase: "REQUIREMENTS" as const } : {}),
    intent: { ...intent, assessment: ready }, updatedAt: input.now,
  });
}

/** The producer an answer's artifact names: the answer is a model's words, kept as untrusted as a plan is. */
export const WORKFLOW_ANSWER_PRODUCER = "agentx-worker-untrusted";

/** What a question-only task keeps of the answer: the model's words with credentials redacted and control characters made spaces, checked once more against the assessment's own limits. */
function cleanedAnswer(input: { restatement: string; answer: string; sources: ReadonlyArray<{ repository: string; path: string; line?: number | undefined }> }): Extract<IntentAssessment, { kind: "answer" }> {
  const oneLine = (text: string) => Array.from(redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim());
  const parsed = IntentAssessmentSchema.safeParse({
    kind: "answer", restatement: oneLine(input.restatement).slice(0, INTENT_RESTATEMENT_MAX).join("") || "A question",
    answer: plainAnswerText(redactText(input.answer)),
    sources: input.sources.map((source) => ({ repository: oneLine(source.repository).slice(0, 200).join(""), path: oneLine(source.path).slice(0, 500).join(""), ...(source.line === undefined ? {} : { line: source.line }) })),
  });
  if (!parsed.success || parsed.data.kind !== "answer") throw new WorkflowTransitionError("the answer is invalid");
  return parsed.data;
}

/** The answer's artifact: the digest is of the answer and its sources, and the object it points at is the file the answer was read from (the Understand result or the plan document). */
function answerArtifact(workflow: WorkflowSnapshot, answer: Extract<IntentAssessment, { kind: "answer" }>, from: { id: string; objectKey: string; createdAt: string }): WorkflowArtifact {
  return WorkflowArtifactSchema.parse({
    id: from.id, type: "answer", version: workflow.artifacts.filter((artifact) => artifact.type === "answer").length + 1,
    sha256: createHash("sha256").update(JSON.stringify({ answer: answer.answer, sources: answer.sources }), "utf8").digest("hex"),
    producer: WORKFLOW_ANSWER_PRODUCER, objectKey: from.objectKey, createdAt: from.createdAt,
  });
}

/** The task as it is once its question is answered: closed and complete, outcome ANSWERED, with the answer on `intent` and as an `{ type: "answer" }` artifact. */
function answeredSnapshot(current: WorkflowSnapshot, answer: Extract<IntentAssessment, { kind: "answer" }>, from: { id: string; objectKey: string; createdAt: string }, now: string, decision?: WorkflowDecision): WorkflowSnapshot {
  // A Full workflow keeps the phase it was at: the schema asks every Full workflow to name one.
  const { blockReason: _blockReason, ...rest } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED", updatedAt: now,
    intent: { ...(current.intent ?? { rounds: 0, pathFrom: "request", answers: [] }), assessment: answer },
    artifacts: [...current.artifacts, answerArtifact(current, answer, from)],
    ...(decision === undefined ? {} : { decisions: [...current.decisions, decision] }),
  });
}

/**
 * Rovara Code version 2: Understand found that the person asked a question that needs no code change. The task ends CLOSED/COMPLETE with the outcome ANSWERED, the answer kept on
 * `intent` and as an `{ type: "answer" }` artifact (`artifact` names the file the answer was read from). `assessment` is the broker's checked copy of the model's answer; it is cleaned
 * and checked here again, and nothing in it can do more than be read: no stage, path or decision comes from it.
 */
export function answerWorkflowIntent(
  currentInput: unknown, input: { expectedRevision: number; assessment: unknown; artifact: { id: string; objectKey: string; createdAt: string }; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.definitionVersion !== "1.1.0" || current.stage !== "UNDERSTAND" || current.state !== "RUNNING" || current.intent === undefined) {
    throw new WorkflowTransitionError("the workflow is not understanding the request");
  }
  const parsed = IntentAssessmentSchema.safeParse(input.assessment);
  if (!parsed.success || parsed.data.kind !== "answer") throw new WorkflowTransitionError("the assessment is not an answer");
  return answeredSnapshot(current, cleanedAnswer(parsed.data), input.artifact, input.now);
}

/** The answer a closed task kept, or undefined: only an ANSWERED workflow has one. */
export function workflowAnswer(workflow: Pick<WorkflowSnapshot, "outcome" | "intent">): Extract<IntentAssessment, { kind: "answer" }> | undefined {
  const assessment = workflow.outcome === "ANSWERED" ? workflow.intent?.assessment : undefined;
  return assessment?.kind === "answer" ? assessment : undefined;
}

/** Answers that cannot be taken, with the error code the broker answers them under: `INTENT_NOT_WAITING` (nothing is waiting for them) or `CONFIG_INVALID` (they are not a full, valid set of answers). */
export class IntentAnswerRefusal extends WorkflowTransitionError {
  readonly code: "INTENT_NOT_WAITING" | "CONFIG_INVALID";
  constructor(code: "INTENT_NOT_WAITING" | "CONFIG_INVALID", message: string) {
    super(message);
    this.name = "IntentAnswerRefusal";
    this.code = code;
  }
}

/** A person's words for a prompt and a record: credentials redacted, control characters made spaces (a line break stays), no longer than an answer may be. */
function cleanAnswerText(text: string): string {
  const cleaned = redactText(text).replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).trim();
  return Array.from(cleaned).slice(0, INTENT_ANSWER_MAX_CHARS).join("");
}

/**
 * Rovara Code version 2: people answered Understand's questions. Only at UNDERSTAND/WAITING, for the round now asked, at the revision that was read; every open question needs one
 * answer (an option of that question, words, or both), and nothing else is taken. The answers are cleaned (credentials redacted, control characters made spaces) and kept with who
 * gave them, where from, and the questions as they were asked, and Understand runs again (UNDERSTAND/READY; the caller writes the dispatch row in the same transaction).
 * `by` is the person the broker authenticated, never anything from the request's body.
 */
export function answerIntentQuestions(
  currentInput: unknown,
  input: { expectedRevision: number; round: number; by: { actorId: string; name: string }; source: string; answers: unknown; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const asked = current.intent?.assessment;
  if (current.definitionVersion !== "1.1.0" || current.stage !== "UNDERSTAND" || current.state !== "WAITING" || current.intent === undefined || asked?.kind !== "questions"
    || input.round !== current.intent.rounds || input.expectedRevision !== current.revision) {
    throw new IntentAnswerRefusal("INTENT_NOT_WAITING", INTENT_NOT_WAITING_MESSAGE);
  }
  const invalid = (message: string) => new IntentAnswerRefusal("CONFIG_INVALID", message);
  const source = z.enum(INTENT_ANSWER_SOURCES).safeParse(input.source);
  if (!ActorIdSchema.safeParse(input.by.actorId).success || !source.success) throw new WorkflowTransitionError("the answers are not from a known person and place");
  const name = Array.from(redactText(input.by.name).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 200).join("");
  if (name === "") throw new WorkflowTransitionError("the answers need the name of the person who gave them");
  const parsed = z.array(IntentAnswerSchema).min(1).max(INTENT_QUESTIONS_MAX).safeParse(input.answers);
  if (!parsed.success) {
    // Field names only: the values are a person's words.
    throw invalid(`answers: ${parsed.error.issues[0]?.path.map(String).join(".") || "the list"} is not valid`);
  }
  const questions = new Map(asked.questions.map((question) => [question.id, question]));
  if (parsed.data.some((answer) => !questions.has(answer.questionId))) throw invalid("answers: one of them is for a question that wasn't asked");
  if (new Set(parsed.data.map((answer) => answer.questionId)).size !== parsed.data.length || parsed.data.length !== questions.size) throw invalid(ANSWER_EVERY_QUESTION_MESSAGE);
  const cleaned: IntentAnswer[] = [];
  for (const answer of parsed.data) {
    const options = questions.get(answer.questionId)?.options;
    if (answer.optionId !== undefined && options?.some((option) => option.id === answer.optionId) !== true) throw invalid("answers: one of them is not one of the question's options");
    const text = answer.text === undefined ? undefined : cleanAnswerText(answer.text);
    if (answer.optionId === undefined && (text === undefined || text === "")) throw invalid("answers: each answer picks an option or says something");
    cleaned.push({ questionId: answer.questionId, ...(answer.optionId === undefined ? {} : { optionId: answer.optionId }), ...(text === undefined || text === "" ? {} : { text }) });
  }
  const ordered = asked.questions.map((question) => cleaned.find((answer) => answer.questionId === question.id)!);
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, state: "READY", updatedAt: input.now,
    intent: { ...current.intent, answers: [...current.intent.answers, { round: current.intent.rounds, by: { actorId: input.by.actorId, name }, source: source.data, answers: ordered, questions: asked.questions, at: input.now }] },
  });
}

/**
 * Understand never came back (or never started) in time: the task ends, closed, with the reason, so it gives its workspace slot back like a task whose plan was rejected.
 * Only an UNDERSTAND step that is READY or RUNNING ends this way.
 */
export function endStuckUnderstand(currentInput: unknown, now: string): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.definitionVersion !== "1.1.0" || current.stage !== "UNDERSTAND" || (current.state !== "READY" && current.state !== "RUNNING")) {
    throw new WorkflowTransitionError("the workflow is not waiting on Understand");
  }
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", blockReason: UNDERSTAND_TIMED_OUT_MESSAGE, updatedAt: now });
}

export function submitWorkflowArtifact(
  currentInput: unknown,
  input: { expectedRevision: number; artifact: WorkflowArtifact; now: string; proposal?: WorkflowCheckProposal; noChangeNeeded?: boolean },
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
  const { workflowDependenciesApproval: _oldDependencyApproval, workflowDependenciesOperationId: _oldDependencyOperationId,
    workflowDependenciesProgress: _oldDependencyProgress, ...withoutOldDependencyApproval } = current;
  void _oldDependencyApproval;
  void _oldDependencyOperationId;
  void _oldDependencyProgress;
  // Plan 6 Task 8: a Rovara Code version 2 coding plan is checked by a second model before a person sees it (a Full task's requirements and design are not).
  // MERGE-DECISION: a plan that says the request needs no code change (Task 4) has no change to check, so it goes straight to the person.
  if (artifact.data.type === "design" && workflowIsDesignReviewing(current) && !designReviewAwaitsDesign(current.designReview) && designReviewActive(current.designReview)) {
    // A revision after a review is the planner's resolution of the findings (`resolveDesignReview`), which carries the document with it.
    throw new WorkflowTransitionError("the design review resolves its findings with the revised design");
  }
  const checked = input.noChangeNeeded !== true && planCritiqued(current, artifact.data.type);
  const next = WorkflowSnapshotSchema.parse({
    ...withoutOldDependencyApproval,
    revision: current.revision + 1,
    stage: checked ? "PLAN_CRITIQUE" : "PLAN_REVIEW",
    state: checked ? "READY" : "WAITING",
    artifacts: [...current.artifacts, artifact.data],
    ...(policy === undefined ? {} : { checkPolicy: policy }),
    updatedAt: input.now,
  });
  return next;
}

/** Whether a plan of this type, made by this workflow, goes through the plan check: a version 2 coding plan of a sequence that has a plan check step. */
function planCritiqued(workflow: Pick<WorkflowSnapshot, "definitionVersion" | "program"> & { reviewPhase?: WorkflowSnapshot["reviewPhase"]; designReview?: WorkflowSnapshot["designReview"] }, type: WorkflowArtifact["type"]): boolean {
  if (workflow.definitionVersion !== "1.1.0" || workflow.program?.steps.some((step) => step.kind === "plan_critic") !== true) return false;
  // Design review (DR6): with it ON for the task, the first design document of a Full task goes through the plan-check stage in its design form. With it OFF `designReview` is absent and this is the plan check as it was.
  if (type === "design") return workflow.reviewPhase === "DESIGN" && designReviewAwaitsDesign(workflow.designReview);
  return type === "plan";
}

function runningPlanCheck(currentInput: unknown, expectedRevision: number, states: readonly WorkflowState[] = ["RUNNING"]): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.revision !== expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.stage !== "PLAN_CRITIQUE" || !states.includes(current.state)) throw new WorkflowTransitionError("the workflow is not running the plan check");
  // The design review (DR6) runs in this stage too, with its own moves (task-workflow-design-review.ts); the plan check's never act on it.
  if (workflowIsDesignReviewing(current)) throw new WorkflowTransitionError("the workflow is running the design review, not the plan check");
  return current;
}

/**
 * The plan check's result (Rovara Code version 2). The critic's points are advice: they are kept for the person and can neither approve the plan nor move it past
 * PLAN_REVIEW. A `revise` verdict with a blocking point sends the plan back to the planner once (`PLAN_CRITIC_REVISIONS_MAX`), with the points kept; the revised plan is checked
 * again. Every other result, and the second check whatever it says, goes to the person at PLAN_REVIEW with the critiques. `sameModelAsPlanner` notes that the project allows only one model.
 */
export function submitPlanCritique(
  currentInput: unknown,
  input: { expectedRevision: number; critique: PlanCritique; sameModelAsPlanner?: true; now: string },
): WorkflowSnapshot {
  const current = runningPlanCheck(currentInput, input.expectedRevision);
  const critique = PlanCritiqueSchema.safeParse(input.critique);
  if (!critique.success) throw new WorkflowTransitionError("the plan critique is invalid");
  const earlier = current.critique;
  const revisions = earlier?.revisions ?? 0;
  const critiques = [...(earlier?.critiques ?? []), critique.data];
  if (critiques.length > PLAN_CRITIC_REVISIONS_MAX + 1) throw new WorkflowTransitionError("the plan critique is invalid");
  const sendBack = critique.data.verdict === "revise" && critique.data.points.some((point) => point.severity === "blocking") && revisions < PLAN_CRITIC_REVISIONS_MAX;
  const kept: WorkflowCritique = {
    status: "done", critiques, revisions: sendBack ? revisions + 1 : revisions,
    ...(input.sameModelAsPlanner === true ? { sameModelAsPlanner: true as const } : {}),
  };
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, stage: sendBack ? "PLAN" : "PLAN_REVIEW", state: sendBack ? "READY" : "WAITING", critique: kept, updatedAt: input.now,
  });
}

/**
 * The plan check ended with no critique to add: it stopped at a spending limit (`stopped_at_limit`, `limit` says which), or it could not run or give an answer (`done`, so the plan is shown
 * as it was checked so far, which may be not at all). The plan goes to the person; whatever was critiqued before is kept. A check is advice, so it never holds a plan back. It may be closed
 * before it started (`READY`: its start was given up) as well as while it runs.
 */
export function closePlanCritique(
  currentInput: unknown,
  input: { expectedRevision: number; status: WorkflowCritique["status"]; limit?: "planning" | "other"; sameModelAsPlanner?: true; now: string },
): WorkflowSnapshot {
  const current = runningPlanCheck(currentInput, input.expectedRevision, ["RUNNING", "READY"]);
  const earlier = current.critique;
  const kept: WorkflowCritique = {
    status: input.status, critiques: earlier?.critiques ?? [], revisions: earlier?.revisions ?? 0,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.sameModelAsPlanner === true || earlier?.sameModelAsPlanner === true ? { sameModelAsPlanner: true as const } : {}),
  };
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, stage: "PLAN_REVIEW", state: "WAITING", critique: kept, updatedAt: input.now });
}

/**
 * The plan check could not use its model (the account has no access to it): the same check is made again on the next-ranked model. RUNNING goes back to READY at the next revision, so the
 * start of the next attempt has a request ID of its own; the critiques kept so far stay. Bounded by the caller (`CRITIC_MODEL_ATTEMPTS_MAX`): this only moves the workflow.
 */
export function retryPlanCritique(currentInput: unknown, input: { expectedRevision: number; now: string }): WorkflowSnapshot {
  const current = runningPlanCheck(currentInput, input.expectedRevision);
  return WorkflowSnapshotSchema.parse({ ...current, revision: current.revision + 1, state: "READY", updatedAt: input.now });
}

/**
 * The one revision a blocking point asked for could not be paid for (the planning budget ran out as it ran): the plan goes to the person as it was, with the critic's points and the
 * word that it was not revised. Nothing is paused and no money is asked for, because no person asked for the revision.
 */
export function skipPlanRevision(currentInput: unknown, input: { expectedRevision: number; limit: "planning" | "other"; now: string }): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  const critique = current.critique;
  if (current.stage !== "PLAN" || current.state !== "RUNNING" || critique === undefined || critique.revisions < 1 || critique.critiques.length === 0) {
    throw new WorkflowTransitionError("the workflow is not revising a plan after its check");
  }
  return WorkflowSnapshotSchema.parse({
    ...current, revision: current.revision + 1, stage: "PLAN_REVIEW", state: "WAITING", critique: { ...critique, notRevised: true, limit: input.limit }, updatedAt: input.now,
  });
}

/** Blocks the current step with `reason`; `regressedChecks` names the tests a review-only rerun found regressed. */
export function blockWorkflow(currentInput: unknown, reason: string, now: string, detail: { regressedChecks?: readonly string[]; noChangeFindings?: NoChangeFindings | undefined;
  failedE2ERound?: { status: "FAILED"; candidateDigest: string; roundId: string; groupRunIds: readonly string[]; admissionSha256: string; evidenceSha256: string } } = {}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const { regressedChecks: _prior, noChangeFindings: _priorFindings, ...withoutRegressions } = current;
  void _prior;
  void _priorFindings;
  const failure = detail.failedE2ERound;
  const failedRound = failure !== undefined && current.e2e?.required === true && current.candidate?.digest === failure.candidateDigest
    && current.e2e.currentRoundId === failure.roundId && current.e2e.currentGroupRunIds.length === failure.groupRunIds.length
    && current.e2e.currentGroupRunIds.every((runId, index) => runId === failure.groupRunIds[index]) ? failure : undefined;
  const { failedRound: _priorFailedRound, ...e2eWithoutFailure } = current.e2e ?? {};
  void _priorFailedRound;
  return WorkflowSnapshotSchema.parse({
    ...withoutRegressions, revision: current.revision + 1, state: "BLOCKED", blockReason: reason.slice(0, 500), updatedAt: now,
    ...(detail.regressedChecks === undefined || detail.regressedChecks.length === 0 ? {} : { regressedChecks: detail.regressedChecks }),
    // Only the no-code-change stop keeps what the run found; any other block drops an earlier run's findings with the block they belonged to.
    ...(detail.noChangeFindings === undefined || !isNoCodeChangedReason(reason) ? {} : { noChangeFindings: detail.noChangeFindings }),
    ...(current.e2e === undefined ? {} : { e2e: { ...e2eWithoutFailure, ...(failedRound === undefined ? {} : { failedRound }) } }),
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
  e2e?: { required?: boolean | undefined; currentRoundId?: string | undefined; currentGroupRunIds?: readonly string[] | undefined;
    failedRound?: { status: string; candidateDigest: string; roundId: string; groupRunIds: readonly string[]; admissionSha256: string; evidenceSha256: string } | undefined } | undefined;
}): boolean {
  if (!sendBackAllowedFrom(workflow)) return false;
  // Only evidence about the current code counts: a review or check of older code describes code that is gone.
  const current = workflow.candidate?.digest;
  if (workflow.stage === "REVIEW") {
    // SR-1: the second review (switch `cr`, `on`) blocked a review that passed: the findings are on the task's second opinion, and sending the work back is how they are fixed.
    if (workflow.blockReason === SECOND_REVIEW_BLOCK_REASON) return current !== undefined;
    return current !== undefined && workflow.reviews?.some((review) => review.candidateDigest === current
      && review.findings?.some((finding) => findingBlocks(finding, review.role)
        && !findingAccepted(finding, review.role, review.candidateDigest, workflow.acceptedFindings))) === true;
  }
  if (workflow.stage === "VERIFY") {
    // Review only: a rerun of the agent's own tests regressed, and no result was recorded for it.
    if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.regressionFound) return true;
    // The base branch was merged into the pull request and the merged code needs its checks again: a coding run on the workspace that holds the merge may leave the code as it is, and exports it so the checks (a
    // required E2E round included) can run on it. It is the way on where Retry checks cannot.
    if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.baseMergedRecheck) return true;
    // Blocks that only an administrator qualifying the runtime, or approving the plan again, can fix: new code cannot, even for a task with no checks.
    if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) === true || workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX) === true
      || workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) === true || workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX) === true) return false;
    // A required browser and API round that could not be admitted from this candidate (its build source or inputs are unusable): only new code can fix that.
    if (workflow.e2e?.required === true && workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX) === true) return true;
    // A required round whose groups ended with codes: new code fixes it when at least one group ended with a code the candidate causes (it did not build, stopped at start, never
    // answered, or its seed failed), whatever the other groups ended with. When none did, the codes are Rovara's or the environment's, and a task with no checks of its own (review
    // only) must not be sent back for them by the rule below.
    // An incomplete-evidence block whose reason holds no readable code says nothing about who is at fault, and gives the coder nothing to fix: no Send back, not even by the rule below.
    if (workflow.e2e?.required === true && workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX) === true) return evidenceCandidateCodes(workflow.blockReason).length > 0;
    // Review only: there is no check to retry, so coding again is the way on, except from rewritten history.
    if (workflowIsReviewOnly(workflow.checkPolicy)) return workflow.blockReason !== WORKFLOW_HISTORY_REWRITTEN_MESSAGE;
    const failedOrdinaryCheck = current !== undefined && workflow.verification?.candidateDigest === current
      && workflow.verification.results?.some((result) => result.status === "FAILED" && !workflowCheckResultBroken(result)) === true;
    const failure = workflow.e2e?.failedRound;
    const failedCurrentE2ERound = workflow.e2e?.required === true && current !== undefined && failure?.status === "FAILED"
      && failure.candidateDigest === current && failure.roundId === workflow.e2e.currentRoundId
      && failure.groupRunIds.length > 0 && failure.groupRunIds.length === workflow.e2e.currentGroupRunIds?.length
      && failure.groupRunIds.every((runId, index) => runId === workflow.e2e?.currentGroupRunIds?.[index]);
    return failedOrdinaryCheck || failedCurrentE2ERound;
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
  authority?: WorkflowOwnerAuthority,
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (!workflowOwnerAuthorized(current.ownerId, input.actorId, authority)) {
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
    // A program picks coding up again at the step the work goes back to.
    ...(current.program === undefined ? {} : { programStepId: programSendBackStep(current.program, current.programStepId).id }),
    decisions: [...current.decisions, decision], updatedAt: input.now,
  });
}

declare const wholeTaskSpendBrand: unique symbol;
/**
 * Model spend, in US dollars, of the WHOLE task so far (planning, every coding run, checks and reviews, from the task's cost records), not of the current plan version or round. The
 * automatic-fixing cap is per task, so a number that counts less lets automatic fixing spend past it. The brand makes a caller say so through `wholeTaskSpendUsd`.
 */
export type WholeTaskSpendUsd = number & { readonly [wholeTaskSpendBrand]: true };
export function wholeTaskSpendUsd(usd: number): WholeTaskSpendUsd {
  return usd as WholeTaskSpendUsd;
}
/** The money inputs of one more automatic round. All three are required by the policy and by the guard functions below. */
export interface WorkflowAutoSpend {
  /** Whole-task spend so far. */
  spentUsd: WholeTaskSpendUsd;
  /** The estimate of one more round. */
  roundEstimateUsd: number;
  /** The most automatic fixing may spend on one task (default 15). */
  capUsd: number;
}
/**
 * Why one more automatic round is not allowed by the money: `inputs-missing` when any number is absent or not a finite, non-negative number (never read as zero), `spend-cap` when
 * spent plus the estimate is over the cap. Undefined when it fits. Used by the policy and held again by the two guard functions.
 */
export function workflowAutoSpendRefusal(spend: Partial<WorkflowAutoSpend> | undefined): "inputs-missing" | "spend-cap" | undefined {
  const numbers = [spend?.spentUsd, spend?.roundEstimateUsd, spend?.capUsd];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return "inputs-missing";
  return (spend?.spentUsd as number) + (spend?.roundEstimateUsd as number) > (spend?.capUsd as number) ? "spend-cap" : undefined;
}

/**
 * The request ID of one automatic action on one workflow revision. It depends only on the task, the revision the action was decided on and the kind of action, so a repeated trigger
 * (a recovered dispatch, the reconciler running again) reaches the idempotency check with the same key, and only one of two writers on the same revision can win.
 */
export function workflowAutoActionRequestId(taskId: string, revision: number, action: "AUTO_FIX" | "AUTO_RETRY"): string {
  return workflowRequestId("autofix", taskId, revision, action);
}

/** How many automatic actions a workflow's decisions already hold, for the automatic limits. Derived from the decisions only: nothing else is stored. */
export interface WorkflowAutoFixCounts {
  /** Automatic send backs recorded since the plan's last approval. */
  sendBacksSincePlanApproval: number;
  /** Automatic send backs and retries in the whole task. */
  actions: number;
  /** Automatic retries recorded for this stage and this candidate (undefined: a stage with no candidate yet). */
  retriesFor: (stage: (typeof WORKFLOW_AUTO_STAGES)[number], candidateDigest: string | undefined) => number;
}

/** Whether a decision is an automatic re-run after a merge of the base (decision 70(c)): a retry with exactly that reason. It has its own daily allowance and does not use the task's lifetime automatic actions. */
export const isBaseMergedRetry = (decision: WorkflowDecision): boolean => decision.source === "AUTO_RETRY" && decision.reason === BASE_MERGED_RETRY_REASON;

/** How many automatic re-runs after a merge of the base the decisions hold that were made in the 24 hours before `nowMs`. */
export function baseMergedRetriesToday(decisions: readonly WorkflowDecision[], nowMs: number): number {
  return decisions.filter((decision) => isBaseMergedRetry(decision) && nowMs - Date.parse(decision.at) < 24 * 3_600_000).length;
}

export function workflowAutoFixCounts(decisions: readonly WorkflowDecision[]): WorkflowAutoFixCounts {
  let lastApproval = -1;
  decisions.forEach((decision, index) => { if (decision.decision === "APPROVE" && (decision.source ?? "GATE") === "GATE") lastApproval = index; });
  const automatic = decisions.map((decision, index) => ({ decision, index })).filter(({ decision }) => decision.source === "AUTO_FIX" || decision.source === "AUTO_RETRY");
  return {
    sendBacksSincePlanApproval: automatic.filter(({ decision, index }) => decision.source === "AUTO_FIX" && index > lastApproval).length,
    // A re-run after a merge of the base has its own daily allowance: it is not one of the task's lifetime automatic actions.
    actions: automatic.filter(({ decision }) => !isBaseMergedRetry(decision)).length,
    retriesFor: (stage, candidateDigest) => automatic.filter(({ decision }) => decision.source === "AUTO_RETRY" && decision.auto?.stage === stage
      && decision.auto.candidateDigest === candidateDigest).length,
  };
}

/** Block reasons only a person can resolve: sending the work back to coding never helps, so the broker never does it on its own. */
function personOnlyBlock(blockReason: string | undefined): boolean {
  return blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE || blockReason === WORKFLOW_BLOCK_REASONS.leftoverProcesses || blockReason === WORKFLOW_BLOCK_REASONS.setupChangedFiles
    || [WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX]
      .some((prefix) => blockReason?.startsWith(prefix) === true);
}

/**
 * The broker, by itself, sends blocked checks or reviews back to coding (automatic fixing). It records a REQUEST_CHANGES decision by the AGENTX actor with source AUTO_FIX and is
 * otherwise the same move as the owner's Send back. It is a different function on purpose: it can only make this one move, from a blocked VERIFY or REVIEW, and never approves, skips,
 * rejects, publishes or acts in a plan review or a pull request. It holds the limits itself (2 per approved plan version, 6 automatic actions in all), so the policy cannot be bypassed,
 * and it refuses a stale revision. It also refuses when the whole-task spend plus one more round is over the cap or any money input is missing (`workflowAutoSpendRefusal`). The request ID is derived (`workflowAutoActionRequestId`): the same call again, on the same revision, returns the workflow as it already is.
 * Whether to call it is the policy's decision (`autoFixDecision`); the owner pressing Send back first makes this one fail with an out-of-date revision.
 */
export function returnWorkflowToImplementationAutomatically(
  currentInput: unknown,
  input: { expectedRevision: number; reason: string; spend: WorkflowAutoSpend; now: string },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const requestId = workflowAutoActionRequestId(current.taskId, input.expectedRevision, "AUTO_FIX");
  const prior = current.decisions.find((decision) => decision.requestId === requestId);
  if (prior !== undefined) {
    if (prior.source === "AUTO_FIX" && prior.workflowRevision === input.expectedRevision) return current;
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("the workflow changed since this was decided; it is out of date");
  if (current.state !== "BLOCKED" || (current.stage !== "VERIFY" && current.stage !== "REVIEW")) {
    throw new WorkflowTransitionError("only blocked checks or reviews are sent back to coding automatically");
  }
  if ((current.pullRequests?.length ?? 0) > 0) throw new WorkflowTransitionError("a pull request is already open for part of this change; a person decides what happens next");
  // A renewed test machine is fixed by approving the plan again (a retry), never by new code.
  if (personOnlyBlock(current.blockReason) || current.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX) === true) throw new WorkflowTransitionError("this block needs a person; new code does not fix it");
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  const counts = workflowAutoFixCounts(current.decisions);
  if (counts.sendBacksSincePlanApproval >= WORKFLOW_AUTO_SEND_BACK_LIMIT) throw new WorkflowTransitionError("the automatic send back limit for this plan is reached");
  if (counts.actions >= WORKFLOW_AUTO_ACTION_LIMIT) throw new WorkflowTransitionError("the automatic action limit for this task is reached");
  if (workflowAutoSpendRefusal(input.spend) !== undefined) throw new WorkflowTransitionError("the whole-task spend is unknown or over the automatic fixing cap");
  const decision = WorkflowDecisionRecordSchema.parse({
    requestId, workflowRevision: current.revision, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX",
    reason: input.reason.trim().slice(0, 500), source: "AUTO_FIX",
    auto: { stage: current.stage, ...(current.candidate === undefined ? {} : { candidateDigest: current.candidate.digest }) }, at: input.now,
  });
  const { blockReason: _blockReason, ...unblocked } = current;
  void _blockReason;
  return WorkflowSnapshotSchema.parse({
    ...unblocked, revision: current.revision + 1, stage: "IMPLEMENT", state: "READY",
    decisions: [...current.decisions, decision], updatedAt: input.now,
  });
}

/**
 * The decision that records one automatic retry of a blocked stage (AUTO_RETRY), for the broker to append in the same write that runs the retry (the existing Retry route for that
 * stage). Refuses a stale revision, a stage that is not the blocked one, and a second automatic retry of the same stage for the same candidate, and holds the 6-action limit. The same
 * call again on the same revision returns the decision already recorded (`current.decisions` holds it): the caller must not append it twice.
 */
export function workflowAutomaticRetryDecision(
  currentInput: unknown,
  input: { expectedRevision: number; stage: (typeof WORKFLOW_AUTO_STAGES)[number]; reason: string; spend: WorkflowAutoSpend; now: string },
): WorkflowDecision {
  const current = validSnapshot(currentInput);
  const requestId = workflowAutoActionRequestId(current.taskId, input.expectedRevision, "AUTO_RETRY");
  const prior = current.decisions.find((decision) => decision.requestId === requestId);
  if (prior !== undefined) {
    if (prior.source === "AUTO_RETRY" && prior.workflowRevision === input.expectedRevision && prior.auto?.stage === input.stage) return prior;
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.revision !== input.expectedRevision) throw new WorkflowTransitionError("the workflow changed since this was decided; it is out of date");
  if (current.state !== "BLOCKED" || current.stage !== input.stage) throw new WorkflowTransitionError("only the blocked stage is retried automatically");
  if (personOnlyBlock(current.blockReason)) throw new WorkflowTransitionError("this block needs a person; a retry does not fix it");
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  const counts = workflowAutoFixCounts(current.decisions);
  if (counts.retriesFor(input.stage, current.candidate?.digest) >= WORKFLOW_AUTO_RETRY_LIMIT) throw new WorkflowTransitionError("this stage was already retried automatically for this code");
  const baseMerged = input.reason === BASE_MERGED_RETRY_REASON;
  if (baseMerged ? baseMergedRetriesToday(current.decisions, Date.parse(input.now)) >= BASE_MERGED_RETRIES_PER_DAY : counts.actions >= WORKFLOW_AUTO_ACTION_LIMIT) {
    throw new WorkflowTransitionError(baseMerged ? "the automatic re-runs after a merge of the base for this task are used up for today" : "the automatic action limit for this task is reached");
  }
  if (workflowAutoSpendRefusal(input.spend) !== undefined) throw new WorkflowTransitionError("the whole-task spend is unknown or over the automatic fixing cap");
  return WorkflowDecisionRecordSchema.parse({
    requestId, workflowRevision: current.revision, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX",
    reason: input.reason.trim().slice(0, 500), source: "AUTO_RETRY",
    auto: { stage: input.stage, ...(current.candidate === undefined ? {} : { candidateDigest: current.candidate.digest }) }, at: input.now,
  });
}

/**
 * The code each repository's pull request holds, by repository, for judging whether an approved fix changed anything:
 * GitHub's tree for its head as recorded, whatever the pull request's state; else, for a pull request recorded without one,
 * the tree of the reviewed code it was opened or last updated with when that is the current candidate (or a collected
 * feedback bundle's). A repository with no pull request keeps the current candidate's tree. Undefined when the task has no
 * open pull request, or an open one's code is not known.
 */
export function workflowPullRequestTrees(workflow: WorkflowSnapshot): Map<string, string> | undefined {
  const pullRequests = workflow.pullRequests ?? [];
  if (!pullRequests.some((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN")) return undefined;
  const trees = new Map((workflow.candidate?.repositories ?? []).map((repository) => [repository.repositoryId, repository.treeSha] as const));
  for (const pullRequest of pullRequests) {
    const tree = pullRequest.headTreeSha
      ?? (workflow.candidate?.digest === pullRequest.candidateDigest ? workflow.candidate.repositories.find((repository) => repository.repositoryId === pullRequest.repositoryId)?.treeSha : undefined)
      ?? workflow.feedbackReview?.bundleRefs.find((bundle) => bundle.repositoryId === pullRequest.repositoryId && bundle.number === pullRequest.number
        && bundle.candidateDigest === pullRequest.candidateDigest)?.headTreeSha;
    if (tree !== undefined) trees.set(pullRequest.repositoryId, tree);
    else if (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN") return undefined;
  }
  return trees;
}

/** The note recorded with the owner's "Keep the pull request as it is" (a dismissal of the approved fix that changed nothing). */
export const WORKFLOW_KEEP_PULL_REQUESTS_NOTE = "The owner kept the pull request as it is.";

/** The task waiting for the merge again, its pull requests as they are; throws when that is not where it can go back to. */
function keptPullRequests(current: WorkflowSnapshot, input: { requestId: string; actorId: string; now: string }): WorkflowSnapshot {
  const review = current.feedbackReview;
  if (current.stage !== "IMPLEMENT" || current.state !== "BLOCKED" || current.blockReason !== WORKFLOW_BLOCK_REASONS.fixChangedNothing
    || review === undefined || review.status !== "APPROVED" || review.reviewRef === undefined || current.candidate === undefined
    || !(current.pullRequests ?? []).some((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN")) {
    throw new WorkflowTransitionError("the pull request can be kept as it is only after an approved fix changed nothing");
  }
  if (current.feedbackDecisions?.some((decision) => decision.requestId === input.requestId) || current.decisions.some((decision) => decision.requestId === input.requestId)) {
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  const decision = WorkflowFeedbackDecisionSchema.parse({
    schemaVersion: 1, requestId: input.requestId, workflowRevision: current.revision, decision: "DISMISS", actorId: input.actorId, actorRole: "TASK_OWNER",
    reviewDigest: review.reviewRef.sha256, proposalDigest: review.reviewRef.proposalDigest, bundleDigests: review.bundleRefs.map((bundle) => bundle.sha256),
    selectedFindingIds: [], selectedCommentIds: [], candidates: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE, at: input.now,
  });
  const { blockReason: _blockReason, feedbackDispatchApproval: _approval, ...rest } = current;
  void _blockReason;
  void _approval;
  // The feedback the fix was for stays recorded as dismissed, so the same comments are not reviewed again.
  return WorkflowSnapshotSchema.parse({
    ...rest, revision: current.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING",
    feedbackReview: { ...review, status: "DISMISSED" }, feedbackDecisions: [...(current.feedbackDecisions ?? []), decision].slice(-100), updatedAt: input.now,
  });
}

/**
 * Whether Slack offers "Keep the pull request as it is": an approved fix changed nothing, and the code, checks and reviews
 * the pull requests hold are still the task's, so it can simply wait for the merge again.
 */
export function workflowKeepPullRequestsOffered(workflow: WorkflowSnapshot): boolean {
  try {
    keptPullRequests(workflow, { requestId: "00000000-0000-4000-8000-000000000000", actorId: workflow.ownerId, now: workflow.updatedAt });
    return true;
  } catch {
    return false;
  }
}

/** The owner keeps the pull requests as they are after an approved fix changed nothing: the task waits for the merge again. */
export function keepWorkflowPullRequests(
  currentInput: unknown,
  input: { requestId: string; actorId: string; now: string },
  authority?: WorkflowOwnerAuthority,
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (!workflowOwnerAuthorized(current.ownerId, input.actorId, authority)) {
    throw new WorkflowTransitionError("only the task owner can keep the pull request as it is");
  }
  try {
    return keptPullRequests(current, input);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw error;
    throw new WorkflowTransitionError("the pull request can no longer be kept as it is");
  }
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

/** How many of the owner's plan-review instructions a coding run is given (the newest). */
export const OWNER_PLAN_INSTRUCTIONS_MAX = 5;
/** The longest one of them, in characters. */
export const OWNER_PLAN_INSTRUCTION_MAX_CHARS = 500;

/**
 * The owner's own instructions from plan review: the reasons of their Request changes decisions at the plan gate, the newest few, each cut to 500 characters. Only those: not the
 * owner's page comments, thread replies, check or review output, Rovara's own decisions (actor AGENTX) or a decision made another way than the gate (a send-back, a feedback decision).
 * The coding prompt repeats them as the owner's words, and the worker keeps them through conversation compaction (the `workflowApprovedPlan` field), so what counts as one is decided here, once.
 */
export function ownerPlanInstructions(workflow: Pick<WorkflowSnapshot, "decisions">): string[] {
  return workflow.decisions
    .filter((decision) => decision.decision === "REQUEST_CHANGES" && decision.actorRole !== "AGENTX" && (decision.source === undefined || decision.source === "GATE"))
    .slice(-OWNER_PLAN_INSTRUCTIONS_MAX).map((decision) => decision.reason.slice(0, OWNER_PLAN_INSTRUCTION_MAX_CHARS));
}

/**
 * The problems a send-back asks the coder to fix, about the current code only: each review finding the change
 * introduced, as "text (file:line)", each selected check that failed, as "<label> failed", and each test a review-only
 * rerun found regressed, as "<test> passed before this change and fails now". Pre-existing findings, and reviews or
 * checks of older code, are left out.
 */
export function sendBackProblems(workflow: WorkflowSnapshot, describeApplicationCode?: (code: string) => string | undefined): WorkflowSendBackProblem[] {
  const regressed = (workflow.regressedChecks ?? []).map((test) => ({ source: "check" as const, text: `${test} passed before this change and fails now`, regressed: true as const }));
  const current = workflow.candidate?.digest;
  if (current === undefined) return regressed;
  const findings = (workflow.reviews ?? []).filter((review) => review.candidateDigest === current).flatMap((review) => blockingFindings(review, workflow.acceptedFindings)
    .map((finding) => workflowFindingProblem(review.role, finding)));
  // SR-1: the second review's blocking findings the owner has not accepted, as code review problems marked as the second review's.
  const secondFindings = openSecondReviewFindings(workflow).map((finding) => { const problem = workflowFindingProblem("CRITIC", finding); return { ...problem, text: `second review: ${problem.text}` }; });
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  const failed = workflow.verification?.candidateDigest !== current ? [] : workflow.verification.results.filter((result) => result.status === "FAILED" && !workflowCheckResultBroken(result))
    .map((result) => ({ source: "check" as const, text: `${checks.find((check) => check.id === result.checkId)?.label ?? result.checkId} failed` }));
  const failure = workflow.e2e?.failedRound;
  const failedE2E = workflow.e2e?.required === true && failure?.status === "FAILED" && failure.candidateDigest === current
    && failure.roundId === workflow.e2e.currentRoundId && failure.groupRunIds.length > 0
    && failure.groupRunIds.length === workflow.e2e.currentGroupRunIds.length
    && failure.groupRunIds.every((runId, index) => runId === workflow.e2e?.currentGroupRunIds[index])
    ? [{ source: "check" as const, text: `required E2E verification failed for the current round (${failure.groupRunIds.join(", ")})` }]
    : [];
  // A browser and API round that could not be started from this candidate: the coder is told why, in the words the owner saw.
  const refusedRound = workflow.stage === "VERIFY" && workflow.state === "BLOCKED" && workflow.e2e?.required === true && workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX) === true
    ? [{ source: "check" as const, text: `the browser and API checks could not be started: ${workflow.blockReason.slice(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX.length).replace(/ Send the task back to coding, or close it\.$/, "")}` }]
    : [];
  // A browser and API round with groups that ended with a code the candidate causes: the coder is told those fixed codes and their fixed sentences (never the infrastructure codes of other
  // groups, a log or what the app printed).
  const evidenceCodes = workflow.stage === "VERIFY" && workflow.state === "BLOCKED" && workflow.e2e?.required === true ? evidenceCandidateCodes(workflow.blockReason) : [];
  const appFailures = evidenceCodes.map((code) => {
    const sentence = describeApplicationCode?.(code);
    return { source: "check" as const, text: `the browser and API checks could not run on this change (${code})${sentence === undefined ? "" : `: ${sentence}`}` };
  });
  return [...findings, ...secondFindings, ...failed, ...failedE2E, ...refusedRound, ...appFailures, ...regressed];
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
  // SR-1: the second review's findings (an `on` second review that blocked) are the owner's to resolve the same way; accepting the first review's findings does not touch them.
  for (const finding of openSecondReviewFindings(workflow)) {
    const findingId = workflowFindingFingerprint("CRITIC", finding);
    if (!open.has(findingId)) {
      open.set(findingId, { findingId, role: "CRITIC", text: `second review: ${finding.text}`, ...(finding.file === undefined ? {} : { file: finding.file }), ...(finding.line === undefined ? {} : { line: finding.line }) });
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
  authority?: WorkflowOwnerAuthority,
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  if (!workflowOwnerAuthorized(current.ownerId, actor.actorId, authority)) {
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
    return returnWorkflowToImplementation(withAccepted, { requestId: input.requestId, actorId: actor.actorId, reason: summary, now: options.now, source: "FINDINGS" }, authority);
  }
  const decision = WorkflowDecisionSchema.parse({
    requestId: input.requestId, workflowRevision: current.revision, decision: "APPROVE", actorId: actor.actorId,
    actorRole: "TASK_OWNER", reason: summary, source: "FINDINGS", at: options.now,
  });
  const firstReviewsClear = workflowReviewRoles(current).every((role) => (current.reviews ?? []).some((review) =>
    review.role === role && review.candidateDigest === candidateDigest && reviewCleared(review, acceptedFindings)));
  // SR-1: a second review that blocked holds the change until each of its findings is resolved too; accepting the first review's findings alone never clears it.
  const secondOpen = openSecondReviewFindings(withAccepted).length > 0;
  const reviewsClear = firstReviewsClear && !secondOpen;
  const { blockReason: firstReason, secondReviewBlock: _secondBlock, ...unblocked } = withAccepted;
  void _secondBlock;
  const blockReason = firstReviewsClear ? SECOND_REVIEW_BLOCK_REASON : firstReason;
  // With a program, the reviews this step asked for are clear: the program goes on to its next step.
  const advanced = reviewsClear && current.program !== undefined ? advanceStage(current, "PULL_REQUEST") : undefined;
  return WorkflowSnapshotSchema.parse({
    ...(reviewsClear ? unblocked : { ...withAccepted, blockReason }), revision: current.revision + 1,
    ...(!reviewsClear ? { blockReason } : advanced === undefined ? { stage: "PULL_REQUEST", state: "READY" } : programArrival(withAccepted, advanced)),
    decisions: [...current.decisions, decision], updatedAt: options.now,
  });
}

/**
 * The owner's answers that differ from AgentX's recommendation, in the plan's decision order. Without answers there are
 * none (Slack and MCP use the recommended answers). With answers, every decision of the plan is answered exactly once
 * with one of its options; a document whose decisions are not known (Markdown) takes no answers.
 */
function ownerAnswerOverrides(
  answers: ReadonlyArray<{ decisionId: string; optionId: string }> | undefined,
  decisions: ReadonlyArray<{ id: string; optionIds: readonly string[]; recommended: string }> | undefined,
): Array<{ decisionId: string; optionId: string }> {
  if (answers === undefined) return [];
  if (decisions === undefined) {
    if (answers.length > 0) throw new WorkflowTransitionError("this document has no decisions to answer");
    return [];
  }
  const chosen = new Map(answers.map((answer) => [answer.decisionId, answer.optionId]));
  if (chosen.size !== answers.length) throw new WorkflowTransitionError("each decision can be answered only once");
  if (answers.some((answer) => !decisions.some((decision) => decision.id === answer.decisionId))) {
    throw new WorkflowTransitionError("an answer names a decision this plan does not have");
  }
  return decisions.flatMap((decision) => {
    const optionId = chosen.get(decision.id);
    if (optionId === undefined) throw new WorkflowTransitionError("answer every decision");
    if (!decision.optionIds.includes(optionId)) throw new WorkflowTransitionError("an answer names an option this decision does not have");
    return optionId === decision.recommended ? [] : [{ decisionId: decision.id, optionId }];
  });
}

/**
 * Whether two answer lists choose the same option for the same decisions, whatever their order. Stored decisions come
 * back from DynamoDB with their maps in any order, so answers are never compared as JSON text.
 */
export function sameAnswers(
  a: ReadonlyArray<{ decisionId: string; optionId: string }>,
  b: ReadonlyArray<{ decisionId: string; optionId: string }>,
): boolean {
  const left = new Map(a.map((answer) => [answer.decisionId, answer.optionId]));
  const right = new Map(b.map((answer) => [answer.decisionId, answer.optionId]));
  if (left.size !== a.length || right.size !== b.length || left.size !== right.size) return false;
  for (const [decisionId, optionId] of left) {
    if (right.get(decisionId) !== optionId) return false;
  }
  return true;
}

export function decideWorkflow(
  currentInput: unknown,
  requestInput: unknown,
  actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" },
  options: {
    now: string;
    allowedSkipStages: readonly WorkflowStage[];
    /** The decided plan's decisions; required when the request carries answers. Absent for a Markdown document. */
    decisions?: ReadonlyArray<{ id: string; optionIds: readonly string[]; recommended: string }>;
    via?: "PAGE";
    authority?: WorkflowOwnerAuthority;
    /** Digest of the graph loaded from the current coding-plan artifact, when present. */
    workBreakdownDigest?: string;
    /** The current plan's `noChangeNeeded`, as the broker read it from the checked document (with the plan's title as the restatement); needed to close the plan as answered. */
    noChangeNeeded?: NoChangeNeeded & { restatement: string };
  },
): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const request = WorkflowDecisionRequestSchema.safeParse(requestInput);
  const actorId = ActorIdSchema.safeParse(actor.actorId);
  if (!request.success || !actorId.success) throw new WorkflowTransitionError("workflow decision is invalid");
  if (options.authority !== undefined
    ? actor.role !== "TASK_OWNER" || !workflowOwnerAuthorized(current.ownerId, actor.actorId, options.authority)
    : actor.role === "TASK_OWNER" && !workflowOwnerAuthorized(current.ownerId, actor.actorId)) {
    throw new WorkflowTransitionError("only the task owner may decide this workflow stage");
  }
  const commentsIncluded = request.data.includedCommentIds?.length ?? 0;

  const prior = current.decisions.find((decision) => decision.requestId === request.data.requestId);
  if (prior !== undefined) {
    const answerOverrides = ownerAnswerOverrides(request.data.answers, options.decisions);
    const selectedOptionalCheckIds = request.data.selectedOptionalCheckIds ?? current.checkPolicy?.selectedOptionalIds ?? [];
    // Stored decisions come back from DynamoDB with their maps in any order: answers are compared by content.
    const duplicate = prior.workflowRevision === request.data.expectedRevision
      && prior.decision === request.data.decision
      && prior.actorId === actor.actorId
      && prior.reason === request.data.reason
      && prior.artifactDigest === request.data.artifactDigest
      && prior.workBreakdownDigest === request.data.workBreakdownDigest
      && JSON.stringify(prior.selectedOptionalCheckIds ?? []) === JSON.stringify(selectedOptionalCheckIds)
      && sameAnswers(prior.answerOverrides ?? [], answerOverrides)
      && (prior.commentsIncluded ?? 0) === commentsIncluded
      && prior.via === options.via
      && (prior.closedAs === "ANSWERED") === (request.data.closeAsAnswered === true);
    if (duplicate) return current;
    throw new WorkflowTransitionError("request ID was already used for a different workflow decision");
  }
  if (current.revision !== request.data.expectedRevision) throw new WorkflowTransitionError("workflow revision is stale");
  if (current.stage !== "PLAN_REVIEW" || current.state !== "WAITING") {
    throw new WorkflowTransitionError("workflow is not waiting for a plan decision");
  }
  // The answers are checked once the decision is known to be current, so a stale one hears that it is stale.
  const answerOverrides = ownerAnswerOverrides(request.data.answers, options.decisions);
  const selectedOptionalCheckIds = request.data.selectedOptionalCheckIds ?? current.checkPolicy?.selectedOptionalIds ?? [];
  if (current.checkPolicy !== undefined && selectedOptionalCheckIds.some((id) => !current.checkPolicy?.optional.some((check) => check.id === id))) {
    throw new WorkflowTransitionError("decision selected an optional check not approved by project policy");
  }
  const currentPlan = current.artifacts.filter((artifact) => artifact.type === (current.path === "QUICK" || current.reviewPhase === "IMPLEMENTATION_PLAN" ? "plan" : current.reviewPhase === "REQUIREMENTS" ? "requirements" : "design")).at(-1);
  if (currentPlan === undefined || request.data.artifactDigest !== currentPlan.sha256) {
    throw new WorkflowTransitionError("decision must name the current plan digest");
  }
  if (request.data.decision === "APPROVE" && options.workBreakdownDigest !== request.data.workBreakdownDigest) {
    throw new WorkflowTransitionError(options.workBreakdownDigest === undefined
      ? "decision cannot bind a work breakdown that is not in the current plan"
      : "decision must name the current work breakdown digest");
  }
  if (request.data.workBreakdownDigest !== undefined && options.workBreakdownDigest !== request.data.workBreakdownDigest) {
    throw new WorkflowTransitionError("decision must name the current work breakdown digest");
  }
  if (request.data.workBreakdownDigest !== undefined && (request.data.decision !== "APPROVE" || currentPlan.type !== "plan")) {
    throw new WorkflowTransitionError("a work breakdown can be bound only by approving a coding plan");
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
    ...(request.data.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: request.data.workBreakdownDigest }),
    ...(current.checkPolicy === undefined ? {} : { selectedOptionalCheckIds }),
    ...(answerOverrides.length === 0 ? {} : { answerOverrides }),
    ...(commentsIncluded === 0 ? {} : { commentsIncluded }),
    ...(options.via === undefined ? {} : { via: options.via }),
    ...(request.data.closeAsAnswered === true ? { closedAs: "ANSWERED" as const } : {}),
    at: options.now,
  });
  if (current.decisions.length >= 100) throw new WorkflowTransitionError("workflow decision history is full");
  // "Close as answered": the plan said no change is needed, and the owner agrees. The task ends ANSWERED, keeping the plan's answer.
  if (request.data.closeAsAnswered === true) {
    if (current.definitionVersion !== "1.1.0" || options.noChangeNeeded === undefined) throw new WorkflowTransitionError("this plan does not say that no change is needed");
    return answeredSnapshot(current, cleanedAnswer(options.noChangeNeeded), { id: `${currentPlan.id}-answer`.slice(0, 128), objectKey: currentPlan.objectKey, createdAt: options.now }, options.now, decision);
  }

  const nextFullPhase = current.path === "FULL" && request.data.decision === "APPROVE"
    ? current.reviewPhase === "REQUIREMENTS" ? "DESIGN" as const
      : current.reviewPhase === "DESIGN" ? "IMPLEMENTATION_PLAN" as const : undefined
    : undefined;
  // Approving the last document (or skipping it, which goes on the same way) goes on to coding: the engine's IMPLEMENT, or the first step of the program.
  const advance = request.data.decision === "REJECT" || request.data.decision === "REQUEST_CHANGES" || nextFullPhase !== undefined ? undefined : advanceStage(current, "IMPLEMENT");
  const nextStage: WorkflowStage = request.data.decision === "REJECT" ? "CLOSED"
    : request.data.decision === "REQUEST_CHANGES" ? "PLAN"
      : advance?.stage ?? "PLAN";
  const outcome = request.data.decision === "APPROVE" && nextFullPhase === undefined ? "PASSED"
    : request.data.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED"
      : request.data.decision === "REJECT" ? "REJECTED"
        : request.data.decision === "SKIP" ? "SKIPPED" : undefined;
  // Changes the person asks for make a new plan, which is checked afresh: the critique of the plan they sent back is dropped (the approved plan's stays for the record).
  const { critique: _sentBackCritique, ...withoutCritique } = current;
  void _sentBackCritique;
  // The same for a design review: the design the person sent back is reviewed afresh (bounded, and never past a cost stop), what the review cost so far stays counted, and its paid rounds are archived.
  const rearmed = request.data.decision === "REQUEST_CHANGES" && current.reviewPhase === "DESIGN" && current.designReview !== undefined ? { designReview: rearmedDesignReview(current.designReview, { at: options.now, by: { actorId: actor.actorId } }) } : {};
  return WorkflowSnapshotSchema.parse({
    ...(request.data.decision === "REQUEST_CHANGES" ? withoutCritique : current),
    ...rearmed,
    revision: current.revision + 1,
    stage: nextStage,
    state: request.data.decision === "REJECT" ? "COMPLETE" : "READY",
    ...(nextFullPhase === undefined ? {} : { reviewPhase: nextFullPhase }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(advance?.programStepId === undefined ? {} : { programStepId: advance.programStepId }),
    updatedAt: options.now,
    decisions: [...current.decisions, decision],
    ...(request.data.decision === "APPROVE" && request.data.workBreakdownDigest !== undefined ? {
      workflowDependenciesApproval: {
        artifactDigest: currentPlan.sha256,
        graphDigest: request.data.workBreakdownDigest,
        workflowRevision: current.revision,
        actorId: actor.actorId,
        runId: workflowRequestId("workflow-dependencies-run", current.taskId, current.revision, request.data.requestId, request.data.workBreakdownDigest),
      },
      workflowDependenciesProgress: [],
    } : {}),
    ...(current.checkPolicy === undefined ? {} : { checkPolicy: { ...current.checkPolicy, selectedOptionalIds: selectedOptionalCheckIds } }),
  });
}

export { workflowCheckCommandText } from "./workflow-check-input.js";

export { BASE_MERGED_RETRIES_PER_DAY, BASE_MERGED_RETRY_REASON, BASE_MERGED_RECHECKING_MILESTONE, BASE_MERGED_NEEDS_YOU_MILESTONE, WORKFLOW_NOT_RUN_PREFIX, isStepNotRunReason, openSecondReviewFindings, secondReviewBlockFinding, WORKFLOW_SECOND_REVIEW_LINE_MAX, WorkflowSecondReviewBlockSchema, type WorkflowSecondReviewBlock, ActorIdSchema, WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_REGRESSED_CHECKS_MAX, WORKFLOW_REGRESSED_CHECK_MAX, CandidateRepositorySchema, CandidateManifestSchema, VerificationResultsSchema, WorkflowVerificationRetrySchema, WorkflowReviewFindingSchema, type WorkflowReviewFinding, WORKFLOW_REVIEW_FAILURE_REASONS, WORKFLOW_REVIEW_MODEL_FAILURE_PATTERN, WorkflowReviewReportSchema, type WorkflowReviewReport, findingBlocks, workflowFindingFingerprint, WorkflowAcceptedFindingSchema, WORKFLOW_ACCEPTED_FINDINGS_MAX, type AcceptedFindingRef, findingAccepted, blockingFindings, reviewCleared, WorkflowPullRequestSchema, FeedbackIdSchema, FeedbackObjectKeySchema, FeedbackCommentRefSchema, WorkflowFeedbackBundleMetadataSchema, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackPrioritySchema, WorkflowFeedbackAssessmentSchema, WorkflowFeedbackFindingRefSchema, WorkflowFeedbackCandidateBindingSchema, WorkflowFeedbackReviewMetadataSchema, WorkflowFeedbackReviewRefSchema, WorkflowFeedbackNoteSchema, WorkflowFeedbackDecisionSchema, WorkflowFeedbackApprovalBindingSchema, ReviewedWorkflowFeedbackSchema, WorkflowFeedbackThreadObservationSchema, FeedbackThreadObservationsSchema, WorkflowFeedbackReviewSchema, WorkflowFeedbackShownSchema, FEEDBACK_SHOWN_MAX_ROUNDS, FEEDBACK_SHOWN_MAX_IDS, WorkflowStageSchema, WorkflowStateSchema, WorkflowProgramStepSchema, WorkflowProgramSchema, WorkflowObjectKeySchema, WorkflowArtifactSchema, WORKFLOW_DECISION_ANSWERS_MAX, WORKFLOW_DECISION_COMMENTS_MAX, PlanDecisionIdSchema, PlanOptionIdSchema, WorkflowAnswerSchema, WorkflowDecisionSchema, WorkflowDecisionRecordSchema, WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_AUTO_STAGES, WORKFLOW_AUTO_SEND_BACK_LIMIT, WORKFLOW_AUTO_RETRY_LIMIT, WORKFLOW_AUTO_ACTION_LIMIT, WorkflowAutoActionSchema, WorkflowCheckSchema, type WorkflowCheck, WORKFLOW_PROPOSED_CHECKS_MAX, WorkflowCheckProposalSchema, WorkflowCheckPolicySchema, type WorkflowCheckPolicy, workflowSelectedChecks, workflowIsReviewOnly, WorkflowPathSchema, WorkflowReviewPhaseSchema, WorkflowCanvasLineageSchema, WorkflowCanvasCloseoutSchema, WorkflowCanvasCloseoutAttemptSchema, WorkflowReviewBaseSchema, PROGRAM_ROUNDS_MAX, WORKFLOW_PULL_REQUEST_UPDATE_CAUSES, WORKFLOW_FIX_DROPS_BASE_CHANGES, WorkflowPullRequestUpdateFailureSchema, WorkflowSnapshotShapeSchema, WorkflowSnapshotViewSchema } from "./task-workflow.js";
