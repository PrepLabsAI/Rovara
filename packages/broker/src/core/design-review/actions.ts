// Design review stage: what the owner does to a review that is waiting or blocked, on the task flow's ports. None of these approves or spends anything:
//   - `answerDesignQuestions`: the owner's answers to the one question card. The planner answers the findings again with them (a CRITIC_REPLAN row, in the same commit as the answers);
//   - `resumeParkedReview`: a parked review is picked up again, and the clock starts over;
//   - `retryBlockedReview`: a review that blocked (a rule file that could not be verified, a leftover program, a lost run) runs its step again; what its blocked round cost is already counted;
//   - `designFirstOf`: a request that starts with `design first:` asks for the review whatever the project's setting says, but only while the stage exists for the company.
// Who may do each is the install's owner on a laptop (the pages and routes sign them in); a hosted adapter narrows it. Every one is conditional on the workflow revision the person was looking at.
import {
  WorkflowTransitionError, agentXError, answerDesignQuestions, designWaitOf, resumeParkedDesignReview, workflowIsDesignReviewing, type WorkflowSnapshot,
} from "@agentx/contracts";
import { parseDesignFirstPrefix } from "../../rovara-code/explicit-path.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readTask } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { commitWorkflow, runDispatchRow } from "../task-flow/stage-machine.js";
import { iso } from "../task-flow/support.js";
import { resumeBlockedCheck } from "./check-ends.js";
import { designReviewAvailableFor } from "./switch.js";
import type { DesignReviewRuntime } from "./round-ports.js";
import { designRowFor, designRowItem } from "./steps.js";
import { designWaitArmItems } from "./wait.js";

const STALE = "This changed since you read it. Read the latest and try again.";

async function open(deps: TaskFlowDeps, taskId: string, expectedRevision: number | undefined): Promise<TaskRecord & { workflow: WorkflowSnapshot }> {
  const task = await readTask(deps, taskId);
  if (task === undefined || task.companyId !== deps.companyId || task.closedAt !== undefined || task.workflow === undefined || task.workflow.designReview === undefined) throw agentXError("NOT_FOUND", "This is no longer waiting for you.");
  if (expectedRevision !== undefined && task.workflow.revision !== expectedRevision) throw agentXError("CHANGE_STALE", STALE);
  return task as TaskRecord & { workflow: WorkflowSnapshot };
}

/** Commits a move with the row it makes due (and the wait it starts), then runs the row. A task that moved on is `CHANGE_STALE`. */
async function commitMove(deps: TaskFlowDeps, task: TaskRecord & { workflow: WorkflowSnapshot }, next: WorkflowSnapshot): Promise<void> {
  const now = iso(deps);
  const row = designRowFor(next);
  const committed = await commitWorkflow(deps, task, next, [...(row === undefined ? [] : [designRowItem(deps, task.taskId, next.revision, row, now)]), ...designWaitArmItems(deps, task.taskId, next, Date.parse(now))]);
  if (!committed) throw agentXError("CHANGE_STALE", STALE);
  if (row !== undefined) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: row });
}

/** The owner's answers to the question card. The contract move checks them (every question once, an option of that question, cleaned text); a refusal is the request's, not a fault. */
export async function answerReviewQuestions(deps: TaskFlowDeps, input: { taskId: string; expectedRevision?: number; answers: readonly unknown[]; actorId: string }): Promise<void> {
  const task = await open(deps, input.taskId, input.expectedRevision);
  const review = task.workflow.designReview;
  if (review?.status !== "waiting_answers" || task.workflow.stage !== "PLAN" || task.workflow.state !== "WAITING") throw agentXError("NOT_FOUND", "This is no longer waiting for you.");
  let next: WorkflowSnapshot;
  try {
    next = answerDesignQuestions(task.workflow, { expectedRevision: task.workflow.revision, answers: input.answers, by: { actorId: input.actorId }, now: iso(deps) });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  await commitMove(deps, task, next);
}

/** Picks a parked review up again: it waits again and the clock starts over. */
export async function resumeParkedReview(deps: TaskFlowDeps, input: { taskId: string; expectedRevision?: number; actorId: string }): Promise<void> {
  const task = await open(deps, input.taskId, input.expectedRevision);
  const wait = designWaitOf(task.workflow);
  if (wait?.parkedAt === undefined) throw agentXError("NOT_FOUND", "This is not paused.");
  let next: WorkflowSnapshot;
  try {
    next = resumeParkedDesignReview(task.workflow, { expectedRevision: task.workflow.revision, by: { actorId: input.actorId }, now: iso(deps) });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  await commitMove(deps, task, next);
}

/** Whether a blocked workflow is the review's step (a round, or the planner's answer to the findings), which Retry resumes. A blocked design the planner was WRITING is the planning step's own retry. */
export const isBlockedReview = (workflow: WorkflowSnapshot): boolean =>
  workflow.state === "BLOCKED" && workflowIsDesignReviewing(workflow) && (workflow.stage === "PLAN_CRITIQUE" || (workflow.stage === "PLAN" && workflow.designReview?.status === "resolving"));

/** Retry of a blocked review step: `resumeBlockedDesignReview` through `resumeBlockedCheck`, which also removes what the blocked round left stored. The retry adds nothing to the spend (the block already counted it). */
export async function retryBlockedReview(deps: TaskFlowDeps, task: TaskRecord, expectedRevision: number | undefined): Promise<boolean> {
  const workflow = task.workflow;
  if (workflow === undefined || !isBlockedReview(workflow)) return false;
  if (expectedRevision !== undefined && workflow.revision !== expectedRevision) throw agentXError("CHANGE_STALE", STALE);
  let next: WorkflowSnapshot;
  try {
    next = await resumeBlockedCheck(deps.store, task.workspaceId, workflow, iso(deps));
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  await commitMove(deps, task as TaskRecord & { workflow: WorkflowSnapshot }, next);
  return true;
}

/**
 * The `design first:` prefix of a request, read ONLY while the design review stage exists for the company (the switch is on and the company allows it). Otherwise the text is returned as it came: no prefix is stripped and nothing is
 * recorded, exactly as before the stage existed. An empty request after the prefix is refused.
 */
export async function designFirstOf(runtime: Pick<DesignReviewRuntime, "reader" | "env">, companyId: Parameters<typeof designReviewAvailableFor>[1], text: string): Promise<{ designFirst: boolean; rest: string }> {
  if (!(await designReviewAvailableFor(runtime.reader, companyId, runtime.env))) return { designFirst: false, rest: text };
  const typed = parseDesignFirstPrefix(text);
  if (typed.designFirst && typed.rest.trim() === "") throw agentXError("CONFIG_INVALID", "instructions: the request is empty");
  return typed.designFirst ? { designFirst: true, rest: typed.rest.trim() } : { designFirst: false, rest: text };
}
