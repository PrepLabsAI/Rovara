// Spec 067: task readers. A task's owner shares it read-only with another member of the task's project, by developer
// ID. A reader reads the task and its events as the owner does (in the task page's viewer view); what else a share shows is
// the one read rule's table (core/task-flow/read-rule.ts). A reader's access holds only while they are still a member of the project,
// checked on every read; for anyone else a shared task reads as not found, exactly as an unshared one.
//
// Stored on the task's own partition: `DEVTASK#<taskId>` / `READER#<developerId>`.
import { rethrowMembershipReadFailure } from "../developer/membership-read.js";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  TASK_READERS_MAX,
  TaskReaderPutRequestSchema,
  agentXError,
  type TaskReader,
  type TaskReaderDeleteResponse,
  type TaskReaderPutResponse,
  type TaskReadersResponse,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { recordInCompany } from "./company-check.js";
import { taskCompanyId } from "../developer/task-person-identity.js";
import { taskOwnerDevelopers } from "../developer/task-people.js";

export interface TaskReaderPerson {
  /** The person's display name now. */
  name: string;
  /** Whether they hold a grant on the project (a developer or an administrator of it). */
  projectMember: boolean;
  /**
   * Only when asked with `ownTask` (and the task's id): whether they may use the project as a task START does now (`checkProjectAccess`): a grant, or, for an OLD-engine task (no engine stamp), fresh
   * bound-channel membership while the project lets channel members use it. Never given to a reader (a reader needs the grant, `projectMember`).
   */
  mayStart?: boolean;
}

export interface TaskReaderDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  log?(entry: Record<string, unknown>): void;
  /**
   * A registered, not removed person and whether they are a member of `project` in the task's company (`taskCompany`, DEC 254zzz98 review L2: a live member of that company, with
   * its grant); undefined for anyone else. Without it, tasks can't be shared.
   */
  taskReaderPerson?(developerId: string, project: string, taskCompany?: string, options?: { ownTask?: true; taskId?: string }): Promise<TaskReaderPerson | undefined>;
}

interface ReaderRecord {
  pk: string;
  sk: string;
  schemaVersion: 1;
  developerId: string;
  role: "viewer";
  grantedBy: string;
  grantedAt: string;
}

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const readerKey = (taskId: string, developerId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `READER#${developerId}` });

// No company is in scope on this path (a task record and the caller carry none; the AWS broker serves one company here), so the fallback sink is a company-less console line:
// it is one entry of the company-log inventory (tests/fixtures/company-log-sites.json), like the other AWS-path loggers.
const log = (deps: TaskReaderDependencies, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

function developerIdOf(value: string): string {
  // An ID that is not one is never echoed back: it could be long or carry markup.
  if (!DEVELOPER_ID.test(value)) throw agentXError("CONFIG_INVALID", "name the person by their developer ID");
  return value;
}

function person(deps: TaskReaderDependencies): (developerId: string, task: DeveloperTaskRecord) => Promise<TaskReaderPerson | undefined> {
  if (deps.taskReaderPerson === undefined) throw agentXError("NOT_FOUND", "sharing tasks is not set up in this deployment");
  return (developerId, task) => deps.taskReaderPerson!(developerId, task.project, taskCompanyId(task));
}

async function readerRecord(deps: TaskReaderDependencies, taskId: string, developerId: string): Promise<ReaderRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: readerKey(taskId, developerId), ConsistentRead: true })) as { Item?: ReaderRecord };
  return response.Item?.role === "viewer" ? response.Item : undefined;
}

async function readerRecords(deps: TaskReaderDependencies, taskId: string): Promise<ReaderRecord[]> {
  const records: ReaderRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :reader)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":reader": "READER#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: ReaderRecord[]; LastEvaluatedKey?: Record<string, unknown> };
    records.push(...(page.Items ?? []).filter((item) => item.role === "viewer" && DEVELOPER_ID.test(item.developerId)));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return records.sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
}

const view = (record: ReaderRecord, now: TaskReaderPerson | undefined): TaskReader => ({
  developerId: record.developerId, name: (now?.name.trim() || "Unknown").slice(0, 200), role: record.role,
  projectMember: now?.projectMember === true, grantedAt: record.grantedAt,
});

/**
 * The stored share of `developerId` on `task`, for the one read rule (core/task-flow/read-rule.ts, which decides what the share's role may see): the row's role AS STORED (any text; the rule treats a role
 * it does not know as no share), and only while they are still a registered member of the task's project. Undefined for anyone else. The caller has already found they are not the task's own person.
 */
export async function readerShare(deps: TaskReaderDependencies, task: DeveloperTaskRecord, developerId: string): Promise<{ role: string } | undefined> {
  if (deps.taskReaderPerson === undefined) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: readerKey(task.taskId, developerId), ConsistentRead: true })) as { Item?: { role?: unknown } };
  if (typeof response.Item?.role !== "string") return undefined;
  const now = await deps.taskReaderPerson(developerId, task.project, taskCompanyId(task));
  if (now?.projectMember !== true) {
    log(deps, { event: "developer.task_reader_refused", taskId: task.taskId, reason: now === undefined ? "not_registered" : "not_project_member" });
    return undefined;
  }
  return { role: response.Item.role };
}

/**
 * Whether `developerId` OWNS the task now AND still holds the access that makes an owner, read now. Who owns it follows the task's People list when it has one: the people the list names owners (the starter is one
 * only while the list names them so: a starter the list denied, or a task handed or taken over to someone else, is not held by the starter even if the project is granted back), and an owner needs a live company
 * member's own project GRANT (ARCH RULING (b): a person who reaches the project only through its Slack channel is never an owner). With no list it is the task's own stored person, who holds it by the access that
 * let them START it: the project grant, or (the start's own test, `checkProjectAccess`) fresh bound-channel membership while the project lets channel members use it (a task the retired workflow started: DELETE WITH
 * THE OLD TASKS). A person removed from the project or the company, who left the channel, or whose project turned channel use off keeps no hold on their old task through the stored id alone. No way to ask is "no"; a MEMBERSHIP read that
 * fails is the retryable 503 (membership-read.ts), never "no".
 */
export async function holdsOwnTask(deps: Pick<TaskReaderDependencies, "taskReaderPerson" | "documentClient" | "tableName">, task: DeveloperTaskRecord, developerId: string): Promise<boolean> {
  try {
    const owners = await taskOwnerDevelopers(deps, task.taskId);
    if (!namesOwner(owners, task, developerId)) return false;
    const hold = await ownTaskHold(deps, task, developerId);
    // A People list's owner needs the project GRANT; the stored person of a task with no list holds it as the start's own test says (a grant, or for an old-engine task the channel).
    return owners === undefined ? hold !== false : hold === "grant";
  } catch (error) { rethrowMembershipReadFailure(error); return false; }
}

/** Whether the task's records name `developerId` its owner: the People list's owners when it has a list, else the task's own stored person. */
const namesOwner = (owners: readonly string[] | undefined, task: DeveloperTaskRecord, developerId: string): boolean => owners === undefined ? task.developerId === developerId : owners.includes(developerId);

/**
 * How `developerId` holds the task's project now: "grant" (the project grant, the only way a NEW-engine task is held: its start and every step need it), "channel" (an OLD-engine task, no engine stamp, by the start's
 * own test, which also admits bound-channel membership), or false. The engine is read from the task's stamp inside `taskReaderPerson` (a stamp that is there, or cannot be read, is grant only).
 */
async function ownTaskHold(deps: Pick<TaskReaderDependencies, "taskReaderPerson">, task: DeveloperTaskRecord, developerId: string): Promise<"grant" | "channel" | false> {
  if (deps.taskReaderPerson === undefined) return false;
  try {
    const now = await deps.taskReaderPerson(developerId, task.project, taskCompanyId(task), { ownTask: true, taskId: task.taskId });
    return now?.projectMember === true ? "grant" : now?.mayStart === true ? "channel" : false;
  } catch (error) { rethrowMembershipReadFailure(error); return false; }
}

/** The same test as `holdsOwnTask`, as a refusal: the task's own person who no longer holds the project reads as "no such task" (the caller's own words). */
export async function requireOwnTask(deps: Pick<TaskReaderDependencies, "taskReaderPerson" | "documentClient" | "tableName">, task: DeveloperTaskRecord, developerId: string, refusal: () => Error): Promise<void> {
  if (!await holdsOwnTask(deps, task, developerId)) throw refusal();
}

/**
 * Whether a task of the person's own task INDEX lists as theirs: in a company, a task of the caller's, in that company, whose project they still hold as a start would (read now; a grant once per project for one page, in `held`).
 * With no company layer, as it always was (everything the index names).
 */
export async function listsAsOwn(deps: Pick<TaskReaderDependencies, "taskReaderPerson" | "documentClient" | "tableName"> & { companyId?: string | undefined }, task: DeveloperTaskRecord | undefined, developerId: string, held: Map<string, boolean>): Promise<boolean> {
  if (deps.companyId === undefined) return true;
  if (task === undefined || task.developerId !== developerId || !recordInCompany(task, deps.companyId)) return false;
  // The task is theirs to list only while its own People list (if it has one) still names them an owner (per task). A hold by the grant holds for every task of the project (read once per page); a hold by the channel is
  // per task (it depends on the task's engine) and only the stored person of a task with no list has one, so it is never kept.
  try {
    const owners = await taskOwnerDevelopers(deps, task.taskId);
    if (!namesOwner(owners, task, developerId)) return false;
    if (held.get(task.project) === true) return true;
    const hold = await ownTaskHold(deps, task, developerId);
    if (hold === "grant") held.set(task.project, true);
    return owners === undefined ? hold !== false : hold === "grant";
  } catch (error) { rethrowMembershipReadFailure(error); return false; }
}

/** `GET …/readers`: the owner's list. The caller is the owner. */
export async function listTaskReaders(deps: TaskReaderDependencies, task: DeveloperTaskRecord): Promise<TaskReadersResponse> {
  const lookup = person(deps);
  const records = await readerRecords(deps, task.taskId);
  return { readers: await Promise.all(records.slice(0, TASK_READERS_MAX).map(async (record) => view(record, await lookup(record.developerId, task)))) };
}

/** `PUT …/readers/{developerId}`: the owner shares the task with a member of its project. Sharing again changes nothing. */
export async function grantTaskReader(deps: TaskReaderDependencies, task: DeveloperTaskRecord, ownerId: string, rawDeveloperId: string, input: unknown): Promise<TaskReaderPutResponse> {
  const parsed = TaskReaderPutRequestSchema.safeParse(input);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "send a requestId (a UUID) and the role viewer");
  const developerId = developerIdOf(rawDeveloperId);
  if (developerId === ownerId) throw agentXError("CONFIG_INVALID", "you own this task, so you already read it");
  const now = await person(deps)(developerId, task);
  // Not a person and not a member of the project are worded alike, so the answer doesn't say who is registered.
  if (now === undefined || !now.projectMember) throw agentXError("CONFIG_INVALID", `that person isn't a member of ${task.project}; add them to the project first`);
  const existing = await readerRecord(deps, task.taskId, developerId);
  if (existing !== undefined) return { reader: view(existing, now), already: true };
  if ((await readerRecords(deps, task.taskId)).length >= TASK_READERS_MAX) throw agentXError("CONFIG_INVALID", `a task can be shared with at most ${String(TASK_READERS_MAX)} people`);
  const record: ReaderRecord = { ...readerKey(task.taskId, developerId), schemaVersion: 1, developerId, role: "viewer", grantedBy: ownerId, grantedAt: new Date(deps.now()).toISOString() };
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if ((error as { name?: unknown }).name !== "ConditionalCheckFailedException") throw error;
    // A grant raced this one: answer with the one that landed.
    const landed = await readerRecord(deps, task.taskId, developerId);
    if (landed !== undefined) return { reader: view(landed, now), already: true };
    throw error;
  }
  log(deps, { event: "developer.task_reader_granted", taskId: task.taskId, owner: ownerId, reader: developerId, requestId: parsed.data.requestId });
  return { reader: view(record, now), already: false };
}

/** `DELETE …/readers/{developerId}`: the owner stops sharing the task with someone. */
export async function revokeTaskReader(deps: TaskReaderDependencies, task: DeveloperTaskRecord, ownerId: string, rawDeveloperId: string): Promise<TaskReaderDeleteResponse> {
  const developerId = developerIdOf(rawDeveloperId);
  try {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: readerKey(task.taskId, developerId), ConditionExpression: "attribute_exists(pk)" }));
  } catch (error) {
    if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") return { developerId, removed: false };
    throw error;
  }
  log(deps, { event: "developer.task_reader_revoked", taskId: task.taskId, owner: ownerId, reader: developerId });
  return { developerId, removed: true };
}
