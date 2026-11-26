import { coreTaskMarkKey, coreTaskMarkOf } from "../../core-host/core-task-mark.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";

export async function isCoreFeedbackTask(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord): Promise<boolean> {
  if (task.companyId !== deps.companyId) return false;
  const stamp = await deps.store.get(coreTaskMarkKey(task.taskId));
  return stamp?.["orgId"] === task.companyId && stamp["taskId"] === task.taskId && coreTaskMarkOf(stamp)?.areas.flow === "core";
}
