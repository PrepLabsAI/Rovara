import { engineStampKey, stampOf } from "../../core-host/engine-stamp.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";

export async function isCoreFeedbackTask(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord): Promise<boolean> {
  if (task.companyId !== deps.companyId) return false;
  const stamp = await deps.store.get(engineStampKey(task.taskId));
  return stamp?.["orgId"] === task.companyId && stamp["taskId"] === task.taskId && stampOf(stamp)?.areas.flow === "core";
}
