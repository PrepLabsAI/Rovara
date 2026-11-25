// S1: `performRegistryAction`, what every surface's press goes through, in order (4.7):
//   1. the caller is the person the HOST resolved (never a body); the audit sink names the surface (`via`), bound by the entry point and never read from the press;
//   2. the task is read from the person's own company, who they are to it is read live and judged by the entry's rule (`judge`): not found / not yours / not offered / stale, all before any write;
//   3. a move whose confirm was shown carries the digest of that confirm (`confirmDigest`): a missing one is `needs_input`, a different one `stale`, BEFORE any write, so a renderer that skipped the dialog cannot make the move;
//   4. ONE call into the existing function, whose refusals become a stable code, reason and `writes` (an error that names none is `maybe`).
// The same press twice is the same request id (derived from the press itself), so the engine's own idempotency answers it once.
import { createHash } from "node:crypto";
import { WorkflowTransitionError, type ActionBinding, type ActionResult, type ActionValues, type TaskActionId } from "@agentx/contracts";
import { auditViaCaller } from "../audit-read/index.js";
import { confirmDigestOf } from "./digest.js";
import { isRefusal, judge, refusal, refusalOfError, type Refusal } from "./judge.js";
import type { ActionCaller, ActionEnv, Description } from "./types.js";

export interface RegistryPress {
  actionId: string;
  taskId: string;
  /** What the person was shown (the card or modal's own words, checked against what is offered now). */
  binding: unknown;
  values?: ActionValues | undefined;
  /** The digest of the confirm the person saw, when the move has one. */
  confirmDigest?: string | undefined;
  /** What makes this press this press: a button press's message and action times, a form submission's view and binding. The same key twice is one request. */
  requestKey: string;
  /** The surface's name, bound by the entry point (`slack`): never read from a body. */
  via: string;
}

/** A UUID derived from the press, so the same press is the same request id for the engine's own idempotency. */
export function requestIdOf(requestKey: string): string {
  const hash = createHash("sha256").update(`rovara:task-action:${requestKey}`, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A move whose confirm was shown carries the digest of what it showed THIS person at THIS state: a missing one is `needs_input`, a different one `stale`; undefined when the move has no confirm or the digest is the one. */
function confirmRefusal(judged: { entry: { id: TaskActionId }; task: { taskId: string }; binding: ActionBinding }, caller: ActionCaller, description: Description | undefined, given: string | undefined): Refusal | undefined {
  if (description?.confirm === undefined) return undefined;
  if (given === undefined) return refusal("TASK_ACTION_NEEDS_INPUT", "needs_input");
  const expected = confirmDigestOf({ action: judged.entry.id, taskId: judged.task.taskId, personId: caller.principal.personId, binding: judged.binding, confirm: description.confirm, bound: description.bound });
  return given === expected ? undefined : refusal("TASK_ACTION_STALE", "stale");
}

export async function performRegistryAction(env: ActionEnv, caller: ActionCaller, press: RegistryPress): Promise<ActionResult> {
  try {
    const judged = await judge(env, caller, press);
    if (isRefusal(judged)) return { status: "refused", ...judged };
    const { entry, task, standing, binding } = judged;
    const values = press.values ?? {};
    const description = entry.describe === undefined ? undefined : await entry.describe(env, caller, task, binding, values);
    const unconfirmed = confirmRefusal(judged, caller, description, press.confirmDigest);
    if (unconfirmed !== undefined) return { status: "refused", ...unconfirmed };
    const deps = { ...env.deps, audit: auditViaCaller(env.deps.audit, press.via) };
    const performed = await entry.perform({ env, deps, caller, task, standing, binding, requestId: requestIdOf(press.requestKey), values });
    return performed.status === "replayed" ? { status: "replayed" } : { status: performed.status, ...(performed.said === undefined ? {} : { said: performed.said }), ...(performed.next === undefined || performed.next.length === 0 ? {} : { next: performed.next }) };
  } catch (error) {
    // The engine's own transition refusals are raised before anything is committed.
    const failed = error instanceof WorkflowTransitionError ? refusal("TASK_ACTION_NOT_OFFERED", "not_offered") : refusalOfError(error);
    return { status: "refused", ...failed };
  }
}
