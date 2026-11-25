// F2-A: the facts `stateOf` reads, gathered for one task from what the core already holds: the task record (its workflow, its plan self-check), the merge tracking in the store, and the registry's state-only offers (whether a
// decision waits). Merge tracking is read from the STORE, never from the task view's optional `mergeTracking` member (the view serves it only on v2 full reads). A host adds the few facts the record does not hold (a prepare that
// failed, the budget pause, a wait on the system, the review round it serves) through `extra`.
import { DECISION_MOVES, type DocumentStore, type OrgId } from "@agentx/contracts";
import { planRevisionsUsed } from "../../developer/plan-self-check.js";
import { readMergeTracking } from "../merge/store.js";
import { planDocumentKindOf } from "../plan/answer.js";
import { stateOffers } from "../task-actions/index.js";
import type { TaskRecord } from "../task-flow/records.js";
import type { StandingFacts, SystemWait } from "./state.js";

/** What a host knows that the stored task does not say. */
export interface ExtraFacts {
  failedPrepare?: boolean | undefined;
  budgetPaused?: boolean | undefined;
  stoppedByPerson?: boolean | undefined;
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

/** Whether a check failed: an open pull request whose checks fail (merge tracking, from the store), or a failing result recorded for the code the task holds now. */
export async function failedChecksOf(store: Pick<DocumentStore, "query">, orgId: OrgId, task: TaskRecord): Promise<boolean> {
  const workflow = task.workflow;
  if (workflow === undefined) return false;
  const verification = workflow.verification;
  if (verification !== undefined && workflow.candidate !== undefined && verification.candidateDigest === workflow.candidate.digest && verification.results.some((result) => result.status === "FAILED")) return true;
  if (workflow.pullRequests === undefined || workflow.pullRequests.length === 0) return false;
  const tracked = await readMergeTracking(store, task.taskId, orgId);
  return tracked.some((item) => item.state === "open" && (item.ci === "failing" || item.failingChecks.length > 0));
}

export async function standingFactsOf(deps: { store: Pick<DocumentStore, "query">; companyId: OrgId }, task: TaskRecord, extra: ExtraFacts = {}): Promise<StandingFacts> {
  const workflow = task.workflow;
  const planUsed = workflow === undefined || workflow.stage !== "PLAN" ? 0 : planRevisionsUsed(task.planSelfCheck, planDocumentKindOf(workflow), workflow.artifacts.filter((entry) => entry.type === planDocumentKindOf(workflow)).length + 1);
  const [needsPerson, failedChecks] = await Promise.all([needsPersonOf(task), failedChecksOf(deps.store, deps.companyId, task)]);
  return {
    workflow, closed: task.closedAt !== undefined, budgetPaused: extra.budgetPaused === true, failedPrepare: extra.failedPrepare === true, needsPerson, planRevisionsUsed: planUsed, failedChecks,
    ...(extra.reviewRound === undefined ? {} : { reviewRound: extra.reviewRound }), ...(extra.wait === undefined ? {} : { wait: extra.wait }), ...(extra.stoppedByPerson === true ? { stoppedByPerson: true } : {}),
  };
}
