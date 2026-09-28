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
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.member, ":entity": entityOf(charge.member), ":task": new Set([taskId]) },
    } },
  ];
}

/** Releases what chargeItems took. The caller's transaction also marks the task closed, once. */
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
      ConditionExpression: "#count >= :one",
      ExpressionAttributeNames: { "#count": "count", "#tasks": "tasks" },
      ExpressionAttributeValues: { ":one": 1, ":task": new Set([taskId]) },
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
