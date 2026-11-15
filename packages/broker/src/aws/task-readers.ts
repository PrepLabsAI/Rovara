// Spec 067: task readers. A task's owner shares it read-only with another member of the task's project, by developer
// ID. A reader reads the task and its events as the owner does (in the task page's viewer view) and nothing else: every
// other task route keeps its owner-only check. A reader's access holds only while they are still a member of the project,
// checked on every read; for anyone else a shared task reads as not found, exactly as an unshared one.
//
// Stored on the task's own partition: `DEVTASK#<taskId>` / `READER#<developerId>`.
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

export interface TaskReaderPerson {
  /** The person's display name now. */
  name: string;
  /** Whether they hold a grant on the project (a developer or an administrator of it). */
  projectMember: boolean;
}

export interface TaskReaderDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  log?(entry: Record<string, unknown>): void;
  /** A registered, not removed person and whether they are a member of `project`; undefined for anyone else. Without it, tasks can't be shared. */
  taskReaderPerson?(developerId: string, project: string): Promise<TaskReaderPerson | undefined>;
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

const log = (deps: TaskReaderDependencies, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

function developerIdOf(value: string): string {
  // An ID that is not one is never echoed back: it could be long or carry markup.
  if (!DEVELOPER_ID.test(value)) throw agentXError("CONFIG_INVALID", "name the person by their developer ID");
  return value;
}

function person(deps: TaskReaderDependencies): (developerId: string, project: string) => Promise<TaskReaderPerson | undefined> {
  if (deps.taskReaderPerson === undefined) throw agentXError("NOT_FOUND", "sharing tasks is not set up in this deployment");
  return (developerId, project) => deps.taskReaderPerson!(developerId, project);
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
 * Whether `developerId` reads `task` as a reader now: a reader record, and still a registered member of the task's project. The
 * caller has already found they are not its owner.
 */
export async function readsAsReader(deps: TaskReaderDependencies, task: DeveloperTaskRecord, developerId: string): Promise<boolean> {
  if (deps.taskReaderPerson === undefined) return false;
  if (await readerRecord(deps, task.taskId, developerId) === undefined) return false;
  const now = await deps.taskReaderPerson(developerId, task.project);
  if (now?.projectMember !== true) {
    log(deps, { event: "developer.task_reader_refused", taskId: task.taskId, reason: now === undefined ? "not_registered" : "not_project_member" });
    return false;
  }
  return true;
}

/** `GET …/readers`: the owner's list. The caller is the owner. */
export async function listTaskReaders(deps: TaskReaderDependencies, task: DeveloperTaskRecord): Promise<TaskReadersResponse> {
  const lookup = person(deps);
  const records = await readerRecords(deps, task.taskId);
  return { readers: await Promise.all(records.slice(0, TASK_READERS_MAX).map(async (record) => view(record, await lookup(record.developerId, task.project)))) };
}

/** `PUT …/readers/{developerId}`: the owner shares the task with a member of its project. Sharing again changes nothing. */
export async function grantTaskReader(deps: TaskReaderDependencies, task: DeveloperTaskRecord, ownerId: string, rawDeveloperId: string, input: unknown): Promise<TaskReaderPutResponse> {
  const parsed = TaskReaderPutRequestSchema.safeParse(input);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "send a requestId (a UUID) and the role viewer");
  const developerId = developerIdOf(rawDeveloperId);
  if (developerId === ownerId) throw agentXError("CONFIG_INVALID", "you own this task, so you already read it");
  const now = await person(deps)(developerId, task.project);
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
