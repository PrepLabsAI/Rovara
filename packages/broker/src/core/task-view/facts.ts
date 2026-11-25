// F2-A: the facts `stateOf` reads, gathered for one task from what the core already holds: the task record (its workflow, its plan self-check), the merge tracking in the store, and the registry's state-only offers (whether a
// decision waits). Merge tracking is read from the STORE, never from the task view's optional `mergeTracking` member (the view serves it only on v2 full reads). A host adds the few facts the record does not hold (a prepare that
// failed, the budget pause, a wait on the system, the review round it serves) through `extra`.
import { DECISION_MOVES, OWNER_LEFT_PROJECT_WORDS, WORKFLOW_BLOCK_REASONS, openReviewFindings, type DocumentStore, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { planRevisionsUsed } from "../../developer/plan-self-check.js";
import { DEFAULT_CI_MODE, readyToMerge } from "../merge/merge-tracking.js";
import { growthOwedOf, owedLevelOf, type GrowthOwed } from "../merge/grown-owed.js";
import { readMergeTracking } from "../merge/store.js";
import { dispatchRowKey } from "../task-flow/keys.js";
import { STOPPED_CHECKS_REASON, STOPPED_STEP_REASON } from "../task-flow/cancel.js";
import { planDocumentKindOf } from "../plan/answer.js";
import { stateOffers } from "../task-actions/index.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceOperations } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { readWorkspace } from "../task-flow/stage-machine.js";
import type { StandingFacts, SystemWait } from "./state.js";

/** A step refused because nobody who owns the task still has its project waits on a project admin, not on an owner who is not there (`needs_role`: "Needs a project admin"). */
function projectAdminAsk(workflow: WorkflowSnapshot | undefined): { askedRole?: "project_admin" } {
  return workflow?.state === "BLOCKED" && workflow.blockReason === OWNER_LEFT_PROJECT_WORDS ? { askedRole: "project_admin" } : {};
}

/** What a host knows that the stored task does not say. Everything the stored task and its workspace do say (a prepare that failed, a person's Stop, the review round of a custom sequence) is read by `standingFactsOf` itself, so every surface sees it. */
export interface ExtraFacts {
  failedPrepare?: boolean | undefined;
  budgetPaused?: boolean | undefined;
  stoppedByPerson?: boolean | undefined;
  runLost?: boolean | undefined;
  wait?: SystemWait | undefined;
  reviewRound?: { round: number; max: number } | undefined;
}

/** Whether a decision waits on a person: the stored task offers a decision move (the registry's own `when`, no person asked), or its step is blocked for a reason a person may lift, or the plan or the questions wait. */
export async function needsPersonOf(task: TaskRecord): Promise<boolean> {
  const workflow = task.workflow;
  if (task.closedAt !== undefined || workflow === undefined) return false;
  if ((workflow.stage === "PLAN_REVIEW" || workflow.stage === "UNDERSTAND") && workflow.state === "WAITING") return true;
  const offers = await stateOffers({ plan: true, merge: false, people: false }, task);
  return offers.some((offer) => DECISION_MOVES.includes(offer.id));
}

/** Why a blocked review needs a person: it found problems (open blocking findings of the current code), or it could not finish (a review that is unreadable, timed out or missing), or it could not even start (the dispatch failed for good: the fixed reason). Absent at any other step. */
export function reviewBlockOf(workflow: WorkflowSnapshot | undefined): "findings" | "unfinished" | "not_started" | undefined {
  if (workflow === undefined || workflow.stage !== "REVIEW" || workflow.state !== "BLOCKED") return undefined;
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.reviewsCouldNotStart) return "not_started";
  return openReviewFindings(workflow).length > 0 ? "findings" : "unfinished";
}

/**
 * A step whose start failed and whose dispatch the sweep is still retrying (its row has failed at least once and the step is not blocked yet): the task is waiting, not stuck. Only after the last attempt does it block (and read Needs you,
 * `WORKFLOW_BLOCK_REASONS.reviewsCouldNotStart`). Undefined when no start is being retried.
 */
async function startRetryOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord): Promise<SystemWait | undefined> {
  const workflow = task.workflow;
  if (workflow === undefined || task.closedAt !== undefined || workflow.state === "BLOCKED" || workflow.state === "COMPLETE") return undefined;
  const row = await deps.store.get(dispatchRowKey(deps.companyId, task.taskId, workflow.revision)).catch(() => undefined);
  if (row === undefined || typeof row["attempts"] !== "number" || row["attempts"] < 1) return undefined;
  return row["kind"] === "REVIEW" ? "start_reviews" : "start_step";
}

/** What merge tracking says of the task's pull requests, for the two facts that read it. Empty when the task has none. */
async function trackedOf(store: Pick<DocumentStore, "query">, orgId: OrgId, task: TaskRecord) {
  const workflow = task.workflow;
  if (workflow?.pullRequests === undefined || workflow.pullRequests.length === 0) return [];
  return readMergeTracking(store, task.taskId, orgId);
}

/** Whether a check failed: an open pull request whose checks fail (merge tracking, from the store), or a failing result recorded for the code the task holds now. */
export async function failedChecksOf(store: Pick<DocumentStore, "query">, orgId: OrgId, task: TaskRecord): Promise<boolean> {
  const workflow = task.workflow;
  if (workflow === undefined) return false;
  const verification = workflow.verification;
  if (verification !== undefined && workflow.candidate !== undefined && verification.candidateDigest === workflow.candidate.digest && verification.results.some((result) => result.status === "FAILED")) return true;
  return (await trackedOf(store, orgId, task)).some((item) => item.state === "open" && (item.ci === "failing" || item.failingChecks.length > 0));
}

/**
 * Whether the pull requests that wait are ready for a person to merge, by the one reading (`readyToMerge`): every pull request is tracked and ready, and the task waits (WAITING). Undefined where there is no pull request to read: the
 * line then says "Ready to merge" as it always did for a task that waits with none recorded.
 */
export async function pullRequestReadyOf(store: Pick<DocumentStore, "query">, orgId: OrgId, task: TaskRecord): Promise<boolean | undefined> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.pullRequests === undefined || workflow.pullRequests.length === 0) return undefined;
  const items = await trackedOf(store, orgId, task);
  return workflow.state === "WAITING" && items.length > 0 && items.length === workflow.pullRequests.length && items.every((item) => readyToMerge(item, DEFAULT_CI_MODE));
}

/** What a change that grew still owes before it can merge (TIER-GROWTH-MERGE): the one reader the merge view, the press and the sessions read too. Undefined where nothing is owed or nothing waits. */
export async function growthOwedFor(store: Pick<DocumentStore, "query">, orgId: OrgId, task: TaskRecord): Promise<GrowthOwed | undefined> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "WAIT_FOR_MERGE" || task.closedAt !== undefined || owedLevelOf(workflow) === undefined) return undefined;
  return growthOwedOf(workflow, await trackedOf(store, orgId, task));
}

/** The review round whose problems are being fixed, from the custom sequence's own count: a review step that sent findings back (`programRounds`) and the coding that follows it, until its re-review. Absent for the built-in path (it has no counted rounds). */
export function reviewRoundOf(workflow: WorkflowSnapshot | undefined): { round: number; max: number } | undefined {
  const program = workflow?.program;
  if (workflow === undefined || program === undefined || workflow.programRounds === undefined || (workflow.stage !== "IMPLEMENT" && workflow.stage !== "VERIFY")) return undefined;
  const at = program.steps.findIndex((step) => step.id === workflow.programStepId);
  if (at < 0) return undefined;
  for (const [index, step] of program.steps.entries()) {
    const rounds = workflow.programRounds[step.id];
    const back = step.onFindings === undefined ? -1 : program.steps.findIndex((candidate) => candidate.id === step.onFindings?.backTo);
    if (step.kind === "review" && step.onFindings !== undefined && rounds !== undefined && back >= 0 && back <= at && at < index) return { round: rounds, max: step.onFindings.maxRounds };
  }
  return undefined;
}

/** Whether the workspace could not be prepared (the repository would not clone): the task's own status reads Failed there (`deriveTaskStatus`), and the standing says Stopped. A preparation a person's Stop ended is that Stop, not a failure (`standingFactsOf`). */
async function failedPrepareOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord): Promise<boolean> {
  if (task.closedAt !== undefined) return false;
  return (await readWorkspace(deps, task.workspaceId).catch(() => undefined))?.status === "PREPARATION_FAILED";
}

/**
 * Whether a person stopped the task and nothing has started the work again. The mark is on the task row (`personStop`, written with the stop's claim). A workflow task holds it while the stop's own effect is the latest move: the step it
 * blocked (one or two revisions on) or, when nothing was in flight, the step still running at the revision it stopped at. A retry or any later move leaves it behind. A task with no workflow holds it while no run began after the stop.
 */
async function stoppedByPersonOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord): Promise<boolean> {
  const mark = task.personStop;
  if (mark === undefined || task.closedAt !== undefined) return false;
  const workflow = task.workflow;
  if (workflow !== undefined) {
    if (mark.revision === undefined) return false;
    // A block counts only when it IS the stop's own (its fixed sentences): a stop with nothing running and a later failed retry, or a stop that lost a race with the step's own end, are not the person's Stop.
    if (workflow.state === "BLOCKED") return (workflow.blockReason === STOPPED_STEP_REASON || workflow.blockReason === STOPPED_CHECKS_REASON) && workflow.revision > mark.revision && workflow.revision <= mark.revision + 2;
    return workflow.state === "RUNNING" && workflow.revision === mark.revision;
  }
  const operations = await workspaceOperations(deps, task.workspaceId).catch(() => undefined);
  return operations !== undefined && !operations.some((operation) => operation.createdAt > mark.at);
}

export async function standingFactsOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord, extra: ExtraFacts = {}): Promise<StandingFacts> {
  const workflow = task.workflow;
  const planUsed = workflow === undefined || workflow.stage !== "PLAN" ? 0 : planRevisionsUsed(task.planSelfCheck, planDocumentKindOf(workflow), workflow.artifacts.filter((entry) => entry.type === planDocumentKindOf(workflow)).length + 1);
  const [needsPerson, failedChecks, preparing, stopped, pullRequestReady, startRetry, growthOwed] = await Promise.all([needsPersonOf(task), failedChecksOf(deps.store, deps.companyId, task), failedPrepareOf(deps, task), stoppedByPersonOf(deps, task), pullRequestReadyOf(deps.store, deps.companyId, task), startRetryOf(deps, task), growthOwedFor(deps.store, deps.companyId, task)]);
  const reviewRound = extra.reviewRound ?? reviewRoundOf(workflow);
  const reviewBlock = reviewBlockOf(workflow);
  const wait = extra.wait ?? startRetry;
  return {
    workflow, closed: task.closedAt !== undefined, budgetPaused: extra.budgetPaused === true, failedPrepare: extra.failedPrepare === true || (preparing && !stopped), needsPerson: needsPerson || growthOwed?.state === "needs_you", planRevisionsUsed: planUsed, failedChecks,
    ...(pullRequestReady === undefined ? {} : { pullRequestReady }), ...(growthOwed === undefined ? {} : { growthOwed }), ...(reviewBlock === undefined ? {} : { reviewBlock }),
    ...(reviewRound === undefined ? {} : { reviewRound }), ...(wait === undefined ? {} : { wait }), ...(extra.stoppedByPerson === true || stopped ? { stoppedByPerson: true } : {}), ...(extra.runLost === true ? { runLost: true } : {}),
    ...projectAdminAsk(workflow),
  };
}
