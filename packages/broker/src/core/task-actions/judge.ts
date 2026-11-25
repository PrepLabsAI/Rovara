// S1: the checks every press and every describe share, in order (4.7 steps 2 and 3): read the task from the person's own company, who the person is to it (the rule of the entry), whether the action is offered now, and whether the press
// names what is offered now (revision, digest). A refusal is a stable code, reason and `writes` ("none": nothing has been written yet). Nothing here reads anything a surface sent except the action id, the task id and the binding.
import { AgentXError, ActionBindingSchema, type ActionBinding, type AgentXErrorCode, type TaskActionRefusalReason, type TaskActionWrites } from "@agentx/contracts";
import { readTask } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { entryOf } from "./entries.js";
import { satisfies, standingOf } from "./standing.js";
import type { ActionCaller, ActionEnv, Standing, TaskActionEntry } from "./types.js";

export interface Refusal { code: AgentXErrorCode; reason: TaskActionRefusalReason; writes: TaskActionWrites }
export const refusal = (code: AgentXErrorCode, reason: TaskActionRefusalReason, writes: TaskActionWrites = "none"): Refusal => ({ code, reason, writes });

/** The reason a code stands for when a throw site named none (a stable map by code, never by the sentence). `writes` is never taken from a code. */
export function reasonOfCode(code: AgentXErrorCode): TaskActionRefusalReason {
  switch (code) {
    case "TASK_NOT_FOUND": case "NOT_FOUND": return "not_found";
    case "FORBIDDEN": case "TASK_ACCESS_DENIED": case "PROJECT_ACCESS_DENIED": return "not_yours";
    case "CHANGE_STALE": case "IDEMPOTENCY_CONFLICT": case "STALE_FENCE": case "TASK_ACTION_STALE": case "SPENDING_APPROVAL_STALE": return "stale";
    case "WORKSPACE_BUSY": case "TASK_BUSY": case "WORKSPACE_NOT_READY": return "busy";
    case "BUDGET_EXCEEDED": case "ORG_BUDGET_EXCEEDED": case "PROJECT_BUDGET_EXCEEDED": case "AGENT_BUDGET_EXCEEDED": case "MACHINE_TIME_EXCEEDED": return "over_limit";
    case "TASK_ACTION_NEEDS_INPUT": return "needs_input";
    case "TASK_ACTION_NEEDS_WEB": return "needs_web";
    case "TASK_ACTION_NOT_OFFERED": case "CONFIG_INVALID": case "INTENT_NOT_WAITING": case "PROJECT_ARCHIVED": return "not_offered";
    default: return "unavailable";
  }
}

/** A thrown error as a refusal. An error that names no `writes` is `maybe` (fail safe: the person checks the task before pressing again). */
export function refusalOfError(error: unknown): Refusal {
  if (error instanceof AgentXError) return refusal(error.code, error.detail.reason ?? reasonOfCode(error.code), error.detail.writes ?? "maybe");
  return refusal("RUNTIME_UNAVAILABLE", "unavailable", "maybe");
}

export interface Judged { entry: TaskActionEntry; task: TaskRecord; standing: Standing | undefined; binding: ActionBinding }

/** Who the rule lets through; a person who may read the task but not act is told so (`not_yours`), anyone else reads "not found". */
async function mayAct(env: ActionEnv, caller: ActionCaller, entry: TaskActionEntry, task: TaskRecord, standing: Standing | undefined): Promise<Refusal | undefined> {
  if (entry.who === "merge") {
    if (env.merge === undefined) return refusal("TASK_ACTION_NOT_OFFERED", "not_offered");
    return (await env.merge.standing(caller, task).catch(() => ({ may: false }))).may ? undefined : refusal(standing?.kind === "reader" ? "FORBIDDEN" : "TASK_NOT_FOUND", standing?.kind === "reader" ? "not_yours" : "not_found");
  }
  if (satisfies(entry.who, standing)) return undefined;
  if (entry.who === "held") return refusal("TASK_ACTION_NOT_OFFERED", "not_offered");
  return standing?.kind === "reader" ? refusal("FORBIDDEN", "not_yours") : refusal("TASK_NOT_FOUND", "not_found");
}

/** Steps 2 and 3 of a press. `bound` is what the press names (the surface's word); it is compared with what is offered NOW. */
export async function judge(env: ActionEnv, caller: ActionCaller, press: { actionId: string; taskId: string; binding: unknown }): Promise<Judged | Refusal> {
  const entry = entryOf(press.actionId as never);
  if (entry === undefined) return refusal("TASK_ACTION_NOT_OFFERED", "not_offered");
  const task = await readTask(env.deps, press.taskId).catch(() => undefined);
  if (task === undefined || task.companyId !== env.deps.companyId) return refusal("TASK_NOT_FOUND", "not_found");
  const standing = await standingOf(env.deps, caller, task);
  const denied = await mayAct(env, caller, entry, task, standing);
  if (denied !== undefined) return denied;
  if (task.closedAt !== undefined && entry.id !== "people.view") return refusal("TASK_ACTION_NOT_OFFERED", "closed");
  const offered = await Promise.resolve(entry.when(env, task, caller)).catch(() => undefined);
  if (offered === undefined) return refusal("TASK_ACTION_NOT_OFFERED", "not_offered");
  const named = ActionBindingSchema.safeParse(press.binding);
  if (!named.success || named.data.revision !== offered.revision || named.data.digest !== offered.digest) return refusal("TASK_ACTION_STALE", "stale");
  return { entry, task, standing, binding: offered };
}

export const isRefusal = (value: Judged | Refusal): value is Refusal => "reason" in value;
