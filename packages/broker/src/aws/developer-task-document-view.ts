// Task page document view, stage copy, and pull request description formatting (extracted from aws/developer-tasks.ts).
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  GENERAL_FAKE_MADE_NOTE,
  WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX,
  WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX,
  WORKFLOW_BLOCK_REASONS,
  WORKFLOW_PLAN_MAX_BYTES,
  agentXError,
  blockingFindings,
  canonicalJson,
  commentIdInAuthor,
  commentRefInAuthor,
  planSummaryLines,
  redactText,
  reviewCleared,
  workflowApplicationRetryOffered,
  workflowFindingAccepted,
  workflowIsReviewOnly,
  workflowKeepPullRequestsOffered,
  workflowPullRequestUpdateDue,
  workflowReviewRoles,
  workflowReviewsSawPartialDiff,
  workflowSelectedChecks,
  type E2EScenarioResults,
  type PlanClaim,
  type PlanDocument,
  type PlanFeature,
  type TaskComment,
  type TaskSuggestion,
  type WorkflowReviewFinding,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { PULL_REQUEST_PARTIAL_REVIEW_LINE, PULL_REQUEST_STATUS_END, PULL_REQUEST_STATUS_START } from "../developer/pull-request-feedback-section.js";
import {
  TASK_OWNER_LABEL,
  isE2EPlanCorrectionBlockReason,
  taskOwnerKey,
  type DeveloperTaskRecord,
} from "../developer/task-records.js";
import { planEvidencePointerKey, type PlanEvidencePointer } from "../developer/plan-evidence-jobs.js";
import { loadPlanEvidence, loadWorkflowDocument, type LoadedDocument } from "../developer/plan-artifacts.js";
import { documentSummaryLines, isFeedbackReviewFailure, workflowDocumentName } from "../developer/workflow-messages.js";
import { loadPlanSelfCheck } from "../developer/plan-self-check.js";
import { can, pageAccess, type TaskAccess } from "../developer/task-access.js";
import { getTaskPeoplePresentation } from "../developer/task-people.js";
import { isRuntimeRenewedBlock } from "../e2e/requalify-hold.js";
import { AutoFixAskSchema, autoFixCardLines } from "../developer/autofix-messages.js";
import { listSuggestions, listTaskComments, suggestionsFor } from "../developer/page-comments.js";
import type { TaskDocumentKind, TaskDocumentView } from "./task-web.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";

export const TASK_PAGE_DOCUMENTS: ReadonlyArray<{ type: "requirements" | "design" | "plan"; kind: TaskDocumentKind; label: string; anchor: string }> = [
  { type: "requirements", kind: "requirements", label: "Requirements", anchor: "requirements" },
  { type: "design", kind: "design", label: "Design", anchor: "design" },
  { type: "plan", kind: "coding plan", label: "Coding plan", anchor: "coding-plan" },
];

const HISTORY_REASON_MAX_CHARS = 200;
const WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES = 30_000;
const WORKFLOW_PLAN_SUMMARY_LINE_MAX = 500;
/** At most this many accepted findings are listed in the pull request description. */
const WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED = 20;
const PEOPLE_EVENT_ROLES = new Set(["owner", "commenter", "viewer", "denied"]);
const IN_SLACK = "in the task's Slack thread";

export interface TaskDocumentViewHelpers {
  log(deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>): void;
  get<T>(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<T | undefined>;
  ownerLabel(developerName: string): string;
  coherentPageAccess(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{
    access: TaskAccess;
    capabilities: { peopleRevision?: number; canManagePeople: boolean; canTakeOwnership: boolean };
  }>;
  legacyQuoteCommentRefs(
    deps: DeveloperTaskRouteDependencies,
    task: DeveloperTaskRecord,
    workflow: WorkflowSnapshot,
    artifact: WorkflowSnapshot["artifacts"][number],
    plan: PlanDocument,
  ): Promise<Record<string, string> | undefined>;
  applicationResultOperations(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<readonly unknown[]>;
  publicationAttempts(deps: Pick<DeveloperTaskRouteDependencies, "actions">, task: DeveloperTaskRecord): Promise<"failed" | "retrying" | undefined>;
  commentAnswersAvailable(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<boolean>;
  pageDecidingView(
    deps: DeveloperTaskRouteDependencies,
    input: {
      task: DeveloperTaskRecord;
      caller: DeveloperCaller;
      comments: readonly TaskComment[];
      suggestions: readonly TaskSuggestion[];
      citations: ReadonlyMap<string, ReadonlyMap<string, string>>;
      claimIds: ReadonlyMap<string, ReadonlySet<string>>;
    },
  ): Promise<Pick<TaskDocumentView, "pageComments" | "pageSuggestions" | "waiting" | "commentSeq" | "optionalChecks">>;
  pagePlanFeature(deps: DeveloperTaskRouteDependencies, access: TaskAccess): Promise<PlanFeature | undefined>;
}

function planReviewWaitingStage(workflow: WorkflowSnapshot, owner: boolean): { status: string; nextStep: string } {
  if (isE2EPlanCorrectionBlockReason(workflow.blockReason)) {
    return owner
      ? { status: "The E2E plan needs correction", nextStep: `Request changes to submit a corrected E2E plan, or close the task ${IN_SLACK}.` }
      : { status: "The E2E plan needs correction", nextStep: `The task owner must request changes and submit a corrected E2E plan, or close the task ${IN_SLACK}.` };
  }
  return owner
    ? { status: "Waiting for your approval", nextStep: `Approve or request changes ${IN_SLACK}.` }
    : { status: "Waiting for the owner's approval", nextStep: `The task owner approves or requests changes ${IN_SLACK}.` };
}

function implementBlockedStage(workflow: WorkflowSnapshot): { status: string; nextStep: string } {
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.fixChangedNothing) {
    return {
      status: "The approved fix didn't change any code",
      nextStep: workflowKeepPullRequestsOffered(workflow)
        ? `Retry coding, keep the pull request as it is, or close the task ${IN_SLACK}.`
        : `Retry coding or close the task ${IN_SLACK}.`,
    };
  }
  return {
    status: workflow.blockReason === WORKFLOW_BLOCK_REASONS.noCodeChanged ? "Coding finished, but no code changed" : "Coding stopped before it finished",
    nextStep: `Retry coding or close the task ${IN_SLACK}.`,
  };
}

function verifyBlockedStage(workflow: WorkflowSnapshot): { status: string; nextStep: string } {
  // A block of a browser and API round names its own way on: new code does not fix a runtime that needs qualifying or a selection that needs approving again.
  if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX) === true) {
    return { status: "The browser and API checks can't run on the runtime as it is now", nextStep: `An administrator must qualify the runtime again; then retry the checks, or close the task ${IN_SLACK}.` };
  }
  if (isRuntimeRenewedBlock(workflow.blockReason)) {
    return { status: "The test machine was renewed; the approved browser and API checks need approving again", nextStep: `Retry the checks to approve the plan again against the renewed machine, or close the task ${IN_SLACK}.` };
  }
  if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX) === true) {
    return { status: "The approved browser and API checks no longer match the test accounts", nextStep: `The test accounts changed; approve the checks again by retrying them, or close the task ${IN_SLACK}.` };
  }
  if (workflow.blockReason?.startsWith(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX) === true) {
    return { status: "The approved browser and API checks no longer match the runtime", nextStep: `Retry the checks to approve the plan again against what is ready now, or close the task ${IN_SLACK}.` };
  }
  return { status: "The checks didn't pass or couldn't run", nextStep: `Send it back to coding, retry the checks, or close the task ${IN_SLACK}.` };
}

function pullRequestReadyStage(publication: "failed" | "retrying" | undefined): { status: string; nextStep: string } {
  // The last try to open it failed: said until the next try's result, so the page never says "opening" over a failure.
  if (publication === "failed") return { status: "The draft pull request didn't open", nextStep: `Retry opening the pull request or close the task ${IN_SLACK}.` };
  if (publication === "retrying") return { status: "Trying again to open the draft pull request; the last try didn't open it", nextStep: "Review and merge it on GitHub once it's open." };
  return { status: "Opening a draft pull request", nextStep: "Review and merge it on GitHub once it's open." };
}

function waitForMergeBlockedStage(workflow: WorkflowSnapshot): { status: string; nextStep: string } {
  // Only a changed pull request stops the following; after a failed feedback review or push, the merge is still tracked.
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestChanged) return { status: "Stopped following the pull request", nextStep: `Close the task ${IN_SLACK}.` };
  // The pull request changed on GitHub while the fix was pushed: its merge is no longer followed.
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed && workflow.pullRequestUpdateFailure?.cause === "HEAD_MOVED") {
    return { status: "Stopped following the pull request", nextStep: `Merge or close it on GitHub, then close the task ${IN_SLACK}.` };
  }
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed) return { status: "Couldn't push the fix", nextStep: `Merge or update it on GitHub, or close the task ${IN_SLACK}.` };
  return {
    status: isFeedbackReviewFailure(workflow.blockReason) ? "Couldn't review the pull request feedback" : "Something went wrong; still watching the pull request",
    nextStep: "Merge it on GitHub and the task finishes, or close the task in Slack.",
  };
}

function taskPageStageForKey(
  key: string,
  workflow: WorkflowSnapshot,
  name: string,
  owner: boolean,
  publication: "failed" | "retrying" | undefined,
): { status: string; nextStep: string } {
  switch (key) {
    case "PLAN/READY": case "PLAN/RUNNING": return { status: `Writing the ${name}`, nextStep: `It will be posted ${IN_SLACK} for approval; no code changes until it's approved.` };
    case "PLAN/BLOCKED": return { status: `Stopped while writing the ${name}`, nextStep: `Retry planning or close the task ${IN_SLACK}.` };
    // A teammate reading the page is not the one who approves.
    case "PLAN_REVIEW/WAITING": return planReviewWaitingStage(workflow, owner);
    case "PLAN_REVIEW/BLOCKED": return { status: `Stopped before approval of the ${name}`, nextStep: `Close the task ${IN_SLACK} and start again.` };
    case "IMPLEMENT/READY": case "IMPLEMENT/RUNNING": return { status: "Writing the code", nextStep: "The checks and reviews run when coding finishes." };
    case "IMPLEMENT/BLOCKED": return implementBlockedStage(workflow);
    case "VERIFY/WAITING": return workflow.e2e?.required === true && workflow.e2e.currentRoundId === undefined
      ? { status: "Preparing the checks", nextStep: "The checks start when workspace compute is ready." }
      : { status: "Preparing the checks", nextStep: "The approved checks start shortly." };
    case "VERIFY/READY": case "VERIFY/RUNNING": return { status: "Running the checks", nextStep: "The code and security reviews start when the checks pass." };
    case "VERIFY/BLOCKED": return verifyBlockedStage(workflow);
    case "REVIEW/READY": case "REVIEW/WAITING": case "REVIEW/RUNNING": return { status: "Code and security reviews are running", nextStep: "A draft pull request opens when both pass." };
    case "REVIEW/BLOCKED": return { status: "The reviews found problems or couldn't finish", nextStep: `Send it back to coding, retry the reviews, or close the task ${IN_SLACK}.` };
    case "PULL_REQUEST/READY": return pullRequestReadyStage(publication);
    case "PULL_REQUEST/BLOCKED": return { status: "The draft pull request didn't open", nextStep: `Retry opening the pull request or close the task ${IN_SLACK}.` };
    case "WAIT_FOR_MERGE/WAITING": return { status: "Waiting for the pull request to be merged", nextStep: "Review and merge it on GitHub; the task finishes when it's merged." };
    case "WAIT_FOR_MERGE/BLOCKED": return waitForMergeBlockedStage(workflow);
    case "MERGED/COMPLETE": return { status: "Merged", nextStep: "Nothing; this task is complete." };
    default: return { status: "In progress", nextStep: `Follow the task ${IN_SLACK}.` };
  }
}

/** Where a workflow task stands and what happens next, in the words the task page shows. */
export function taskPageStage(workflow: WorkflowSnapshot | undefined, closed: boolean, owner: boolean, publication: "failed" | "retrying" | undefined = undefined): { status: string; nextStep: string } {
  if (closed || workflow?.stage === "CLOSED") return { status: "Closed", nextStep: "Nothing; this task is closed." };
  if (workflow === undefined) return { status: "In progress", nextStep: "Follow the task where it was started." };
  // After approved PR feedback the pull requests are already open: the fix is pushed to them.
  if (workflow.stage === "PULL_REQUEST" && (workflow.state === "READY" || workflow.state === "RUNNING") && workflowPullRequestUpdateDue(workflow)) {
    return { status: "Pushing the fix to the pull request", nextStep: "Review and merge it on GitHub once the fix is pushed." };
  }
  return taskPageStageForKey(`${workflow.stage}/${workflow.state}`, workflow, workflowDocumentName(workflow), owner, publication);
}

/** The progress strip's current step, spelled as the page spells it; `Complete` once merged (every step done); empty when no step is current. */
export function taskPageStep(workflow: WorkflowSnapshot | undefined, closed: boolean): string {
  if (workflow?.stage === "MERGED") return "Complete";
  if (closed || workflow === undefined) return "";
  switch (workflow.stage) {
    case "PLAN": case "PLAN_REVIEW": {
      const name = workflowDocumentName(workflow);
      return name === "coding plan" ? "Coding plan" : name === "design" ? "Design" : "Requirements";
    }
    case "IMPLEMENT": return "Coding";
    case "VERIFY": return "Checks";
    case "REVIEW": return "Reviews";
    case "PULL_REQUEST": case "WAIT_FOR_MERGE": return "Pull request";
    default: return "";
  }
}

/** " · 1 answer changed · 2 comments included" for a decision that changed answers or sent comments; "" otherwise (SC-003). */
function decisionExtras(decision: WorkflowSnapshot["decisions"][number]): string {
  const changed = decision.answerOverrides?.length ?? 0;
  const comments = decision.commentsIncluded ?? 0;
  return `${changed === 0 ? "" : ` · ${changed} ${changed === 1 ? "answer" : "answers"} changed`}${comments === 0 ? "" : ` · ${comments} ${comments === 1 ? "comment" : "comments"} included`}`;
}

function cutReason(reason: string): string {
  const characters = Array.from(redactText(reason).replace(/\s+/gu, " ").trim());
  return characters.length <= HISTORY_REASON_MAX_CHARS ? characters.join("") : `${characters.slice(0, HISTORY_REASON_MAX_CHARS - 1).join("")}…`;
}

/** Every claim ID of a document, at every level. */
export function planClaimIds(plan: PlanDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (claims: readonly PlanClaim[]) => {
    for (const claim of claims) {
      ids.add(claim.id);
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  return ids;
}

function recordClaimCommentCitations(claim: PlanClaim, found: Map<string, string>, refs?: Readonly<Record<string, string>>): void {
  for (const evidence of claim.evidence ?? []) {
    if (evidence.kind !== "quote") continue;
    const ref = commentRefInAuthor(evidence.author);
    const id = commentIdInAuthor(evidence.author) ?? (ref === undefined ? undefined : refs?.[ref]);
    if (id !== undefined && !found.has(id)) found.set(id, claim.id);
  }
}

/**
 * The first claim (in document order) whose evidence quotes each comment, by comment ID (a quote's author `comment:<ID>`, or,
 * for a plan stored before that, its ref ("comment c1") through `refs`).
 */
export function claimsCitingComments(plan: PlanDocument, refs?: Readonly<Record<string, string>>): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (claims: readonly PlanClaim[]) => {
    for (const claim of claims) {
      recordClaimCommentCitations(claim, found, refs);
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  return found;
}

function requiredReviewsDidNotClear(workflow: WorkflowSnapshot): boolean {
  const current = (workflow.reviews ?? []).filter((review) => review.candidateDigest === workflow.candidate?.digest);
  if (current.length === 0) return ["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(workflow.stage);
  return current.some((review) => !reviewCleared(review, workflow.acceptedFindings))
    || (["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(workflow.stage)
      && workflowReviewRoles(workflow).some((role) => !current.some((review) => review.role === role)));
}

/**
 * A model-written plan line made inert on GitHub: images dropped, links reduced to their text, URLs in angle brackets
 * unwrapped and other HTML tags dropped, and every @ followed by a zero-width joiner so no one is mentioned or notified.
 * A zero-width joiner also follows each `://` and `www`, so no bare URL becomes a link, and each `#` before a digit, so
 * no `#123` or `org/repo#123` cross-references an issue or pull request.
 */
export function inertPlanLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/giu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("@", "@\u200D")
    .replaceAll("://", "://\u200D")
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}\u200D.`)
    .replace(/#(?=\d)/gu, "#\u200D")
    .trim();
}

/**
 * The task's title as the pull request shows it: Slack's markup (a mention, a channel, a link with its label, a
 * broadcast) reduced to plain words first, then made inert for GitHub as a plan line is. A Slack-started task's title is
 * the requester's words, so nothing in it may mention anyone or link anywhere on GitHub.
 */
export function inertTaskTitle(title: string): string {
  const plain = title
    .replace(/<(?:https?|mailto):[^|>]*\|([^>]*)>/giu, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gu, "#$1")
    .replace(/<[@#!][^>]*>/gu, "")
    .replace(/\s+/gu, " ");
  return inertPlanLine(plain);
}

function summarizePlanForPullRequest(plan: LoadedDocument | string | undefined): string[] {
  const lines = typeof plan === "object" && plan.format === "structured"
    ? planSummaryLines(plan.plan).map(inertPlanLine)
    : documentSummaryLines((typeof plan === "string" ? plan : plan?.markdown ?? "").split("\n").map(inertPlanLine).join("\n"));
  return lines.map((line) => line.slice(0, WORKFLOW_PLAN_SUMMARY_LINE_MAX));
}

function pullRequestFooterLine(workflow: WorkflowSnapshot, reviewOnly: boolean, reviewDidNotClear: boolean): string {
  if (reviewDidNotClear) return "The required reviews did not finish. Nothing was sent to GitHub. See the task page for review results.";
  const checksPhrase = reviewOnly ? " and reviews" : ", checks and reviews";
  const madeByRovara = !reviewOnly && workflow.verification?.results.some((result) => result.madeByRovara === true) === true;
  const note = madeByRovara ? ` (${GENERAL_FAKE_MADE_NOTE})` : "";
  return `Opened as a draft by AgentX after the owner-approved plan${checksPhrase} passed${note}. Merge it on GitHub.`;
}

/**
 * The draft pull request's description: what the owner-approved plan set out to do, which checks and reviews passed
 * (or, first, that no automated check applied and why), where the task lives, and that a human merges it. At most
 * 30,000 bytes.
 */
export function workflowPullRequestBody(task: DeveloperTaskRecord, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, pageUrl: string | undefined, proofLines: readonly string[] = []): string {
  // A structured plan's summary is its top claims; a legacy one's is its first lines (task 18: the same as the plan's
  // Slack message). Either way each line is made inert for GitHub first.
  const summary = summarizePlanForPullRequest(plan);
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const reviewDidNotClear = requiredReviewsDidNotClear(workflow);
  // Model-written: one line, redacted and made inert like a plan line.
  const noneReason = workflow.checkPolicy?.noneReason === undefined ? "" : inertPlanLine(redactText(workflow.checkPolicy.noneReason).replace(/\s+/gu, " ")).trim();
  const lines = [
    ...(reviewOnly ? ["Not verified by automated checks (review only).", ...(noneReason === "" ? [] : [`Why: ${noneReason}`]), ""] : []),
    ...(summary.length > 0 ? summary : [inertTaskTitle(task.title)]),
    "",
    // Between markers, so a pushed PR feedback fix can bring them up to date and leave the rest as the person left it.
    PULL_REQUEST_STATUS_START,
    ...workflowPullRequestStatusLines(workflow, proofLines),
    PULL_REQUEST_STATUS_END,
    ...(pageUrl === undefined ? [] : [`AgentX task: ${pageUrl}`]),
    "",
    pullRequestFooterLine(workflow, reviewOnly, reviewDidNotClear),
  ];
  const body = lines.join("\n");
  if (Buffer.byteLength(body, "utf8") <= WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES) return body;
  // Cut on a character boundary: a split multi-byte character decodes as U+FFFD, which is dropped.
  return Buffer.from(body, "utf8").subarray(0, WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
}

function formatAcceptedFindingsLines(accepted: ReadonlyArray<NonNullable<WorkflowSnapshot["acceptedFindings"]>[number]>): string[] {
  if (accepted.length === 0) return [];
  const listed = accepted.slice(0, WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED).map((finding) => {
    const roleLabel = finding.role === "SECURITY" ? "security" : "code";
    const text = inertPlanLine(redactText(finding.text).replace(/\s+/gu, " "));
    const reason = inertPlanLine(redactText(finding.reason).replace(/\s+/gu, " "));
    return `- [${roleLabel}] ${text} \u2014 accepted: ${reason}`;
  });
  const overflow = accepted.length > WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED
    ? [`- and ${accepted.length - WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED} more; see the task page`]
    : [];
  return [`Owner accepted ${accepted.length} review finding${accepted.length === 1 ? "" : "s"}:`, ...listed, ...overflow];
}

function formatPassedCheckLabels(workflow: WorkflowSnapshot): string[] {
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  return (workflow.verification?.results ?? []).filter((result) => result.status === "PASS").map((result) => {
    // A proposed check's label is model-written: one line, redacted and made inert like a plan line, as every label is.
    const label = inertPlanLine(redactText(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId).replace(/\s+/gu, " "));
    return `${label} passed${result.madeByRovara === true ? ` (${GENERAL_FAKE_MADE_NOTE})` : ""}`;
  });
}

function reviewStatusWord(workflow: WorkflowSnapshot, role: "CRITIC" | "SECURITY"): string {
  const review = (workflow.reviews ?? []).find((entry) => entry.role === role && entry.candidateDigest === workflow.candidate?.digest);
  if (review === undefined || !reviewCleared(review, workflow.acceptedFindings)) return review?.status === "FINDINGS" ? "did not pass" : "could not finish";
  return review.status === "FINDINGS" ? "passed after the owner accepted its findings" : "passed";
}

/**
 * The pull request description's lines about the current code: which checks passed on it (none for review only), how
 * its reviews went, the review findings the owner accepted, and whether the reviews saw only part of the change. Each
 * line is one line, redacted and made inert for GitHub. Rewritten after a pushed PR feedback fix, so it is always about
 * the code on the pull request.
 */
export function workflowPullRequestStatusLines(workflow: WorkflowSnapshot, proofLines: readonly string[] = []): string[] {
  const passed = formatPassedCheckLabels(workflow);
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  // The issues noted are those nobody had to resolve: the findings the owner accepted are listed on their own.
  const noted = (workflow.reviews ?? []).reduce((count, review) => count + review.findings.filter((finding) => !workflowFindingAccepted(workflow, review.role, finding)).length, 0);
  const notedPhrase = noted > 0 ? `; ${noted} earlier issue${noted === 1 ? "" : "s"} noted` : "";
  const accepted = (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === workflow.candidate?.digest);
  return [
    ...(reviewOnly ? [] : [`Checks: ${passed.length > 0 ? passed.join(", ") : "none recorded"}`]),
    `Reviews: code review ${reviewStatusWord(workflow, "CRITIC")}; security review ${reviewStatusWord(workflow, "SECURITY")}${notedPhrase}`,
    ...(requiredReviewsDidNotClear(workflow) ? ["The required reviews did not finish. Nothing was sent to GitHub. See the task page for review results."] : []),
    ...formatAcceptedFindingsLines(accepted),
    ...(workflowReviewsSawPartialDiff(workflow) ? [PULL_REQUEST_PARTIAL_REVIEW_LINE] : []),
    ...proofLines,
  ];
}

type WorkflowArtifact = WorkflowSnapshot["artifacts"][number];

async function resolveArtifactEvidenceRecord(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  artifact: WorkflowArtifact,
  isLatest: boolean,
  helpers: Pick<TaskDocumentViewHelpers, "get">,
): Promise<{ objectKey: string; sha256: string } | undefined> {
  if (!isLatest || artifact.evidence !== undefined) return artifact.evidence;
  const pointer = await helpers.get<Partial<PlanEvidencePointer>>(deps, planEvidencePointerKey(taskId, artifact.id)).catch(() => undefined);
  if (pointer?.artifactId === artifact.id && pointer.artifactSha256 === artifact.sha256 && typeof pointer.objectKey === "string" && typeof pointer.sha256 === "string") {
    return { objectKey: pointer.objectKey, sha256: pointer.sha256 };
  }
  return undefined;
}

async function loadStructuredDocumentEntry(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  kind: TaskDocumentKind,
  artifact: WorkflowArtifact,
  isLatest: boolean,
  approved: boolean,
  privatePrefix: string,
  read: (objectKey: string, maxBytes: number) => Promise<string | undefined>,
  plan: PlanDocument,
  helpers: Pick<TaskDocumentViewHelpers, "get" | "log">,
): Promise<TaskDocumentView["documents"][number]> {
  // Cited code is read for the current version only, and only from this task's own storage.
  // A bundle that cannot be used is logged (no model text), so a broken bundle can be told from GitHub trouble.
  const evidenceUnverified = (reason: "digest" | "prefix" | "missing") => helpers.log(deps, { component: "task-page", event: "evidence_unverified", taskId, reason });
  // The bundle's place: on the artifact for a plan stored with its evidence, else the item the evidence job wrote later
  // (it counts only for this artifact and digest). A pointer that cannot be read leaves the code out and never hides the page.
  const recorded = await resolveArtifactEvidenceRecord(deps, taskId, artifact, isLatest, helpers);
  if (isLatest && recorded !== undefined && !recorded.objectKey.startsWith(privatePrefix)) evidenceUnverified("prefix");
  const evidence = isLatest && recorded?.objectKey.startsWith(privatePrefix) === true
    ? await loadPlanEvidence(read, { ...artifact, evidence: recorded }, evidenceUnverified)
    : undefined;
  // Still loading only while nothing is recorded: a recorded bundle that cannot be used is a failure, not a wait.
  // What the plan self-check stored beside a coding plan (a fixed "not checked" when there is no usable record); the other documents are not judged.
  const selfCheck = kind === "coding plan" ? await loadPlanSelfCheck(async (key) => read(key, 70_000), artifact) : undefined;
  return {
    kind, version: artifact.version, approved, current: isLatest, format: "structured", plan,
    ...(recorded === undefined ? { createdAt: artifact.createdAt } : {}),
    ...(evidence === undefined ? {} : { evidence }),
    ...(selfCheck === undefined ? {} : { selfCheck }),
  };
}

async function loadDocumentVersion(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  spec: (typeof TASK_PAGE_DOCUMENTS)[number],
  artifact: WorkflowArtifact,
  isLatest: boolean,
  approvedDigests: ReadonlySet<string | undefined>,
  privatePrefix: string,
  helpers: Pick<TaskDocumentViewHelpers, "get" | "log">,
): Promise<TaskDocumentView["documents"][number] | undefined> {
  const drop = (reason: string, errorName?: string) => {
    helpers.log(deps, { event: "developer.task_page_document_unverified", taskId, documentType: spec.type, reason, ...(errorName === undefined ? {} : { errorName }) });
    return undefined;
  };
  // Only this task's own private storage is read; a document recorded anywhere else is never shown.
  if (!artifact.objectKey.startsWith(privatePrefix)) return drop("outside_task_storage");
  let readError: unknown;
  const read = async (objectKey: string, maxBytes: number): Promise<string | undefined> => {
    try { return await deps.actions.readArtifact(objectKey, maxBytes); }
    catch (error) { readError = error; return undefined; }
  };
  const document = await loadWorkflowDocument(read, artifact, {});
  if (readError !== undefined) return drop("read_failed", readError instanceof Error ? readError.name : "unknown");
  if (document === undefined || (document.format === "markdown" && Buffer.byteLength(document.markdown, "utf8") > WORKFLOW_PLAN_MAX_BYTES)) {
    return drop("integrity_check_failed");
  }
  const approved = approvedDigests.has(artifact.sha256);
  if (document.format === "markdown") {
    return { kind: spec.kind, version: artifact.version, approved, current: isLatest, format: "markdown", markdown: redactText(document.markdown) };
  }
  return loadStructuredDocumentEntry(deps, taskId, spec.kind, artifact, isLatest, approved, privatePrefix, read, document.plan, helpers);
}

async function loadTaskPageDocuments(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  taskId: string,
  workflow: WorkflowSnapshot | undefined,
  helpers: Pick<TaskDocumentViewHelpers, "get" | "log">,
): Promise<{ documents: TaskDocumentView["documents"]; unverified: TaskDocumentKind[] }> {
  const documents: TaskDocumentView["documents"] = [];
  const unverified: TaskDocumentKind[] = [];
  const privatePrefix = `private/${task.ownerKey}/${task.workspaceId}/`;
  const approvedDigests = new Set((workflow?.decisions ?? []).filter((decision) => decision.decision === "APPROVE" && decision.artifactDigest !== undefined).map((decision) => decision.artifactDigest));
  for (const spec of TASK_PAGE_DOCUMENTS) {
    const versions = (workflow?.artifacts ?? []).filter((item) => item.type === spec.type).sort((left, right) => left.version - right.version);
    const latest = versions.at(-1);
    if (latest === undefined) continue;
    const loaded: TaskDocumentView["documents"] = [];
    let currentFailed = false;
    for (const artifact of versions) {
      const entry = await loadDocumentVersion(deps, taskId, spec, artifact, artifact === latest, approvedDigests, privatePrefix, helpers);
      if (entry !== undefined) loaded.push(entry);
      // An older version that can't be shown is left out; when the current one can't, the page names the document.
      else if (artifact === latest) currentFailed = true;
    }
    if (currentFailed) unverified.push(spec.kind);
    else documents.push(...loaded);
  }
  return { documents, unverified };
}

function buildTaskPageChecksSection(workflow: WorkflowSnapshot | undefined, documents: TaskDocumentView["documents"]) {
  const checkPolicy = workflow?.checkPolicy;
  const current = workflow?.candidate?.digest;
  const results = current !== undefined && workflow?.verification?.candidateDigest === current ? workflow.verification.results : [];
  const proposedIds = new Set((checkPolicy?.proposed ?? []).map((check) => check.id));
  const currentPlan = documents.find((document) => document.kind === "coding plan" && document.current);
  const proves = currentPlan?.format === "structured" ? currentPlan.plan.checks?.proves : undefined;
  const checks = workflowSelectedChecks(checkPolicy).map((check) => {
    const recorded = results.find((result) => result.checkId === check.id);
    const status = recorded?.status;
    return {
      id: check.id, label: check.label,
      passed: status === "PASS" ? true : status === "FAILED" ? false : undefined,
      ...(status === "UNKNOWN" ? { unclear: true as const } : {}),
      ...(recorded?.madeByRovara === true ? { madeByRovara: true as const } : {}),
      ...(proposedIds.has(check.id) ? { proposed: true as const } : {}),
      ...(proves?.[check.id] === undefined ? {} : { proves: proves[check.id]! }),
    };
  });
  // Model-written: the page escapes it. Review only is said once a coding plan exists to have proposed nothing.
  const hasPlan = (workflow?.artifacts ?? []).some((artifact) => artifact.type === "plan");
  let checksNote: string | undefined;
  if (checkPolicy?.proposalNote !== undefined) checksNote = `${checkPolicy.proposalNote}.`;
  else if (checkPolicy !== undefined && hasPlan && checks.length === 0) {
    checksNote = checkPolicy.noneReason === undefined
      ? "No automated checks apply. Review only."
      : `No automated checks apply: ${redactText(checkPolicy.noneReason).replace(/[.\s]+$/u, "")}. Review only.`;
  }
  return { checks, checksRan: results.length > 0, checksNote };
}

function buildTaskPageFindings(workflow: WorkflowSnapshot | undefined): TaskDocumentView["findings"] {
  const current = workflow?.candidate?.digest;
  // The latest review of each kind for the current code: a retried review replaces the one before it.
  const latestReviews = new Map<string, NonNullable<WorkflowSnapshot["reviews"]>[number]>();
  for (const review of (workflow?.reviews ?? []).filter((item) => current === undefined || item.candidateDigest === current)) {
    const seen = latestReviews.get(review.role);
    if (seen === undefined || review.recordedAt >= seen.recordedAt) latestReviews.set(review.role, review);
  }
  // A finding the owner accepted is listed on its own, not as open. The contracts decide what blocks: an advisory finding
  // never does, and a security finding is never advisory, whatever the reviewer marked.
  return [...latestReviews.values()].flatMap((review) => {
    const blocking = new Set<unknown>(blockingFindings(review));
    const open = new Set<unknown>(blockingFindings(review, workflow?.acceptedFindings));
    return ((review.findings ?? []) as ReadonlyArray<WorkflowReviewFinding | string>).flatMap((finding) => {
      if (blocking.has(finding) && !open.has(finding)) return [];
      // Reports stored before structured findings hold plain strings; they read as caused by this change.
      const entry: WorkflowReviewFinding = typeof finding === "string" ? { text: finding, origin: "INTRODUCED" } : finding;
      return [{
        role: review.role === "SECURITY" ? "security" as const : "code" as const,
        text: redactText(entry.text), origin: entry.origin,
        ...(entry.file === undefined ? {} : { file: entry.file }),
        ...(entry.line === undefined ? {} : { line: entry.line }),
        ...(entry.origin === "INTRODUCED" && !blocking.has(finding) ? { advisory: true as const } : {}),
      }];
    });
  });
}

function formatDecisionHistoryText(
  decision: WorkflowSnapshot["decisions"][number],
  who: string,
  name: string,
): string {
  const reason = `: ${cutReason(decision.reason)}`;
  if (decision.source === "AUTO_FIX") return `${who} sent the task back to coding by itself${reason}`;
  if (decision.source === "AUTO_RETRY") return `${who} retried the ${decision.auto?.stage === "REVIEW" ? "reviews" : "checks"} by itself${reason}`;
  if (decision.source === "SEND_BACK") return `${who} sent the task back to coding${reason}`;
  if (decision.source === "FINDINGS") return `${who} resolved the review findings${reason}`;
  if (decision.decision === "APPROVE") return `${who} approved ${name}${decisionExtras(decision)}`;
  if (decision.decision === "REQUEST_CHANGES") return `${who} asked for changes to ${name}${decisionExtras(decision)}${reason}`;
  if (decision.decision === "REJECT") return `${who} rejected ${name}${reason}`;
  return `${who} skipped ${name}`;
}

function parsePeopleHistoryEvent(value: unknown): { actorDeveloperId: string; targetDeveloperId: string; createdAt: string; afterRole: string } {
  const event = value as Record<string, unknown>;
  if (event.entityType !== "TASK_PEOPLE_EVENT" || event.schemaVersion !== 1 || typeof event.actorDeveloperId !== "string"
    || typeof event.targetDeveloperId !== "string" || typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt))
    || typeof event.afterRole !== "string" || !PEOPLE_EVENT_ROLES.has(event.afterRole)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "Task People history is invalid");
  }
  return { actorDeveloperId: event.actorDeveloperId, targetDeveloperId: event.targetDeveloperId, createdAt: event.createdAt, afterRole: event.afterRole };
}

async function loadPeopleHistoryEntries(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  personName: (actorId: string | undefined) => string,
): Promise<TaskDocumentView["history"]> {
  const entries: TaskDocumentView["history"] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":event": "PEOPLE_EVENT#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(response.Items)) throw agentXError("RUNTIME_UNAVAILABLE", "Task People history could not be read");
    for (const value of response.Items) {
      const event = parsePeopleHistoryEvent(value);
      const actor = personName(taskOwnerKey(event.actorDeveloperId, taskId));
      const target = personName(taskOwnerKey(event.targetDeveloperId, taskId));
      const text = event.afterRole === "denied" ? `${actor} removed access for ${target}` : `${actor} made ${target} ${event.afterRole}`;
      entries.push({ at: event.createdAt, text });
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return entries;
}

function documentLinkOf(artifact: { type: string; version: number }): { name: string; link: string } | undefined {
  const found = TASK_PAGE_DOCUMENTS.find((item) => item.type === artifact.type);
  return found === undefined ? undefined : { name: `${found.label} v${artifact.version}`, link: `#${found.anchor}-v${artifact.version}` };
}

function decisionActorLabel(decision: WorkflowSnapshot["decisions"][number], personName: (actorId: string | undefined) => string): string {
  if (decision.actorRole === "AGENTX") return "Rovara";
  if (decision.actorRole === "PROJECT_ADMIN") return "A project admin";
  return personName(decision.actorId);
}

async function buildTaskPageHistory(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  workflow: WorkflowSnapshot | undefined,
  personName: (actorId: string | undefined) => string,
): Promise<TaskDocumentView["history"]> {
  // What happened to the documents, newest first. A decision names the owner (or a project admin) and the version decided on.
  const history: TaskDocumentView["history"] = [];
  for (const artifact of workflow?.artifacts ?? []) {
    const found = documentLinkOf(artifact);
    if (found !== undefined) history.push({ at: artifact.createdAt, text: `${found.name} was written`, link: found.link });
  }
  for (const decision of workflow?.decisions ?? []) {
    const who = decisionActorLabel(decision, personName);
    const artifact = decision.artifactDigest === undefined ? undefined : workflow?.artifacts.find((item) => item.sha256 === decision.artifactDigest);
    const found = artifact === undefined ? undefined : documentLinkOf(artifact);
    history.push({ at: decision.at, text: formatDecisionHistoryText(decision, who, found?.name ?? "the document"), ...(found === undefined ? {} : { link: found.link }) });
  }
  history.push(...await loadPeopleHistoryEntries(deps, taskId, personName));
  history.sort((left, right) => right.at.localeCompare(left.at));
  return history;
}

async function buildCommentCitationsAndLegacyRefs(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot | undefined,
  documents: TaskDocumentView["documents"],
  helpers: Pick<TaskDocumentViewHelpers, "legacyQuoteCommentRefs">,
): Promise<{ citations: Map<string, Map<string, string>>; claimIds: Map<string, Set<string>> }> {
  const citations = new Map<string, Map<string, string>>();
  const claimIds = new Map<string, Set<string>>();
  for (const [index, document] of documents.entries()) {
    if (document.format !== "structured") continue;
    const type = TASK_PAGE_DOCUMENTS.find((entry) => entry.kind === document.kind)?.type;
    const artifact = workflow?.artifacts.find((item) => item.type === type && item.version === document.version);
    if (artifact === undefined || workflow === undefined) continue;
    // A plan stored before quotes named comments by ID credits one as "comment c1": the refs that step's planner was given.
    const refs = await helpers.legacyQuoteCommentRefs(deps, task, workflow, artifact, document.plan);
    const updated = refs === undefined ? document : { ...document, commentRefs: refs };
    if (refs !== undefined) documents[index] = updated;
    citations.set(artifact.id, claimsCitingComments(updated.plan, updated.commentRefs));
    claimIds.set(artifact.id, planClaimIds(updated.plan));
  }
  return { citations, claimIds };
}

async function resolveVisibleWorkflowDependenciesProgress(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  workflow: WorkflowSnapshot | undefined,
): Promise<WorkflowSnapshot["workflowDependenciesProgress"]> {
  const graphOperationId = workflow?.workflowDependenciesOperationId;
  if (workflow === undefined || graphOperationId === undefined) return workflow?.workflowDependenciesProgress;
  const binding = await deps.actions.workflowBinding(task.workspaceId, graphOperationId);
  if (binding === undefined) return [];
  const storedProgress = workflow.workflowDependenciesProgress ?? [];
  const visibleBySequence = new Map<number, (typeof storedProgress)[number]>();
  for (const retained of binding.resumeProgress ?? []) {
    const recorded = storedProgress.find((entry) => entry.sequence === retained.sequence && canonicalJson(entry) === canonicalJson(retained));
    if (recorded !== undefined) visibleBySequence.set(recorded.sequence, recorded);
  }
  const sequenceStart = binding.sequenceStart ?? 0;
  for (const entry of storedProgress) {
    if (entry.operationId === graphOperationId && entry.sequence > sequenceStart) visibleBySequence.set(entry.sequence, entry);
  }
  return [...visibleBySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

async function loadTaskE2EScenarioResults(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  taskId: string,
  owner: boolean,
  helpers: Pick<TaskDocumentViewHelpers, "applicationResultOperations" | "log">,
): Promise<E2EScenarioResults | undefined> {
  if (task.workflow?.e2e?.required !== true || deps.workflowE2EScenarioResults === undefined) return undefined;
  try {
    return await deps.workflowE2EScenarioResults({ task, operations: await helpers.applicationResultOperations(deps, task), actor: owner ? "owner" : "viewer" });
  } catch (error) {
    helpers.log(deps, { event: "developer.task_e2e_results_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

async function loadTaskCommentsAndSuggestions(
  deps: DeveloperTaskRouteDependencies,
  taskId: string,
  helpers: Pick<TaskDocumentViewHelpers, "log">,
): Promise<{ comments: TaskComment[]; suggestions: TaskSuggestion[] }> {
  try {
    const [comments, suggestions] = await Promise.all([listTaskComments(deps, taskId), listSuggestions(deps, taskId)]);
    return { comments, suggestions };
  } catch (error) {
    helpers.log(deps, { event: "developer.task_page_comments_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
    return { comments: [], suggestions: [] };
  }
}

async function buildPersonNameResolver(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  taskId: string,
  helpers: Pick<TaskDocumentViewHelpers, "ownerLabel">,
): Promise<(actorId: string | undefined) => string> {
  let presentation: Awaited<ReturnType<typeof getTaskPeoplePresentation>> = [];
  try { presentation = await getTaskPeoplePresentation(deps, taskId); }
  catch { /* Historical labels are presentation only; a malformed immutable pair falls back to generic actors. */ }
  const actorNames = new Map(presentation.map((person) => [taskOwnerKey(person.developerId, taskId), redactText(person.name)]));
  const ownerName = redactText(helpers.ownerLabel(task.developerName));
  return (actorId: string | undefined): string => {
    if (actorId === task.ownerKey) return ownerName === TASK_OWNER_LABEL ? "The task owner" : ownerName;
    return actorId === undefined ? "A task owner" : actorNames.get(actorId) ?? "A task owner";
  };
}

function selectShownSuggestions(documents: TaskDocumentView["documents"], suggestions: readonly TaskSuggestion[]): TaskSuggestion[] {
  // A suggestion shows on the version it was made on, or on a later one where its decision did not change.
  return TASK_PAGE_DOCUMENTS.flatMap(({ type, kind }) => {
    const versions = documents.filter((document) => document.kind === kind && document.format === "structured");
    const latest = versions.find((document) => document.current);
    if (latest?.format !== "structured") return [];
    const plans = new Map(versions.flatMap((document) => document.format === "structured" ? [[document.version, document.plan] as const] : []));
    return suggestionsFor(suggestions, { document: type, version: latest.version, plan: latest.plan, plans });
  });
}

function buildAcceptedFindings(
  workflow: WorkflowSnapshot | undefined,
  personName: (actorId: string | undefined) => string,
) {
  const current = workflow?.candidate?.digest;
  const unique = new Map((workflow?.acceptedFindings ?? [])
    .filter((accepted) => accepted.candidateDigest === current)
    .map((accepted) => [`${accepted.role}:${accepted.fingerprint}`, accepted] as const));
  return [...unique.values()].map((accepted) => ({
    role: accepted.role === "SECURITY" ? "security" as const : "code" as const,
    text: redactText(accepted.text),
    reason: redactText(accepted.reason),
    owner: personName(accepted.actorId),
    at: accepted.at,
  }));
}

function optionalDocumentViewFields(input: {
  task: DeveloperTaskRecord;
  workflow: WorkflowSnapshot | undefined;
  access: TaskAccess;
  e2eResults: E2EScenarioResults | undefined;
  unverified: TaskDocumentKind[];
  checksNote: string | undefined;
  acceptedFindings: NonNullable<TaskDocumentView["acceptedFindings"]>;
  visibleWorkflowDependenciesProgress: WorkflowSnapshot["workflowDependenciesProgress"];
  autofixLines: string[];
  peopleRevision: number | undefined;
  planFeature: PlanFeature | undefined;
}): Partial<TaskDocumentView> {
  const { task, workflow, access, e2eResults, unverified, checksNote, acceptedFindings, visibleWorkflowDependenciesProgress, autofixLines, peopleRevision, planFeature } = input;
  return {
    ...(e2eResults === undefined ? {} : { e2eResults }),
    ...(unverified.length === 0 ? {} : { unverified }),
    ...(checksNote === undefined ? {} : { checksNote }),
    ...(acceptedFindings.length === 0 ? {} : { acceptedFindings }),
    ...(visibleWorkflowDependenciesProgress === undefined ? {} : { workflowDependenciesProgress: visibleWorkflowDependenciesProgress }),
    ...(workflow !== undefined && task.closedAt === undefined && workflowApplicationRetryOffered(workflow) ? { applicationRetry: { canRetry: can(access.role, "retry") } } : {}),
    ...(autofixLines.length === 0 ? {} : { autofix: { lines: autofixLines } }),
    ...(peopleRevision === undefined ? {} : { peopleRevision }),
    ...(planFeature === undefined ? {} : { planFeature }),
  };
}

/**
 * Task 18: what the read-only task page shows. The task's owner may read it, and so may a member of the Slack channel
 * the task is shared into (they see its thread already) who can also use the task's project (FR-048). Anyone else is
 * refused: a reader on this Slack workspace who can use the project (FR-047) is told whose approval to ask for, and
 * everyone else, including a reader whose checks failed, gets the answer a missing task gets. Each document is read
 * through its recorded key and shown only when its digest matches; review findings are the current code's.
 */
export async function getTaskDocumentViewWithHelpers(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  taskId: string,
  helpers: TaskDocumentViewHelpers,
): Promise<TaskDocumentView> {
  const { access, capabilities } = await helpers.coherentPageAccess(deps, caller, taskId);
  const { task } = access;
  const owner = access.role === "owner";
  const workflow = task.workflow;
  const { documents, unverified } = await loadTaskPageDocuments(deps, task, taskId, workflow, helpers);
  const { checks, checksRan, checksNote } = buildTaskPageChecksSection(workflow, documents);
  const findings = buildTaskPageFindings(workflow);
  const personName = await buildPersonNameResolver(deps, task, taskId, helpers);
  const acceptedFindings = buildAcceptedFindings(workflow, personName);
  const history = await buildTaskPageHistory(deps, taskId, workflow, personName);
  // Comments and suggestions never hide the page: when they cannot be read, the documents still show.
  const { comments, suggestions } = await loadTaskCommentsAndSuggestions(deps, taskId, helpers);
  const { citations, claimIds } = await buildCommentCitationsAndLegacyRefs(deps, task, workflow, documents, helpers);
  const shownSuggestions = selectShownSuggestions(documents, suggestions);
  const visibleWorkflowDependenciesProgress = await resolveVisibleWorkflowDependenciesProgress(deps, task, workflow);
  // M1.3 Task 3.7: the rows of the task's browser and API round, from the broker's own verification of its stored evidence. A round that cannot be read never hides the page.
  const e2eResults = await loadTaskE2EScenarioResults(deps, task, taskId, owner, helpers);
  // AUTOFIX: what Rovara did by itself and, while the step is blocked, why it asks (the stored ask, read as data).
  const autofixAsk = AutoFixAskSchema.safeParse(task.autofixAsk);
  const autofixLines = workflow === undefined ? [] : autoFixCardLines(workflow, workflow.state === "BLOCKED" && autofixAsk.success ? autofixAsk.data : undefined, { plain: true });
  const decidingView = await helpers.pageDecidingView(deps, { task, caller, comments, suggestions: shownSuggestions, citations, claimIds });
  const planFeature = await helpers.pagePlanFeature(deps, access);
  return {
    taskId, now: deps.now(), title: task.title, ...taskPageStage(workflow, task.closedAt !== undefined, owner, await helpers.publicationAttempts(deps, task)),
    path: workflow?.path ?? "QUICK", revision: workflow?.revision ?? 0, stage: taskPageStep(workflow, task.closedAt !== undefined), role: owner ? "owner" : "reader",
    documents, checks, checksRan, findings,
    pullRequests: (workflow?.pullRequests ?? []).map((pullRequest) => ({ url: pullRequest.url, number: pullRequest.number, state: pullRequest.state })),
    history, access: pageAccess(access), canManagePeople: capabilities.canManagePeople,
    canTakeOwnership: capabilities.canTakeOwnership, comments, suggestions: shownSuggestions, askAvailable: await helpers.commentAnswersAvailable(deps, task),
    ...decidingView,
    ...optionalDocumentViewFields({
      task, workflow, access, e2eResults, unverified, checksNote, acceptedFindings,
      visibleWorkflowDependenciesProgress, autofixLines, peopleRevision: capabilities.peopleRevision, planFeature,
    }),
  };
}
