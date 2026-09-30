// packages/broker/src/aws/admin-actions.ts
// Spec 025 E8, E9, E19: the admin actions 25e's change tools apply that no admin command had. Each
// is called only by a confirmed change (Task 7) or by the CLI's own change path (Tasks 14, 15).
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER, SlackUserIdSchema, agentXError, type EndDeveloperSessionsRequest, type EndDeveloperSessionsResponse } from "@agentx/contracts";
import { MAX_PER_ORGANIZATION, MAX_PER_PERSON, WORKSPACE_LIMITS_KEY, isWholeLimit } from "../developer/limits.js";
import { emailIndexKey } from "../developer/store.js";
import { ownerKeyForSubject } from "./lambda.js";

export interface AdminActionDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The sign-in table; absent where developer sign-in is not set up. */
  signInTableName?: string;
  slackTeamId?: string;
  limitDefaults: { member: number; organization: number };
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  now(): number;
}
export interface ResolvedDeveloper {
  developerId: string;
  via: "id" | "slack" | "email";
  slackUserId?: string;
  profile?: { displayName: string; provider: "slack" | "oidc"; slackUserId?: string; sessionsEndedAt?: string };
}

const HEX64 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
// Never the email itself: an error can reach a log, a tool result or a Slack post.
const EMAIL_NOT_SIGNED_IN = "nobody has signed in to AgentX with that email yet; name them by Slack user ID, or ask them to sign in first";
const conditional = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";
const normalEmail = (email: string) => email.trim().toLowerCase();

/** FR-008: a Slack sign-in's developer ID, so a grant can come before the first sign-in (E8). */
export function developerIdForSlackUser(userId: string): string {
  return ownerKeyForSubject(SLACK_OIDC_ISSUER, userId);
}

async function signInItem(deps: AdminActionDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  if (deps.signInTableName === undefined) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

function profileFrom(item: Record<string, unknown> | undefined): ResolvedDeveloper["profile"] {
  if (item === undefined || typeof item.displayName !== "string" || (item.provider !== "slack" && item.provider !== "oidc")) return undefined;
  return {
    displayName: item.displayName, provider: item.provider,
    ...(typeof item.slackUserId === "string" ? { slackUserId: item.slackUserId } : {}),
    ...(typeof item.sessionsEndedAt === "string" ? { sessionsEndedAt: item.sessionsEndedAt } : {}),
  };
}

const developerItem = (deps: AdminActionDependencies, developerId: string) => signInItem(deps, { pk: `DEVELOPER#${developerId}`, sk: "META" });

export async function resolveDeveloper(deps: AdminActionDependencies, reference: string): Promise<ResolvedDeveloper> {
  const value = reference.trim();
  if (HEX64.test(value)) {
    const profile = profileFrom(await developerItem(deps, value));
    return { developerId: value, via: "id", ...(profile === undefined ? {} : { profile }) };
  }
  if (SlackUserIdSchema.safeParse(value).success) {
    const developerId = developerIdForSlackUser(value);
    const profile = profileFrom(await developerItem(deps, developerId));
    return { developerId, via: "slack", slackUserId: value, ...(profile === undefined ? {} : { profile }) };
  }
  if (EMAIL.test(value)) {
    const indexed = await signInItem(deps, emailIndexKey(value));
    // Q4: an email names only someone who signed in with it (from this release on).
    if (typeof indexed?.developerId !== "string" || !HEX64.test(indexed.developerId)) throw agentXError("NOT_FOUND", EMAIL_NOT_SIGNED_IN);
    const item = await developerItem(deps, indexed.developerId);
    // The index is never cleaned when a verified email changes, so an old entry still points at its
    // developer: it names them only while their record still holds that email.
    if (typeof item?.email !== "string" || normalEmail(item.email) !== normalEmail(value)) throw agentXError("NOT_FOUND", EMAIL_NOT_SIGNED_IN);
    const profile = profileFrom(item);
    return { developerId: indexed.developerId, via: "email", ...(profile === undefined ? {} : { profile }) };
  }
  throw agentXError("CONFIG_INVALID", "developer must be a developer ID, an email or a Slack user ID such as U0123456789");
}

export async function projectGrant(deps: AdminActionDependencies, project: string, developerId: string): Promise<{ role: "developer" | "administrator" } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}` }, ConsistentRead: true })) as { Item?: { role?: unknown } };
  const role = response.Item?.role;
  return role === "developer" || role === "administrator" ? { role } : undefined;
}

/** FR-013.1: a `developer` ProjectMembership row. An administrator row for the same key is kept as it is. */
export async function grantProjectAccess(deps: AdminActionDependencies, admin: { issuer: string; subject: string }, project: string, developerId: string): Promise<{ granted: true; already: boolean }> {
  const current = await projectGrant(deps, project, developerId);
  if (current?.role === "administrator") throw agentXError("CONFIG_INVALID", `that developer already administers ${project}, so there is nothing to grant`);
  if (current?.role === "developer") return { granted: true, already: true };
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}`, entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, role: "developer", grantedBy: admin, grantedAt: new Date(deps.now()).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!conditional(error)) throw error;
    // A row appeared between the read and the write: say what it is rather than assume.
    const raced = await projectGrant(deps, project, developerId);
    if (raced?.role === "administrator") throw agentXError("CONFIG_INVALID", `that developer already administers ${project}, so there is nothing to grant`);
    return { granted: true, already: true };
  }
  return { granted: true, already: false };
}

export async function revokeProjectAccess(deps: AdminActionDependencies, project: string, developerId: string): Promise<{ revoked: boolean }> {
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: `MEMBER#${developerId}`, sk: `PROJECT#${project}` },
      // Only a grant: an administrator row is never removed by revoking a developer's access.
      ConditionExpression: "#role = :developer",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":developer": "developer" },
    }));
    return { revoked: true };
  } catch (error) {
    if (conditional(error)) return { revoked: false };
    throw error;
  }
}

/** E19, FR-053: the setting the broker reads at each workspace creation. */
export async function setWorkspaceLimits(deps: AdminActionDependencies, admin: { issuer: string; subject: string }, limits: { perPerson: number; perOrganization: number }): Promise<{ perPerson: number; perOrganization: number; updatedAt: string }> {
  // The bounds readWorkspaceLimits accepts, so a written setting is never one the broker ignores.
  if (!isWholeLimit(limits.perPerson, MAX_PER_PERSON)) throw agentXError("CONFIG_INVALID", `the per-person limit must be a whole number from 1 to ${MAX_PER_PERSON}`);
  if (!isWholeLimit(limits.perOrganization, MAX_PER_ORGANIZATION)) throw agentXError("CONFIG_INVALID", `the organization limit must be a whole number from 1 to ${MAX_PER_ORGANIZATION}`);
  if (limits.perPerson > limits.perOrganization) throw agentXError("CONFIG_INVALID", `the per-person limit (${limits.perPerson}) cannot be more than the organization limit (${limits.perOrganization})`);
  const updatedAt = new Date(deps.now()).toISOString();
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...WORKSPACE_LIMITS_KEY, entityType: "SETTING", perPerson: limits.perPerson, perOrganization: limits.perOrganization, updatedBy: admin, updatedAt },
  }));
  return { perPerson: limits.perPerson, perOrganization: limits.perOrganization, updatedAt };
}

export async function endSessions(deps: AdminActionDependencies, developerId: string): Promise<{ endedAt: string }> {
  if (deps.endDeveloperSessions === undefined) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment, so there is no sign-in to end");
  const endedAt = new Date(deps.now()).toISOString();
  const answer = await deps.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at: endedAt });
  if (answer.ok) return { endedAt };
  if (answer.error === "not_found") throw agentXError("NOT_FOUND", "that developer has never signed in, so there is no sign-in to end");
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
}
