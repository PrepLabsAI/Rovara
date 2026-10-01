// Issue 173: the reconciler backstop. Issue 167 cancels a Slack worker task when its turn gives up
// for good, but a task can still run with nobody waiting on it when the Slack service crashes
// first, or when a message goes to the dead-letter queue with no final attempt. Each reconciler run
// hands a Slack thread's coding task still live 4 hours after it started to the broker, which
// checks again that nobody waits on it (the thread's activeTurn, issue 157) and cancels it through
// the cancel route's own path; the thread then gets one short note.
//
// Never touched: tasks started from an AI tool (MCP developer tasks run with no waiter by design),
// operations already asked to cancel or finished, and anything a turn waits on. This module only
// picks the candidates and acts on the broker's answer; the broker decides.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { taskPointerKey } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };

/** Owner decision, 2026-09-30: 4 hours (2 and 8 were the other options). */
export const UNWAITED_TASK_LIMIT_MS = 4 * 60 * 60_000;
const LIMIT_HOURS = UNWAITED_TASK_LIMIT_MS / 3_600_000;
export const UNWAITED_TASK_NOTE = `AgentX stopped a task that had run for over ${LIMIT_HOURS} hours with nobody waiting on it. Send a new message if you still need it.`;
/** Statuses of a task still running or about to: CANCEL_REQUESTED is already on its way out. */
const LIVE: ReadonlySet<string> = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

export interface SlackThreadPlace { channelId: string; threadTs: string }

/** The broker's answer: it queued a cancel, or found nothing it may cancel (with why, for the log). */
export type UnwaitedTaskStop =
  | { outcome: "CANCEL_REQUESTED"; cancelOperationId: string; thread: SlackThreadPlace }
  | { outcome: "SKIPPED"; reason: string };

/**
 * Whether an operation is old and live enough to be a candidate: a coding task, still ACCEPTED,
 * DISPATCHING or RUNNING more than the limit after it started, and not started from an AI tool.
 * The broker applies the same test again before it cancels.
 */
export function isUnwaitedTaskCandidate(operation: Record<string, unknown> | undefined, now: Date): boolean {
  if (operation?.kind !== "task" || !LIVE.has(String(operation.status))) return false;
  const started = typeof operation.createdAt === "string" ? Date.parse(operation.createdAt) : Number.NaN;
  if (!Number.isFinite(started) || now.getTime() - started <= UNWAITED_TASK_LIMIT_MS) return false;
  const requester = operation.requestedBy as { kind?: unknown } | undefined;
  return requester?.kind !== "developer";
}

export interface UnwaitedTaskSweepDependencies {
  client: Client;
  tableName: string;
  /** Asks the broker to cancel the task, if it still may. */
  stopTask(workspaceId: string, operationId: string): Promise<UnwaitedTaskStop>;
  postNote(thread: SlackThreadPlace, text: string): Promise<void>;
  log: (entry: Record<string, unknown>) => void;
}

export interface UnwaitedTaskSweepResult {
  /** Operation IDs the broker queued a cancel for this run. */
  cancelled: string[];
  /**
   * Operation IDs whose cancel failed, or workspace IDs whose reads failed. Nothing changed for them,
   * so the next run tries again.
   */
  failed: string[];
  /** Notes that could not be posted. Never retried: the task is already cancelled, so the next run skips it. */
  noteFailures: number;
}

const errorName = (error: unknown) => error instanceof Error ? error.name : "unknown";

/**
 * The workspace's active operation ID when it is a candidate: an old live coding task, not from an
 * AI tool, in a workspace a Slack thread owns. The last check is the broker's too; doing it here
 * keeps an API or CLI workspace's long task from invoking the broker on every run.
 */
async function candidateOperation(
  get: (pk: string, sk: string) => Promise<Record<string, unknown> | undefined>,
  workspaceId: string,
  now: Date,
): Promise<string | undefined> {
  const workspace = await get(`WORKSPACE#${workspaceId}`, "META");
  const operationId = workspace?.activeOperationId;
  if (typeof operationId !== "string" || operationId.length === 0) return undefined;
  if (!isUnwaitedTaskCandidate(await get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`), now)) return undefined;
  const pointer = taskPointerKey(workspaceId);
  if (await get(pointer.pk, pointer.sk) !== undefined) return undefined;
  if (typeof workspace?.ownerKey !== "string") return undefined;
  const thread = await get(`SLACK_THREAD#${workspace.ownerKey}`, "META");
  return thread?.workspaceId === workspaceId && typeof thread.thread === "string" ? operationId : undefined;
}

/**
 * Looks at the active operation of each given workspace: the reconciler's live sessions. A task in
 * a workspace with no live session holds no worker, so none is missed that keeps a worker running.
 */
export async function sweepUnwaitedTasks(
  dependencies: UnwaitedTaskSweepDependencies,
  workspaceIds: Iterable<string>,
  now: Date,
): Promise<UnwaitedTaskSweepResult> {
  const result: UnwaitedTaskSweepResult = { cancelled: [], failed: [], noteFailures: 0 };
  const get = async (pk: string, sk: string) => ((await dependencies.client.send(new GetCommand({
    TableName: dependencies.tableName, Key: { pk, sk }, ConsistentRead: true,
  }))) as { Item?: Record<string, unknown> }).Item;
  for (const workspaceId of workspaceIds) {
    let operationId: string | undefined;
    try {
      operationId = await candidateOperation(get, workspaceId, now);
    } catch (error) {
      // One workspace's failed read never stops the others; its name only, and the next run reads it again.
      result.failed.push(workspaceId);
      dependencies.log({ event: "unwaited_task.read_failed", workspaceId, errorName: errorName(error) });
      continue;
    }
    if (operationId === undefined) continue;
    const fields = { workspaceId, operationId };
    let answer: UnwaitedTaskStop;
    try {
      answer = await dependencies.stopTask(workspaceId, operationId);
    } catch (error) {
      // The error's name only: a message could carry a response body. Still live, so retried next run.
      result.failed.push(operationId);
      dependencies.log({ event: "unwaited_task.cancel_failed", ...fields, errorName: errorName(error) });
      continue;
    }
    if (answer.outcome !== "CANCEL_REQUESTED") {
      dependencies.log({ event: "unwaited_task.skipped", ...fields, reason: answer.reason });
      continue;
    }
    result.cancelled.push(operationId);
    dependencies.log({ event: "unwaited_task.cancelled", ...fields, cancelOperationId: answer.cancelOperationId });
    try {
      await dependencies.postNote(answer.thread, UNWAITED_TASK_NOTE);
    } catch (error) {
      result.noteFailures += 1;
      dependencies.log({ event: "unwaited_task.note_failed", ...fields, errorName: errorName(error) });
    }
  }
  return result;
}

/** The backstop runs only where the infrastructure named the broker and the Slack secret: named environments. */
export function unwaitedTaskBackstopWanted(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.BROKER_FUNCTION_NAME) && Boolean(env.SLACK_SECRET_ARN);
}

const brokerFailure = (name: string) => Object.assign(new Error("the broker did not stop the task"), { name });

/**
 * stopTask over a direct invocation of the broker Lambda (`invoke` sends the payload, RequestResponse).
 * A refusal or failure throws an error named by the broker's error code (an AgentX code, or
 * "unknown"), never carrying the broker's message, so the sweep can log the name alone.
 */
export function createBrokerTaskStopper(
  invoke: (payload: string) => Promise<{ FunctionError?: string | undefined; Payload?: Uint8Array | undefined }>,
): (workspaceId: string, operationId: string) => Promise<UnwaitedTaskStop> {
  return async (workspaceId, operationId) => {
    const response = await invoke(JSON.stringify({ source: "agentx.session-reconciler", action: "stop-unwaited-task", workspaceId, operationId }));
    if (response.FunctionError !== undefined || response.Payload === undefined) throw brokerFailure("BrokerInvokeFailed");
    let reply: { statusCode?: unknown; body?: unknown };
    let body: Record<string, unknown>;
    try {
      reply = JSON.parse(new TextDecoder().decode(response.Payload)) as { statusCode?: unknown; body?: unknown };
      body = JSON.parse(typeof reply.body === "string" ? reply.body : "{}") as Record<string, unknown>;
    } catch {
      throw brokerFailure("BrokerAnswerUnreadable");
    }
    if (reply.statusCode !== 200) {
      const code = (body.error as { code?: unknown } | undefined)?.code;
      throw brokerFailure(`BrokerRefused_${typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "unknown"}`);
    }
    if (body.outcome === "SKIPPED" && typeof body.reason === "string") return { outcome: "SKIPPED", reason: body.reason };
    const thread = body.thread as { channelId?: unknown; threadTs?: unknown } | undefined;
    if (body.outcome === "CANCEL_REQUESTED" && typeof body.cancelOperationId === "string"
      && typeof thread?.channelId === "string" && typeof thread.threadTs === "string") {
      return { outcome: "CANCEL_REQUESTED", cancelOperationId: body.cancelOperationId, thread: { channelId: thread.channelId, threadTs: thread.threadTs } };
    }
    throw brokerFailure("BrokerAnswerUnreadable");
  };
}
