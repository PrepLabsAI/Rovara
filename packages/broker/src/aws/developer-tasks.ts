// Spec 025 FR-016 to FR-021: the developer task routes. Every task has its own workspace, reached
// through the existing handlers (DeveloperTaskActions) with the task's owner key. Nothing here
// reads the deployment mode (FR-024).
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  CHANNEL_PRIVACY_NOT_SET_UP,
  PRIVATE_CHANNEL_NOT_A_MEMBER,
  AdminShareModeRequestSchema,
  AgentXError,
  CHANNEL_TURNS_MAX,
  ContinueDeveloperTaskRequestSchema,
  DEVELOPER_EVENTS_DEFAULT,
  DEVELOPER_EVENTS_MAX,
  DEVELOPER_TASK_LIST_DEFAULT,
  DEVELOPER_TASK_LIST_MAX,
  DEVELOPER_TASK_SUMMARY_MAX,
  DeveloperPullRequestRequestSchema,
  DeveloperTaskActionRequestSchema,
  DeveloperTaskStatusSchema,
  PullRequestResultSchema,
  ShareDeveloperTaskRequestSchema,
  SlackChannelIdSchema,
  StartDeveloperTaskRequestSchema,
  WorkspaceClosePreflightResultSchema,
  agentXError,
  cleanClientName,
  developerTaskPolicy,
  diffStat,
  lastAssistantResponse,
  redactText,
  sharedTaskKey,
  taskTitle,
  type DeveloperCloseResponse,
  type DeveloperPullRequestResponse,
  type DeveloperTaskListItem,
  type DeveloperTaskPolicy,
  type DeveloperTaskShare,
  type DeveloperTaskStatus,
  type DeveloperTaskView,
  type Operation,
  type StartDeveloperTaskRequest,
  type WorkspaceInstance,
} from "@agentx/contracts";
import type { z } from "zod";
import { channelLabel, decideMode, decideShare, type BoundChannel, type ShareDecision } from "../developer/share.js";
import { chargeConflict, chargeItems, developerCharge, limitReached, readWorkspaceLimits, releaseConflict, releaseItems, type ChargeConflict, type WorkspaceLimits } from "../developer/limits.js";
import {
  aiToolTurn,
  byCreated,
  deriveTaskStatus,
  developerTaskIdentity,
  inertName,
  partyOfTask,
  recentTaskEvents,
  sharedSubject,
  shareView,
  startIdempotencyKey,
  taskIndexKey,
  taskKey,
  taskPointerKey,
  taskShare,
  type DeveloperTaskIndexRecord,
  type DeveloperTaskPointerRecord,
  type DeveloperTaskRecord,
  type TaskShare,
  type TurnParty,
  type WorkspaceCharge,
} from "../developer/task-records.js";
import { hashJson, isConditional } from "./broker-shared.js";
import type { DeveloperTaskActions, TransactItems } from "./developer-task-actions.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { setupWatchKey } from "./stuck-setup.js";

export interface DeveloperTaskRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  slackTeamId?: string;
  actions: DeveloperTaskActions;
  checkAccess(project: string): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[] }>;
  /** C3: bound channels' names and privacy, best effort (R10). */
  boundChannels?(channelIds: readonly string[]): Promise<BoundChannel[]>;
  /**
   * Q10: whether this Slack user is a member of this channel, through the access check's own Slack
   * lookup; SLACK_UNAVAILABLE when the lookup fails. Without it no private-channel share is allowed.
   */
  channelMember?(slackUserId: string, channelId: string): Promise<boolean>;
  /** C5: the project's bound channel IDs, sorted, for sharing a task that already exists (R11: no access check). */
  projectChannelIds(project: string): Promise<string[]>;
  now(): number;
  log?(entry: Record<string, unknown>): void;
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (deps: Pick<DeveloperTaskRouteDependencies, "now">) => new Date(deps.now()).toISOString();
const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

function parse<T>(schema: z.ZodType<T>, body: unknown, deps: Pick<DeveloperTaskRouteDependencies, "log">, route: string): T {
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

async function get<T>(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

const putNew = (tableName: string, item: Record<string, unknown>) => ({ Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } });

function turnTable(deps: Pick<DeveloperTaskRouteDependencies, "actions">): string {
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
    throw agentXError("TASK_NOT_FOUND", TASK_ID.test(taskId) ? `no task ${taskId} of yours` : "that is not a task ID of yours");
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

/**
 * The files the diff names, redacted. An empty diff has none (a ranged read of a zero-byte object
 * is a 416 on S3, so callers skip size 0). Storage trouble must not break the read of an ended
 * task, so a failed read logs the error name and leaves the changed files out.
 */
async function changedFiles(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, objectKey: string): Promise<TaskDetails["changedFiles"]> {
  let diff: string;
  try {
    diff = await deps.actions.readArtifact(objectKey, DIFF_READ_BYTES);
  } catch (error) {
    log(deps, { event: "developer.task_diff_read_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
  if (diff === "") return undefined;
  return diffStat(diff).map((file) => ({ ...file, repository: redactText(file.repository), path: redactText(file.path) }));
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
    if (diff !== undefined && diff.size !== 0) {
      if (ownArtifactKey(task, lastTask.id, diff.objectKey)) {
        const changed = await changedFiles(deps, task, diff.objectKey);
        if (changed !== undefined) details.changedFiles = changed;
      } else {
        // The key is not logged: it names another workspace.
        log(deps, { event: "developer.task_artifact_key_refused", taskId: task.taskId, artifactId: diff.id });
      }
    }
  }
  if (pullRequests.length > 0) details.pullRequests = pullRequests;
  return details;
}

/**
 * What a close preflight's result says is unpublished, per repository, or undefined when it was
 * safe or is not a preflight result (ruling F11: the close route and the task view share it).
 */
function unpublishedOf(result: unknown): DeveloperCloseResponse["unpublished"] {
  const preflight = WorkspaceClosePreflightResultSchema.safeParse(result);
  if (!preflight.success || preflight.data.safeToClose) return undefined;
  return preflight.data.repositories.map((repository) => ({ repository: repository.name, reasons: [...repository.reasons] }));
}

/** The workspace and its operations, read once and shared by a route's steps. */
interface WorkspaceReads { workspace: WorkspaceInstance; operations: Operation[] }
async function workspaceReads(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<WorkspaceReads> {
  const [workspace, operations] = await Promise.all([deps.actions.workspace(task.workspaceId), deps.actions.operations(task.workspaceId)]);
  return { workspace, operations };
}

/** The live view of a task (R4), with the result details once it has ended. Callers load the owned task first. */
export async function taskView(
  deps: DeveloperTaskRouteDependencies,
  task: DeveloperTaskRecord,
  options: { events: number; details: boolean; loaded?: WorkspaceReads },
): Promise<DeveloperTaskView> {
  const [{ workspace, operations }, pointer] = await Promise.all([
    options.loaded ?? workspaceReads(deps, task),
    get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
  ]);
  const derived = deriveTaskStatus({
    closedAt: task.closedAt,
    workspaceStatus: workspace.status,
    pointer,
    operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, error: operation.error, createdAt: operation.createdAt, fence: operation.fence })),
  });
  const events = derived.current === undefined || options.events === 0
    ? []
    : recentTaskEvents(await deps.actions.eventsNewestFirst(derived.current.id, 200), options.events);
  const details = options.details && derived.status !== "STARTING" && derived.status !== "RUNNING" ? await taskDetails(deps, task, operations) : {};
  // C15: only the full read shows channel turns, and a storage problem never breaks it.
  let channelTurns: DeveloperTaskView["channelTurns"];
  if (options.details && task.share?.threadTs !== undefined) {
    try {
      const turns = await deps.actions.channelTurns(sharedSubject({ ...task.share, threadTs: task.share.threadTs }), task.taskId, CHANNEL_TURNS_MAX);
      if (turns.length > 0) channelTurns = turns;
    } catch (error) {
      log(deps, { event: "developer.channel_turns_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  // R22: why the latest close did not happen, while no later close runs, the task is open and
  // the developer has not asked for more work since (a continue or a pull request may publish it).
  const lastClose = operations.filter((operation) => operation.kind === "close").sort(byCreated).at(-1);
  const workedSince = lastClose !== undefined && derived.current !== undefined && byCreated(derived.current, lastClose) > 0;
  const unpublished = lastClose?.status === "SUCCEEDED" && !derived.closing && derived.status !== "CLOSED" && !workedSince ? unpublishedOf(lastClose.result) : undefined;
  return {
    taskId: task.taskId,
    title: task.title,
    project: task.project,
    status: derived.status,
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
    startingRevision: task.startingRevision,
    client: task.client,
    shared: task.shared,
    ...(task.share === undefined ? {} : { share: shareView(task.share) }),
    ...(derived.closing ? { closing: true } : {}),
    createdAt: task.createdAt,
    updatedAt: derived.current?.createdAt ?? task.updatedAt,
    events,
    ...details,
    ...(channelTurns === undefined ? {} : { channelTurns }),
    ...(unpublished === undefined ? {} : { unpublished }),
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

type ProjectAccess = Awaited<ReturnType<DeveloperTaskRouteDependencies["checkAccess"]>>;

/**
 * C3: where and how a task is shared, or undefined for a private one. Names are read only when a
 * share needs them, and shown only to a caller with a Slack link, as GET /v1/dev/projects does
 * (R10). Q10: privacy is read for every share, since a private channel needs its sharer's membership.
 */
async function shareFor(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  project: string,
  access: ProjectAccess,
  wanted: { shareToChannel: boolean; shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
): Promise<ShareDecision | undefined> {
  if (!wanted.shareToChannel && access.policy.share !== "required") return undefined;
  const linked = caller.slackUserId !== undefined;
  const looked: BoundChannel[] = deps.boundChannels === undefined
    ? access.channelIds.map((channelId) => ({ channelId }))
    : await deps.boundChannels(access.channelIds);
  // R10: a caller with no Slack link keeps each channel's privacy, never its name.
  const bound: BoundChannel[] = linked ? looked : looked.map(({ channelId, isPrivate }) => (isPrivate === undefined ? { channelId } : { channelId, isPrivate }));
  let decision: ShareDecision | undefined;
  try {
    decision = decideShare({
      project, policy: access.policy, bound, shareToChannel: wanted.shareToChannel,
      ...(wanted.shareMode === undefined ? {} : { shareMode: wanted.shareMode }),
      ...(wanted.channel === undefined ? {} : { channel: wanted.channel }),
    });
  } catch (error) {
    // A channel named by name when Slack did not name every bound channel: the name may be right,
    // so say the names could not be read rather than blame it, and give the IDs to use (IDs only, R10).
    const byName = wanted.channel !== undefined && !SlackChannelIdSchema.safeParse(wanted.channel).success;
    if (linked && deps.boundChannels !== undefined && byName && error instanceof AgentXError && error.code === "CHANNEL_REQUIRED" && bound.some((channel) => channel.name === undefined)) {
      throw agentXError("CHANNEL_REQUIRED", `AgentX could not read the channel names from Slack; name the channel by its ID: ${bound.map((channel) => channel.channelId).sort().join(", ")}`);
    }
    throw error;
  }
  if (decision !== undefined) await confirmMayShareInto(deps, caller, bound.find((channel) => channel.channelId === decision.channelId) ?? { channelId: decision.channelId });
  return decision;
}

const NOT_A_MEMBER = PRIVATE_CHANNEL_NOT_A_MEMBER;
const PRIVACY_UNKNOWN = "Slack could not be reached to check whether that channel is private; try again shortly";
const PRIVACY_NOT_SET_UP = CHANNEL_PRIVACY_NOT_SET_UP;

/**
 * Q10 (owner answer, 2026-09-29): a private channel takes a share only from one of its members. A
 * public channel needs nothing. A channel whose privacy is unknown (Slack did not answer, or no
 * channel-info lookup is configured) is treated as private unless the caller is a member, and a
 * failed membership lookup refuses: nothing here lets a share through on doubt.
 */
async function confirmMayShareInto(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, channel: BoundChannel): Promise<void> {
  if (channel.isPrivate === false) return;
  const refusal = () => channel.isPrivate === true
    ? agentXError("CHANNEL_REQUIRED", NOT_A_MEMBER)
    : agentXError("SLACK_UNAVAILABLE", deps.boundChannels === undefined ? PRIVACY_NOT_SET_UP : PRIVACY_UNKNOWN);
  // A caller with no Slack link cannot be confirmed as a member.
  if (caller.slackUserId === undefined || deps.channelMember === undefined) throw refusal();
  if (!(await deps.channelMember(caller.slackUserId, channel.channelId))) throw refusal();
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
  // FR-031, C4: decided here, in R8's place for sharing; a refusal is audited and writes nothing else.
  let decision: ShareDecision | undefined;
  try {
    decision = await shareFor(deps, caller, request.project, access, { shareToChannel: request.shareToChannel === true, shareMode: request.shareMode, channel: request.channel });
  } catch (error) {
    if (error instanceof AgentXError) return refused(error);
    throw error;
  }
  let share: TaskShare | undefined;
  if (decision !== undefined) {
    // Bindings exist only under a team ID, so this cannot happen; refuse rather than write a half share.
    if (deps.slackTeamId === undefined) return refused(agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared"));
    share = taskShare(decision, deps.slackTeamId, receivedAt);
  }
  const project = await deps.actions.latestProject(request.project);
  if (project === undefined) return refused(agentXError("PROJECT_NOT_FOUND", `project \`${request.project}\` doesn't exist in this AgentX`));
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
    charge, shared: share !== undefined, ...(share === undefined ? {} : { share, shareVersion: 1 }),
    createdAt: receivedAt, updatedAt: receivedAt,
  };
  const index: DeveloperTaskIndexRecord = {
    ...taskIndexKey(caller.developerId, receivedAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, project: request.project, title, client,
    status: "STARTING", shared: share !== undefined, startingRevision: revision, workspaceId, createdAt: receivedAt, updatedAt: receivedAt,
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
    // FR-055, C17: the stuck-setup sweep's watch on this prepare, keyed by the prepare's creation
    // (the task's start, Q5). Only developer-task starts write one (Q4); the sweep removes it.
    putNew(deps.tableName, {
      ...setupWatchKey(preparation.workspace.createdAt, workspaceId), entityType: "SETUP_WATCH",
      workspaceId, operationId: preparation.operationId, taskId, createdAt: preparation.workspace.createdAt,
    }),
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
 * open-task list stay current. Best effort: a failed write only costs a stale index row. A CLOSED
 * row never changes again: a read that derived its status before a close must not undo it.
 * `updatedAt` is the task view's, so the list and the view agree.
 */
export async function syncIndex(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, status: DeveloperTaskStatus, updatedAt: string = iso(deps)): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND #status <> :status AND #status <> :closed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": status, ":closed": "CLOSED", ":now": updatedAt },
    }));
  } catch (error) {
    if (!isConditional(error)) log(deps, { event: "developer.task_index_sync_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const whole = (value: string | null, fallback: number, min: number, max: number, name: string): number => {
  if (value === null) return fallback;
  const parsed = /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw agentXError("CONFIG_INVALID", `${name} must be a whole number from ${min} to ${max}`);
  return parsed;
};

async function readTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, url: URL): Promise<{ task: DeveloperTaskView }> {
  // R8, R11: the owner always reads their own task; access is not checked again.
  const events = whole(url.searchParams.get("events"), DEVELOPER_EVENTS_DEFAULT, 0, DEVELOPER_EVENTS_MAX, "events");
  let task = await loadOwnedTask(deps, caller, taskId);
  let loaded: WorkspaceReads | undefined = await workspaceReads(deps, task);
  // R15: a safe close whose completion did not land is finished by the next read. The view reuses
  // the reads unless the close landed and changed them.
  if (await resumeClose(deps, task, loaded)) {
    task = await loadOwnedTask(deps, caller, taskId);
    loaded = undefined;
  }
  const view = await taskView(deps, task, { events, details: true, ...(loaded === undefined ? {} : { loaded }) });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return { task: view };
}

const TASK_INDEX_SK = /^TASK#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_MAX = 256;
const LIST_SCAN_MAX = 200;
const encodeCursor = (sk: string) => Buffer.from(JSON.stringify({ sk }), "utf8").toString("base64url");

/**
 * The list's position: the sort key of the last index row it looked at. The cursor is validated,
 * not signed. That is enough because it grants nothing: only a sort key is taken from the client,
 * it must have the index row's exact shape, and the partition is always the caller's own. A cursor
 * copied from another developer, or forged, can only move through the caller's own tasks, and the
 * worst a forged one does is start the caller's list at another point.
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
      let updatedAt = row.updatedAt;
      // A closed task never changes again, so only open rows are derived afresh.
      if (row.status !== "CLOSED") {
        const task = await get<DeveloperTaskRecord>(deps, taskKey(row.taskId));
        if (task !== undefined && task.developerId === caller.developerId) {
          const view = await taskView(deps, task, { events: 0, details: false });
          current = view.status;
          if (current !== row.status) {
            updatedAt = view.updatedAt;
            await syncIndex(deps, task, current, updatedAt);
          }
        }
      }
      const more = position < rows.length - 1 || response.LastEvaluatedKey !== undefined;
      const matches = (project === null || row.project === project) && (status === undefined || !status.success || current === status.data);
      if (matches) {
        tasks.push({ taskId: row.taskId, title: row.title, project: row.project, status: current, shared: row.shared, createdAt: row.createdAt, updatedAt });
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

const CLOSED_TASK = "this task is closed; start a new one with agentx_start_task";
const NEVER_STARTED = "this task never started; close it with agentx_close_task and start a new one";
const CLOSING_TASK = "this task is closing; check it with agentx_get_task, and if the close is refused for unpublished work you can continue it";

/**
 * What continue and a pull request need before they touch the workspace: an open task that got
 * past its setup (R17, for every setup failure, whatever its category) and is not closing. Access
 * is not checked again (R11): a developer who left the project's channels can still continue and
 * publish their own task. Callers load the owned task first, which is the ownership check.
 */
async function actionableWorkspace(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<WorkspaceInstance> {
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  if (workspace.status === "PREPARATION_FAILED") throw agentXError("CONFIG_INVALID", NEVER_STARTED);
  // A close in flight is not work to wait for or cancel: say so, not TASK_BUSY.
  if (workspace.status === "CLOSING") throw agentXError("CONFIG_INVALID", CLOSING_TASK);
  return workspace;
}

/**
 * A continue or pull request the handler refused as busy: when a close started after this route
 * checked the workspace, the answer is the closing message, not TASK_BUSY.
 */
async function busyOrClosing(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, error: unknown): Promise<never> {
  if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "CLOSING") throw agentXError("CONFIG_INVALID", CLOSING_TASK);
    const channel = await channelDriver(deps, task, workspace.activeOperationId);
    if (channel !== undefined) throw agentXError("TASK_BUSY", channel);
  }
  return busy(error, task.taskId);
}

/** C14, D4: the words for a developer's action that met a teammate's channel turn, or undefined. */
async function channelDriver(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operationId: string | null): Promise<string | undefined> {
  if (operationId === null || task.share?.threadTs === undefined) return undefined;
  const activity = await deps.actions.channelActivity({ taskId: task.taskId, operationId, threadSubject: sharedSubject({ ...task.share, threadTs: task.share.threadTs }) });
  if (activity.driver === undefined) return undefined;
  // The name reaches the AI tool inert, as every other name there does.
  const who = activity.driver.name === undefined ? `Slack user ${activity.driver.slackUserId}` : inertName(activity.driver.name);
  // F18: a floor. The running turn may or may not still count among the thread's pending messages.
  const waiting = activity.waiting === 0 ? "" : `, and at least ${activity.waiting} more channel message${activity.waiting === 1 ? " is" : "s are"} waiting`;
  return `task ${task.taskId} is running a request from ${who} in its shared Slack thread${waiting}; wait with agentx_wait_for_task, stop it with agentx_cancel_task, or make the thread view only with agentx_share_task`;
}

/** The existing handlers' busy answers, in the developer's words (FR-049's TASK_BUSY). */
function busy(error: unknown, taskId: string): never {
  if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) {
    throw agentXError("TASK_BUSY", `task ${taskId} is still working; wait for it with agentx_wait_for_task, or stop it with agentx_cancel_task`);
  }
  throw error;
}

async function continueTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ContinueDeveloperTaskRequestSchema, value, deps, "continue");
  const task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  await actionableWorkspace(deps, task);
  const receivedAt = iso(deps);
  try {
    // acceptTask answers a repeated requestId with its first operation and writes nothing, and
    // refuses a second running turn (TASK_BUSY) before anything is written.
    await deps.actions.acceptTask(developerTaskIdentity(task), task.workspaceId, { requestId: request.requestId, conversationId: task.conversationId, prompt: request.instructions }, (operation) => [
      // R12: the accepted record commits with the operation or not at all.
      putNew(turns, aiToolTurn({
        party: partyOfTask(task), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: request.instructions, response: `Continuing task ${taskId} as operation ${operation.id}.`, operationId: operation.id,
      })),
    ]);
  } catch (error) {
    return busyOrClosing(deps, task, error);
  }
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return { task: view };
}

/** The payload a cancel's idempotency item holds: a continue or PR with the same requestId conflicts. */
const CANCEL_PAYLOAD_HASH = hashJson({ action: "cancel" });

async function cancelTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(DeveloperTaskActionRequestSchema, value, deps, "cancel");
  const task = await loadOwnedTask(deps, caller, taskId);
  // Final review M2: a closed task is refused as continue refuses it, before anything is written,
  // so a repeat after the close answers "this task is closed" like any new call.
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const turns = turnTable(deps);
  const receivedAt = iso(deps);
  // Ruling F14: the same key the task's other actions use, so one requestId names one action.
  const idempotencyKey = { pk: `IDEMPOTENCY#${task.ownerKey}#${task.workspaceId}`, sk: `REQUEST#${request.requestId}` };
  const repeated = async (): Promise<boolean> => {
    const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
    if (previous === undefined) return false;
    if (previous.payloadHash !== CANCEL_PAYLOAD_HASH) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another action on this task; use a new request_id");
    return true;
  };
  const current = async () => ({ task: await taskView(deps, task, { events: 0, details: false }) });
  // A repeated cancel answers with the task as it is now and writes nothing.
  if (await repeated()) return current();
  const marker = putNew(deps.tableName, { ...idempotencyKey, entityType: "IDEMPOTENCY", action: "cancel", payloadHash: CANCEL_PAYLOAD_HASH });
  const record = (response: string, operationId?: string) => putNew(turns, aiToolTurn({
    party: partyOfTask(task), turnId: randomUUID(), action: "cancel", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
    request: "cancel", response, ...(operationId === undefined ? {} : { operationId }),
  }));
  let handled = false;
  const pointer = await get<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId));
  if (pointer?.pendingPrompt !== undefined) {
    // R16, P45: before the instructions run, removing them is the whole cancel. Only the pointer
    // changes; the workspace and the prepare are left to finish, and then queue nothing.
    try {
      await deps.actions.transact([
        { Update: {
          TableName: deps.tableName, Key: taskPointerKey(task.workspaceId),
          UpdateExpression: "SET cancelledAt = :now REMOVE pendingPrompt", ConditionExpression: "attribute_exists(pendingPrompt)",
          ExpressionAttributeValues: { ":now": receivedAt },
        } },
        marker,
        record("Cancelled before the instructions ran."),
      ]);
      handled = true;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same cancel, sent again, committed first.
      if (await repeated()) return current();
      // The prepare's result queued the instructions meanwhile: cancel the running task instead.
    }
  }
  if (!handled) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    let outcome: "CANCEL_REQUESTED" | "NOTHING_RUNNING";
    try {
      outcome = (await deps.actions.cancelRunning(developerTaskIdentity(task), workspace, (operation) => [
        record("Asked the worker to stop.", operation.id),
        marker,
      ])).outcome;
    } catch (error) {
      // The same cancel, sent again, committed first (its marker failed this transaction).
      if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY" && await repeated()) return current();
      // The task moved on while the cancel was written: the code stays, the words name the tool.
      if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "STALE_FENCE")) {
        throw agentXError(error.code, "the task changed while cancelling; try agentx_cancel_task again");
      }
      throw error;
    }
    if (outcome === "NOTHING_RUNNING") {
      // R12's one exception (ruling F15): nothing ran, so there is no action transaction for the
      // record to join. It is written with the cancel's idempotency item in its own transaction.
      // A failed write is counted and logged, and never hides the answer.
      try {
        await deps.actions.transact([marker, record("Nothing was running.")]);
      } catch (error) {
        if (!isConditional(error)) turnRecordFailed(deps, error);
      }
    }
  }
  const view = await taskView(deps, task, { events: 0, details: false });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return { task: view };
}

/**
 * R22. A repeated requestId returns the same operation, except once the task is closed: the closed
 * check comes first, so a repeat after the close answers "this task is closed" like any new call.
 */
async function openPullRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperPullRequestResponse> {
  const request = parse(DeveloperPullRequestRequestSchema, value, deps, "pull-request");
  const task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const workspace = await actionableWorkspace(deps, task);
  let repository = request.repository;
  if (repository === undefined) {
    // The revision the workspace was prepared from, which the publication pushes from: a
    // repository a newer revision added is not in this workspace.
    const pinned = await deps.actions.projectRevision(workspace.projectName, workspace.projectRevision);
    if (pinned === undefined) throw agentXError("CONFIG_INVALID", "this task's project revision is no longer registered; ask an admin");
    const repositories = pinned.definition.repositories.map((entry) => entry.name);
    if (repositories.length > 1) throw agentXError("CONFIG_INVALID", `this project has several repositories; name one of: ${repositories.join(", ")}`);
    if (repositories.length === 0) throw agentXError("CONFIG_INVALID", `project \`${task.project}\` has no repositories; ask an admin`);
    repository = repositories[0]!;
  }
  const receivedAt = iso(deps);
  let accepted: Awaited<ReturnType<DeveloperTaskActions["acceptPullRequest"]>>;
  try {
    // R22: answers at once. A repeated requestId returns the same operation and writes nothing.
    accepted = await deps.actions.acceptPullRequest(developerTaskIdentity(task), task.workspaceId, {
      requestId: request.requestId, repository, title: request.title, draft: request.draft,
      ...(request.body === undefined ? {} : { body: request.body }),
    }, (operation) => [
      putNew(turns, aiToolTurn({
        party: partyOfTask(task), turnId: randomUUID(), action: "pull_request", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
        request: `${request.title}\n\n${request.body ?? ""}`, response: `Opening a pull request on ${repository} as operation ${operation.id}.`, operationId: operation.id,
      })),
    ]);
  } catch (error) {
    return busyOrClosing(deps, task, error);
  }
  const published = PullRequestResultSchema.safeParse(accepted.operation.result);
  const pullRequest = accepted.operation.status === "SUCCEEDED" && published.success
    ? { repository: published.data.repository, number: published.data.number, url: published.data.url, state: "open" as const }
    : undefined;
  const view = await taskView(deps, task, { events: 0, details: true });
  await syncIndex(deps, task, view.status, view.updatedAt);
  return {
    task: view,
    operationId: accepted.operation.id,
    operationStatus: accepted.operation.status,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/** A share changed meanwhile (by the notifier or either share route) retries the close; 4 attempts, then the last conflict is rethrown. */
const CLOSE_ATTEMPTS = 4;

/**
 * R15: deletes the compute, then in one transaction releases the counters the task charged (R6:
 * the charge stored on the task, whatever the developer's Slack link is now), closes the
 * workspace, sets the task's `closedAt` and marks the index row CLOSED. The task's own `closedAt`
 * transition guards the release, so it happens exactly once. `extra` joins the same transaction
 * (ruling F15: the close's accepted record when no preflight ran). `closeOperationId` is the safe
 * preflight's operation, or undefined for a workspace whose preparation failed.
 *
 * A failed condition is decided from fresh reads: a lost race (another call closed the task first)
 * is not an error; counters an earlier release already gave back (releaseConflict) do not block
 * the close, which is sent again without them; anything else is rethrown, never hidden. Callers
 * load the owned task, or are the worker's authenticated callback.
 *
 * C24, ruling F4: a shared task's thread record is marked closed in the same transaction, and a
 * share the notifier changed after the task was read (a thread it just recorded) is read again, so
 * the thread's record is closed too.
 */
export async function finishTaskClose(
  deps: { tableName: string; actions: DeveloperTaskActions; documentClient: { send(command: unknown): Promise<unknown> } },
  task: DeveloperTaskRecord,
  closeOperationId: string | undefined,
  extra: TransactItems = [],
): Promise<void> {
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status !== "CLOSED") await deps.actions.deleteCompute(workspace);
  const now = new Date().toISOString();
  const closing = (current: DeveloperTaskRecord): TransactItems => [
    ...(workspace.status === "CLOSED" ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" },
      UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: closeOperationId === undefined ? "#status = :failed" : "#status = :closing AND closeOperationId = :operation",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":closed": "CLOSED", ":now": now,
        ...(closeOperationId === undefined ? { ":failed": "PREPARATION_FAILED" } : { ":closing": "CLOSING", ":operation": closeOperationId }),
      },
    } }]),
    // Ruling F4: a shared task's close holds only while its share is the one read here, so a thread
    // the notifier recorded meanwhile is read again and closed below, never left open.
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET closedAt = :now, updatedAt = :now",
      ConditionExpression: current.share === undefined
        ? "attribute_exists(pk) AND attribute_not_exists(closedAt)"
        : "attribute_exists(pk) AND attribute_not_exists(closedAt) AND shareVersion = :sv",
      ExpressionAttributeValues: { ":now": now, ...(current.share === undefined ? {} : { ":sv": current.shareVersion ?? 0 }) },
    } },
    // Deliberately unconditional (an upsert): the start writes this row with the task, and a close
    // must mark it CLOSED whatever status a read last synced into it.
    { Update: {
      TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
    } },
    // C24: the shared thread's record says the task closed, so its mentions get the closed notice.
    ...(current.share?.threadTs === undefined ? [] : [{ Update: {
      TableName: deps.tableName,
      Key: sharedTaskKey({ teamId: current.share.teamId, channelId: current.share.channelId, threadTs: current.share.threadTs }),
      UpdateExpression: "SET closedAt = :now", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": now },
    } }]),
    // E20 (25c C22): the close's own completed record, in the close's transaction, so it commits once.
    ...(deps.actions.turnRecordsTableName === undefined ? [] : [{ Put: {
      TableName: deps.actions.turnRecordsTableName,
      Item: aiToolTurn({
        party: partyOfTask(current), turnId: closeOperationId ?? randomUUID(), action: "close", phase: "completed", outcome: "succeeded",
        receivedAt: now, finishedAt: now, request: "close", response: "The task is closed, and its workspace is released.",
        ...(closeOperationId === undefined ? {} : { operationId: closeOperationId }),
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    } }]),
    ...extra,
  ];
  let current = task;
  let release = true;
  let lastError: unknown;
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
    try {
      // First, at positions 0 and 1: releaseConflict reads the cancellation reasons by position.
      await deps.actions.transact([...(release ? releaseItems(deps.tableName, task.charge, task.taskId) : []), ...closing(current)]);
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
      lastError = error;
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      // Another call finished the close first; its transaction released the counters once.
      if (fresh?.closedAt !== undefined) return;
      // Ruling F4: the notifier changed the share (it recorded the thread) meanwhile: close that one.
      if (fresh !== undefined && fresh.shareVersion !== current.shareVersion) {
        current = fresh;
        continue;
      }
      if (!release) throw error;
      // Rethrows anything but counters that no longer hold this task.
      await releaseConflict(deps.documentClient, deps.tableName, task.charge, task.taskId, error);
      console.log(JSON.stringify({ component: "broker", event: "developer.task_release_already_released", taskId: task.taskId }));
      release = false;
    }
  }
  throw lastError;
}

/**
 * R15: finishes a close whose preflight ended safe but whose completion did not land (the worker's
 * callback could not delete the compute, say). Answers whether it closed the task. A failure is
 * logged by its name and left for the next read or close. `loaded` is the caller's reads, when it
 * has them. Callers load the owned task first.
 */
export async function resumeClose(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, loaded?: WorkspaceReads): Promise<boolean> {
  if (task.closedAt !== undefined) return false;
  const safe = safeClose(loaded ?? await workspaceReads(deps, task));
  if (safe === undefined) return false;
  try {
    await finishTaskClose(deps, task, safe.id);
    return true;
  } catch (error) {
    log(deps, { event: "developer.task_close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/** The close operation of a CLOSING workspace whose preflight ended safe, if there is one. */
function safeClose({ workspace, operations }: WorkspaceReads): Operation | undefined {
  if (workspace.status !== "CLOSING" || workspace.closeOperationId === undefined) return undefined;
  const operation = operations.find((entry) => entry.id === workspace.closeOperationId);
  const preflight = WorkspaceClosePreflightResultSchema.safeParse(operation?.result);
  return operation?.status === "SUCCEEDED" && preflight.success && preflight.data.safeToClose ? operation : undefined;
}

const CLOSE_CHECKING = "AgentX is checking the task's workspace for unpublished work before closing it; check back with agentx_get_task";
const CLOSE_REFUSED = "not closed: some work is not published; push it or open a pull request with agentx_open_pull_request, then close the task again";
const CLOSE_COMPUTE_PENDING = "the workspace has no unpublished work, but its compute is not removed yet; try agentx_close_task again shortly";
const CLOSE_CHECK_FAILED = "the check for unpublished work did not finish; try agentx_close_task again with a new request_id";
const CLOSE_STILL_OPEN = "the task is still open; try agentx_close_task again with a new request_id";
const COMPUTE_STOPPING = "the task's compute is still stopping; try agentx_close_task again shortly";
const CLOSE_FAILED = "AgentX could not close this task just now; try agentx_close_task again, and ask an admin if it keeps failing";

/** Why a close did not close the task (it always says, so the AI tool can tell the developer). */
function notClosedMessage(reads: WorkspaceReads, operation: Operation | undefined, unpublished: DeveloperCloseResponse["unpublished"]): string {
  if (unpublished !== undefined) return CLOSE_REFUSED;
  if (safeClose(reads) !== undefined) return CLOSE_COMPUTE_PENDING;
  if (reads.workspace.status === "CLOSING" || operation?.status === "ACCEPTED" || operation?.status === "RUNNING") return CLOSE_CHECKING;
  if (operation !== undefined && operation.status !== "SUCCEEDED") return CLOSE_CHECK_FAILED;
  return CLOSE_STILL_OPEN;
}

/** A setup-failed task's close (ruling F15: its accepted record commits with the close). */
async function closeNeverStarted(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, record: TransactItems[number]): Promise<void> {
  try {
    await finishTaskClose(deps, task, undefined, [record]);
  } catch (error) {
    // The compute refuses while it is starting or stopping: its own words, not busy()'s.
    if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY") throw agentXError("TASK_BUSY", COMPUTE_STOPPING);
    if (!isConditional(error)) throw error;
    log(deps, { event: "developer.task_close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    throw agentXError("WORKSPACE_BUSY", CLOSE_FAILED);
  }
}

/**
 * FR-016, R15, R22, owner decisions 5 and 6. Answers at once: usually `closing: true` while the
 * worker checks for unpublished work, which the AI tool then follows with agentx_get_task. There
 * is no force: unpublished work refuses the close, listing each repository and why.
 *
 * Idempotent: the same requestId reports its preflight's outcome and writes nothing. A fresh
 * requestId while a close is in flight, or after the task closed, answers with that close and
 * writes no new record: nothing new was accepted (the close already has its accepted record).
 */
async function closeTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<DeveloperCloseResponse> {
  const request = parse(DeveloperTaskActionRequestSchema, value, deps, "close");
  let task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const receivedAt = iso(deps);
  const record = (response: string, operationId?: string) => putNew(turns, aiToolTurn({
    party: partyOfTask(task), turnId: randomUUID(), action: "close", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
    request: "close", response, ...(operationId === undefined ? {} : { operationId }),
  }));
  let unpublished: DeveloperCloseResponse["unpublished"];
  let operation: Operation | undefined;
  if (task.closedAt === undefined) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "PREPARATION_FAILED") {
      // A task whose setup failed has nothing to check: it closes now and frees its slot.
      await closeNeverStarted(deps, task, record("Closed; the task's workspace never started."));
    } else if (workspace.status === "PREPARING") {
      throw agentXError("TASK_BUSY", `task ${taskId} is still starting; cancel it with agentx_cancel_task, then close it once it has stopped`);
    } else if (workspace.status !== "CLOSED") {
      let started: Awaited<ReturnType<DeveloperTaskActions["startClose"]>>;
      try {
        // startClose answers a close in flight, and a repeated requestId, with the existing close
        // operation and writes nothing; otherwise the record commits with the preflight (R12).
        started = await deps.actions.startClose(developerTaskIdentity(task), workspace, request.requestId, (operation) => [
          record("Checking the workspace for unpublished work before closing.", operation.id),
        ]);
      } catch (error) {
        busy(error, taskId);
      }
      operation = (await deps.actions.operations(task.workspaceId)).find((entry) => entry.id === started.operationId);
      if (operation?.status === "SUCCEEDED") unpublished = unpublishedOf(operation.result);
    }
    await resumeClose(deps, task);
    task = await loadOwnedTask(deps, caller, taskId);
  }
  const reads = await workspaceReads(deps, task);
  const view = await taskView(deps, task, { events: 0, details: false, loaded: reads });
  await syncIndex(deps, task, view.status, view.updatedAt);
  if (view.status === "CLOSED") return { task: view, closed: true };
  return { task: view, closed: false, ...(unpublished === undefined ? {} : { unpublished }), message: notClosedMessage(reads, operation, unpublished) };
}

/** A path segment, decoded; a malformed escape is kept as is and then fails the task ID check. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const SHARE_ATTEMPTS = 3;

/** A share's channel as a message names it: `#name` when its name was stored (public only), else its ID (R10). */
const shareLabel = (share: TaskShare) => channelLabel({ channelId: share.channelId, ...(share.channelName === undefined ? {} : { name: share.channelName, isPrivate: false }) });

/** C5: the share the request asks for, from the task's current one, or "unchanged". */
async function nextShare(
  deps: DeveloperTaskRouteDependencies,
  caller: DeveloperCaller,
  task: DeveloperTaskRecord,
  request: { shareMode?: "view" | "continue" | undefined; channel?: string | undefined },
  now: string,
): Promise<TaskShare | "unchanged"> {
  const project = await deps.actions.latestProject(task.project);
  if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; ask an admin");
  const policy = developerTaskPolicy(project.definition);
  if (task.share === undefined) {
    // R11: sharing an existing task does not recheck project access; it uses the latest policy.
    const decision = await shareFor(deps, caller, task.project, { revision: project.definition.revision, policy, access: "granted", channelIds: await deps.projectChannelIds(task.project) }, { shareToChannel: true, shareMode: request.shareMode, channel: request.channel });
    if (decision === undefined || deps.slackTeamId === undefined) throw agentXError("CHANNEL_REQUIRED", "this AgentX has no Slack workspace set, so tasks cannot be shared");
    return taskShare(decision, deps.slackTeamId, now);
  }
  const current = task.share;
  if (request.channel !== undefined) {
    const named = request.channel.replace(/^#/, "").toLowerCase();
    if (request.channel !== current.channelId && current.channelName?.toLowerCase() !== named) {
      throw agentXError("CONFIG_INVALID", `this task is already shared in ${shareLabel(current)}; its channel cannot change`);
    }
  }
  return withMode(current, decideMode(policy, request.shareMode ?? current.mode));
}

/** The share with a new mode, or "unchanged". Built field by field, so a stale modeReason is dropped. */
function withMode(current: TaskShare, mode: { mode: "view" | "continue"; modeReason?: "continue_not_allowed" }): TaskShare | "unchanged" {
  if (mode.mode === current.mode && mode.modeReason === current.modeReason) return "unchanged";
  return {
    teamId: current.teamId, channelId: current.channelId,
    ...(current.channelName === undefined ? {} : { channelName: current.channelName }),
    sharedReason: current.sharedReason, sharedAt: current.sharedAt,
    ...(current.threadTs === undefined ? {} : { threadTs: current.threadTs }),
    ...(current.postFailedAt === undefined ? {} : { postFailedAt: current.postFailedAt }),
    mode: mode.mode,
    ...(mode.modeReason === undefined ? {} : { modeReason: mode.modeReason }),
  };
}

/** An AgentX admin who changed a task's share mode (C25), named on the audit record. */
export interface ShareAdmin { issuer: string; subject: string; displayName?: string }
export type ShareModeDependencies = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "actions" | "now" | "log">;

/**
 * C1, C5, C25: one share change's items: the task's whole share map under shareVersion, the index
 * row, the thread record's mode, the idempotency item and the `share` audit record (Q9), which
 * names the admin when an admin made the change.
 */
function shareItems(
  deps: ShareModeDependencies,
  turns: string,
  task: DeveloperTaskRecord,
  share: TaskShare,
  audit: { idempotencyKey: { pk: string; sk: string }; payloadHash: string; receivedAt: string; request: string; admin?: ShareAdmin },
): TransactItems {
  const version = task.shareVersion ?? 0;
  return [
    { Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: "SET #share = :share, #shared = :true, shareVersion = :next, updatedAt = :now",
      ConditionExpression: version === 0
        ? "attribute_exists(pk) AND attribute_not_exists(shareVersion) AND attribute_not_exists(closedAt)"
        : "shareVersion = :current AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#share": "share", "#shared": "shared" },
      ExpressionAttributeValues: { ":share": share, ":true": true, ":next": version + 1, ":now": audit.receivedAt, ...(version === 0 ? {} : { ":current": version }) },
    } },
    // Unconditional, as the close's: the start wrote this row with the task.
    { Update: {
      TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
      UpdateExpression: "SET #shared = :true", ExpressionAttributeNames: { "#shared": "shared" }, ExpressionAttributeValues: { ":true": true },
    } },
    ...(share.threadTs === undefined ? [] : [{ Update: {
      TableName: deps.tableName, Key: sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }),
      UpdateExpression: "SET #mode = :mode", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#mode": "mode" }, ExpressionAttributeValues: { ":mode": share.mode },
    } }]),
    putNew(deps.tableName, { ...audit.idempotencyKey, entityType: "IDEMPOTENCY", action: "share", payloadHash: audit.payloadHash }),
    // Q9: a share or mode change is audited like the task's other actions.
    putNew(turns, aiToolTurn({
      party: partyOfTask(task), turnId: randomUUID(), action: "share", phase: "accepted", outcome: "accepted", receivedAt: audit.receivedAt, finishedAt: iso(deps),
      request: audit.request, response: `Shared in ${shareLabel(share)}, ${share.mode === "view" ? "view only" : "open to the channel"}.`,
      ...(audit.admin === undefined ? {} : { admin: audit.admin }),
    })),
  ];
}

const shareIdempotencyKey = (task: DeveloperTaskRecord, requestId: string) => ({ pk: `IDEMPOTENCY#${task.ownerKey}#${task.workspaceId}`, sk: `REQUEST#${requestId}` });
const REUSED_REQUEST = "this request_id was already used for another action on this task; use a new request_id";

/**
 * C5. Answers at once; the notifier posts the start message or the mode change (C6). Only the
 * task's developer may call this route; an AgentX admin switches the mode through adminShareMode
 * (C25). Every write of `share` replaces the map, conditioned on shareVersion, so a notifier write
 * between this read and this write is read again, never lost (C1).
 */
async function shareTask(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown): Promise<{ task: DeveloperTaskView }> {
  const request = parse(ShareDeveloperTaskRequestSchema, value, deps, "share");
  let task = await loadOwnedTask(deps, caller, taskId);
  const turns = turnTable(deps);
  const idempotencyKey = shareIdempotencyKey(task, request.requestId);
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode ?? null, channel: request.channel ?? null });
  const answer = async () => {
    const view = await taskView(deps, task, { events: 0, details: false });
    await syncIndex(deps, task, view.status, view.updatedAt);
    return { task: view };
  };
  const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", REUSED_REQUEST);
    return answer();
  }
  for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt += 1) {
    if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    const receivedAt = iso(deps);
    const share = await nextShare(deps, caller, task, request, receivedAt);
    if (share === "unchanged") return answer();
    const items = shareItems(deps, turns, task, share, {
      idempotencyKey, payloadHash, receivedAt,
      request: `share ${request.shareMode ?? "default mode"}${request.channel === undefined ? "" : ` in ${request.channel}`}`,
    });
    try {
      await deps.actions.transact(items);
      task = await loadOwnedTask(deps, caller, taskId);
      return answer();
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same share, sent again, committed first.
      const concurrent = await get<{ payloadHash: string }>(deps, idempotencyKey);
      if (concurrent !== undefined) return shareTask(deps, caller, taskId, value);
      // The notifier (or a close) changed the task meanwhile: decide again from a fresh read.
      task = await loadOwnedTask(deps, caller, taskId);
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while sharing; try agentx_share_task again");
}

/**
 * C25 (owner answer to Q2, 2026-09-29): an AgentX admin switches a shared task between view only and
 * continue, within the latest revision's policy. The broker's admin route has already checked the
 * admin claim and the project's administrator membership (FR-015). An admin cannot share a private
 * task (sharing stays the developer's choice), move it to another channel, or change a closed task.
 * Ruling F5 (D22): the answer is the task's ID and share only, never its title or results.
 */
export async function adminShareMode(deps: ShareModeDependencies, admin: ShareAdmin, task: DeveloperTaskRecord, value: unknown): Promise<{ task: { taskId: string; share?: DeveloperTaskShare } }> {
  const request = parse(AdminShareModeRequestSchema, value, deps, "admin-share-mode");
  const turns = turnTable(deps);
  const idempotencyKey = shareIdempotencyKey(task, request.requestId);
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode, channel: null, admin: `${admin.issuer}#${admin.subject}` });
  let current = task;
  const answer = () => ({ task: { taskId: current.taskId, ...(current.share === undefined ? {} : { share: shareView(current.share) }) } });
  const reload = async () => {
    const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
    if (fresh === undefined) throw agentXError("TASK_NOT_FOUND", `no task ${task.taskId}`);
    current = fresh;
  };
  const previous = await get<{ payloadHash: string }>(deps, idempotencyKey);
  if (previous !== undefined) {
    if (previous.payloadHash !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", REUSED_REQUEST);
    return answer();
  }
  for (let attempt = 0; attempt < SHARE_ATTEMPTS; attempt += 1) {
    if (current.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "this task is closed, so its share mode can no longer change");
    if (current.share === undefined) throw agentXError("CONFIG_INVALID", "this task is private; only its developer can share it");
    const project = await deps.actions.latestProject(current.project);
    if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; register it again first");
    const share = withMode(current.share, decideMode(developerTaskPolicy(project.definition), request.shareMode));
    if (share === "unchanged") return answer();
    const receivedAt = iso(deps);
    try {
      await deps.actions.transact(shareItems(deps, turns, current, share, { idempotencyKey, payloadHash, receivedAt, request: `admin share mode ${request.shareMode}`, admin }));
      await reload();
      return answer();
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The same request committed first, or the notifier (or a close) changed the task: read it again.
      const committed = await get(deps, idempotencyKey) !== undefined;
      await reload();
      if (committed) return answer();
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while switching its mode; try again");
}

/** Every developer task route answers 200 with its body; errors are AgentXErrors. */
export async function routeDeveloperTaskRequest(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (request.method === "POST" && url.pathname === "/v1/dev/tasks") return startTask(deps, caller, body(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/tasks") return listTasks(deps, caller, url);
  const route = /^\/v1\/dev\/tasks\/([^/]+)(?:\/(events|continue|cancel|close|pull-requests|share))?$/.exec(url.pathname);
  const taskId = route?.[1] === undefined ? undefined : safeDecode(route[1]);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === undefined) return readTask(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "GET" && route?.[2] === "events") return taskEvents(deps, caller, taskId, url);
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "continue") return continueTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "cancel") return cancelTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "close") return closeTask(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "pull-requests") return openPullRequest(deps, caller, taskId, body(request));
  if (taskId !== undefined && request.method === "POST" && route?.[2] === "share") return shareTask(deps, caller, taskId, body(request));
  throw agentXError("NOT_FOUND", "route not found");
}
