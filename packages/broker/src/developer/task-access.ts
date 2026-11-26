// Spec 061 slice 2: who may do what on a task page. Every check goes through resolveTaskAccess and the one role-to-action
// table below, so roles (slice 3) change only these two places; callers never decide roles themselves.
import { rethrowMembershipReadFailure } from "../core/membership-read.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { resolveTaskPeopleAccess, taskListBinding, type TaskRole } from "./task-people.js";
import { taskKey, taskOwnerKey, type DeveloperTaskRecord } from "./task-records.js";
import { readerKey, requireOwnTask } from "../aws/task-readers.js";
import { isCoreTaskThatExists } from "../aws/engine-boundary.js";

export type { TaskRole } from "./task-people.js";
export type TaskAction = "read" | "peopleRead" | "comment" | "commentWrite" | "suggest" | "decide" | "ask" | "peopleManage" | "takeOwnership" | "retry" | "publish" | "feedback" | "close" | "control";

export const TASK_ACTION_ROLES: Record<TaskAction, readonly TaskRole[]> = {
  read: ["owner", "commenter", "viewer"],
  peopleRead: ["owner", "commenter", "viewer"],
  // `comment` is the Slack thread's "continue" (broker.ts slackTaskAccess): it keeps its roles.
  comment: ["owner", "commenter"],
  // READ-RULE-SHARE-B (owner DEC 254zzz577, rule 3): the plan-page comment WRITE. A People-list viewer ("Can view") writes one too, as the stored share does; a viewer still never suggests, decides, asks, continues a Slack thread or acts.
  commentWrite: ["owner", "commenter", "viewer"],
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
  /** The person is not on the task's People list: they read only because the task is shared into a Slack channel they are in (a commenter). The read rule decides what that grants (`CHANNEL_SHARE_PARTS`). */
  viaChannelShare?: true;
  /**
   * The stored share row ("Can view", spec 067) this access came from, when it did (`sharedCommenterAccess`): the comment's transaction checks that row still holds (a share revoked between the decision and the write
   * writes nothing: the write is tied to the row, READ-RULE-SHARE-B / Opus S5). Absent for every access that does not come from a stored share.
   */
  sharedRow?: { pk: string; sk: string };
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
  if (await isCoreTaskThatExists(deps, taskId)) throw notFound();
  return await taskAccessOfRecord(deps, caller, task, action, taskId);
}


/**
 * Core task web routes (Cloud #188 item 3): the very same rule as `resolveTaskAccess`, for a core task's record that the CORE has already read and checked against the caller's live company (aws/core-task-rule-routes.ts).
 * The core's routes mirror the old task routes' access exactly by calling this one function; nothing here knows which engine runs the task.
 */
export async function resolveCoreTaskAccess(deps: AccessDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord, action?: TaskAction): Promise<TaskAccess> {
  if (!TASK_ID.test(task.taskId)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  return await taskAccessOfRecord(deps, caller, task, action, task.taskId);
}

/**
 * A person the task is shared with by the stored share ("Can view", spec 067) comments as the People list's commenter does for a channel share: the role is `commenter` (it comments, never acts or decides), bound to the
 * list's revision and owners where the task has a list. The CALLER proves the share (the one read rule's decision says `shared` for this person on this task); nothing here decides who is a share, and a task that is closed
 * still refuses the comment itself.
 */
export async function sharedCommenterAccess(deps: AccessDependencies, task: DeveloperTaskRecord, developerId: string): Promise<TaskAccess> {
  const binding = await taskListBinding(deps, task, developerId);
  // REMOVAL WINS at the write too: the list read that supplies the fence's revision is the SAME read that says whether this person is denied, so a deny landing after the rule's decision cannot slip a comment through behind a fresh revision.
  if (binding.role === "denied") throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  return { task, role: "commenter", sharedRow: readerKey(task.taskId, developerId), ownerActorIds: binding.ownerActorIds ?? [taskOwnerKey(task.developerId, task.taskId)], ...(binding.peopleRevision === undefined ? {} : { peopleRevision: binding.peopleRevision }) };
}

/** The person reads only because the task is shared into a Slack channel they are in (the People list does not name them). */
function channelShareOf(people: { implicit: boolean }): { viaChannelShare?: true } {
  return people.implicit ? { viaChannelShare: true } : {};
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
      return { task, role: people.role, peopleRevision: people.peopleRevision, ownerActorIds: people.ownerActorIds, ...channelShareOf(people) };
    }
  } catch (error) {
    // A membership or grant read that FAILED is the retryable 503 (membership-read.ts), never "no such task".
    rethrowMembershipReadFailure(error);
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
    rethrowMembershipReadFailure(error);
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

