import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  REQUALIFY_AGE_METRIC, REQUALIFY_PROFILE_ID, RequalifyLastSuccessSchema, RequalifyScheduleEnabledSchema, requalifyLastSuccessKey, requalifyScheduleEnabledKey,
} from "@agentx/contracts";
import type { RequalifyStepsDependencies } from "./runtime-requalify-steps.js";

/**
 * ARGUARD: the renewal cannot be switched off silently. The daily check reports every run how old the last successful renewal is, so `RuntimeRequalifyStale` has a value to breach on
 * (until now only a 1 on success existed: a renewal that never ran left no data and the alarm could not fire). Both rows are in the renewal lock's partition, which the Lambda's
 * state grant already covers (leading key RUNTIME_REQUALIFY*).
 */

export type HeartbeatDependencies = Pick<RequalifyStepsDependencies, "documentClient" | "tableName" | "cloudwatch" | "config" | "now">;

const DAY_MS = 24 * 3_600_000;
const nowOf = (deps: Pick<HeartbeatDependencies, "now">): number => deps.now?.() ?? Date.now();

type Store = { documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string };

async function readAt(store: Store, key: { pk: string; sk: string }, kind: "enabled" | "success"): Promise<number | undefined> {
  const item = (await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: key, ConsistentRead: true }))).Item;
  if (item === undefined) return undefined;
  const { pk: _pk, sk: _sk, ...fields } = item;
  void _pk; void _sk;
  const parsed = kind === "enabled" ? RequalifyScheduleEnabledSchema.safeParse(fields) : RequalifyLastSuccessSchema.safeParse(fields);
  if (!parsed.success) throw new Error("the schedule row is not as written by the renewal");
  return Date.parse(parsed.data.at);
}

/**
 * Days since the last successful renewal (since the first enable until there is one); undefined while the schedule was never enabled. Two reads by key. Used by the daily check and, so the
 * number keeps arriving when the schedule is off, by the sessions reconciler.
 */
export async function renewalAgeDays(store: Store, now: number): Promise<number | undefined> {
  const enabledAt = await readAt(store, requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID), "enabled");
  if (enabledAt === undefined) return undefined;
  const since = (await readAt(store, requalifyLastSuccessKey(REQUALIFY_PROFILE_ID), "success")) ?? enabledAt;
  return Math.max(0, Math.round(((now - since) / DAY_MS) * 100) / 100);
}

/** Records, once, that the daily schedule ran (so it was enabled). A later call never moves the time. */
export async function markScheduleEnabled(deps: HeartbeatDependencies): Promise<void> {
  const item = RequalifyScheduleEnabledSchema.parse({ entityType: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED", at: new Date(nowOf(deps)).toISOString() });
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID), ...item }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
}

/** The time of the last successful renewal, for the age. Called as a run completes. */
export async function recordRenewalSuccess(deps: Pick<HeartbeatDependencies, "documentClient" | "tableName" | "now">, runId: string): Promise<void> {
  const item = RequalifyLastSuccessSchema.parse({ entityType: "RUNTIME_REQUALIFY_LAST_SUCCESS", at: new Date(nowOf(deps)).toISOString(), runId });
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...requalifyLastSuccessKey(REQUALIFY_PROFILE_ID), ...item } }));
}

/**
 * One scheduled run of the daily check: marks the schedule as enabled, then emits the age in days of the last successful renewal (of the first enable until one exists).
 * Never throws: the check's real job, starting a renewal, must not depend on its heartbeat; a failure is a fixed line in the Lambda's log.
 */
export async function dailyHeartbeat(deps: HeartbeatDependencies): Promise<void> {
  try {
    await markScheduleEnabled(deps);
    const days = (await renewalAgeDays(deps, nowOf(deps))) ?? 0;
    await deps.cloudwatch.send(new PutMetricDataCommand({ Namespace: deps.config.metricsNamespace, MetricData: [{ MetricName: REQUALIFY_AGE_METRIC, Value: days, Unit: "None" }] }));
  } catch {
    console.error("requalify-heartbeat-failed");
  }
}
