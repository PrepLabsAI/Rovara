// The existing page comment APIs, for either stored engine. Core comments need
// the caller's live company before the same task-role rule is evaluated.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { ownerOfExistingTask } from "../aws/engine-boundary.js";
import { rowInCompany } from "./company-rows.js";
import { resolveCoreTaskAccess, resolveTaskAccess, type TaskAccess } from "./task-access.js";
import { taskKey, type DeveloperTaskRecord } from "./task-records.js";

export async function resolvePageCommentAccess(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskAccess> {
  if (await ownerOfExistingTask(deps, taskId) !== "core") return resolveTaskAccess(deps, caller, taskId);
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  const task = response.Item;
  if (task === undefined || deps.companyId === undefined || !rowInCompany(task as unknown as Record<string, unknown>, deps.companyId)) {
    throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  }
  return resolveCoreTaskAccess(deps, caller, task);
}
