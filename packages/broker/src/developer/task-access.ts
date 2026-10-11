// Spec 061 slice 2: who may do what on a task page. Every check goes through resolveTaskAccess and the one role-to-action
// table below, so roles (slice 3) change only these two places; callers never decide roles themselves.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { taskKey, type DeveloperTaskRecord } from "./task-records.js";

/** `owner`: the task's developer. `commenter`: a member of the task's channel who can use its project. */
export type TaskRole = "owner" | "commenter";
export type TaskAction = "read" | "comment" | "suggest" | "decide" | "ask";

export const TASK_ACTION_ROLES: Record<TaskAction, readonly TaskRole[]> = {
  read: ["owner", "commenter"],
  comment: ["owner", "commenter"],
  suggest: ["commenter"],
  decide: ["owner"],
  ask: ["owner", "commenter"],
};

export function can(role: TaskRole, action: TaskAction): boolean {
  return TASK_ACTION_ROLES[action].includes(role);
}

/** A reader's access to one task: the task as stored, and their role on it. */
export interface TaskAccess { task: DeveloperTaskRecord; role: TaskRole }

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type AccessDependencies = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "checkAccess" | "channelMember" | "slackTeamId" | "log">;

const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

/**
 * The task a task-page reader may see, and their role. Not theirs and no such task both read as TASK_NOT_FOUND; only an
 * eligible teammate on the task's own Slack workspace who is not in the task's channel gets TASK_ACCESS_DENIED, with the
 * owner's name (FR-029). Whatever fails on the way (the project check, the membership lookup) reads as not found too,
 * because an answer that differed would confirm the task exists.
 */
export async function resolveTaskAccess(deps: AccessDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskAccess> {
  const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (!TASK_ID.test(taskId)) throw notFound();
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  const task = response.Item;
  if (task === undefined) throw notFound();
  if (task.developerId === caller.developerId) return { task, role: "owner" };
  let usesProject = false;
  try {
    await deps.checkAccess(task.project);
    usesProject = true;
  } catch (error) {
    log(deps, { event: "developer.task_page_project_access_refused", taskId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  const share = task.share;
  if (!usesProject || share === undefined || caller.slackUserId === undefined || deps.channelMember === undefined) throw notFound();
  let member: boolean;
  try {
    member = await deps.channelMember(caller.slackUserId, share.channelId);
  } catch (error) {
    log(deps, { event: "developer.task_page_membership_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
    throw notFound();
  }
  if (!member) {
    // Only someone on the task's own Slack workspace who may use the project is told whom to ask.
    if (deps.slackTeamId === undefined || share.teamId !== deps.slackTeamId) throw notFound();
    throw Object.assign(agentXError("TASK_ACCESS_DENIED", "you can't open this task yet"), { owners: [task.developerName] });
  }
  return { task, role: "commenter" };
}

/** Whether the task still takes comments, suggestions and decisions: not closed and not finished. */
export function taskOpen(task: DeveloperTaskRecord): boolean {
  return task.closedAt === undefined && task.workflow?.stage !== "CLOSED" && task.workflow?.stage !== "MERGED";
}

/** What a reader may do on the page now, for the page view. */
export function pageAccess(access: TaskAccess): { role: TaskRole; canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean } {
  const open = taskOpen(access.task);
  return {
    role: access.role,
    canComment: open && can(access.role, "comment"),
    canSuggest: open && can(access.role, "suggest"),
    canDecide: open && can(access.role, "decide"),
    canAsk: open && can(access.role, "ask"),
  };
}
