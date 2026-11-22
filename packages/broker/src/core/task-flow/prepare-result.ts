import { change, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord } from "./records.js";
import { prepareWatchKey } from "./prepare-watch.js";
import { releaseItems } from "./limits.js";
import { chargeMarkerKey, taskKey } from "./keys.js";
import { readTask } from "./reads.js";
import { workspaceKeys } from "./workspace-location.js";
import { iso } from "./support.js";

/** The failed preparation's pending prompt and workspace slot end in its result's own transaction. */
export async function preparationResultItems(deps: TaskFlowDeps, operation: OperationRecord, status: string): Promise<TransactItem[]> {
  if (operation.kind !== "prepare") return [];
  const items: TransactItem[] = [{ kind: "delete", key: prepareWatchKey(deps.companyId, operation.createdAt, operation.workspaceId) }];
  if (status === "SUCCEEDED") return items;
  const location = await workspaceKeys(deps, operation.workspaceId);
  const pointer = await deps.store.get(location.taskPointerKey());
  if (typeof pointer?.["taskId"] !== "string") return items;
  items.push({ kind: "update", key: location.taskPointerKey(), ops: [change.remove("pendingPrompt"), change.remove("pendingWorkflowMode")], condition: when.eq("taskId", pointer["taskId"]) });
  const task = await readTask(deps, pointer["taskId"]);
  if (task !== undefined && await deps.store.get(chargeMarkerKey(task.charge, task.taskId)) !== undefined) {
    items.push(...releaseItems(task.charge, task.taskId));
    items.push({ kind: "update", key: taskKey(task.taskId), ops: [change.set("releasedAt", iso(deps))], condition: when.eq("workspaceId", operation.workspaceId) });
  }
  return items;
}
