// S1: who a person is to a task, read live for one press (4.3). The registry encodes the rules Code applies today; it does not unify them:
//   owner           the one `owner` rule: the person the task runs for or a People co-owner (`loadTaskAsOwner`, the web's rule). Retry, send back, findings, feedback, keep, close, the plan decisions.
//   owner-or-admin  the owner, or a live company owner or admin (`stopStandingOf`). Stop only.
//   readers         anyone who may read the task, and a live company admin (the People view; the People function itself decides what is shown).
// A person who may not read the task gets no standing at all: the surface says "not found", never "not yours", so a task's existence is not told to someone who cannot see it.
import { AgentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { loadTaskAsOwner } from "../task-flow/owner-round.js";
import { decideTaskRead } from "../task-flow/read-rule.js";
import type { TaskRecord } from "../task-flow/records.js";
import type { ActionCaller, Standing, WhoRule } from "./types.js";

const isCompanyAdmin = (role: unknown): boolean => role === "owner" || role === "admin";

/** The person's standing now, or undefined when they may not read the task (or it is not of the company this runtime serves, or they hold a script token). */
export async function standingOf(deps: TaskFlowDeps, caller: ActionCaller, task: TaskRecord): Promise<Standing | undefined> {
  if (caller.principal.companyId !== deps.companyId || task.companyId !== deps.companyId || caller.scriptToken !== undefined) return undefined;
  const admin = isCompanyAdmin(caller.companyRole);
  try {
    const owned = await loadTaskAsOwner(deps, caller, task.taskId);
    return { kind: "owner", acting: owned.acting, admin };
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
  }
  if (admin) return { kind: "admin" };
  // A reader: the one read rule's "readable" read (a failure of it is "no standing", as every failure of this lookup always was).
  const reads = await decideTaskRead(deps, { caller: { principal: caller.principal }, task, read: "readable" }).then(() => true, () => false);
  return reads ? { kind: "reader" } : undefined;
}

/** Whether the standing satisfies the rule. `merge`, `take-over` and `held` are the host's own check, run by their entries. */
export function satisfies(rule: WhoRule, standing: Standing | undefined): boolean {
  if (standing === undefined) return false;
  switch (rule) {
    case "owner": return standing.kind === "owner";
    case "owner-or-admin": return standing.kind === "owner" || standing.kind === "admin";
    // A live company admin who is not the owner reads the People view too: the People function itself then decides what they may see (the same one the web calls).
    case "readers": return true;
    case "merge": case "take-over": return true;
    case "held": return false;
  }
}
