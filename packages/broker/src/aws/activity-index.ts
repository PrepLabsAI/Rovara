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

export interface IndexStore {
  get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined>;
  /** Conditioned attribute_not_exists(pk): a replayed record writes nothing twice. */
  put(item: Record<string, unknown>): Promise<void>;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const FAILED = new Set(["FAILED", "INTERRUPTED"]);
/** The requester schema's limit on a developer's display name. */
const REQUESTER_NAME_MAX = 200;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

interface Context { project: string; origin: "slack" | "ai_tool"; taskId?: string; thread?: string; developerName?: string }

/** A5: the project, the origin and the turn record link, from the workspace's own records. */
async function contextOf(store: IndexStore, workspaceId: string): Promise<Context> {
  const workspace = await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  const project = text(workspace?.projectName) ?? "unknown";
  const pointer = await store.get(taskPointerKey(workspaceId));
  const taskId = text(pointer?.taskId);
  if (taskId !== undefined) {
    const task = await store.get(taskKey(taskId));
    const developerName = text(task?.developerName);
    return { project, origin: "ai_tool", taskId, ...(developerName === undefined ? {} : { developerName }) };
  }
  const ownerKey = text(workspace?.ownerKey);
  const thread = ownerKey === undefined ? undefined : text((await store.get({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META" }))?.thread);
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
  const kind = String(next.kind);
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
    inputTokens: telemetry.data.tokens.input, outputTokens: telemetry.data.tokens.output, costUsd: telemetry.data.costUsd,
  };
  if (!UsageIndexRecordSchema.safeParse(indexed).success) return "invalid";
  return { ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at), ...indexed };
}

export async function indexActivity(records: readonly StreamRecord[], store: IndexStore, log: (entry: Record<string, unknown>) => void): Promise<{ failures: number; usage: number; failed: number }> {
  const result = { failures: 0, usage: 0, failed: 0 };
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
    if (!failure && !usage) continue;
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
