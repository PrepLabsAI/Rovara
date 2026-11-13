// Task actions (owner decision 198), continue: more work for a task that has ended its run (finished, failed, stopped or interrupted). The new instructions start a new round on the same task, in the same workspace
// and conversation: the code and the branch are as the last round left them. Cloud's `continueTask`, over the ports; Code refused it.
//
// Only a task with no workflow takes a free-form turn, as in Cloud: a workflow task runs its own steps and is moved by its approvals, a send back or its findings (`send-back.ts`, `review-findings.ts`), and says so.
// A task that is still working answers TASK_BUSY (wait or stop it first), a closed task or a workspace that never got ready is refused with its own words, and a setup run takes no follow-up.
//
// What it holds, each one tested: who acts (the owner or a co-owner; anyone else reads no such task), the same request id once (a repeat with the same words answers the first and starts nothing, other words are
// refused), the task's money cap and `Admission` (`owner-round.ts`), and the new round is the operation's own transaction: the round, its idempotency record and its audit line commit together or not at all.
import { ContinueDeveloperTaskRequestSchema, agentXError, when, type TransactItem } from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { taskPointerKey } from "./keys.js";
import { CLOSED_TASK, GATED_TASK_TURN_REFUSAL, NEVER_STARTED_TASK, admitRound, loadTaskAsOwner, parseBody, type TaskActionsOptions } from "./owner-round.js";
import { readTask, taskViewOf, type TaskView } from "./reads.js";
import { fromDocument, type TaskPointerRecord } from "./records.js";
import { acceptStep, readWorkspace } from "./stage-machine.js";
import { hashJson, iso, newId } from "./support.js";

export const STILL_WORKING = "This task is still working. Wait for it to finish, or stop it, then send the new instructions.";
export const SETUP_RUN_TAKES_NO_FOLLOW_UP = "A setup run takes no follow-up. Start a new setup run instead.";
export const CONTINUE_RETRY = "Rovara could not start the task just now; try again with the same request_id";

/** The record of one accepted continue, under its request id: what the first one asked and the round it started. Written in the round's own transaction. */
export const continueRecordKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `CONTINUE#${requestId}` });

export async function continueTask(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, taskId: string, value: unknown): Promise<TaskView> {
  const request = parseBody(ContinueDeveloperTaskRequestSchema, value);
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  const payloadHash = hashJson({ instructions: request.instructions });
  // A repeat answers what the first one did and writes nothing; the same id for other words is refused. Asked before the task's state, so a repeat of a continue that was accepted still answers once its round ended.
  const earlier = await deps.store.get(continueRecordKey(task.taskId, request.requestId));
  if (earlier !== undefined) {
    if (earlier["payloadHash"] !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for other instructions; use a new one");
    return taskViewOf(deps, task);
  }
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  if (task.purpose !== undefined) throw agentXError("CONFIG_INVALID", SETUP_RUN_TAKES_NO_FOLLOW_UP);
  // A workflow task is moved by its own approvals, a send back or its findings, never by a free-form turn in its workspace.
  if (task.workflow !== undefined) throw agentXError("WORKSPACE_BUSY", GATED_TASK_TURN_REFUSAL);
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  if (workspace.status === "PREPARATION_FAILED") throw agentXError("CONFIG_INVALID", NEVER_STARTED_TASK);
  // A task whose first instructions have not run yet is still starting: they are its first round, and this is not. A task still working holds its workspace; any other state that cannot take a round is the step's own WAITING, below.
  const pointer = fromDocument<TaskPointerRecord>(await deps.store.get(taskPointerKey(task.workspaceId)));
  if (pointer?.pendingPrompt !== undefined || workspace.activeOperationId !== null) throw agentXError("TASK_BUSY", STILL_WORKING);
  // The money, access and admission checks come last, so a refusal for any other reason is the one the person reads first, and nothing has been written when one is refused.
  await admitRound(deps, options, { task, caller, requestId: request.requestId });
  const operationId = newId(deps);
  const now = iso(deps);
  const extra: TransactItem[] = [
    ...(acting.items ?? []),
    { kind: "put", item: { ...continueRecordKey(task.taskId, request.requestId), entityType: "TASK_CONTINUE", taskId: task.taskId, requestId: request.requestId, payloadHash, operationId, at: now }, condition: when.absent() },
    ...stageAudit(deps, { eventId: `task.continued:${task.taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.continued", subject: { type: "task", id: task.taskId }, details: { project: task.project } }),
  ];
  const accepted = await acceptStep(deps, { task, workspace, requestId: request.requestId, prompt: request.instructions, operationId, extra });
  if (accepted.result === "STARTED") return taskViewOf(deps, (await readTask(deps, task.taskId)) ?? task);
  if (accepted.result === "DUPLICATE") {
    // The same request committed first (a repeat at the same moment): answer it if it asked the same, refuse it if not.
    const record = await deps.store.get(continueRecordKey(task.taskId, request.requestId));
    if (record !== undefined && record["payloadHash"] === payloadHash) return taskViewOf(deps, (await readTask(deps, task.taskId)) ?? task);
    throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another request on this task; use a new one");
  }
  if (accepted.result === "WAITING") throw agentXError("TASK_BUSY", STILL_WORKING);
  // The task moved on between the read and the commit (closed, or the person's access ended).
  const fresh = await readTask(deps, task.taskId);
  if (fresh === undefined || fresh.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  throw agentXError("WORKSPACE_BUSY", CONTINUE_RETRY);
}
