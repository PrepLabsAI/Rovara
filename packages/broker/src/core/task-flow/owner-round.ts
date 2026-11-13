// Task actions (owner decision 198): what the three owner moves on a task already running (send back, review findings, continue) share. Host-neutral: the laptop's routes and Cloud's both call these through
// `createTaskActions` (`task-actions.ts`), over the same `TaskFlowDeps`.
//
// What is held here, once, for every move that starts one more round of paid work on a task:
//   - who acts: the task's owner or a co-owner (`TaskAccess.ownerActing`; Code's own rule when absent). Anyone else reads "no such task". A script token is never the owner acting.
//   - the money: the task's cap (`TaskActionsOptions.roundCap`: what the task may spend and what it has) must have room, and an unreadable spend refuses (never read as nothing spent); a task waiting for more spend to be
//     approved is not sent on by a person's move; and `Admission` is asked (`task.round`) before anything is written. Admission is a gate here: a reservation it hands back is given back at once, since the machine
//     start (`machine.start`) and the model proxy hold the money of the round itself.
//   - access: the person the task runs for must still be allowed to have it run (`TaskAccess.checkStep`), and an archived project takes no new work.
import {
  WORKFLOW_BLOCK_REASONS,
  agentXError,
  isRunLimitBlockReason,
  redactText,
  type Principal,
  type WorkflowOwnerAuthority,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import type { ZodType } from "zod";
import { OWNER_ROLE, taskNotFound } from "./access.js";
import { admit, releaseAdmission } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { loadOwnedTask } from "./reads.js";
import type { TaskRecord } from "./records.js";

/** The `Admission` action name of one more round of work on a task a person asked for. Cloud's adapter answers it; Code's default allows it. */
export const OWNER_ROUND_ADMISSION_ACTION = "task.round";

export const CLOSED_TASK = "This task is closed. Start a new one.";
export const NEVER_STARTED_TASK = "This task never started and its workspace was released. Start a new task, and close this one.";
export const WAITING_FOR_SPEND = "This task is waiting for more spend to be approved. Sending it on cannot skip that approval.";
export const SPEND_UNKNOWN = "Rovara cannot tell what this task has spent, so it does not start more work on it. Try again in a moment.";
export const TASK_ARCHIVED = (project: string): string => `project \`${project}\` is archived; unarchive it to start new work`;
const usd = (value: number): string => `$${value.toFixed(2)}`;

/** What a host tells the actions about money. Optional: an install that holds no run limit (`ROVARA_RUN_LIMIT=0`) leaves `roundCap` out, and no round is refused for money by it (Admission still is asked). */
export interface TaskActionsOptions {
  /**
   * The cap the task is held to and what it has spent, in dollars; undefined when no cap is held for it. `spentUsd` undefined means the spend cannot be told (another currency, an unreadable ledger): the round is
   * refused, never started on a guess. A function that throws refuses the round the same way.
   */
  roundCap?: (task: TaskRecord) => Promise<{ limitUsd: number; spentUsd: number | undefined } | undefined>;
}

/** The person acting as the task's owner, as the workflow engine will check them. */
export interface OwnerActing { actorId: string; authority?: WorkflowOwnerAuthority }

/**
 * The task, when the caller is its owner or a co-owner, and who the engine records as acting. A task the caller may not act on is "no such task" (the task flow's own answer); a caller who may act on it but is
 * not an owner of it is refused the same way, so a task's existence is not told to someone who cannot move it. Never believes an id from a body.
 */
export async function loadTaskAsOwner(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<{ task: TaskRecord; acting: OwnerActing }> {
  const task = await loadOwnedTask(deps, caller, taskId);
  // A script token is scoped to reading and starting tasks; it is never the owner acting on one.
  if (caller.scriptToken !== undefined) throw taskNotFound();
  const identity = { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey };
  const acting = deps.access.ownerActing === undefined ? defaultOwnerActing(caller.principal, identity) : await deps.access.ownerActing(caller.principal, identity);
  if (acting === undefined) throw taskNotFound();
  return { task, acting };
}

/** Code's rule: the owner of the install, or the person the task runs for, acts as the task's owner. */
function defaultOwnerActing(principal: Principal, task: { developerId: string; ownerKey: string }): OwnerActing | undefined {
  return principal.roles.includes(OWNER_ROLE) || principal.personId === task.developerId ? { actorId: task.ownerKey } : undefined;
}

/** A body read against its schema; the refusal names the field, never the value (the values are the owner's words). */
export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

/** The owner's words as the flow keeps them: redacted of anything key-shaped and trimmed. They are the owner's own instructions, so they are otherwise kept whole. */
export const ownerWords = (text: string): string => redactText(text).trim();

/** Whether the workflow waits for more spend to be approved (a budget pause, or a run limit nobody accepted): a person's move never skips that. */
export const waitingForSpend = (workflow: Pick<WorkflowSnapshot, "state" | "blockReason">): boolean =>
  workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused || isRunLimitBlockReason(workflow.blockReason));

/**
 * The checks every round of new work passes before anything is written: the project takes new work, the person the task runs for may still have it run, the task's cap has room, and `Admission` agrees.
 * Throws the refusal otherwise; nothing has been written by then.
 */
export async function admitRound(deps: TaskFlowDeps, options: TaskActionsOptions, input: { task: TaskRecord; caller: TaskCaller; requestId: string }): Promise<void> {
  const { task, caller } = input;
  const project = await deps.projects.latest(task.project);
  if (project?.archived === true) throw agentXError("PROJECT_ARCHIVED", TASK_ARCHIVED(task.project));
  const permitted = await deps.access.checkStep(task);
  if (!permitted.allowed) throw agentXError("FORBIDDEN", permitted.message);
  await requireRoomUnderCap(options, task);
  const admitted = await admit(deps, {
    idempotencyKey: `${OWNER_ROUND_ADMISSION_ACTION}:${task.taskId}:${input.requestId}`, action: OWNER_ROUND_ADMISSION_ACTION, actor: caller.principal, projectName: task.project,
    subject: { type: "task", id: task.taskId },
  });
  if ("refusal" in admitted) throw admitted.refusal;
  // A reservation nobody settles would hold the allowance until it expires: the round's own money is held by the machine start and the model proxy.
  await releaseAdmission(deps, admitted.reservationId);
}

/** The task's cap must have room: a task that has spent it (or whose spend cannot be told) is refused before a machine is woken. */
async function requireRoomUnderCap(options: TaskActionsOptions, task: TaskRecord): Promise<void> {
  if (options.roundCap === undefined) return;
  let cap: Awaited<ReturnType<NonNullable<TaskActionsOptions["roundCap"]>>>;
  try {
    cap = await options.roundCap(task);
  } catch {
    throw agentXError("BUDGET_EXCEEDED", SPEND_UNKNOWN);
  }
  if (cap === undefined) return;
  if (cap.spentUsd === undefined || !Number.isFinite(cap.spentUsd) || !Number.isFinite(cap.limitUsd)) throw agentXError("BUDGET_EXCEEDED", SPEND_UNKNOWN);
  if (cap.spentUsd >= cap.limitUsd) {
    throw agentXError("BUDGET_EXCEEDED", `This task has used its run limit (${usd(cap.spentUsd)} of ${usd(cap.limitUsd)}), so Rovara will not start more work on it. Start a new task.`);
  }
}
