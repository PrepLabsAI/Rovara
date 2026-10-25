import { createHash } from "node:crypto";
import { E2EWorkflowProgressSchema, E2EQualifiedRoundSchema, E2E_PROJECT_CHECK_ID } from "./e2e.js";
import { z } from "zod";
import { ProjectCommandSchema } from "./project.js";
import { WORKFLOW_PROPOSED_CHECK_DEFAULT_TIMEOUT_SECONDS, WorkflowProposedCheckInputSchema, feedbackReplacementCheckProblem } from "./workflow-check-input.js";
import { WorkItemProgressV1Schema, WorkflowDependencyApprovalSchema } from "./workflow-dependencies.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ActorIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface WorkflowOwnerAuthority { actorId: string; ownerIds: readonly string[] }

function workflowOwnerAuthorized(legacyOwnerId: string, actorId: string, authority?: WorkflowOwnerAuthority): boolean {
  if (!ActorIdSchema.safeParse(actorId).success) return false;
  if (authority === undefined) return actorId === legacyOwnerId;
  return authority.actorId === actorId
    && authority.ownerIds.length > 0
    && authority.ownerIds.every((ownerId) => ActorIdSchema.safeParse(ownerId).success)
    && new Set(authority.ownerIds).size === authority.ownerIds.length
    && authority.ownerIds.includes(actorId);
}

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
export const WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX = "The approved browser and API checks can no longer run as approved. Retry the checks to approve the plan again against what is ready now. What changed: ";
/**
 * A test account the plan was approved with has a newer registered definition (the setup was approved again, or the definition expired and was written again). The way on is
 * the same re-approval as for a requalified runtime: one retry approves the plan again against the accounts that are registered now.
 */
export const WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX = "The test accounts changed; approve the checks again. What changed: ";

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
  pullRequestChanged: "The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.",
  /** A required pull request was closed on GitHub without merging; reopened, it is followed again. */
  pullRequestClosed: "The pull request was closed on GitHub without merging. Reopen it there, or close this task.",
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
    && [WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX]
      .some((prefix) => workflow.blockReason?.startsWith(prefix) === true);
}

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

/** At most this many decisions in a plan (PLAN_DECISIONS_MAX), and so answers in one decision. */
const WORKFLOW_DECISION_ANSWERS_MAX = 20;
/** At most this many page comments in one decision (DECISION_COMMENTS_MAX). */
const WORKFLOW_DECISION_COMMENTS_MAX = 25;
const PlanDecisionIdSchema = z.string().regex(/^d[1-9][0-9]?$/);
const PlanOptionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const WorkflowAnswerSchema = z.object({ decisionId: PlanDecisionIdSchema, optionId: PlanOptionIdSchema }).strict();

export const WorkflowDecisionSchema = z.object({
  requestId: z.string().uuid(),
  workflowRevision: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]),
  actorId: ActorIdSchema,
  actorRole: z.enum(["TASK_OWNER", "PROJECT_ADMIN"]),
  reason: z.string().trim().min(1).max(500),
  artifactDigest: DigestSchema.optional(),
  /** The exact dependency graph covered by this whole-plan approval. */
  workBreakdownDigest: DigestSchema.optional(),
  selectedOptionalCheckIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(20).optional(),
  /** Where the decision was made: an approval gate (the default), the owner sending blocked work back to coding, or the owner resolving review findings. */
  source: z.enum(["GATE", "SEND_BACK", "FINDINGS"]).optional(),
  /** Plan decisions: the owner's answers that differ from AgentX's recommended ones, in the plan's decision order. */
  answerOverrides: z.array(WorkflowAnswerSchema).min(1).max(WORKFLOW_DECISION_ANSWERS_MAX).optional(),
  /** How many page comments the decision sent along (their IDs are in the decision's detail item). */
  commentsIncluded: z.number().int().min(0).max(WORKFLOW_DECISION_COMMENTS_MAX).optional(),
  /** Made on the task page; absent for Slack, MCP and older decisions. */
  via: z.literal("PAGE").optional(),
  at: z.string().datetime(),
}).strict();
export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;

export const WorkflowCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  command: ProjectCommandSchema,
}).strict().refine((check) => check.id !== E2E_PROJECT_CHECK_ID, "project-e2e is reserved for trusted E2E aggregation");
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
  feedbackNotes: z.array(WorkflowFeedbackNoteSchema).max(100).optional(),
  canvasLineage: z.array(WorkflowCanvasLineageSchema).max(100).optional(),
  canvasLineageVersion: z.number().int().nonnegative().optional(),
  canvasCloseout: WorkflowCanvasCloseoutSchema.optional(),
  canvasCloseoutAttempt: WorkflowCanvasCloseoutAttemptSchema.optional(),
  workflowDependenciesApproval: WorkflowDependencyApprovalSchema.optional(),
  /** Broker-authored pointer to the accepted operation for the current approved graph attempt; never exposed in task views. */
  workflowDependenciesOperationId: z.string().uuid().optional(),
  workflowDependenciesProgress: z.array(WorkItemProgressV1Schema).max(32).optional(),
}).superRefine((workflow, context) => {
  const taskMetadata = { feedbackReview: workflow.feedbackReview, feedbackDecisions: workflow.feedbackDecisions, feedbackDispatchApproval: workflow.feedbackDispatchApproval, feedbackNotes: workflow.feedbackNotes, feedbackReviewHistory: workflow.feedbackReviewHistory, feedbackThreadObservations: workflow.feedbackThreadObservations, verificationRetries: workflow.verificationRetries, canvasLineage: workflow.canvasLineage, canvasCloseout: workflow.canvasCloseout, canvasCloseoutAttempt: workflow.canvasCloseoutAttempt, workflowDependenciesApproval: workflow.workflowDependenciesApproval, workflowDependenciesOperationId: workflow.workflowDependenciesOperationId, workflowDependenciesProgress: workflow.workflowDependenciesProgress };
  if (Buffer.byteLength(JSON.stringify(taskMetadata), "utf8") > 262_144) {
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
    ...(keep ? current : reopened ? unblocked : withoutPriorOutcome),
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

/** Requires fresh bindings supplied by the reconciler; dispatch must independently reconcile again. */
export function decideWorkflowFeedbackFindings(currentInput: unknown, input: {
  requestId: string; expectedRevision: number; reviewDigest: string; proposalDigest: string;
  bundleDigests: string[]; selectedFindingIds: string[]; decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS"; ownerNote?: string;
}, actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" }, now: string, authority?: WorkflowOwnerAuthority): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const review = current.feedbackReview;
  if (actor.role !== "TASK_OWNER" || !workflowOwnerAuthorized(current.ownerId, actor.actorId, authority)) {
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
  const { workflowDependenciesApproval: _oldDependencyApproval, workflowDependenciesOperationId: _oldDependencyOperationId,
    workflowDependenciesProgress: _oldDependencyProgress, ...withoutOldDependencyApproval } = current;
  void _oldDependencyApproval;
  void _oldDependencyOperationId;
  void _oldDependencyProgress;
  const next = WorkflowSnapshotSchema.parse({
    ...withoutOldDependencyApproval,
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
export function blockWorkflow(currentInput: unknown, reason: string, now: string, detail: { regressedChecks?: readonly string[];
  failedE2ERound?: { status: "FAILED"; candidateDigest: string; roundId: string; groupRunIds: readonly string[]; admissionSha256: string; evidenceSha256: string } } = {}): WorkflowSnapshot {
  const current = validSnapshot(currentInput);
  const { regressedChecks: _prior, ...withoutRegressions } = current;
  void _prior;
  const failure = detail.failedE2ERound;
  const failedRound = failure !== undefined && current.e2e?.required === true && current.candidate?.digest === failure.candidateDigest
    && current.e2e.currentRoundId === failure.roundId && current.e2e.currentGroupRunIds.length === failure.groupRunIds.length
    && current.e2e.currentGroupRunIds.every((runId, index) => runId === failure.groupRunIds[index]) ? failure : undefined;
  const { failedRound: _priorFailedRound, ...e2eWithoutFailure } = current.e2e ?? {};
  void _priorFailedRound;
  return WorkflowSnapshotSchema.parse({
    ...withoutRegressions, revision: current.revision + 1, state: "BLOCKED", blockReason: reason.slice(0, 500), updatedAt: now,
    ...(detail.regressedChecks === undefined || detail.regressedChecks.length === 0 ? {} : { regressedChecks: detail.regressedChecks }),
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
    return current !== undefined && workflow.reviews?.some((review) => review.candidateDigest === current
      && review.findings?.some((finding) => findingBlocks(finding, review.role)
        && !findingAccepted(finding, review.role, review.candidateDigest, workflow.acceptedFindings))) === true;
  }
  if (workflow.stage === "VERIFY") {
    // Review only: a rerun of the agent's own tests regressed, and no result was recorded for it.
    if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.regressionFound) return true;
    // Blocks that only an administrator qualifying the runtime, or approving the plan again, can fix: new code cannot, even for a task with no checks.
    if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) === true || workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX) === true
      || workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) === true) return false;
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
    decisions: [...current.decisions, decision], updatedAt: input.now,
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
  return [...findings, ...failed, ...failedE2E, ...refusedRound, ...appFailures, ...regressed];
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
  const reviewsClear = (["CRITIC", "SECURITY"] as const).every((role) => (current.reviews ?? []).some((review) =>
    review.role === role && review.candidateDigest === candidateDigest && reviewCleared(review, acceptedFindings)));
  const { blockReason, ...unblocked } = withAccepted;
  return WorkflowSnapshotSchema.parse({
    ...(reviewsClear ? unblocked : withAccepted), revision: current.revision + 1,
    ...(reviewsClear ? { stage: "PULL_REQUEST", state: "READY" } : { blockReason }),
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
      && prior.via === options.via;
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
