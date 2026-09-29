// Spec 025 phase 25b: a developer task's records, owner key, status and failure rules, event text
// and audit records. No I/O; aws/developer-tasks.ts and the broker's result hook call these.
import { createHash } from "node:crypto";
import {
  inertName,
  AiToolTurnRecordSchema,
  DEVELOPER_EVENT_TEXT_MAX,
  DEVELOPER_FAILURE_MESSAGE_MAX,
  DEVELOPER_TASK_OWNER_ISSUER,
  PullRequestResultSchema,
  TURN_TEXT_LIMIT,
  aiToolTurnRecordKeys,
  capText,
  lastAssistantResponse,
  redactAndCap,
  redactText,
  slackThreadSubject,
  slackThreadUrl,
  type AiToolTurnRecord,
  type DeveloperRequester,
  type DeveloperTaskEvent,
  type DeveloperTaskFailureCategory,
  type DeveloperTaskShare,
  type DeveloperTaskStatus,
  type Operation,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import type { ShareDecision } from "./share.js";

export interface CounterKey { pk: string; sk: string }
export interface WorkspaceCharge { member: CounterKey; organization: CounterKey }

/** DEVTASK#<taskId> / META: the task. */
export interface DeveloperTaskRecord {
  pk: string;
  sk: "META";
  entityType: "DEVELOPER_TASK";
  taskId: string;
  developerId: string;
  provider: "slack" | "oidc";
  developerName: string;
  slackUserId?: string;
  client: string;
  project: string;
  title: string;
  workspaceId: string;
  ownerKey: string;
  conversationId: string;
  startingRevision: number;
  charge: WorkspaceCharge;
  /** C1: whether the task is shared to its channel, and how. */
  shared: boolean;
  share?: TaskShare;
  /** C1: every write of `share` replaces the whole map, conditioned on this number. */
  shareVersion?: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/** C1: a shared task's thread, as the task record keeps it. */
export interface TaskShare {
  teamId: string;
  channelId: string;
  channelName?: string;
  mode: "view" | "continue";
  sharedReason: "requested" | "required";
  modeReason?: "continue_not_allowed";
  sharedAt: string;
  threadTs?: string;
  postFailedAt?: string;
}

export function taskShare(decision: ShareDecision, teamId: string, sharedAt: string): TaskShare {
  return {
    teamId, channelId: decision.channelId,
    ...(decision.channelName === undefined ? {} : { channelName: decision.channelName }),
    mode: decision.mode, sharedReason: decision.sharedReason,
    ...(decision.modeReason === undefined ? {} : { modeReason: decision.modeReason }),
    sharedAt,
  };
}

/** The wire view of a share: a thread link only once the notifier has posted (C6). */
export function shareView(share: TaskShare): DeveloperTaskShare {
  return {
    mode: share.mode, channelId: share.channelId,
    ...(share.channelName === undefined ? {} : { channelName: share.channelName }),
    sharedReason: share.sharedReason,
    ...(share.modeReason === undefined ? {} : { modeReason: share.modeReason }),
    ...(share.threadTs === undefined ? {} : { threadUrl: slackThreadUrl({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }) }),
    ...(share.postFailedAt === undefined ? {} : { postFailed: true }),
  };
}

/** The shared thread's Slack subject, the key of its Slack-side records (ruling F11: contracts' builder, which validates). */
export const sharedSubject = (share: TaskShare & { threadTs: string }): string =>
  slackThreadSubject({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs });

/** DEVELOPER#<developerId> / TASK#<createdAt>#<taskId>: the task index of FR-017. */
export interface DeveloperTaskIndexRecord {
  pk: string;
  sk: string;
  entityType: "DEVELOPER_TASK_INDEX";
  taskId: string;
  project: string;
  title: string;
  client: string;
  status: DeveloperTaskStatus;
  shared: boolean;
  startingRevision: number;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

/** WORKSPACE#<workspaceId> / DEVELOPER_TASK: how a worker callback finds the task (R2, R3). */
export interface DeveloperTaskPointerRecord {
  pk: string;
  sk: "DEVELOPER_TASK";
  entityType: "DEVELOPER_TASK_POINTER";
  taskId: string;
  developerId: string;
  requester: DeveloperRequester;
  conversationId: string;
  firstRequestId: string;
  /** The first instructions, until the prepare's result queues them (R3). */
  pendingPrompt?: string;
  /** Set when the task was cancelled before its instructions ran (R16). */
  cancelledAt?: string;
}

export const taskKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "META" as const });
export const taskIndexKey = (developerId: string, createdAt: string, taskId: string) => ({ pk: `DEVELOPER#${developerId}`, sk: `TASK#${createdAt}#${taskId}` });
export const taskPointerKey = (workspaceId: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK" as const });
export const startIdempotencyKey = (developerId: string, requestId: string) => ({ pk: `IDEMPOTENCY#${developerId}#DEVTASK`, sk: `REQUEST#${requestId}` });

export const taskOwnerSubject = (developerId: string, taskId: string): string => `${developerId}/${taskId}`;

/** FR-017: the same function as ownerKeyForSubject, so every workspace handler accepts it. */
export function taskOwnerKey(developerId: string, taskId: string): string {
  return createHash("sha256").update(DEVELOPER_TASK_OWNER_ISSUER).update("\0").update(taskOwnerSubject(developerId, taskId)).digest("hex");
}

export interface OperationFacts { id: string; kind: string; status: string; error?: string | undefined; createdAt: string; fence?: number | undefined }

const LIVE = new Set(["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"]);

/**
 * Oldest first. F9: exported so Task 10 reuses it rather than redeclaring it. Two operations can
 * share a millisecond, so a tie goes to the fence: each writer operation takes the workspace's
 * next fence, so the later one has the higher fence.
 */
export const byCreated = (left: OperationFacts, right: OperationFacts) =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : (left.fence ?? 0) - (right.fence ?? 0);

/** The newest task or publish operation: what the developer last asked for (R4). */
export function currentOperation(operations: readonly OperationFacts[]): OperationFacts | undefined {
  return operations.filter((operation) => operation.kind === "task" || operation.kind === "publish").sort(byCreated).at(-1);
}

const DISPATCH_OR_COMPUTE = /^RUNTIME_UNAVAILABLE:/;
/** F18: also matches the worker devcontainer's "timeout:<ms>" error text (packages/worker/src/devcontainer.ts). */
const TIMED_OUT = /\btimed? ?out\b|\btimeout:/i;

/** R5. */
export function failureCategory(kind: string, status: string, error: string | undefined): DeveloperTaskFailureCategory {
  if (status === "INTERRUPTED") return "interrupted";
  if (error !== undefined && DISPATCH_OR_COMPUTE.test(error)) return "worker_unavailable";
  if (kind === "prepare") return "setup_failed";
  if (kind === "publish") return "publication_failed";
  if (error !== undefined && TIMED_OUT.test(error)) return "timed_out";
  return "task_failed";
}

const failureOf = (kind: string, status: string, error: string | undefined) => ({
  category: failureCategory(kind, status, error),
  // redactAndCap redacts then caps surrogate-pair-safely (a plain .slice can split an emoji).
  message: redactAndCap(error ?? `the ${kind} operation ended ${status}`, DEVELOPER_FAILURE_MESSAGE_MAX).text,
});

export interface DerivedStatus {
  status: DeveloperTaskStatus;
  failure?: { category: DeveloperTaskFailureCategory; message: string };
  closing: boolean;
  current?: OperationFacts;
}

/** R4's table. */
export function deriveTaskStatus(input: {
  closedAt?: string | undefined;
  workspaceStatus: string;
  pointer?: { pendingPrompt?: string | undefined; cancelledAt?: string | undefined } | undefined;
  operations: readonly OperationFacts[];
}): DerivedStatus {
  const closing = input.workspaceStatus === "CLOSING" || input.operations.some((operation) => operation.kind === "close" && LIVE.has(operation.status));
  const current = currentOperation(input.operations);
  const withCurrent = current === undefined ? {} : { current };
  if (input.closedAt !== undefined || input.workspaceStatus === "CLOSED") return { status: "CLOSED", closing: false, ...withCurrent };
  if (input.pointer?.cancelledAt !== undefined && current === undefined) return { status: "CANCELLED", closing };
  if (input.workspaceStatus === "PREPARATION_FAILED") {
    const prepare = input.operations.filter((operation) => operation.kind === "prepare").sort(byCreated).at(-1);
    return { status: "FAILED", closing, failure: failureOf("prepare", prepare?.status ?? "FAILED", prepare?.error) };
  }
  if (input.pointer?.pendingPrompt !== undefined || input.workspaceStatus === "PREPARING" || current === undefined) return { status: "STARTING", closing };
  if (LIVE.has(current.status)) return { status: "RUNNING", closing, current };
  const status = current.status as "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  return {
    status, closing, current,
    ...(status === "FAILED" || status === "INTERRUPTED" ? { failure: failureOf(current.kind, status, current.error) } : {}),
  };
}

export interface StoredEvent { sequence: number; type: string; timestamp: string; payload: unknown }

// capText caps surrogate-pair-safely (a plain .slice can split an emoji at the boundary).
const text = (value: string) => capText(redactText(value).replace(/\s+/g, " ").trim(), DEVELOPER_EVENT_TEXT_MAX).text;
const field = (payload: unknown, name: string): unknown => (payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined);

/** One worker event as a line the developer can read, or undefined for streaming noise. */
export function taskEvent(event: StoredEvent): DeveloperTaskEvent | undefined {
  const at = event.timestamp;
  const payload = event.payload;
  switch (event.type) {
    case "lifecycle":
    case "result": {
      const status = field(payload, "status");
      return typeof status === "string" ? { at, kind: "status", text: text(`Worker status: ${status}`) } : undefined;
    }
    case "error": {
      const message = field(payload, "message");
      return { at, kind: "error", text: text(typeof message === "string" ? message : "the worker reported an error") };
    }
    case "tool_start":
    case "tool_end": {
      const name = field(payload, "toolName");
      const tool = typeof name === "string" ? name : "a tool";
      const verb = event.type === "tool_start" ? "Started" : field(payload, "isError") === true ? "Failed" : "Finished";
      return { at, kind: "tool", text: text(`${verb} ${tool}`) };
    }
    case "progress": {
      const message = field(payload, "message");
      if (typeof message === "string") return { at, kind: "progress", text: text(message) };
      // F7: reuse lastAssistantResponse (Task 2) instead of a second copy of its block-extraction logic.
      const said = lastAssistantResponse([{ payload }]);
      return said === undefined ? undefined : { at, kind: "message", text: text(said) };
    }
    default:
      return undefined;
  }
}

/** The newest `count` readable events, returned oldest first. */
export function recentTaskEvents(newestFirst: readonly StoredEvent[], count: number): DeveloperTaskEvent[] {
  const picked: DeveloperTaskEvent[] = [];
  for (const event of newestFirst) {
    if (picked.length >= count) break;
    const readable = taskEvent(event);
    if (readable !== undefined) picked.push(readable);
  }
  return picked.reverse();
}

export interface TurnParty {
  taskId: string;
  developerId: string;
  provider: "slack" | "oidc";
  developerName: string;
  slackUserId?: string | undefined;
  client: string;
  workspaceId?: string | undefined;
  settingsRevision?: number | undefined;
}

/** F8: the turn record's party, built from a task record, so Task 11's routes and result hook
 * do not each repeat this literal. */
export function partyOfTask(task: DeveloperTaskRecord): TurnParty {
  return {
    taskId: task.taskId, developerId: task.developerId, provider: task.provider, developerName: task.developerName,
    slackUserId: task.slackUserId, client: task.client, workspaceId: task.workspaceId, settingsRevision: task.startingRevision,
  };
}

/**
 * R12: one immutable AI-tool turn record and its keys. Free text only through redactAndCap, so a
 * secret-looking request or response never reaches storage. Each call is one phase (accepted,
 * completed or refused) of one action; the caller's turnId (a fresh id per phase, or the
 * operation's id for a completed phase) keeps aiToolTurnRecordKeys' sk (TURN#<receivedAt>#<turnId>)
 * distinct per phase, so the three phases of one action are three rows, written once each with
 * PutItem and never updated.
 */
export function aiToolTurn(input: {
  party: TurnParty;
  turnId: string;
  action: AiToolTurnRecord["action"];
  phase: AiToolTurnRecord["phase"];
  outcome: AiToolTurnRecord["outcome"];
  receivedAt: string;
  finishedAt: string;
  request: string;
  response: string;
  operationId?: string | undefined;
  errorCode?: string | undefined;
  /** C25: the AgentX admin who took this action on the developer's task (a share mode change). */
  admin?: { issuer: string; subject: string; displayName?: string } | undefined;
}): Record<string, unknown> & AiToolTurnRecord {
  const request = redactAndCap(input.request, TURN_TEXT_LIMIT);
  const response = redactAndCap(input.response, TURN_TEXT_LIMIT);
  const { party } = input;
  const record = AiToolTurnRecordSchema.parse({
    origin: "ai_tool",
    taskId: party.taskId,
    turnId: input.turnId,
    action: input.action,
    phase: input.phase,
    developer: {
      developerId: party.developerId,
      provider: party.provider,
      displayName: party.developerName.slice(0, 200) || "developer",
      ...(party.slackUserId === undefined ? {} : { slackUserId: party.slackUserId }),
    },
    client: party.client,
    ...(input.admin === undefined ? {} : { admin: {
      issuer: input.admin.issuer.slice(0, 512), subject: input.admin.subject.slice(0, 256),
      ...(input.admin.displayName === undefined ? {} : { displayName: input.admin.displayName.slice(0, 200) }),
    } }),
    receivedAt: input.receivedAt,
    ...(party.settingsRevision === undefined ? {} : { settingsRevision: party.settingsRevision }),
    ...(party.workspaceId === undefined ? {} : { workspaceId: party.workspaceId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    outcome: input.outcome,
    startedAt: input.receivedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.receivedAt)),
    requestText: request.text,
    responseText: response.text,
    ...(request.truncated || response.truncated ? { textTruncated: true } : {}),
    ...(input.errorCode === undefined ? {} : { error: { code: input.errorCode.slice(0, 64) } }),
  });
  return { ...aiToolTurnRecordKeys(record), ...record };
}

const OUTCOME: Record<string, AiToolTurnRecord["outcome"]> = { SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled", INTERRUPTED: "interrupted" };

/**
 * R12: the result of a developer's task or publish operation. Its turnId and receivedAt are the
 * operation's ID and creation time, so its key is fixed and a repeated result cannot write it
 * twice. The response text is the result summary (FR-037), redacted and capped by aiToolTurn.
 */
export function completedTurn(input: {
  task: DeveloperTaskRecord;
  pointer: Pick<DeveloperTaskPointerRecord, "firstRequestId">;
  operation: Pick<Operation, "id" | "kind" | "requestId" | "createdAt"> & { result?: unknown; error?: string | undefined };
  status: string;
  events: readonly StoredEvent[];
  now: string;
}): Record<string, unknown> & AiToolTurnRecord {
  const { operation } = input;
  const ended = `ended ${input.status}${operation.error ? `: ${operation.error}` : ""}`;
  const published = operation.kind === "publish" ? PullRequestResultSchema.safeParse(operation.result) : undefined;
  const response = operation.kind === "publish"
    ? (published?.success ? `Pull request ${published.data.url}` : `The pull request ${ended}`)
    : lastAssistantResponse(input.events) ?? `The task ${ended}`;
  return aiToolTurn({
    party: partyOfTask(input.task),
    turnId: operation.id,
    action: operation.kind === "publish" ? "pull_request" : operation.requestId === input.pointer.firstRequestId ? "start" : "continue",
    phase: "completed",
    outcome: OUTCOME[input.status] ?? "failed",
    receivedAt: operation.createdAt,
    finishedAt: input.now,
    request: "",
    response,
    operationId: operation.id,
  });
}

/** Moved to the contracts package so the MCP server marks names the same way (final review M7). */
export { inertName };

/** FR-023. The client is one of the four names cleanClientName gives, so it needs no escaping. */
export function developerFooter(name: string, client: string): string {
  return `Requested by ${inertName(name)} via AgentX, started from ${client}`;
}

/** The identity every workspace handler sees for a developer task: its own owner key (FR-021). */
export function developerTaskIdentity(task: Pick<DeveloperTaskRecord, "taskId" | "developerId" | "provider" | "developerName" | "client">): AuthenticatedIdentity {
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(task.developerId, task.taskId),
    ownerKey: taskOwnerKey(task.developerId, task.taskId),
    isAdministrator: false,
    claims: {},
    developer: { developerId: task.developerId, provider: task.provider, name: task.developerName, client: task.client, taskId: task.taskId },
  };
}
