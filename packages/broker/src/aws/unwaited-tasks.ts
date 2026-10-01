// Issue 173: the reconciler backstop. Issue 167 cancels a Slack worker task when its turn gives up
// for good, but a task can still run with nobody waiting on it when the Slack service crashes
// first, or when a message goes to the dead-letter queue with no final attempt.
//
// Owner decisions, 2026-10-01. Each reconciler run cancels a Slack thread's coding task that has
// been idle for 24 hours (no new worker event) with nobody waiting on it. The cancel runs here,
// inside the reconciler, through requestCancellation, the cancel route's own code; the thread then
// gets one short note.
//
// Idle: the latest worker event's timestamp (the event the worker's callback stored last, found by
// the operation's eventSequence), else the operation's updatedAt, else its createdAt. updatedAt
// alone is not enough: the broker refreshes it only when the task starts running, not per event.
// The event's timestamp is the worker's clock: one running ahead is capped at now, and one running
// behind makes the task look idle for longer by that much (workers keep NTP time). The cancel is
// written only while no new event has landed since the idle check; a status change alone in that
// window (a task that sat 24 hours before it ran) is not checked.
//
// Waiting: the thread's activeTurn names the task and its seenAt is under 15 minutes old. The
// Slack service stamps seenAt when it saves the turn and on every SQS heartbeat (5 minutes) while
// the turn lives. An activeTurn with no seenAt was written by an older Slack service: it counts as
// a waiter until the task has been idle 48 hours, so a rollout cannot cancel a live turn. An
// activeTurn or seenAt that cannot be read counts as a waiter.
//
// Never touched: tasks started from an AI tool (MCP developer tasks run with no waiter by design),
// operations already asked to cancel or finished, other operation kinds, and anything waited on.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { WorkspaceInstanceSchema, workspaceRecordFields } from "@agentx/contracts";
import { taskPointerKey } from "../developer/task-records.js";
import { requestCancellation } from "./cancellation.js";
import { parseSlackSecrets } from "./slack-ingress.js";

/** Owner decision, 2026-10-01: a task idle this long with nobody waiting is stopped. */
export const UNWAITED_TASK_IDLE_LIMIT_MS = 24 * 60 * 60_000;
/** An activeTurn counts as a waiter only while its seenAt is this recent. */
export const WAITER_SEEN_WITHIN_MS = 15 * 60_000;
/** An activeTurn with no seenAt (an older Slack service) counts as a waiter until the task is idle this long. */
export const UNSTAMPED_WAITER_GRACE_MS = 48 * 60 * 60_000;
const LIMIT_HOURS = UNWAITED_TASK_IDLE_LIMIT_MS / 3_600_000;
export const UNWAITED_TASK_NOTE = `AgentX stopped a task that had been idle for over ${LIMIT_HOURS} hours with nobody waiting on it. Send a new message if you still need it.`;
/** Statuses of a task still running or about to: CANCEL_REQUESTED is already on its way out. */
const LIVE: ReadonlySet<string> = new Set(["ACCEPTED", "DISPATCHING", "RUNNING"]);

type Client = { send(command: unknown): Promise<unknown> };

export interface SlackThreadPlace { channelId: string; threadTs: string }

const time = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** When the task last showed activity, in epoch milliseconds, never later than now. */
export function lastActivityAt(
  operation: { createdAt?: unknown; updatedAt?: unknown },
  latestEvent: { timestamp?: unknown } | undefined,
  now: Date,
): number {
  const candidates = [time(latestEvent?.timestamp), time(operation.updatedAt), time(operation.createdAt)].filter((value): value is number => value !== undefined);
  // A worker clock ahead of ours counts as active now, never as active in the future.
  return Math.min(Math.max(...candidates, 0), now.getTime());
}

export interface UnwaitedTaskSweepDependencies {
  client: Client;
  tableName: string;
  /** The Slack threads table, read for the thread's activeTurn. */
  threadsTableName: string;
  /** Signs the cancel operation's worker callbacks, as the broker does. */
  callbackSigningKey: string;
  postNote(thread: SlackThreadPlace, text: string): Promise<void>;
  log: (entry: Record<string, unknown>) => void;
}

export interface UnwaitedTaskSweepResult {
  /** Operation IDs cancelled this run. */
  cancelled: string[];
  /** Operation IDs whose cancel failed; they are still live, so the next run tries again. */
  failed: string[];
  /** Workspace IDs whose reads failed; nothing changed for them, so the next run reads them again. */
  readFailures: string[];
  /** Notes that could not be posted. Never retried: the task is already cancelled, so the next run skips it. */
  noteFailures: number;
}

type Candidate = { workspace: Record<string, unknown>; operationId: string; eventSequence: number; thread: SlackThreadPlace & { teamId: string } };

const errorName = (error: unknown) => error instanceof Error ? error.name : "unknown";

/** The workspace's active task, when it may be cancelled: every rule above but the cancel's own race checks. */
async function candidate(
  dependencies: UnwaitedTaskSweepDependencies,
  workspaceId: string,
  now: Date,
): Promise<Candidate | { skip: string } | undefined> {
  const get = async (tableName: string, pk: string, sk: string, projection?: string) => ((await dependencies.client.send(new GetCommand({
    TableName: tableName, Key: { pk, sk }, ConsistentRead: true, ...(projection === undefined ? {} : { ProjectionExpression: projection }),
  }))) as { Item?: Record<string, unknown> }).Item;
  const state = (pk: string, sk: string) => get(dependencies.tableName, pk, sk);
  const workspace = await state(`WORKSPACE#${workspaceId}`, "META");
  const operationId = workspace?.activeOperationId;
  if (workspace === undefined || typeof operationId !== "string" || operationId.length === 0) return undefined;
  const operation = await state(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`);
  // Every operation record carries an eventSequence (from 0); one without cannot be judged.
  if (operation?.kind !== "task" || !LIVE.has(String(operation.status)) || typeof operation.eventSequence !== "number") return undefined;
  if ((operation.requestedBy as { kind?: unknown } | undefined)?.kind === "developer") return undefined;
  const sequence = operation.eventSequence;
  const latestEvent = sequence > 0 ? await state(`OPERATION#${operationId}`, `EVENT#${String(sequence).padStart(12, "0")}`) : undefined;
  const idle = now.getTime() - lastActivityAt(operation, latestEvent, now);
  if (idle <= UNWAITED_TASK_IDLE_LIMIT_MS) return undefined;
  const pointer = taskPointerKey(workspaceId);
  if (await state(pointer.pk, pointer.sk) !== undefined) return undefined;
  if (typeof workspace.ownerKey !== "string") return undefined;
  const record = await state(`SLACK_THREAD#${workspace.ownerKey}`, "META");
  // An API or CLI workspace has no thread record: left alone quietly, as on every run. A record that
  // is unreadable or names another workspace is logged, so a mis-wired thread is visible.
  if (record === undefined) return undefined;
  if (record.workspaceId !== workspaceId) return { skip: "thread-rebound" };
  const parts = typeof record.thread === "string" ? record.thread.split("/") : [];
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { skip: "thread-record-unreadable" };
  const [teamId, channelId, threadTs] = parts as [string, string, string];
  // The activeTurn alone: never the thread's other fields, such as a turn note with the member's words.
  const meta = await get(dependencies.threadsTableName, `THREAD#${record.thread as string}`, "META", "activeTurn");
  const waiter = waiterOf(meta?.activeTurn, operationId, idle, now);
  if (waiter !== undefined) return { skip: waiter };
  return { workspace, operationId, eventSequence: sequence, thread: { teamId, channelId, threadTs } };
}

/** Why the activeTurn counts as a waiter for this task, or undefined when it does not. */
function waiterOf(activeTurn: unknown, operationId: string, idle: number, now: Date): string | undefined {
  if (activeTurn === undefined || activeTurn === null) return undefined;
  if (typeof activeTurn !== "object") return "waiter-unreadable";
  const turn = activeTurn as { operationId?: unknown; seenAt?: unknown };
  if (typeof turn.operationId !== "string" || turn.operationId.length === 0) return "waiter-unreadable";
  if (turn.operationId !== operationId) return undefined;
  if (turn.seenAt === undefined) return idle > UNSTAMPED_WAITER_GRACE_MS ? undefined : "waited-on-unstamped";
  const seenAt = time(turn.seenAt);
  if (seenAt === undefined) return "waiter-unreadable";
  return now.getTime() - seenAt < WAITER_SEEN_WITHIN_MS ? "waited-on" : undefined;
}

/**
 * Looks at the active operation of each given workspace: the reconciler's live sessions. A workspace
 * with no live session holds no worker, so none is missed that keeps a worker running.
 */
export async function sweepUnwaitedTasks(
  dependencies: UnwaitedTaskSweepDependencies,
  workspaceIds: Iterable<string>,
  now: Date,
): Promise<UnwaitedTaskSweepResult> {
  const result: UnwaitedTaskSweepResult = { cancelled: [], failed: [], readFailures: [], noteFailures: 0 };
  for (const workspaceId of workspaceIds) {
    let found: Awaited<ReturnType<typeof candidate>>;
    try {
      found = await candidate(dependencies, workspaceId, now);
    } catch (error) {
      // One workspace's failed read never stops the others; its name only, and the next run reads it again.
      result.readFailures.push(workspaceId);
      dependencies.log({ event: "unwaited_task.read_failed", workspaceId, errorName: errorName(error) });
      continue;
    }
    if (found === undefined) continue;
    if ("skip" in found) {
      dependencies.log({ event: "unwaited_task.skipped", workspaceId, reason: found.skip });
      continue;
    }
    const { operationId, thread } = found;
    const fields = { workspaceId, operationId };
    let answer: Awaited<ReturnType<typeof requestCancellation>>;
    try {
      const workspace = WorkspaceInstanceSchema.parse(workspaceRecordFields(found.workspace));
      // The cancel route's own path. onlyLive: a result, a member's stop or a new worker event that
      // lands first wins.
      answer = await requestCancellation({
        documentClient: dependencies.client as never, tableName: dependencies.tableName, callbackSigningKey: dependencies.callbackSigningKey,
      }, workspace, operationId, {}, () => [], { onlyLive: true, eventSequence: found.eventSequence });
    } catch (error) {
      // The error's name only: a message could carry stored data. Still live, so retried next run.
      result.failed.push(operationId);
      dependencies.log({ event: "unwaited_task.cancel_failed", ...fields, errorName: errorName(error) });
      continue;
    }
    if (answer.duplicate) {
      dependencies.log({ event: "unwaited_task.skipped", ...fields, reason: answer.alreadyCancelling ? "already-cancelling" : answer.activeAgain ? "active-again" : "finished" });
      continue;
    }
    result.cancelled.push(operationId);
    dependencies.log({ event: "unwaited_task.cancelled", ...fields, cancelOperationId: answer.operation.id });
    try {
      await dependencies.postNote({ channelId: thread.channelId, threadTs: thread.threadTs }, UNWAITED_TASK_NOTE);
    } catch (error) {
      result.noteFailures += 1;
      dependencies.log({ event: "unwaited_task.note_failed", ...fields, errorName: errorName(error) });
    }
  }
  return result;
}

const BACKSTOP_SETTINGS = ["SLACK_THREADS_TABLE_NAME", "SLACK_SECRET_ARN", "CALLBACK_SIGNING_KEY"] as const;

/**
 * Whether the infrastructure named the threads table, the Slack secret and the signing key (named
 * environments), none of them (the legacy deployment), or only some: a half-wired environment, which
 * the reconciler logs by the missing names.
 */
export function unwaitedTaskBackstopConfiguration(env: NodeJS.ProcessEnv): { state: "on" | "off" } | { state: "partial"; missing: string[] } {
  const missing = BACKSTOP_SETTINGS.filter((name) => !env[name]);
  if (missing.length === 0) return { state: "on" };
  if (missing.length === BACKSTOP_SETTINGS.length) return { state: "off" };
  return { state: "partial", missing };
}

/** The backstop runs only where all of its settings are present. */
export function unwaitedTaskBackstopWanted(env: NodeJS.ProcessEnv): boolean {
  return unwaitedTaskBackstopConfiguration(env).state === "on";
}

/**
 * The bot token from the Slack secret's text, parsed as the notifier and the ingress parse it. Any
 * problem is one error named SlackSecretInvalid, whose message never carries the secret's text.
 */
export function slackBotTokenFrom(secretString: string | undefined): string {
  try {
    return parseSlackSecrets(secretString ?? "").botToken;
  } catch {
    throw Object.assign(new Error("the Slack secret has no usable bot token"), { name: "SlackSecretInvalid" });
  }
}
