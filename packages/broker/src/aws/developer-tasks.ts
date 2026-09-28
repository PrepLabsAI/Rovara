// Spec 025 FR-016 to FR-021: the developer task routes. Every task has its own workspace, reached
// through the existing handlers (DeveloperTaskActions) with the task's owner key. Nothing here
// reads the deployment mode (FR-024).
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  DEVELOPER_EVENTS_DEFAULT,
  DEVELOPER_EVENTS_MAX,
  DEVELOPER_TASK_LIST_DEFAULT,
  DEVELOPER_TASK_LIST_MAX,
  DEVELOPER_TASK_SUMMARY_MAX,
  DeveloperTaskStatusSchema,
  StartDeveloperTaskRequestSchema,
  agentXError,
  cleanClientName,
  diffStat,
  lastAssistantResponse,
  redactText,
  taskTitle,
  type DeveloperTaskListItem,
  type DeveloperTaskPolicy,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type Operation,
  type StartDeveloperTaskRequest,
} from "@agentx/contracts";
import type { z } from "zod";
import { chargeConflict, chargeItems, developerCharge, limitReached, readWorkspaceLimits, type ChargeConflict, type WorkspaceLimits } from "../developer/limits.js";
import {
  aiToolTurn,
  byCreated,
  deriveTaskStatus,
  developerTaskIdentity,
  recentTaskEvents,
  startIdempotencyKey,
  taskIndexKey,
  taskKey,
  taskPointerKey,
  type DeveloperTaskIndexRecord,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
  type TurnParty,
  type WorkspaceCharge,
} from "../developer/task-records.js";
import { hashJson, isConditional } from "./broker-shared.js";
import type { DeveloperTaskActions, TransactItems } from "./developer-task-actions.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export interface DeveloperTaskRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  slackTeamId?: string;
  actions: DeveloperTaskActions;
  checkAccess(project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel" }>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (deps: DeveloperTaskRouteDependencies) => new Date(deps.now()).toISOString();
const log = (deps: DeveloperTaskRouteDependencies, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

function parse<T>(schema: z.ZodType<T>, body: unknown, deps: DeveloperTaskRouteDependencies, route: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "body";
  // Field names only: the values are the developer's text (R12).
  log(deps, { event: "developer.task_request_invalid", route, field });
  throw agentXError("CONFIG_INVALID", `${field}: ${issue?.message ?? "invalid"}`);
}

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

async function get<T>(deps: DeveloperTaskRouteDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

const putNew = (tableName: string, item: Record<string, unknown>) => ({ Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } });

function turnTable(deps: DeveloperTaskRouteDependencies): string {
  const table = deps.actions.turnRecordsTableName;
  // FR-037: an action that cannot be audited does not run.
  if (table === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment; developer tasks are off");
  return table;
}

/** One EMF line for the RecordingFailures alarm, which already sums TurnRecordWriteFailed. */
function turnRecordFailed(deps: DeveloperTaskRouteDependencies, error: unknown) {
  console.log(JSON.stringify({
    _aws: { Timestamp: deps.now(), CloudWatchMetrics: [{ Namespace: process.env.AGENTX_METRICS_NAMESPACE || "AgentX", Dimensions: [[]], Metrics: [{ Name: "TurnRecordWriteFailed", Unit: "Count" }] }] },
    component: "broker", event: "developer.turn_record_failed", error: error instanceof Error ? error.name : "unknown", TurnRecordWriteFailed: 1,
  }));
}

function partyOf(caller: DeveloperCaller, taskId: string, client: string): TurnParty {
  return {
    taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  };
}

/**
 * FR-030's title, redacted before taskTitle cuts it: the title is stored in the task and index
 * rows, shown in views and listed in WORKSPACE_LIMIT messages, so a secret on the instructions'
 * first line must not reach any of them. Redacting first means the cut cannot leave half a token
 * the redactor would miss; taskTitle's cut counts code points, so it never splits an emoji.
 */
function redactedTitle(request: StartDeveloperTaskRequest): string {
  return taskTitle(redactText(request.instructions), request.title === undefined ? undefined : redactText(request.title));
}

/**
 * R12: the refused start's audit record, its own PutItem under the task ID the start would have
 * used (no workspace exists, so there is no action transaction to join; ruling F15). A failed
 * write is counted and logged, and never hides the refusal.
 */
async function refuse(deps: DeveloperTaskRouteDependencies, turns: string, party: TurnParty, request: StartDeveloperTaskRequest, receivedAt: string, error: AgentXError): Promise<never> {
  try {
    const record = aiToolTurn({
      party, turnId: randomUUID(), action: "start", phase: "refused", outcome: "refused", receivedAt, finishedAt: iso(deps),
      request: request.instructions, response: error.message, errorCode: error.code,
    });
    await deps.documentClient.send(new PutCommand({ TableName: turns, Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (writeError) {
    turnRecordFailed(deps, writeError);
  }
  throw error;
}

/** The developer's own task, or TASK_NOT_FOUND for anyone else and for a malformed ID (FR-036). */
export async function loadOwnedTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<DeveloperTaskRecord> {
  const task = TASK_ID.test(taskId) ? await get<DeveloperTaskRecord>(deps, taskKey(taskId)) : undefined;
  if (task === undefined || task.developerId !== caller.developerId) {
    // A malformed ID is never echoed back: it could be long or carry markup.
    throw agentXError("TASK_NOT_FOUND", TASK_ID.test(taskId) ? `no task ${taskId} of yours; run agentx_list_tasks` : "that is not a task ID of yours; run agentx_list_tasks");
  }
  return task;
}

const DIFF_READ_BYTES = 1_000_000;
const ARTIFACT_NAME_MAX = 200;
const DIFF_ARTIFACT = "workspace.diff";

type TaskDetails = Pick<DeveloperTaskView, "summary" | "changedFiles" | "artifacts" | "pullRequests">;

/**
 * Whether an artifact's stored object key lies under this task's own workspace and operation.
 * The key comes from the artifact record, never from the client, but the record's name came from
 * the worker, so a key is read only when it has exactly the prefix the broker writes
 * (`private/<ownerKey>/<workspaceId>/<operationId>/<artifactId>`) and no path segments after it.
 */
function ownArtifactKey(task: DeveloperTaskRecord, operationId: string, objectKey: string): boolean {
  const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operationId}/`;
  return objectKey.startsWith(prefix) && /^[A-Za-z0-9-]+$/.test(objectKey.slice(prefix.length));
}

/** R18: what the latest task operation left, and the task's pull requests. Callers load the owned task first. */
async function taskDetails(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operations: readonly Operation[]): Promise<TaskDetails> {
  const pullRequests = await deps.actions.pullRequests(task.workspaceId);
  const details: TaskDetails = {};
  const lastTask = operations.filter((operation) => operation.kind === "task").sort(byCreated).at(-1);
  if (lastTask !== undefined) {
    const said = lastAssistantResponse((await deps.actions.eventsNewestFirst(lastTask.id, 500)).reverse());
    if (said !== undefined) details.summary = redactText(said).slice(0, DEVELOPER_TASK_SUMMARY_MAX);
    const artifacts = await deps.actions.artifacts(task.workspaceId, lastTask.id);
    details.artifacts = artifacts.map((artifact) => ({ name: redactText(artifact.name).slice(0, ARTIFACT_NAME_MAX), ...(artifact.size === undefined ? {} : { size: artifact.size }) }));
    const diff = artifacts.find((artifact) => artifact.name === DIFF_ARTIFACT);
    if (diff !== undefined) {
      if (ownArtifactKey(task, lastTask.id, diff.objectKey)) {
        details.changedFiles = diffStat(await deps.actions.readArtifact(diff.objectKey, DIFF_READ_BYTES))
          .map((file) => ({ ...file, repository: redactText(file.repository), path: redactText(file.path) }));
      } else {
        // The key is not logged: it names another workspace.
        log(deps, { event: "developer.task_artifact_key_refused", taskId: task.taskId, artifactId: diff.id });
      }
    }
  }
  if (pullRequests.length > 0) details.pullRequests = pullRequests;
  return details;
}

/** The live view of a task (R4), with the result details once it has ended. Callers load the owned task first. */
export async function taskView(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, options: { events: number; details: boolean }): Promise<DeveloperTaskView> {
  const [workspace, pointer, operations] = await Promise.all([
    deps.actions.workspace(task.workspaceId),
    get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
    deps.actions.operations(task.workspaceId),
  ]);
  const derived = deriveTaskStatus({
    closedAt: task.closedAt,
    workspaceStatus: workspace.status,
    pointer,
    operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, error: operation.error, createdAt: operation.createdAt })),
  });
  const events = derived.current === undefined || options.events === 0
    ? []
    : recentTaskEvents(await deps.actions.eventsNewestFirst(derived.current.id, 200), options.events);
  const details = options.details && derived.status !== "STARTING" && derived.status !== "RUNNING" ? await taskDetails(deps, task, operations) : {};
  return {
    taskId: task.taskId,
    title: task.title,
    project: task.project,
    status: derived.status,
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
    startingRevision: task.startingRevision,
    client: task.client,
    shared: task.shared,
    ...(derived.closing ? { closing: true } : {}),
    createdAt: task.createdAt,
    updatedAt: derived.current?.createdAt ?? task.updatedAt,
    events,
    ...details,
  };
}

async function openTasksText(deps: DeveloperTaskRouteDependencies, developerId: string): Promise<string> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" },
    ScanIndexForward: false,
    Limit: 50,
    ConsistentRead: true,
  })) as { Items?: DeveloperTaskIndexRecord[] };
  const open = (response.Items ?? []).filter((row) => row.status !== "CLOSED").slice(0, 10);
  return open.length === 0 ? "" : ` Your open AI-tool tasks: ${open.map((row) => `${row.taskId} (${row.title})`).join("; ")}.`;
}

async function limitError(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, full: "member" | "organization", limits: WorkspaceLimits): Promise<AgentXError> {
  const open = await openTasksText(deps, caller.developerId);
  return full === "member"
    ? agentXError("WORKSPACE_LIMIT", `you have reached the limit of ${limits.member} open workspaces per person, counting Slack threads and AI-tool tasks; close a task with agentx_close_task.${open}`)
    : agentXError("WORKSPACE_LIMIT", `this AgentX has reached its limit of ${limits.organization} open workspaces; close a task with agentx_close_task, or ask an admin.${open}`);
}

/**
 * Which counter refused the start's transaction (chargeConflict), or undefined when the charge
 * items were not what failed. The charge items are the transaction's first two, the positions
 * chargeConflict reads.
 */
async function chargeFailure(deps: DeveloperTaskRouteDependencies, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ChargeConflict | undefined> {
  try {
    return await chargeConflict(deps.documentClient, deps.tableName, charge, taskId, error);
  } catch (unmodeled) {
    if (unmodeled === error) return undefined;
    throw unmodeled;
  }
}

async function startTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(StartDeveloperTaskRequestSchema, value, deps, "start");
  const turns = turnTable(deps);
  const client = cleanClientName(request.client);
  const payloadHash = hashJson({
    project: request.project, instructions: request.instructions, title: request.title ?? null,
    shareToChannel: request.shareToChannel ?? null, shareMode: request.shareMode ?? null, channel: request.channel ?? null,
  });
  const idempotencyKey = startIdempotencyKey(caller.developerId, request.requestId);
  // loadOwnedTask is the ownership check before taskView's reads. Access is not checked again: a
  // retry returns the first task whatever changed since (R8), as every read of a task does (R11).
  const returning = async (previous: { taskId: string; payloadHash: string }) => {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another task; use a new request_id");
    const task = await loadOwnedTask(deps, caller, previous.taskId);
    return { task: await taskView(deps, task, { events: DEVELOPER_EVENTS_DEFAULT, details: false }) };
  };
  // R8: a retried call returns the first task, whatever changed since.
  const previous = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) return returning(previous);

  const taskId = randomUUID();
  const receivedAt = iso(deps);
  const party = partyOf(caller, taskId, client);
  const refused = (error: AgentXError) => refuse(deps, turns, party, request, receivedAt, error);
  // FR-018's project checks come before any DeveloperTaskActions call.
  let access: Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>;
  try {
    access = await deps.checkAccess(request.project);
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  // R9: sharing is phase 25c.
  if (access.policy.share === "required") {
    return refused(agentXError("CHANNEL_REQUIRED", `project \`${request.project}\` requires tasks to be shared to its Slack channel, which this AgentX cannot do yet; use the project's Slack channel`));
  }
  if (request.shareToChannel === true) {
    return refused(agentXError("CHANNEL_REQUIRED", "sharing tasks to Slack is not available yet in this AgentX; start the task without share_to_channel"));
  }
  const project = await deps.actions.latestProject(request.project);
  if (project === undefined) return refused(agentXError("PROJECT_NOT_FOUND", `project \`${request.project}\` doesn't exist in this AgentX; run agentx_list_projects`));
  // The policy checked must be the policy started: a revision registered between the two reads
  // could have turned tasks off or required sharing. Nothing was decided, so nothing is recorded.
  if (project.definition.revision !== access.revision) {
    log(deps, { event: "developer.task_start_revision_changed", checked: access.revision, latest: project.definition.revision });
    throw agentXError("WORKSPACE_BUSY", "the project changed while starting; try again with the same request_id");
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, deps.actions.limitDefaults);
  const charge = developerCharge({ teamId: deps.slackTeamId, slackUserId: caller.slackUserId, developerId: caller.developerId });
  const full = await limitReached(deps.documentClient, deps.tableName, charge, limits);
  if (full !== undefined) return refused(await limitError(deps, caller, full, limits));

  const identity = developerTaskIdentity({ taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client });
  const preparation = await deps.actions.preparation(identity, project, request.requestId);
  const workspaceId = preparation.workspace.id;
  const conversationId = randomUUID();
  const revision = project.definition.revision;
  const title = redactedTitle(request);
  const task: DeveloperTaskRecord = {
    ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, developerId: caller.developerId, provider: caller.amr, developerName: caller.name,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    client, project: request.project, title, workspaceId, ownerKey: identity.ownerKey, conversationId, startingRevision: revision,
    charge, shared: false, createdAt: receivedAt, updatedAt: receivedAt,
  };
  const index: DeveloperTaskIndexRecord = {
    ...taskIndexKey(caller.developerId, receivedAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, project: request.project, title, client,
    status: "STARTING", shared: false, startingRevision: revision, workspaceId, createdAt: receivedAt, updatedAt: receivedAt,
  };
  const pointer: DeveloperTaskPointerRecord = {
    ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId, developerId: caller.developerId,
    requester: { kind: "developer", developerId: caller.developerId, provider: caller.amr },
    // FR-019: the instructions exactly as the tool sent them; only the audit record is redacted.
    conversationId, firstRequestId: randomUUID(), pendingPrompt: request.instructions,
  };
  const turn = aiToolTurn({
    party: { ...party, workspaceId, settingsRevision: revision }, turnId: randomUUID(), action: "start", phase: "accepted", outcome: "accepted",
    receivedAt, finishedAt: iso(deps), request: request.instructions, response: `Task ${taskId} is STARTING on ${request.project} revision ${revision}.`,
  });
  const items: TransactItems = [
    // First, at positions 0 and 1: chargeConflict reads the cancellation reasons by position.
    ...chargeItems(deps.tableName, charge, limits, taskId),
    ...preparation.items,
    putNew(deps.tableName, { ...task }),
    putNew(deps.tableName, { ...index }),
    putNew(deps.tableName, { ...pointer }),
    putNew(deps.tableName, { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId, createdAt: receivedAt, updatedAt: receivedAt }),
    putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", taskId, payloadHash }),
    // R12: the accepted record commits with the start or not at all (ruling F15).
    putNew(turns, turn),
  ];
  try {
    await deps.actions.transact(items);
  } catch (error) {
    if (!isConditional(error)) throw error;
    const conflict = await chargeFailure(deps, charge, taskId, error);
    // This task's own charge is there: the transaction committed and only its answer was lost.
    if (conflict === "already_charged") return returning({ taskId, payloadHash });
    // The same request, sent again, committed first.
    const concurrent = await get<{ taskId: string; payloadHash: string }>(deps, idempotencyKey);
    if (concurrent !== undefined) return returning(concurrent);
    // A counter filled between the check and the transaction.
    if (conflict !== undefined) return refused(await limitError(deps, caller, conflict, limits));
    throw agentXError("WORKSPACE_BUSY", "AgentX could not start the task just now; try again with the same request_id");
  }
  return { task: await taskView(deps, task, { events: 0, details: false }) };
}

/**
 * R4: the index row keeps the last status the API saw, so the task list and WORKSPACE_LIMIT's
 * open-task list stay current. Best effort: a failed write only costs a stale index row.
 */
export async function syncIndex(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, status: DeveloperTaskStatus): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND #status <> :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": status, ":now": iso(deps) },
    }));
  } catch (error) {
    if (!isConditional(error)) log(deps, { event: "developer.task_index_sync_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const whole = (value: string | null, fallback: number, min: number, max: number, name: string): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) throw agentXError("CONFIG_INVALID", `${name} must be a whole number from ${min} to ${max}`);
  return parsed;
};

async function readTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, url: URL): Promise<{ task: DeveloperTaskView }> {
  // R8, R11: the owner always reads their own task; access is not checked again.
  const task = await loadOwnedTask(deps, caller, taskId);
  const view = await taskView(deps, task, { events: whole(url.searchParams.get("events"), DEVELOPER_EVENTS_DEFAULT, 0, DEVELOPER_EVENTS_MAX, "events"), details: true });
  await syncIndex(deps, task, view.status);
  return { task: view };
}

const TASK_INDEX_SK = /^TASK#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_MAX = 256;
const LIST_SCAN_MAX = 200;
const encodeCursor = (sk: string) => Buffer.from(JSON.stringify({ sk }), "utf8").toString("base64url");

/**
 * The list's position: the sort key of the last index row it looked at. Only a sort key is taken
 * from the client; the partition is always the caller's own, so a cursor copied from another
 * developer, or forged, can only move through the caller's own tasks.
 */
function decodeCursor(value: string | null): string | undefined {
  if (value === null) return undefined;
  const invalid = () => agentXError("CONFIG_INVALID", "cursor is not valid; list the tasks again without a cursor");
  if (value.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalid();
  const fields = decoded as Record<string, unknown>;
  if (Object.keys(fields).length !== 1 || typeof fields.sk !== "string" || !TASK_INDEX_SK.test(fields.sk)) throw invalid();
  return fields.sk;
}

async function listTasks(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, url: URL): Promise<{ tasks: DeveloperTaskListItem[]; nextCursor?: string }> {
  const limit = whole(url.searchParams.get("limit"), DEVELOPER_TASK_LIST_DEFAULT, 1, DEVELOPER_TASK_LIST_MAX, "limit");
  const project = url.searchParams.get("project");
  const statusParam = url.searchParams.get("status");
  const status = statusParam === null ? undefined : DeveloperTaskStatusSchema.safeParse(statusParam);
  if (status !== undefined && !status.success) throw agentXError("CONFIG_INVALID", `status must be one of ${DeveloperTaskStatusSchema.options.join(", ")}`);
  const pk = `DEVELOPER#${caller.developerId}`;
  const after = decodeCursor(url.searchParams.get("cursor"));
  const tasks: DeveloperTaskListItem[] = [];
  let start: Record<string, unknown> | undefined = after === undefined ? undefined : { pk, sk: after };
  let scanned = 0;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "TASK#" },
      ScanIndexForward: false,
      Limit: 50,
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: DeveloperTaskIndexRecord[]; LastEvaluatedKey?: Record<string, unknown> };
    const rows = response.Items ?? [];
    for (const [position, row] of rows.entries()) {
      scanned += 1;
      let current: DeveloperTaskStatus = row.status;
      // A closed task never changes again, so only open rows are derived afresh.
      if (row.status !== "CLOSED") {
        const task = await get<DeveloperTaskRecord>(deps, taskKey(row.taskId));
        if (task !== undefined && task.developerId === caller.developerId) {
          current = (await taskView(deps, task, { events: 0, details: false })).status;
          if (current !== row.status) await syncIndex(deps, task, current);
        }
      }
      const more = position < rows.length - 1 || response.LastEvaluatedKey !== undefined;
      const matches = (project === null || row.project === project) && (status === undefined || !status.success || current === status.data);
      if (matches) {
        tasks.push({ taskId: row.taskId, title: row.title, project: row.project, status: current, shared: row.shared, createdAt: row.createdAt, updatedAt: row.updatedAt });
        if (tasks.length >= limit) return more ? { tasks, nextCursor: encodeCursor(row.sk) } : { tasks };
      }
      // One page of the list reads at most LIST_SCAN_MAX index rows; the cursor carries on from there.
      if (scanned >= LIST_SCAN_MAX) return more ? { tasks, nextCursor: encodeCursor(row.sk) } : { tasks };
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return { tasks };
}

async function taskEvents(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, url: URL): Promise<{ events: DeveloperTaskView["events"] }> {
  const task = await loadOwnedTask(deps, caller, taskId);
  return { events: (await taskView(deps, task, { events: whole(url.searchParams.get("limit"), DEVELOPER_EVENTS_DEFAULT, 1, DEVELOPER_EVENTS_MAX, "limit"), details: false })).events };
}

/** A path segment, decoded; a malformed escape is kept as is and then fails the task ID check. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Every developer task route answers 200 with its body; errors are AgentXErrors. */
export async function routeDeveloperTaskRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (request.method === "POST" && url.pathname === "/v1/dev/tasks") return startTask(deps, caller, body(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/tasks") return listTasks(deps, caller, url);
  const route = /^\/v1\/dev\/tasks\/([^/]+)(?:\/(events|continue|cancel|close|pull-requests))?$/.exec(url.pathname);
  const taskId = route?.[1] === undefined ? undefined : safeDecode(route[1]);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === undefined) return readTask(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "events") return taskEvents(deps, caller, taskId, url);
  throw agentXError("NOT_FOUND", "route not found");
}
