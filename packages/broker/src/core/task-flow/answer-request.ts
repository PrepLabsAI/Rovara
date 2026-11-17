// The owner's answers to Understand's questions on a core task, for a host that serves them (the deployed developer route `POST /v1/dev/tasks/{id}/answers`). The workflow takes the answers
// and Understand runs again with them (the same move as the laptop's session route, `local/app/answers.ts`); this adds the host's checks, in one place.
//
// Who may answer (D5: only owners answer the agent): the task's owner by the company's owner rule (`TaskAccess.ownerActing`: on a deployed install the person the task runs for, or a People
// owner where the task has People). A company owner or administrator who is not the task's owner may not; nor may a People commenter or viewer.
// Anyone who may not read the task (another company, a revoked member, a script token, someone the read rule does not name) is told exactly what a missing task tells them. A person who may
// read the task but is not its owner is told so in fixed words.
//
// One request id is one answer: the id is kept under the task's request key, with the answer's audit line and the owner's live access fence, in the SAME transaction as the workflow's move,
// so a repeat (or a race of two) answers nothing more and answers the task as it is now; the same id used with other answers, or for another action on the task, is refused. The round the
// person was asked is checked (a form left open over a newer round is refused, the stale-form guard), and the body is checked at runtime with fixed words before anything is written.
import { z } from "zod";
import {
  INTENT_NOT_WAITING_MESSAGE, INTENT_QUESTIONS_MAX, IntentAnswerRefusal, IntentAnswerSchema, WorkflowTransitionError, agentXError, answerIntentQuestions, when, type TransactItem,
} from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import { taskNotFound } from "./access.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { dispatchRowItem } from "./dispatch-rows.js";
import { CLOSED_TASK } from "./owner-round.js";
import { readTask } from "./reads.js";
import type { TaskRecord } from "./records.js";
import { commitWorkflow, readWorkspace, runDispatchRow } from "./stage-machine.js";
import { hashJson, iso } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

export const ANSWER_NOT_YOURS = "Only the task's owner can answer its questions.";
export const ANSWER_REQUEST_REUSED = "this request_id was already used for other answers or another action on this task; use a new request_id";
export const ANSWERS_BODY_INVALID = "Answers need a request ID (a UUID), the round you were asked (a whole number), and 1 to 3 answers: each names its question (q1 to q3) and picks an option (a to d), says something (1 to 2,000 characters), or both.";
export const ANSWERS_TASK_CHANGED = "The task changed while you were answering. Read it again.";

/** The body, checked at runtime before anything is read for it. Nothing else is taken. */
export const TaskAnswersRequestSchema = z.object({
  requestId: z.string().uuid(),
  round: z.number().int().min(1).max(1_000_000),
  answers: z.array(IntentAnswerSchema).min(1).max(INTENT_QUESTIONS_MAX),
}).strict();
export type TaskAnswersRequest = z.infer<typeof TaskAnswersRequestSchema>;

/** What an answer did: the task as it is after it, and whether this request was a repeat that answered nothing. */
export interface AnswerResult { task: TaskRecord; repeated: boolean }

/** Who this caller is to the task: its owner (with the actor the workflow records and the owner's live access fence), a reader, or undefined (may not read it: a missing task's answer). */
type AnswerStanding = { authority: "owner"; actorId: string; fence: readonly TransactItem[] } | { authority: "reader" };

async function answerStandingOf(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord | undefined): Promise<AnswerStanding | undefined> {
  // The task must be of the company this runtime serves AND of the caller's company: a task row is found by its id alone, so the company is checked on both sides.
  if (task === undefined || caller.principal.companyId !== deps.companyId || task.companyId !== deps.companyId) return undefined;
  // A script token reads and starts; it never answers.
  if (caller.scriptToken !== undefined) return undefined;
  // Without the company's owner rule nobody is an owner here (the host does not serve the answers then).
  if (deps.access.ownerActing === undefined) return undefined;
  const acting = await deps.access.ownerActing(caller.principal, { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey });
  if (acting !== undefined) return { authority: "owner", actorId: acting.actorId, fence: acting.items ?? [] };
  return (await deps.access.canAct(caller.principal, task)) ? { authority: "reader" } : undefined;
}

/** The body, or the fixed refusal (no field value, no cause). */
export function parseTaskAnswers(value: unknown): TaskAnswersRequest {
  const parsed = TaskAnswersRequestSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", ANSWERS_BODY_INVALID);
  return parsed.data;
}

/**
 * Takes the owner's answers to the round of questions now asked, once per request id. `body` is read only after the caller was judged (a body that is not JSON throws there). Throws the
 * missing task's refusal for a caller who may not read the task, `FORBIDDEN` (fixed words) for a reader who is not its owner, the fixed body refusal, `INTENT_NOT_WAITING` for a task not
 * waiting for these answers (another round, or none), and `IDEMPOTENCY_CONFLICT` for a reused request id. Nothing is written on a refusal.
 */
export async function answerTaskOnRequest(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, body: () => unknown): Promise<AnswerResult> {
  const task = await readTask(deps, taskId);
  // The task is read and the caller judged before the body, so someone who may not see the task learns nothing from what they sent.
  const standing = await answerStandingOf(deps, caller, task);
  if (standing === undefined || task === undefined) throw taskNotFound();
  if (standing.authority === "reader") throw agentXError("FORBIDDEN", ANSWER_NOT_YOURS);
  const request = parseTaskAnswers(body());
  const payloadHash = hashJson({ action: "answers", round: request.round, answers: request.answers });
  const workspace = await readWorkspace(deps, task.workspaceId);
  const location = await workspaceKeys({ store: deps.store, companyId: task.companyId }, task.workspaceId);
  const requestKey = location.operationRequestKey(workspace?.ownerKey ?? task.ownerKey, request.requestId);
  const repeat = async (): Promise<boolean> => {
    const earlier = await deps.store.get(requestKey);
    if (earlier === undefined) return false;
    if (earlier["payloadHash"] !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", ANSWER_REQUEST_REUSED);
    return true;
  };
  const now = async (): Promise<TaskRecord> => (await readTask(deps, taskId)) ?? task;
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  // A repeat is answered before the round is checked: the first answer moved the round on, and its repeat must answer the same, not "not waiting".
  if (await repeat()) return { task: await now(), repeated: true };
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("INTENT_NOT_WAITING", INTENT_NOT_WAITING_MESSAGE);
  const at = iso(deps);
  let next;
  try {
    next = answerIntentQuestions(workflow, {
      expectedRevision: workflow.revision, round: request.round, by: { actorId: standing.actorId, name: caller.principal.displayName },
      source: caller.client === "mcp" || caller.client === "cli" ? caller.client : "app", answers: request.answers, now: at,
    });
  } catch (error) {
    // The workflow's own refusals, under the codes the session route gives them (their words are fixed: field names only, never a value).
    if (error instanceof IntentAnswerRefusal) throw agentXError(error.code, error.message);
    if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
    throw error;
  }
  const applied = await commitWorkflow(deps, task, next, [
    dispatchRowItem(deps, task.taskId, next.revision, "UNDERSTAND", at),
    { kind: "put", item: { ...requestKey, entityType: "IDEMPOTENCY", action: "answers", payloadHash, taskId: task.taskId, requestId: request.requestId }, condition: when.absent() },
    // The owner's live access fence (a People revision) joins the move, so a change of who owns the task between the check and the commit refuses it.
    ...standing.fence,
    ...stageAudit(deps, { eventId: `task.questions_answered:${task.taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.questions_answered", subject: { type: "task", id: task.taskId }, details: { project: task.project, round: request.round } }),
  ]);
  if (!applied) {
    // The same answer committed first (a race of two): answer it. An owner who is no longer one reads a missing task, as a fresh check would; otherwise the task moved on.
    if (await repeat()) return { task: await now(), repeated: true };
    const again = await answerStandingOf(deps, caller, await readTask(deps, taskId));
    if (again?.authority !== "owner") throw taskNotFound();
    throw agentXError("CONFIG_INVALID", ANSWERS_TASK_CHANGED);
  }
  await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "UNDERSTAND" });
  return { task: await now(), repeated: false };
}
