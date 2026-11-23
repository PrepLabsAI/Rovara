// The close guard's way to ask for a check of a workspace's unpublished work (`CloseCheckPort`). It writes ONE durable close preparation for the workspace's next fence and nothing else: it starts no machine, writes nothing to the task or the machine, and a repeat
// (the person pressing Close again, a sweep coming round) finds the preparation and answers `already` without a write. The preparation runs on the dispatcher, which starts a stopped machine, retains the workspace and inspects it
// (`close-preparation.ts`), after which the close preview exists and only a bound close can destroy anything. A workspace that cannot be checked at all (an old worker, a failed or deleted session) answers `unsupported`: nothing is promised.
import type { TaskFlowDeps } from "./deps.js";
import { closeOperationId } from "./close-acceptance-record.js";
import { mergeCloseConditions } from "./close-conditions.js";
import type { CloseCheckPort } from "./close-guard.js";
import { planClosePreparation } from "./close-preparation.js";
import { readOperation } from "./results.js";
import type { TaskRecord, WorkspaceRecord } from "./records.js";
import { log } from "./support.js";

export async function requestCloseCheck(deps: TaskFlowDeps, task: TaskRecord, workspace: WorkspaceRecord): Promise<"queued" | "already" | "unsupported"> {
  const availability = await deps.closeInspection?.availability?.(workspace.id);
  if (availability === undefined || availability === "unsupported") return "unsupported";
  const items = await planClosePreparation(deps, workspace, workspace, { wake: availability === "wake" });
  if (items.length === 0) return "unsupported";
  if ((await deps.store.transact(mergeCloseConditions(items))).applied) {
    log(deps, { event: "task_flow.close_check_requested", taskId: task.taskId, wake: availability === "wake" });
    return "queued";
  }
  // Lost: the same fence's preparation already exists (a repeat), or the workspace moved (a step took it). Only the first is a check that will answer.
  const existing = await readOperation(deps, workspace.id, closeOperationId(deps.companyId, workspace.id, `preflight:${workspace.fence + 1}`));
  return existing === undefined ? "unsupported" : "already";
}

/** Stateless: it takes the flow's own deps from the guard, so both roots wire the same object. */
export const closeCheckPort: CloseCheckPort = { request: (task, workspace, deps) => requestCloseCheck(deps, task, workspace) };
