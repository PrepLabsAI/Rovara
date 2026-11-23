import { agentXError, change, when, workspaceSessionKey, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { TaskRecord } from "./records.js";
import { taskKey } from "./keys.js";
import { workspaceOperations } from "./reads.js";
import { readWorkspace } from "./stage-machine.js";
import { readOperation } from "./results.js";
import { workspaceKeys } from "./workspace-location.js";
import { closeFacts } from "./close-conditions.js";
import { toDocument } from "./records.js";
import { CLOSE_TRY_AGAIN_WORDS, retainedCloseWords } from "./close-words.js";

/** Serializes legacy flushing/closure against retention preparation. This is no destruction authority. */
export async function claimLegacyClose(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  if (task.closedAt !== undefined) return;
  const refuse = () => agentXError("WORKSPACE_BUSY", retainedCloseWords(task.taskId));
  const session = await deps.store.get(workspaceSessionKey(task.workspaceId));
  if (session !== undefined && (Object.hasOwn(session, "closeRetention") || Object.hasOwn(session, "closeDestroy"))) throw refuse();
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined) return;
  const location = await workspaceKeys(deps, workspace.id);
  const operation = workspace.activeOperationId === null ? undefined : await readOperation(deps, workspace.id, workspace.activeOperationId);
  const operations = await workspaceOperations(deps, workspace.id);
  if (operations.some(op => op.closePreflight?.target !== undefined || (op.result as { closeInspection?: unknown } | undefined)?.closeInspection !== undefined)) throw refuse();
  const items: TransactItem[] = [
    { kind: "check", key: workspaceSessionKey(workspace.id), condition: when.and(when.notExists("closeRetention"), when.notExists("closeDestroy")) },
    { kind: "check", key: taskKey(task.taskId), condition: when.and(when.eq("companyId", deps.companyId), when.eq("workspaceId", task.workspaceId), when.notExists("closedAt"), when.notExists("closeOperationId")) },
    { kind: "update", key: location.workspaceKey,
      condition: when.and(when.eq("companyId", deps.companyId), when.eq("fence", workspace.fence), when.eq("activeOperationId", workspace.activeOperationId), when.or(when.notExists("legacyCloseClaim"), when.eq("legacyCloseClaim", task.taskId))),
      ops: [change.set("legacyCloseClaim", task.taskId)] },
    ...(operation === undefined ? [] : [{ kind: "check" as const, key: location.operationKey(operation.id), condition: closeFacts(toDocument(operation), ["kind", "fence", "closePreflight", "result"]) }]),
  ];
  // Every sign of a retention was read above and refused with its own words. What is left is a race (a step took the workspace, a check started, the fence moved): nothing is retained that the person could review,
  // so the answer is the transient 'try again', never the retained sentence.
  if (!(await deps.store.transact(items)).applied) throw agentXError("WORKSPACE_BUSY", CLOSE_TRY_AGAIN_WORDS);
}

/** Gives the workspace back when the close that claimed it did not close (a conflict, a flush that threw): a claim nobody finishes would hold every later step and check. A no-op when the close committed (the commit removed it). */
export async function releaseLegacyClose(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  const location = await workspaceKeys(deps, task.workspaceId);
  await deps.store.update({ key: location.workspaceKey, condition: when.and(when.eq("companyId", deps.companyId), when.eq("legacyCloseClaim", task.taskId)), ops: [change.remove("legacyCloseClaim")] }).catch(() => undefined);
}
