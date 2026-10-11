import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SLACK_OIDC_ISSUER,
  SlackChannelIdSchema,
  SlackUserIdSchema,
  TaskPersonProofRequestSchema,
  TaskPersonProofResponseSchema,
  agentXError,
  cleanDisplayName,
  redactAndCap,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../aws/admin-actions.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRecord } from "./task-records.js";
import type { DeveloperRecord } from "./store.js";

export interface TaskPersonIdentity {
  developerId: string;
  slackUserId: string;
  name: string;
  method: "slack" | "oidc";
  issuer: string;
  subject: string;
}

export type ProjectAccessSubject = Pick<DeveloperCaller, "developerId" | "slackUserId">;

export interface TaskPersonIdentityDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  /** Required fresh proof capability. An absent old Identity Lambda is a refusal, with no cached fallback. */
  taskPersonProof(request: TaskPersonProofRequest): Promise<TaskPersonProofResponse>;
  /** A strongly consistent, server-owned DeveloperRecord lookup from the sign-in table. */
  developerRecord(developerId: string): Promise<DeveloperRecord | undefined>;
  /** Current channels bound to the target project. */
  projectChannelIds(project: string): Promise<readonly string[]>;
  /** Existing project policy and grants, evaluated against only the supplied fresh membership. */
  targetProjectAccess(subject: ProjectAccessSubject, project: string, freshMemberOf: readonly string[]): Promise<void>;
}

interface TaskPersonRecord extends TaskPersonIdentity {
  pk: string;
  sk: string;
  schemaVersion: 1;
  personId: string;
  createdAt: string;
}

interface TaskPersonSubjectRecord {
  pk: string;
  sk: string;
  schemaVersion: 1;
  personId: string;
  developerId: string;
  createdAt: string;
}

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHANNELS = 50;

const refuse = (): never => { throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified"); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const taskPk = (taskId: string) => `DEVTASK#${taskId}`;
const personSk = (personId: string) => `PERSON#${personId}`;
const subjectSk = (developerId: string) => `PERSON_SUBJECT#${developerId}`;

const safeName = (name: string, fallback: string): string => cleanDisplayName(redactAndCap(name, 80).text) ?? fallback;

async function getItem(deps: TaskPersonIdentityDependencies, pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk, sk }, ConsistentRead: true })) as { Item?: unknown };
  return isRecord(result.Item) ? result.Item : undefined;
}

async function currentTask(deps: TaskPersonIdentityDependencies, taskId: string): Promise<DeveloperTaskRecord> {
  if (!UUID.test(taskId)) return refuse();
  const item = await getItem(deps, taskPk(taskId), "META");
  if (item?.pk !== taskPk(taskId) || item.sk !== "META" || item.entityType !== "DEVELOPER_TASK" || item.taskId !== taskId
    || typeof item.project !== "string" || !HEX64.test(String(item.developerId)) || (item.provider !== "slack" && item.provider !== "oidc")) return refuse();
  return item as unknown as DeveloperTaskRecord;
}

function parsedIdentity(item: Record<string, unknown>): TaskPersonIdentity | undefined {
  if (!HEX64.test(String(item.developerId)) || !SlackUserIdSchema.safeParse(item.slackUserId).success || typeof item.name !== "string"
    || safeName(item.name, String(item.slackUserId)) !== item.name || (item.method !== "slack" && item.method !== "oidc")
    || typeof item.issuer !== "string" || item.issuer.length === 0 || item.issuer.length > 2048
    || typeof item.subject !== "string" || item.subject.length === 0 || item.subject.length > 512) return undefined;
  return {
    developerId: String(item.developerId),
    slackUserId: String(item.slackUserId),
    name: item.name,
    method: item.method,
    issuer: item.issuer,
    subject: item.subject,
  };
}

async function registryByPerson(deps: TaskPersonIdentityDependencies, taskId: string, personId: string): Promise<TaskPersonIdentity> {
  if (!UUID.test(personId)) return refuse();
  const person = await getItem(deps, taskPk(taskId), personSk(personId));
  if (person?.pk !== taskPk(taskId) || person.sk !== personSk(personId) || person.schemaVersion !== 1 || person.personId !== personId
    || typeof person.createdAt !== "string" || !Number.isFinite(Date.parse(person.createdAt))) return refuse();
  const identity = parsedIdentity(person);
  if (identity === undefined) return refuse();
  const reverse = await getItem(deps, taskPk(taskId), subjectSk(identity.developerId));
  if (reverse?.pk !== taskPk(taskId) || reverse.sk !== subjectSk(identity.developerId) || reverse.schemaVersion !== 1
    || reverse.personId !== personId || reverse.developerId !== identity.developerId || reverse.createdAt !== person.createdAt) return refuse();
  return identity;
}

async function registryBySubject(deps: TaskPersonIdentityDependencies, taskId: string, developerId: string): Promise<TaskPersonIdentity | undefined> {
  const reverse = await getItem(deps, taskPk(taskId), subjectSk(developerId));
  if (reverse === undefined) return undefined;
  if (reverse.schemaVersion !== 1 || reverse.developerId !== developerId || typeof reverse.personId !== "string") return refuse();
  const identity = await registryByPerson(deps, taskId, reverse.personId);
  return identity.developerId === developerId ? identity : refuse();
}

function samePrincipal(left: TaskPersonIdentity, right: TaskPersonIdentity): boolean {
  return left.developerId === right.developerId && left.slackUserId === right.slackUserId && left.method === right.method
    && left.issuer === right.issuer && left.subject === right.subject;
}

async function persistIdentity(deps: TaskPersonIdentityDependencies, taskId: string, identity: TaskPersonIdentity): Promise<TaskPersonIdentity> {
  const existing = await registryBySubject(deps, taskId, identity.developerId);
  if (existing !== undefined) return samePrincipal(existing, identity) ? existing : refuse();
  const personId = deps.uuid();
  if (!UUID.test(personId)) return refuse();
  const createdAt = new Date(deps.now()).toISOString();
  const person: TaskPersonRecord = { pk: taskPk(taskId), sk: personSk(personId), schemaVersion: 1, personId, ...identity, createdAt };
  const reverse: TaskPersonSubjectRecord = { pk: taskPk(taskId), sk: subjectSk(identity.developerId), schemaVersion: 1, personId, developerId: identity.developerId, createdAt };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: person, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: reverse, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    return identity;
  } catch (error) {
    if (!conditional(error)) throw error;
    const winner = await registryBySubject(deps, taskId, identity.developerId);
    return winner !== undefined && samePrincipal(winner, identity) ? winner : refuse();
  }
}

async function qualify(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  subject: ProjectAccessSubject,
): Promise<{ name: string }> {
  if (typeof deps.taskPersonProof !== "function") return refuse();
  let channels: readonly string[];
  try {
    channels = await deps.projectChannelIds(task.project);
  } catch {
    return refuse();
  }
  const channelIds = [...new Set(channels)].sort();
  if (channelIds.length > MAX_CHANNELS || channelIds.some((channelId) => !SlackChannelIdSchema.safeParse(channelId).success)) return refuse();
  const request = TaskPersonProofRequestSchema.safeParse({ kind: "task-person-proof", slackUserId: subject.slackUserId, channelIds });
  if (!request.success) return refuse();
  let raw: TaskPersonProofResponse;
  try {
    raw = await deps.taskPersonProof(request.data);
  } catch {
    return refuse();
  }
  const parsed = TaskPersonProofResponseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.ok) return refuse();
  const memberOf = parsed.data.memberOf;
  const requested = new Set(channelIds);
  if (parsed.data.user.id !== subject.slackUserId || parsed.data.user.teamId !== deps.slackTeamId
    || (task.share !== undefined && task.share.teamId !== deps.slackTeamId)
    || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return refuse();
  try {
    await deps.targetProjectAccess(subject, task.project, memberOf);
  } catch {
    return refuse();
  }
  return { name: safeName(parsed.data.user.name, parsed.data.user.id) };
}

function nativeIdentity(slackUserId: string, name: string): TaskPersonIdentity {
  return {
    developerId: developerIdForSlackUser(slackUserId),
    slackUserId,
    name,
    method: "slack",
    issuer: SLACK_OIDC_ISSUER,
    subject: slackUserId,
  };
}

export async function resolveTaskPickerPerson(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  slackUserId: string,
): Promise<TaskPersonIdentity> {
  if (!SlackUserIdSchema.safeParse(slackUserId).success) return refuse();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const subject = { developerId: developerIdForSlackUser(slackUserId), slackUserId };
  const proof = await qualify(deps, stored, subject);
  return persistIdentity(deps, stored.taskId, nativeIdentity(slackUserId, proof.name));
}

async function verifyStoredIdentity(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<void> {
  if (identity.method === "slack") {
    if (identity.issuer !== SLACK_OIDC_ISSUER || identity.subject !== identity.slackUserId || identity.developerId !== developerIdForSlackUser(identity.slackUserId)) return refuse();
    return;
  }
  if (identity.issuer === SLACK_OIDC_ISSUER || identity.developerId !== ownerKeyForSubject(identity.issuer, identity.subject)) return refuse();
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(identity.developerId);
  } catch {
    return refuse();
  }
  if (record === undefined || record.revoked !== false || record.provider !== "oidc" || record.developerId !== identity.developerId
    || record.issuer !== identity.issuer || record.subject !== identity.subject || record.slackUserId !== identity.slackUserId
    || ownerKeyForSubject(record.issuer, record.subject) !== record.developerId) return refuse();
}

export async function resolveTaskPersonId(
  deps: TaskPersonIdentityDependencies,
  taskId: string,
  personId: string,
): Promise<TaskPersonIdentity> {
  const task = await currentTask(deps, taskId);
  const identity = await registryByPerson(deps, taskId, personId);
  await verifyStoredIdentity(deps, identity);
  await qualify(deps, task, { developerId: identity.developerId, slackUserId: identity.slackUserId });
  return identity;
}
