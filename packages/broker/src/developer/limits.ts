// Spec 025 FR-020 and FR-053: one set of workspace limits for Slack threads and developer tasks.
// The numbers are the admin's setting when there is one, else the stack parameters (R7).
import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { CounterKey, WorkspaceCharge } from "./task-records.js";

type Client = { send(command: unknown): Promise<unknown> };
type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

export const WORKSPACE_LIMITS_KEY = { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" } as const;
export interface WorkspaceLimits { member: number; organization: number; source: "setting" | "parameters" }

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
const whole = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;

export async function readWorkspaceLimits(
  client: Client,
  tableName: string,
  fallback: { member: number; organization: number },
  log: (entry: Record<string, unknown>) => void = defaultLog,
): Promise<WorkspaceLimits> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: WORKSPACE_LIMITS_KEY, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = response.Item;
  if (item === undefined) return { ...fallback, source: "parameters" };
  const member = item.perPerson;
  const organization = item.perOrganization;
  // FR-053: the per-person limit never exceeds the per-organization one.
  if (!whole(member, 50) || !whole(organization, 1_000) || member > organization) {
    log({ event: "workspace_limits.invalid_setting" });
    return { ...fallback, source: "parameters" };
  }
  return { member, organization, source: "setting" };
}

/** R6: a linked developer shares their Slack member's counter; everyone shares the organization's. */
export function developerCharge(input: { teamId?: string | undefined; slackUserId?: string | undefined; developerId: string }): WorkspaceCharge {
  return {
    member: input.teamId !== undefined && input.slackUserId !== undefined
      ? { pk: `SLACK_LIMIT#${input.teamId}`, sk: `MEMBER#${input.slackUserId}` }
      : { pk: `DEVELOPER_LIMIT#${input.developerId}`, sk: "MEMBER" },
    organization: input.teamId !== undefined
      ? { pk: `SLACK_LIMIT#${input.teamId}`, sk: "ORGANIZATION" }
      : { pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" },
  };
}

const entityOf = (key: CounterKey) => (key.pk.startsWith("SLACK_LIMIT#") ? "SLACK_LIMIT" : "DEVELOPER_LIMIT");

/**
 * The same conditions as a Slack thread's charge. The task goes in a string set `tasks`; the
 * Slack limit refusal reads every `threads` entry as a thread subject, so tasks never go there.
 *
 * Self-guarding (fix round 1): the member item's condition also requires `NOT contains(#tasks,
 * :taskId)`, so a repeated charge of the same task cancels the whole transaction instead of
 * incrementing the count a second time. Callers classify a `TransactionCanceledException` with
 * chargeConflict.
 */
export function chargeItems(tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }, taskId: string): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.organization, ":entity": entityOf(charge.organization) },
    } },
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity ADD #tasks :task",
      ConditionExpression: "(attribute_not_exists(#count) OR #count < :limit) AND NOT contains(#tasks, :taskId)",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.member, ":entity": entityOf(charge.member), ":task": new Set([taskId]), ":taskId": taskId },
    } },
  ];
}

/**
 * Releases what chargeItems took. The caller's transaction also marks the task closed, once.
 *
 * Self-guarding (fix round 1): the member item's condition also requires `contains(#tasks,
 * :taskId)`, so a repeated release of the same task (the task is no longer in the set) cancels
 * the whole transaction instead of decrementing the count a second time. Callers classify a
 * `TransactionCanceledException` with releaseConflict.
 */
export function releaseItems(tableName: string, charge: WorkspaceCharge, taskId: string): TransactItems {
  return [
    { Update: {
      TableName: tableName,
      Key: charge.organization,
      UpdateExpression: "SET #count = #count - :one",
      ConditionExpression: "#count >= :one",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":one": 1 },
    } },
    { Update: {
      TableName: tableName,
      Key: charge.member,
      UpdateExpression: "SET #count = #count - :one DELETE #tasks :task",
      ConditionExpression: "#count >= :one AND contains(#tasks, :taskId)",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":one": 1, ":task": new Set([taskId]), ":taskId": taskId },
    } },
  ];
}

/** Which counter is full, read before the start's transaction so the refusal can say so. */
export async function limitReached(client: Client, tableName: string, charge: WorkspaceCharge, limits: { member: number; organization: number }): Promise<"member" | "organization" | undefined> {
  const count = async (key: CounterKey) => {
    const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: { count?: unknown } };
    return typeof response.Item?.count === "number" ? response.Item.count : 0;
  };
  if (await count(charge.member) >= limits.member) return "member";
  if (await count(charge.organization) >= limits.organization) return "organization";
  return undefined;
}

const cancellationReasons = (error: unknown): Array<{ Code?: string }> | undefined => {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  return Array.isArray(reasons) ? reasons as Array<{ Code?: string }> : undefined;
};

const hasTask = async (client: Client, tableName: string, member: CounterKey, taskId: string): Promise<boolean> => {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: member, ConsistentRead: true })) as { Item?: { tasks?: Set<string> } };
  return response.Item?.tasks?.has(taskId) === true;
};

export type ChargeConflict = "already_charged" | "member" | "organization";

/**
 * Classifies a `chargeItems` transaction's `TransactionCanceledException`, so a caller (Tasks 8 and
 * 12) can tell a repeat charge of the same task (already applied; treat as success) apart from a
 * genuine limit refusal. Reads `error.CancellationReasons` positionally, the way
 * packages/broker/src/developer/store.ts's classifyRotationFailure does (chargeItems' TransactItems
 * are [organization, member], in that order): the organization item's condition never depends on a
 * task id, so its failure always means "organization" full. The member item's compound condition
 * can fail for either reason, so a consistent re-read of the member item disambiguates: a taskId
 * already present in `tasks` is a repeat (regardless of the current count, which may coincidentally
 * also be at the limit); otherwise it is a genuine "member" full. Anything else -- a missing
 * CancellationReasons array, or neither item reporting ConditionalCheckFailed -- is an unmodeled
 * failure and is rethrown, not folded into either outcome, so the caller can retry.
 */
export async function chargeConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ChargeConflict> {
  const reasons = cancellationReasons(error);
  if (reasons === undefined) throw error;
  if (reasons[0]?.Code === "ConditionalCheckFailed") return "organization";
  if (reasons[1]?.Code !== "ConditionalCheckFailed") throw error;
  return (await hasTask(client, tableName, charge.member, taskId)) ? "already_charged" : "member";
}

export type ReleaseConflict = "already_released";

/**
 * Classifies a `releaseItems` transaction's `TransactionCanceledException`. The member item's
 * `contains(#tasks, :taskId)` clause no longer holds once a first release has already removed the
 * task, so a repeat release fails there; a consistent re-read confirms the task is genuinely gone
 * before reporting "already_released", rather than folding some other, unmodeled member-condition
 * failure into it. Anything else is rethrown so the caller can retry.
 */
export async function releaseConflict(client: Client, tableName: string, charge: WorkspaceCharge, taskId: string, error: unknown): Promise<ReleaseConflict> {
  const reasons = cancellationReasons(error);
  if (reasons === undefined || reasons[1]?.Code !== "ConditionalCheckFailed") throw error;
  if (await hasTask(client, tableName, charge.member, taskId)) throw error;
  return "already_released";
}
