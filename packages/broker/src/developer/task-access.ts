// Spec 061 slice 2: who may do what on a task page. Every check goes through resolveTaskAccess and the one role-to-action
// table below, so roles (slice 3) change only these two places; callers never decide roles themselves.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { resolveTaskPeopleAccess, type TaskRole } from "./task-people.js";
import { taskKey, taskOwnerKey, type DeveloperTaskRecord } from "./task-records.js";
import { requireOwnTask } from "../aws/task-readers.js";
import { ownerOfExistingTask } from "../aws/engine-boundary.js";

export type { TaskRole } from "./task-people.js";
export type TaskAction = "read" | "peopleRead" | "comment" | "suggest" | "decide" | "ask" | "peopleManage" | "takeOwnership" | "retry" | "publish" | "feedback" | "close" | "control";

export const TASK_ACTION_ROLES: Record<TaskAction, readonly TaskRole[]> = {
  read: ["owner", "commenter", "viewer"],
  peopleRead: ["owner", "commenter", "viewer"],
  comment: ["owner", "commenter"],
  suggest: ["commenter"],
  decide: ["owner"],
  ask: ["owner", "commenter"],
  peopleManage: ["owner"],
  takeOwnership: ["owner", "commenter", "viewer"],
  retry: ["owner"],
  publish: ["owner"],
  feedback: ["owner"],
  close: ["owner"],
  control: ["owner"],
};

export function can(role: TaskRole, action: TaskAction): boolean {
  return TASK_ACTION_ROLES[action].includes(role);
}

/** A reader's access to one task, including the exact PEOPLE revision later writes must fence. */
export interface TaskAccess {
  task: DeveloperTaskRecord;
  role: TaskRole;
  peopleRevision?: number;
  ownerActorIds: readonly string[];
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AccessDependencies = Pick<DeveloperTaskRouteDependencies,
  "documentClient" | "tableName" | "checkAccess" | "channelMember" | "slackTeamId" | "log" | "now" | "taskPeopleConfiguration" | "checkTaskPerson" | "workspaceForTask" | "coreTasks" | "taskReaderPerson">;

const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

/**
 * The task a task-page reader may see, and their role. Not theirs and no such task both read as TASK_NOT_FOUND; only an
 * eligible teammate on the task's own Slack workspace who is not in the task's channel gets TASK_ACCESS_DENIED, with the
 * owner's name (FR-029). Whatever fails on the way (the project check, the membership lookup) reads as not found too,
 * because an answer that differed would confirm the task exists. With `action`, a reader whose possible roles could
 * not take it is refused as not found before any project or channel lookup.
 */
export async function resolveTaskAccess(deps: AccessDependencies, caller: DeveloperCaller, taskId: string, action?: TaskAction): Promise<TaskAccess> {
  const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (!TASK_ID.test(taskId)) throw notFound();
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  const task = response.Item;
  if (task === undefined) throw notFound();
  // Lane E2: a task the core owns is never acted on through the workflow's access (engine-boundary.ts); it reads exactly like a missing one.
  if (await ownerOfExistingTask(deps, taskId) === "core") throw notFound();
  return await taskAccessOfRecord(deps, caller, task, action, taskId);
}

/** Existing review-page reads use the core's own authenticated GET before reusing the page's role projection. Writes keep resolveTaskAccess's engine boundary. */
export async function resolveTaskReadAccess(deps: AccessDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskAccess> {
  if (!TASK_ID.test(taskId)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (await ownerOfExistingTask(deps, taskId) !== "core") return resolveTaskAccess(deps, caller, taskId, "read");
  const answer = await deps.coreTasks?.route({ method: "GET", path: `/v1/dev/tasks/${taskId}`, headers: {} }, caller);
  if (answer?.statusCode !== 200) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  if (response.Item === undefined) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  return resolveCoreTaskAccess(deps, caller, response.Item, "read");
}

/**
 * Core task web routes (Cloud #188 item 3): the very same rule as `resolveTaskAccess`, for a core task's record that the CORE has already read and checked against the caller's live company (aws/core-task-rule-routes.ts).
 * The core's routes mirror the old task routes' access exactly by calling this one function; nothing here knows which engine runs the task.
 */
export async function resolveCoreTaskAccess(deps: AccessDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, action?: TaskAction): Promise<TaskAccess> {
  if (!TASK_ID.test(task.taskId)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  return await taskAccessOfRecord(deps, caller, task, action, task.taskId);
}

async function taskAccessOfRecord(deps: AccessDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, action: TaskAction | undefined, taskId: string): Promise<TaskAccess> {
  const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
  try {
    const people = await resolveTaskPeopleAccess(deps, task, caller.developerId);
    if (people !== undefined) {
      if (action !== undefined) {
        const read = action === "read" || action === "peopleRead";
        if ((!read && !taskOpen(task)) || !can(people.role, action)
          || (action === "takeOwnership" && !people.canTakeOwnership)
          || ((action === "peopleManage" || action === "takeOwnership") && deps.taskPeopleConfiguration?.peopleChangesEnabled !== true)) throw notFound();
      }
      return { task, role: people.role, peopleRevision: people.peopleRevision, ownerActorIds: people.ownerActorIds };
    }
  } catch {
    throw notFound();
  }
  const legacyOwners = [taskOwnerKey(task.developerId, task.taskId)];
  const legacyPeopleAction = action === "peopleManage" || action === "takeOwnership";
  if (task.developerId === caller.developerId) {
    // The stored person (a task with no People list) keeps it only while a LIVE member of the task's company who still holds the project grant (the test a People entry meets and a reader meets):
    // removed from the project or the company, the task reads as not found for them.
    await requireOwnTask(deps, task, caller.developerId, notFound);
    if (legacyPeopleAction || (action !== undefined && action !== "read" && action !== "peopleRead" && !taskOpen(task))) throw notFound();
    return { task, role: "owner", ownerActorIds: legacyOwners };
  }
  // An action only owners may take needs no project or channel lookup for anyone else: they read as not found.
  if (action !== undefined && TASK_ACTION_ROLES[action].every((role) => role === "owner")) throw notFound();
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
  let scopedTeam: string | undefined;
  try {
    const workspace = await deps.workspaceForTask?.(task);
    scopedTeam = workspace?.teamId;
    member = workspace === undefined ? await deps.channelMember(caller.slackUserId, share.channelId) : await deps.channelMember(caller.slackUserId, share.channelId, workspace);
  } catch (error) {
    log(deps, { event: "developer.task_page_membership_unavailable", taskId, errorName: error instanceof Error ? error.name : "unknown" });
    throw notFound();
  }
  if (!member) {
    // Only someone on the task's own Slack workspace who may use the project is told whom to ask.
    if ((scopedTeam ?? deps.slackTeamId) === undefined || share.teamId !== (scopedTeam ?? deps.slackTeamId)) throw notFound();
    throw Object.assign(agentXError("TASK_ACCESS_DENIED", "you can't open this task yet"), { owners: [ownerNameForReaders(task.developerName)] });
  }
  if (legacyPeopleAction || (action !== undefined && (!can("commenter", action)
    || (action !== "read" && action !== "peopleRead" && !taskOpen(task))))) throw notFound();
  return { task, role: "commenter", ownerActorIds: legacyOwners };
}

/**
 * The owner's name as a reader outside the channel is told it. A task started in Slack knows its owner only by Slack
 * user ID ("Slack user U0…"), which is no name a person recognises, so the reader is told to ask the task owner.
 */
export function ownerNameForReaders(developerName: string): string {
  return /^Slack user [UW][A-Z0-9]{2,31}$/.test(developerName) ? "the task owner" : developerName;
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
