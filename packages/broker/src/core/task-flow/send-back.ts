// Task actions (owner decision 198), send back: the task's owner sends blocked work (failed checks, review findings the change introduced, coding that stopped) or a change ready to publish back to coding with their
// instructions. Cloud's `sendTaskWorkflowBackToCoding`, over the ports; today Code sends back only by itself (autofix).
//
// The move is the engine's own (`returnWorkflowToImplementation`: owner only, at a blocked step after the plan, never over an open pull request), committed with the coding step's dispatch row, then the row is run now
// (the recovery sweep runs it otherwise). The coding step (`build-step/start.ts`) builds the prompt from the problems on the workflow and the owner's words kept beside it (`owner-note.ts`), so the same words reach the
// coder whoever starts the row.
//
// What it holds, each one tested: who acts (the owner or a co-owner; anyone else reads no such task), the revision the person saw (a stale one is refused, a missing one too), the same request id once (a repeat with the
// same words answers the first, other words are refused), a closed task, a task waiting for more spend, the task's money cap and `Admission` (`owner-round.ts`), and the change tier: `workflow.flow` is carried over as it is
// (the tier only goes up, and it is worked out again on the new code's diff by whoever writes it, never reset here).
import { ContinueDeveloperTaskRequestSchema, WorkflowTransitionError, agentXError, returnWorkflowToImplementation, workflowSendBackOffered, type WorkflowSnapshot } from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { dispatchRowItem } from "./dispatch-rows.js";
import { ownerNoteItem } from "./owner-note.js";
import { CLOSED_TASK, NEVER_STARTED_TASK, WAITING_FOR_SPEND, admitRound, loadTaskAsOwner, ownerWords, parseBody, waitingForSpend, type TaskActionsOptions } from "./owner-round.js";
import { readTask, taskViewOf, type TaskView } from "./reads.js";
import { readWorkspace, commitWorkflow, runDispatchRow } from "./stage-machine.js";
import { iso, log } from "./support.js";

export const NO_SEND_BACK_FOR_NOW = "there is no current failed check or review finding to send back to coding";
export const SEND_BACK_NEEDS_REVISION = "refresh the task and include its current revision before sending it back to coding";
export const SEND_BACK_OUT_OF_DATE = "this send-back is out of date; refresh the task and try again";

export async function sendBackToCoding(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, taskId: string, value: unknown): Promise<TaskView> {
  const request = parseBody(ContinueDeveloperTaskRequestSchema, value);
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workflow = task.workflow;
  if (workflow === undefined || task.purpose !== undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  const words = ownerWords(request.instructions);
  // A repeat answers what the first one did and writes nothing; the same id for other words is refused.
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.source !== "SEND_BACK" || prior.reason !== words.slice(0, 500)) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    return taskViewOf(deps, task);
  }
  if (waitingForSpend(workflow)) throw agentXError("CONFIG_INVALID", WAITING_FOR_SPEND);
  if (request.expectedRevision === undefined) throw agentXError("CONFIG_INVALID", SEND_BACK_NEEDS_REVISION);
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", SEND_BACK_OUT_OF_DATE);
  if (!workflowSendBackOffered(workflow)) throw agentXError("CONFIG_INVALID", NO_SEND_BACK_FOR_NOW);
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined || workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  if (workspace.status === "PREPARATION_FAILED") throw agentXError("CONFIG_INVALID", NEVER_STARTED_TASK);
  const now = iso(deps);
  let returned: WorkflowSnapshot;
  try {
    returned = returnWorkflowToImplementation(workflow, { requestId: request.requestId, actorId: acting.actorId, reason: words, now }, acting.authority);
  } catch (error) {
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  // The money, access and admission checks come last, so a refusal for any other reason is the one the person reads first, and nothing has been written when one is refused.
  await admitRound(deps, options, { task, caller, requestId: request.requestId });
  const committed = await commitWorkflow(deps, task, returned, [
    dispatchRowItem(deps, task.taskId, returned.revision, "IMPLEMENT", now),
    ...(acting.items ?? []),
    ownerNoteItem({ taskId: task.taskId, requestId: request.requestId, text: words, now: deps.now?.() ?? new Date() }),
    ...stageAudit(deps, { eventId: `task.sent_back:${task.taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.sent_back", subject: { type: "task", id: task.taskId }, details: { project: task.project, revision: workflow.revision } }),
  ]);
  if (!committed) {
    // Lost a race: the same request already committed (answer it), or the task moved on (refuse).
    const fresh = await readTask(deps, task.taskId);
    const again = fresh?.workflow?.decisions.find((decision) => decision.requestId === request.requestId);
    if (fresh !== undefined && again?.source === "SEND_BACK" && again.reason === words.slice(0, 500)) return taskViewOf(deps, fresh);
    throw agentXError("IDEMPOTENCY_CONFLICT", SEND_BACK_OUT_OF_DATE);
  }
  // The coding run starts now; a start that fails leaves the row for the recovery sweep, and the send-back stands.
  await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: returned.revision, kind: "IMPLEMENT" })
    .catch((error: unknown) => log(deps, { event: "task_actions.send_back_start_deferred", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  return taskViewOf(deps, (await readTask(deps, task.taskId)) ?? task);
}
