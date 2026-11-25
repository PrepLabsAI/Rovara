// S1: what a task offers now. `stateOffers` is what the task's state alone offers (for the card a thread is given: public, so it carries no right, no price and no text a person wrote); `actionsFor` is what THIS person may do now (the
// served `actions` of a task read, for a surface that renders per person); `describeAction` answers a press that needs a form or a confirm, judged for the presser FIRST, so a public card never leaks findings text, a close preview or a
// money figure to someone who may not act. All three are pure over the stored task and the person's live standing.
import { TASK_ACTION_NOTES, type ActionBinding, type ActionDescription, type ActionOffer, type ActionValues, type TaskActionId, type TaskActionRisk } from "@agentx/contracts";
import type { TaskRecord } from "../task-flow/records.js";
import { confirmDigestOf } from "./digest.js";
import { isRefusal, judge, refusalOfError } from "./judge.js";
import { TASK_ACTION_ENTRIES } from "./entries.js";
import { satisfies, standingOf } from "./standing.js";
import type { ActionCaller, ActionEnv, TaskActionEntry } from "./types.js";

const needsDialogFor = (entry: TaskActionEntry, task: TaskRecord, risk: TaskActionRisk): boolean => risk === "high" || risk === "irreversible" || (entry.dialog === undefined ? entry.describe !== undefined : entry.dialog(task));

async function offerOf(env: ActionEnv, task: TaskRecord, entry: TaskActionEntry, caller: ActionCaller | undefined): Promise<ActionOffer | undefined> {
  if (entry.who === "held") return undefined;
  const binding = await Promise.resolve(entry.when(env, task, caller as ActionCaller)).catch(() => undefined);
  if (binding === undefined) return undefined;
  const risk = entry.risk(task, {});
  return { id: entry.id, label: entry.label(task), risk, needsDialog: needsDialogFor(entry, task, risk), binding };
}

/** What a host can serve, for the offers a card shows before anyone presses (no person is known): a capability is only whether the host has it. */
export interface OfferCapabilities { plan?: boolean | undefined; merge?: boolean | undefined; people?: boolean | undefined }
const NEVER_ASKED = (): never => { throw new Error("a state-only offer asks nobody"); };

/**
 * What the task's state offers, for no one in particular (the card a thread is given: public, so it carries no right, no price and no text a person wrote). Entries that need a person (taking over a task) are left out. `env` is a full
 * environment, or just what the host can serve.
 */
export async function stateOffers(env: ActionEnv | OfferCapabilities, task: TaskRecord): Promise<ActionOffer[]> {
  const full: ActionEnv = "deps" in env ? env : {
    deps: undefined as never, options: {},
    ...(env.plan === true ? { plan: { facts: NEVER_ASKED, decide: NEVER_ASKED } } : {}),
    ...(env.merge === true ? { merge: { standing: NEVER_ASKED, readiness: NEVER_ASKED, press: NEVER_ASKED } } : {}),
    ...(env.people === true ? { people: { view: NEVER_ASKED, canTakeOwnership: NEVER_ASKED, takeOwnership: NEVER_ASKED } } : {}),
  };
  const offers = await Promise.all(TASK_ACTION_ENTRIES.map((entry) => offerOf(full, task, entry, undefined)));
  return offers.filter((offer): offer is ActionOffer => offer !== undefined);
}

/** What this person may do with the task now: the entries offered by the state whose rule the person satisfies. */
export async function actionsFor(env: ActionEnv, caller: ActionCaller, task: TaskRecord): Promise<ActionOffer[]> {
  const standing = await standingOf(env.deps, caller, task);
  const offers = await Promise.all(TASK_ACTION_ENTRIES.map(async (entry) => {
    const may = entry.who === "merge" ? (env.merge === undefined ? false : (await env.merge.standing(caller, task).catch(() => ({ may: false }))).may) : entry.who === "take-over" ? standing !== undefined : satisfies(entry.who, standing);
    return may ? offerOf(env, task, entry, caller) : undefined;
  }));
  return offers.filter((offer): offer is ActionOffer => offer !== undefined);
}

/** What a declared exclusion says, for a surface that lists the actions it does not offer. */
export const declaredExclusions = (): Array<{ id: TaskActionId; reason: string }> => Object.entries(TASK_ACTION_NOTES).map(([id, reason]) => ({ id: id as TaskActionId, reason: reason ?? "" }));

/**
 * The form and the confirm of one press, for the person who pressed. A refusal (not found, not yours, not offered, stale) is answered INSTEAD of a spec. The confirm digest hashes what this confirm showed this person at this state.
 */
export async function describeAction(env: ActionEnv, caller: ActionCaller, press: { actionId: string; taskId: string; binding: unknown; values?: ActionValues | undefined }): Promise<ActionDescription> {
  const judged = await judge(env, caller, press);
  if (isRefusal(judged)) return { status: "refused", code: judged.code, reason: judged.reason };
  const { entry, task, binding } = judged;
  try {
    const description = entry.describe === undefined ? { spec: { fields: [] } } : await entry.describe(env, caller, task, binding, press.values ?? {});
    const confirmDigest = description.confirm === undefined ? undefined : confirmDigestOf({ action: entry.id, taskId: task.taskId, personId: caller.principal.personId, binding, confirm: description.confirm, bound: description.bound });
    return { status: "ok", label: entry.label(task), spec: description.spec, ...(description.confirm === undefined ? {} : { confirm: description.confirm }), ...(confirmDigest === undefined ? {} : { confirmDigest }), binding };
  } catch (error) {
    const failed = refusalOfError(error);
    return { status: "refused", code: failed.code, reason: failed.reason };
  }
}

export type { ActionBinding };
