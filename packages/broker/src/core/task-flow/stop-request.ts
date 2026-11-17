// A person's Stop on a core task, for a host that serves it (the deployed developer route `POST /v1/dev/tasks/{id}/cancel`, and Slack's stop and the admin cancel after it). `cancelTask` does the
// stop itself (the worker is asked to flush its spend, the machine is stopped, a workflow step waits for Retry) and leaves the caller's authority to the host; this is that check, in one place.
//
// Who may stop (the core session rule, `core/sessions/access.ts`: stop needs `edit`, or a company owner or admin):
//   - the task's owner by the company's owner rule (`TaskAccess.ownerActing`: on a deployed install the person the task runs for, or a People owner where the task has People), or
//   - a live owner or administrator of the TASK'S company. The role is the host's read of the person's membership now (never a token claim, a header or a body), and it counts only for a task
//     of the company that membership names: the task's own company is checked here, so an administrator of another company reaches nothing.
// Anyone else who may not read the task (another company, a revoked member, a script token, someone the read rule does not name) is told exactly what a missing task tells them. A person who
// may read the task but may not stop it is told so in fixed words.
//
// One request id is one stop (the legacy cancel's rule, ruling F14): the id is kept under the task's request key, with the step it targets and a `task.stop_requested` audit line, in one
// transaction BEFORE the stop runs, so a
// repeat (or a race of two) stops nothing more and answers the task as it is now; the same id used for another action on the task is refused.
import { DeveloperTaskActionRequestSchema, agentXError, when, type OrgRole, type TransactItem } from "@agentx/contracts";
import { stageAudit } from "./admission.js";
import { taskNotFound } from "./access.js";
import { cancelTask } from "./cancel.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { parseBody } from "./owner-round.js";
import { readTask } from "./reads.js";
import type { TaskRecord } from "./records.js";
import { readWorkspace } from "./stage-machine.js";
import { hashJson } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

export const STOP_NOT_YOURS = "Only the task's owner or a company admin can stop this task.";
/** The legacy cancel's own words for a closed task (aws/developer-tasks.ts CLOSED_TASK), so the route answers as it always has. */
export const LEGACY_CLOSED_TASK = "this task is closed; start a new one with agentx_start_task";
export const STOP_REQUEST_REUSED = "this request_id was already used for another action on this task; use a new request_id";
/** The legacy cancel's own hash of its payload, so the same request id names the same action on either engine. */
const CANCEL_PAYLOAD_HASH = hashJson({ action: "cancel" });

/** The person asking, with the role their membership gives them NOW in the company the host resolved (undefined: none read, so no admin authority). */
export interface StopCaller extends TaskCaller { companyRole?: OrgRole | undefined }

export type StopAuthority = "owner" | "company-admin";

/** What a stop answered: the task as it is after it, whether this request ran the stop (false for a repeat), and the stop's own answer when it ran. */
export interface StopResult { task: TaskRecord; repeated: boolean; nothingRunning?: boolean; authority: StopAuthority }

const isCompanyAdmin = (role: unknown): boolean => role === "owner" || role === "admin";

/** Who this caller is to the task, with the owner's live access fence (steps for the stop's claim) when they are its owner. */
export interface StopStanding { authority: StopAuthority | "reader"; fence: readonly TransactItem[] }

/**
 * Who this caller is to the task: `owner`, `company-admin`, `reader` (may read it, may not stop it) or undefined (may not read it: a missing task's answer). Without the company's owner rule
 * (`deps.access.ownerActing`) nobody is an owner here (the host does not serve the stop then).
 */
export async function stopStandingOf(deps: TaskFlowDeps, caller: StopCaller, task: TaskRecord | undefined): Promise<StopStanding | undefined> {
  // The task must be of the company this runtime serves AND of the caller's company: a task row is found by its id alone, so the company is checked on both sides.
  if (task === undefined || caller.principal.companyId !== deps.companyId || task.companyId !== deps.companyId) return undefined;
  // A script token reads and starts; it never stops anything.
  if (caller.scriptToken !== undefined) return undefined;
  if (deps.access.ownerActing !== undefined) {
    const acting = await deps.access.ownerActing(caller.principal, { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey });
    if (acting !== undefined) return { authority: "owner", fence: acting.items ?? [] };
  }
  if (isCompanyAdmin(caller.companyRole)) return { authority: "company-admin", fence: [] };
  return (await deps.access.canAct(caller.principal, task)) ? { authority: "reader", fence: [] } : undefined;
}

/**
 * Stops the task's running step for a caller who may stop it, once per request id. `body` is read only after the caller was judged (a body that is not JSON throws there). Throws the missing task's refusal for a caller who may not read the task, `FORBIDDEN` (fixed words) for a
 * reader who may not stop it, and the legacy cancel's refusals for a closed task or a reused request id. Nothing is written on a refusal.
 */
export async function stopTaskOnRequest(deps: TaskFlowDeps, caller: StopCaller, taskId: string, body: () => unknown): Promise<StopResult> {
  const task = await readTask(deps, taskId);
  // The task is read and the caller judged before the body, so someone who may not see the task learns nothing from what they sent.
  const standing = await stopStandingOf(deps, caller, task);
  if (standing === undefined || task === undefined) throw taskNotFound();
  if (standing.authority === "reader") throw agentXError("FORBIDDEN", STOP_NOT_YOURS);
  const authority: StopAuthority = standing.authority;
  const request = parseBody(DeveloperTaskActionRequestSchema, body());
  const workspace = await readWorkspace(deps, task.workspaceId);
  const location = await workspaceKeys({ store: deps.store, companyId: task.companyId }, task.workspaceId);
  const requestKey = location.operationRequestKey(workspace?.ownerKey ?? task.ownerKey, request.requestId);
  /** The earlier claim of this request id, if any (another action's id is refused). */
  const earlierClaim = async (): Promise<Record<string, unknown> | undefined> => {
    const earlier = await deps.store.get(requestKey);
    if (earlier === undefined) return undefined;
    if (earlier["payloadHash"] !== CANCEL_PAYLOAD_HASH) throw agentXError("IDEMPOTENCY_CONFLICT", STOP_REQUEST_REUSED);
    return earlier;
  };
  /**
   * A repeat stops nothing new: it answers the task as it is now. Only when the step its first request claimed is STILL the workspace's active step (the first request's stop did not
   * finish, say a store error after the claim) does the repeat finish that same stop; a step started after the first stop is never stopped by a repeat.
   */
  const answerRepeat = async (earlier: Record<string, unknown>): Promise<StopResult> => {
    const claimed = earlier["operationId"];
    if (typeof claimed === "string" && (await readWorkspace(deps, task.workspaceId))?.activeOperationId === claimed) await cancelTask(deps, task.taskId);
    return { task: await now(), repeated: true, authority };
  };
  const now = async (): Promise<TaskRecord> => (await readTask(deps, taskId)) ?? task;
  // A closed task refuses first, as the legacy cancel does (so a repeat after the close is refused like any new call); a repeat answers the task as it is now and stops nothing.
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", LEGACY_CLOSED_TASK);
  const first = await earlierClaim();
  if (first !== undefined) return await answerRepeat(first);
  const claim = await deps.store.transact([
    { kind: "put", item: { ...requestKey, entityType: "IDEMPOTENCY", action: "cancel", payloadHash: CANCEL_PAYLOAD_HASH, taskId: task.taskId, requestId: request.requestId, operationId: workspace?.activeOperationId ?? null }, condition: when.absent() },
    // The owner's live access fence (a People revision) joins the claim, so a change of who owns the task between the check and the claim refuses it.
    ...standing.fence,
    ...stageAudit(deps, { eventId: `task.stop_requested:${task.taskId}:${request.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.stop_requested", subject: { type: "task", id: task.taskId }, details: { project: task.project, by: authority } }),
  ]);
  if (!claim.applied) {
    // The same stop committed first (a race of two): answer it. Otherwise the owner's access changed under the claim: a missing task's answer, as a fresh check would give.
    const winner = await earlierClaim();
    if (winner !== undefined) return { task: await now(), repeated: true, authority };
    throw taskNotFound();
  }
  // A stop that throws after its claim keeps its id (the claim and its audit line are one record): the same request then finishes it (`answerRepeat`), and so does a new request id.
  const answer = await cancelTask(deps, task.taskId);
  return { task: await now(), repeated: false, nothingRunning: answer.nothingRunning, authority };
}
