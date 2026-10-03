// packages/broker/src/aws/activity-index.ts
// Spec 025 A4, A5: the failure index (FR-038) and the usage index, from the state table's stream.
// The outbox publisher runs it after dispatching; it is best effort, and never fails the batch.
// Logs carry event names, IDs and error names only: an operation's error can quote anything.
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ADMIN_ERROR_TEXT_MAX,
  AdminRequesterSchema,
  FailureIndexRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  TaskUsageTelemetrySchema,
  UsageIndexRecordSchema,
  failureIndexKey,
  indexExpiresAt,
  redactAndCap,
  usageIndexKey,
  type AdminRequester,
  type FailureIndexRecord,
  type UsageIndexRecord,
} from "@agentx/contracts";
import { failureCategory, taskKey, taskPointerKey } from "../developer/task-records.js";
import type { StreamRecord } from "../developer/notifications.js";

/** A4: aborted at the index's deadline; a store passes it to each request it sends. */
export interface IndexStoreOptions { signal?: AbortSignal }

export interface IndexStore {
  get(key: { pk: string; sk: string }, options?: IndexStoreOptions): Promise<Record<string, unknown> | undefined>;
  /** Conditioned attribute_not_exists(pk): a replayed record writes nothing twice. */
  put(item: Record<string, unknown>, options?: IndexStoreOptions): Promise<void>;
}

/** Settles by `deadline` (epoch milliseconds): rejects with a TimeoutError when `run` has not answered by then. */
export function byDeadline<T>(deadline: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
  return Promise.race([run(signal), timedOut]);
}

/** Settles when `signal` aborts: rejects with its reason when `run` has not answered by then. */
function untilAborted<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
  return Promise.race([run(signal), aborted]);
}

/**
 * A4: every store call is bounded by one deadline signal for the whole batch, so a hung request
 * cannot outlive the publisher, and once that signal has fired no further record is started, even
 * when its timer fired before Date.now() reached the deadline.
 */
function bounded(store: IndexStore, signal: AbortSignal): IndexStore {
  return {
    get: (key) => untilAborted(signal, (callSignal) => store.get(key, { signal: callSignal })),
    put: (item) => untilAborted(signal, (callSignal) => store.put(item, { signal: callSignal })),
  };
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const FAILED = new Set(["FAILED", "INTERRUPTED"]);
/** The index schemas' limits: a field over one is cut or dropped, so the row is still written. */
const REQUESTER_NAME_MAX = 200;
const PROJECT_MAX = 63;
const THREAD_MAX = 128;
/** Without a deadline from the caller, the index stops this long after it starts (A4). */
export const INDEX_DEFAULT_BUDGET_MS = 10_000;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

interface Context { project: string; origin: "slack" | "ai_tool"; taskId?: string; thread?: string; developerName?: string }

/** A5: the project, the origin and the turn record link, from the workspace's own records. */
async function contextOf(store: IndexStore, workspaceId: string): Promise<Context> {
  const workspace = await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  const project = text(workspace?.projectName)?.slice(0, PROJECT_MAX) ?? "unknown";
  const pointer = await store.get(taskPointerKey(workspaceId));
  const taskId = text(pointer?.taskId);
  if (taskId !== undefined) {
    const task = await store.get(taskKey(taskId));
    const developerName = text(task?.developerName);
    return { project, origin: "ai_tool", taskId, ...(developerName === undefined ? {} : { developerName }) };
  }
  const ownerKey = text(workspace?.ownerKey);
  const stored = ownerKey === undefined ? undefined : text((await store.get({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META" }))?.thread);
  // A thread subject too long to parse is left out: the failure is still listed, without its link.
  const thread = stored !== undefined && stored.length <= THREAD_MAX ? stored : undefined;
  return { project, origin: "slack", ...(thread === undefined ? {} : { thread }) };
}

/** The operation's requestedBy as the strict requester schema accepts it; anything else is none. */
function requesterOf(value: unknown, developerName: string | undefined): AdminRequester {
  const requester = record(value);
  let candidate: unknown = { kind: "none" };
  if (requester?.kind === "developer") {
    const name = developerName?.slice(0, REQUESTER_NAME_MAX);
    candidate = { kind: "developer", developerId: requester.developerId, provider: requester.provider, ...(name === undefined ? {} : { name }) };
  } else if (requester !== undefined && requester.teamId !== undefined && requester.userId !== undefined) {
    candidate = { kind: "slack", teamId: requester.teamId, userId: requester.userId };
  }
  const parsed = AdminRequesterSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { kind: "none" };
}

const link = (context: Context) => ({ ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.thread === undefined ? {} : { thread: context.thread }) });

async function failureItem(store: IndexStore, next: Record<string, unknown>): Promise<Record<string, unknown> | "invalid"> {
  const workspaceId = String(next.workspaceId);
  const context = await contextOf(store, workspaceId);
  const kind = text(next.kind) ?? "unknown";
  const status = String(next.status) as FailureIndexRecord["status"];
  const error = text(next.error);
  const endedAt = new Date(text(next.updatedAt) ?? Date.now()).toISOString();
  const indexed: FailureIndexRecord = {
    operationId: String(next.id), workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(next.requestedBy, context.developerName),
    kind, status, category: failureCategory(kind, status, error),
    error: redactAndCap(error ?? `the ${kind} operation ended ${status}`, ADMIN_ERROR_TEXT_MAX).text,
    endedAt, ...link(context),
  };
  // The admin failures route parses items with this schema; one it would skip is not written.
  if (!FailureIndexRecordSchema.safeParse(indexed).success) return "invalid";
  return { ...failureIndexKey(endedAt, indexed.operationId), entityType: "FAILURE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(endedAt), ...indexed };
}

async function usageItem(store: IndexStore, event: Record<string, unknown>): Promise<Record<string, unknown> | "unreadable" | "invalid"> {
  const telemetry = TaskUsageTelemetrySchema.safeParse(event.payload);
  if (!telemetry.success) return "unreadable";
  const workspaceId = String(event.workspaceId);
  const operationId = String(event.operationId);
  const at = new Date(text(event.timestamp) ?? Date.now()).toISOString();
  const [context, operation] = await Promise.all([contextOf(store, workspaceId), store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` })]);
  const created = Date.parse(text(operation?.createdAt) ?? at);
  const indexed: UsageIndexRecord = {
    operationId, workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(operation?.requestedBy, context.developerName), ...link(context),
    at, durationMs: Math.max(0, Date.parse(at) - (Number.isFinite(created) ? created : Date.parse(at))),
    inputTokens: telemetry.data.tokens.input + telemetry.data.tokens.cacheRead + telemetry.data.tokens.cacheWrite,
    outputTokens: telemetry.data.tokens.output, costUsd: telemetry.data.costUsd,
  };
  if (!UsageIndexRecordSchema.safeParse(indexed).success) return "invalid";
  return { ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at), ...indexed };
}

/**
 * Indexes a batch's failures and usage events. `deadline` (epoch milliseconds) bounds the work so
 * the publisher never runs past its timeout (a timed-out batch would be dispatched again, A4):
 * once it passes, the records left are skipped and counted in one log line.
 */
export async function indexActivity(
  records: readonly StreamRecord[],
  unbounded: IndexStore,
  log: (entry: Record<string, unknown>) => void,
  deadline: number = Date.now() + INDEX_DEFAULT_BUDGET_MS,
): Promise<{ failures: number; usage: number; failed: number }> {
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const store = bounded(unbounded, deadlineSignal);
  const result = { failures: 0, usage: 0, failed: 0 };
  const work: Array<{ failure: boolean; next: Record<string, unknown> }> = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    let next: Record<string, unknown>;
    let previous: Record<string, unknown> | undefined;
    try {
      next = unmarshall(image) as Record<string, unknown>;
      previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
    } catch {
      continue;
    }
    const failure = next.entityType === "OPERATION" && FAILED.has(String(next.status)) && !TERMINAL.has(String(previous?.status));
    const usage = next.entityType === "EVENT" && next.type === "usage" && entry.eventName === "INSERT";
    if (failure || usage) work.push({ failure, next });
  }
  for (const [position, { failure, next }] of work.entries()) {
    if (deadlineSignal.aborted || Date.now() >= deadline) {
      log({ event: "activity_index.deadline_reached", skipped: work.length - position });
      break;
    }
    const operationId = String(failure ? next.id : next.operationId);
    try {
      const item = failure ? await failureItem(store, next) : await usageItem(store, next);
      if (item === "unreadable" || item === "invalid") {
        log({ event: item === "unreadable" ? "activity_index.usage_unreadable" : "activity_index.record_invalid", operationId });
        result.failed += 1;
        continue;
      }
      await store.put(item);
      if (failure) result.failures += 1;
      else result.usage += 1;
    } catch (error) {
      log({ event: "activity_index.write_failed", operationId, error: errorName(error) });
      result.failed += 1;
    }
  }
  return result;
}
