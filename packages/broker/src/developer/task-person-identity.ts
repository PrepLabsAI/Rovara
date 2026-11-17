import type { SlackWorkspaceScope } from "@agentx/contracts";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeveloperSignInMethodSchema, IMPLICIT_COMPANY_ID, OrgIdSchema, SLACK_OIDC_ISSUER,
  SlackChannelIdSchema,
  SlackUserIdSchema,
  TaskPersonProofRequestSchema,
  TaskPersonProofResponseSchema,
  agentXError,
  cleanDisplayName,
  redactAndCap,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type DeveloperSignInMethod,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../aws/admin-actions.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRecord } from "./task-records.js";
import type { DeveloperRecord } from "./store.js";
import { TASK_PERSON_UNNAMED, isSlackTaskPerson, parseTaskPersonIdentity, taskPersonKindOf } from "./task-person-rows.js";

export interface TaskPersonIdentity {
  developerId: string;
  slackUserId?: string; // C1: present = a `slack` identity (slack, or oidc linked to Slack); absent = `web` (github, cloud, saml, unlinked oidc). See task-person-rows.ts.
  name: string;
  method: DeveloperSignInMethod;
  issuer: string;
  subject: string;
}

export type ProjectAccessSubject = Pick<DeveloperCaller, "developerId" | "slackUserId">;

export interface TaskPersonIdentityDependencies extends TaskPersonWebProofReaders {
  workspace?: SlackWorkspaceScope;
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
  /** Exact caller already authenticated by the enclosing route. Never supplied by system-created callers. */
  trustedCaller?: Pick<DeveloperCaller, "developerId" | "amr" | "name" | "slackUserId">;
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
const unavailable = (): never => { throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable"); };
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

/** C2 (plan 4.1, decisions D1, D3): the live reads of the web proof. Never asked for a `slack` identity. */
export interface TaskPersonWebProofReaders {
  /**
   * Rule 3: the person's live company membership (`COMPANY_MEMBER#<developerId>`), read on every check. Undefined: none, or revoked.
   * A throw: unreadable. Absent: every `web` identity is unavailable (a refusal).
   */
  companyMembership?(developerId: string): Promise<{ companyId: string } | undefined>;
  /**
   * Rule 4: whether the person holds a live `developer` or `administrator` grant on the task's project in the task's company (`access: "granted"`;
   * channel-only access never counts). False: a proven absence. A throw: unreadable, unknown project, or tasks turned off. Absent: every `web` identity is unavailable.
   */
  projectGrant?(developerId: string, project: string, companyId: string): Promise<boolean>;
  /**
   * Set only when the caller could not build the Slack parts (no Slack on the install, or no Slack workspace for the task): a `slack` identity's
   * check then throws exactly this error, as it did before C2, and only a `web` identity can still be proven (D2).
   */
  slackUnavailable?: Error;
  /**
   * C4 (plan 4.2 "Add a person from the web"): the developer ids holding a grant on the project (its PROJECT_MEMBERS# rows), at most `limit` of them
   * (`complete` false when there are more). Each id is only a lead: every one is proved live before it is offered or registered. A throw: unreadable.
   */
  projectMemberIds?(project: string, limit: number): Promise<{ ids: readonly string[]; complete: boolean }>;
}

async function currentTask(deps: TaskPersonIdentityDependencies, taskId: string): Promise<DeveloperTaskRecord> {
  if (!UUID.test(taskId)) return refuse();
  const item = await getItem(deps, taskPk(taskId), "META");
  // C2: a task started with any built-in sign-in method (GitHub, Cloud, SAML too) has a task person; before, only Slack and OIDC did.
  if (item?.pk !== taskPk(taskId) || item.sk !== "META" || item.entityType !== "DEVELOPER_TASK" || item.taskId !== taskId
    || typeof item.project !== "string" || !HEX64.test(String(item.developerId)) || !DeveloperSignInMethodSchema.safeParse(item.provider).success) return refuse();
  return item as unknown as DeveloperTaskRecord;
}

/** The task's company, the way every stored record names it (`slackRecordScope`, `recordInCompany`): absent is the implicit company; anything malformed refuses. */
function taskCompanyId(task: DeveloperTaskRecord): string {
  const row = task as unknown as { companyId?: unknown; orgId?: unknown };
  if (row.companyId === null || row.orgId === null) return refuse();
  const company = OrgIdSchema.safeParse(row.companyId ?? row.orgId ?? IMPLICIT_COMPANY_ID);
  return company.success ? company.data : refuse();
}

const parsedIdentity = parseTaskPersonIdentity;

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

async function persistIdentity(
  deps: TaskPersonIdentityDependencies,
  taskId: string,
  identity: TaskPersonIdentity,
  assertOpen?: () => void,
): Promise<TaskPersonIdentity> {
  assertOpen?.();
  const existing = await registryBySubject(deps, taskId, identity.developerId);
  assertOpen?.();
  if (existing !== undefined) return samePrincipal(existing, identity) ? existing : refuse();
  const personId = deps.uuid();
  if (!UUID.test(personId)) return refuse();
  const createdAt = new Date(deps.now()).toISOString();
  const person: TaskPersonRecord = { pk: taskPk(taskId), sk: personSk(personId), schemaVersion: 1, personId, ...identity, createdAt };
  const reverse: TaskPersonSubjectRecord = { pk: taskPk(taskId), sk: subjectSk(identity.developerId), schemaVersion: 1, personId, developerId: identity.developerId, createdAt };
  try {
    assertOpen?.();
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: person, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: reverse, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    assertOpen?.();
    return identity;
  } catch (error) {
    if (!conditional(error)) throw error;
    assertOpen?.();
    const winner = await registryBySubject(deps, taskId, identity.developerId);
    assertOpen?.();
    return winner !== undefined && samePrincipal(winner, identity) ? winner : refuse();
  }
}

type Qualification = { eligible: true; channelMember: boolean; name: string } | { eligible: false; channelMember: boolean };

async function qualifyCurrent(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  subject: ProjectAccessSubject,
): Promise<Qualification> {
  if (typeof deps.taskPersonProof !== "function") return unavailable();
  let channels: readonly string[];
  try {
    channels = await deps.projectChannelIds(task.project);
  } catch {
    return unavailable();
  }
  const channelIds = [...new Set([...channels, ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
  if (channelIds.length > MAX_CHANNELS || channelIds.some((channelId) => !SlackChannelIdSchema.safeParse(channelId).success)) return unavailable();
  const request = TaskPersonProofRequestSchema.safeParse({ kind: "task-person-proof", slackUserId: subject.slackUserId, channelIds, ...(deps.workspace === undefined ? {} : { workspace: deps.workspace }) });
  if (!request.success) return unavailable();
  let raw: TaskPersonProofResponse;
  try {
    raw = await deps.taskPersonProof(request.data);
  } catch {
    return unavailable();
  }
  const parsed = TaskPersonProofResponseSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  if (!parsed.data.ok) return parsed.data.error === "ineligible" ? { eligible: false, channelMember: false } : unavailable();
  const memberOf = parsed.data.memberOf;
  const requested = new Set(channelIds);
  if (parsed.data.user.id !== subject.slackUserId || parsed.data.user.teamId !== deps.slackTeamId
    || (task.share !== undefined && task.share.teamId !== deps.slackTeamId)
    || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return unavailable();
  const channelMember = task.share === undefined || memberOf.includes(task.share.channelId);
  try {
    await deps.targetProjectAccess(subject, task.project, memberOf);
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") {
      return { eligible: false, channelMember };
    }
    return unavailable();
  }
  return { eligible: true, channelMember, name: safeName(parsed.data.user.name, parsed.data.user.id) };
}

async function qualify(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  subject: ProjectAccessSubject,
): Promise<{ name: string }> {
  let result: Qualification;
  try {
    result = await qualifyCurrent(deps, task, subject);
  } catch {
    return refuse();
  }
  return result.eligible ? { name: result.name } : refuse();
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

/** E: resolves a signed Slack picker selection to its immutable opaque task person. */
export async function resolveTaskPickerPersonWithId(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  slackUserId: string,
): Promise<{ personId: string; identity: TaskPersonIdentity }> {
  const identity = await resolveTaskPickerPerson(deps, task, slackUserId);
  const reverse = await getItem(deps, taskPk(task.taskId), subjectSk(identity.developerId));
  if (reverse === undefined || reverse.pk !== taskPk(task.taskId) || reverse.sk !== subjectSk(identity.developerId)
    || reverse.schemaVersion !== 1 || reverse.developerId !== identity.developerId || typeof reverse.personId !== "string" || !UUID.test(reverse.personId)) return refuse();
  return { personId: reverse.personId, identity };
}

/** Registers a complete fresh Slack directory result without re-reading Slack or creating sessions. */
export async function registerTaskChannelPeople(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  users: readonly { id: string; teamId: string; name: string; memberOf: readonly string[] }[],
  assertOpen?: () => void,
): Promise<readonly TaskPersonIdentity[]> {
  assertOpen?.();
  const stored = await currentTask(deps, task.taskId);
  assertOpen?.();
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const identities: TaskPersonIdentity[] = [];
  for (const user of users) {
    assertOpen?.();
    if (user.teamId !== deps.slackTeamId || !SlackUserIdSchema.safeParse(user.id).success) return unavailable();
    const identity = nativeIdentity(user.id, safeName(user.name, user.id));
    let accessError: unknown;
    try {
      await deps.targetProjectAccess({ developerId: identity.developerId, slackUserId: user.id }, stored.project, user.memberOf);
    } catch (error) {
      accessError = error;
    }
    assertOpen?.();
    if (accessError !== undefined) {
      if (accessError instanceof Error && (accessError as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") continue;
      return unavailable();
    }
    identities.push(await persistIdentity(deps, stored.taskId, identity, assertOpen));
    assertOpen?.();
  }
  return identities;
}

/**
 * C2, plan 4.1 rules 1 and 2 for a `web` identity: the developer id being proven is the one its own sign-in subject names (checked before any
 * read), and `DEVELOPER#<id>/META` exists, is not revoked, and its method, issuer and subject match the registered row. This is the OIDC rule
 * below minus the Slack-id equality: a sign-in may link a Slack account later, and the identity stays `web` (its kind is fixed at registration).
 */
async function webIdentityStatus(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<"current" | "ineligible"> {
  if (identity.slackUserId !== undefined || identity.method === "slack" || identity.issuer === SLACK_OIDC_ISSUER) return refuse();
  // Rule 1: the id comes only from the verified caller or the task's own stored rows, and it must be this sign-in's own id.
  if (identity.developerId !== ownerKeyForSubject(identity.issuer, identity.subject)) return refuse();
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(identity.developerId);
  } catch {
    return unavailable();
  }
  if (record === undefined || typeof record.revoked !== "boolean" || record.provider !== identity.method || record.developerId !== identity.developerId
    || record.issuer !== identity.issuer || record.subject !== identity.subject || ownerKeyForSubject(record.issuer, record.subject) !== record.developerId) return refuse();
  return record.revoked ? "ineligible" : "current";
}

/**
 * C2, the web proof (plan 4.1, decisions D1, D3): rules 1 and 2 (`webIdentityStatus`), then rule 3, live membership in the TASK'S company, and rule 4,
 * a live developer or administrator grant on the task's project. Every rule is read live on every check and makes no Slack call. `present`
 * (the stand-in for `channelMember`) is rules 3 and 4. A proven loss is `eligible: false` (reconciled like a Slack departure); anything unreadable throws.
 */
async function qualifyWeb(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  identity: TaskPersonIdentity,
): Promise<{ eligible: boolean; present: boolean }> {
  // Without the live membership and grant reads there is no web proof: unavailable, before any read.
  if (typeof deps.companyMembership !== "function" || typeof deps.projectGrant !== "function") return unavailable();
  const companyId = taskCompanyId(task);
  const status = await webIdentityStatus(deps, identity);
  if (status === "ineligible") return { eligible: false, present: false };
  let membership: { companyId: string } | undefined;
  try {
    membership = await deps.companyMembership(identity.developerId);
  } catch {
    return unavailable();
  }
  if (membership !== undefined && (typeof membership !== "object" || membership === null || typeof membership.companyId !== "string")) return unavailable();
  // Rule 3: a member of another company (even one with a same-named project) is never eligible here.
  if (membership?.companyId !== companyId) return { eligible: false, present: false };
  let granted: unknown;
  try {
    granted = await deps.projectGrant(identity.developerId, task.project, companyId);
  } catch {
    return unavailable();
  }
  if (typeof granted !== "boolean") return unavailable();
  // Rule 4: channel-only access never applies to a web identity; only a grant does.
  return granted ? { eligible: true, present: true } : { eligible: false, present: false };
}

async function storedIdentityStatus(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<"current" | "ineligible"> {
  if (identity.method === "slack") {
    if (identity.slackUserId === undefined || identity.issuer !== SLACK_OIDC_ISSUER || identity.subject !== identity.slackUserId
      || identity.developerId !== developerIdForSlackUser(identity.slackUserId)) return refuse();
    return "current";
  }
  if (identity.issuer === SLACK_OIDC_ISSUER || identity.developerId !== ownerKeyForSubject(identity.issuer, identity.subject)) return refuse();
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(identity.developerId);
  } catch {
    return unavailable();
  }
  if (record === undefined || typeof record.revoked !== "boolean" || record.provider !== "oidc" || record.developerId !== identity.developerId
    || record.issuer !== identity.issuer || record.subject !== identity.subject || record.slackUserId !== identity.slackUserId
    || ownerKeyForSubject(record.issuer, record.subject) !== record.developerId) return refuse();
  return record.revoked ? "ineligible" : "current";
}

async function verifyStoredIdentity(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<void> {
  let status: "current" | "ineligible";
  try {
    status = await storedIdentityStatus(deps, identity);
  } catch {
    return refuse();
  }
  if (status !== "current") return refuse();
}

/**
 * D2: side-effect-free current qualification for an exact task developer identity. A proven loss
 * returns eligible=false; unavailable or malformed proof throws so callers cannot reconcile it as
 * a departure. No registry, sign-in or session row is created here.
 */
export async function checkTaskPersonIdentity(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  developerId: string,
): Promise<{ subject: ProjectAccessSubject; identity: TaskPersonIdentity; eligible: boolean; channelMember: boolean }> {
  if (!HEX64.test(developerId)) return refuse();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  let identity = await registryBySubject(deps, stored.taskId, developerId);
  if (identity === undefined) {
    const caller = deps.trustedCaller;
    if (caller?.developerId === developerId && caller.amr === "slack" && SlackUserIdSchema.safeParse(caller.slackUserId).success
      && developerIdForSlackUser(caller.slackUserId!) === developerId) {
      identity = nativeIdentity(caller.slackUserId!, safeName(caller.name, caller.slackUserId!));
    } else if (developerId !== stored.developerId) {
      return refuse();
    } else if (stored.provider === "slack") {
      if (!SlackUserIdSchema.safeParse(stored.slackUserId).success || developerId !== developerIdForSlackUser(stored.slackUserId!)) return refuse();
      identity = nativeIdentity(stored.slackUserId!, safeName(stored.developerName, stored.slackUserId!));
    } else {
      // An OIDC task creator: linked to Slack when the task stored a Slack user id (as before), else a `web` identity (C1, plan 3 item 3).
      // C2: a GitHub, Cloud or SAML task creator is always a `web` identity of its own method (plan 4.1); a Slack id on such a task is not a link.
      const linked = stored.provider === "oidc" && stored.slackUserId !== undefined;
      if (linked && !SlackUserIdSchema.safeParse(stored.slackUserId).success) return refuse();
      let record: DeveloperRecord | undefined;
      try {
        record = await deps.developerRecord(developerId);
      } catch {
        return unavailable();
      }
      if (record === undefined || record.provider !== stored.provider || record.developerId !== developerId || typeof record.issuer !== "string"
        || typeof record.subject !== "string" || ownerKeyForSubject(record.issuer, record.subject) !== developerId) return refuse();
      if (linked) {
        if (!SlackUserIdSchema.safeParse(record.slackUserId).success) return refuse();
        identity = {
          developerId, slackUserId: record.slackUserId!, name: safeName(record.displayName, record.slackUserId!),
          method: "oidc", issuer: record.issuer, subject: record.subject,
        };
      } else {
        // C2: no Slack-id equality for a `web` identity (plan 4.1 rule 2); a later Slack link on the sign-in does not change the identity's kind.
        identity = {
          developerId, name: typeof record.displayName === "string" ? safeName(record.displayName, TASK_PERSON_UNNAMED) : TASK_PERSON_UNNAMED,
          method: stored.provider, issuer: record.issuer, subject: record.subject,
        };
      }
    }
  }
  // The one place a check branches on identity kind. `slack` keeps today's proof, byte for byte (D2); `web` has the web proof (C2, D1),
  // where `channelMember` carries `present` (rules 3 and 4), so every caller's owner rule applies unchanged. No Slack call.
  if (!isSlackTaskPerson(identity)) {
    if (taskPersonKindOf(identity) !== "web" || identity.developerId !== developerId) return refuse();
    // The company is the stored task's, read now; a caller's copy naming another company refuses.
    const fresh = stored as unknown as { companyId?: unknown; orgId?: unknown };
    const given = task as unknown as { companyId?: unknown; orgId?: unknown };
    if (fresh.companyId !== given.companyId || fresh.orgId !== given.orgId) return refuse();
    const web = await qualifyWeb(deps, stored, identity);
    return { subject: { developerId }, identity, eligible: web.eligible, channelMember: web.present };
  }
  if (deps.slackUnavailable !== undefined) throw deps.slackUnavailable;
  const status = await storedIdentityStatus(deps, identity);
  const subject = { developerId, slackUserId: identity.slackUserId };
  if (status === "ineligible") return { subject, identity, eligible: false, channelMember: false };
  const proof = await qualifyCurrent(deps, stored, subject);
  return proof.eligible
    ? { subject, identity: { ...identity, name: proof.name }, eligible: true, channelMember: proof.channelMember }
    : { subject, identity, eligible: false, channelMember: proof.channelMember };
}

export async function resolveTaskPersonId(
  deps: TaskPersonIdentityDependencies,
  taskId: string,
  personId: string,
): Promise<TaskPersonIdentity> {
  const task = await currentTask(deps, taskId);
  const identity = await registryByPerson(deps, taskId, personId);
  // C2: a `web` person resolves only with a current web proof (plan 4.1); a proven loss and anything unreadable both refuse. No Slack call.
  if (!isSlackTaskPerson(identity)) {
    if (taskPersonKindOf(identity) !== "web") return refuse();
    let web: { eligible: boolean };
    try {
      web = await qualifyWeb(deps, task, identity);
    } catch {
      return refuse();
    }
    return web.eligible ? identity : refuse();
  }
  await verifyStoredIdentity(deps, identity);
  await qualify(deps, task, { developerId: identity.developerId, slackUserId: identity.slackUserId });
  return identity;
}

/**
 * C4: the `web` identity a developer's own sign-in record names now, or undefined when the record cannot make one (Slack, revoked, malformed, or
 * carrying a Slack link: plan 4.1, D2, `web` means no Slack link, so a Slack-linked OIDC or GitHub person is added through Slack and keeps the Slack proof).
 */
async function webIdentityFromRecord(deps: TaskPersonIdentityDependencies, developerId: string): Promise<TaskPersonIdentity | undefined> {
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(developerId);
  } catch {
    return unavailable();
  }
  if (record === undefined || record.revoked !== false || record.developerId !== developerId || typeof record.issuer !== "string" || typeof record.subject !== "string"
    || record.provider === "slack" || !DeveloperSignInMethodSchema.safeParse(record.provider).success || record.issuer === SLACK_OIDC_ISSUER
    || record.slackUserId !== undefined
    || record.subject.length === 0 || record.subject.length > 512 || record.issuer.length === 0 || record.issuer.length > 2048
    || ownerKeyForSubject(record.issuer, record.subject) !== developerId) return undefined;
  const identity: TaskPersonIdentity = {
    developerId, name: typeof record.displayName === "string" ? safeName(record.displayName, TASK_PERSON_UNNAMED) : TASK_PERSON_UNNAMED,
    method: record.provider, issuer: record.issuer, subject: record.subject,
  };
  return taskPersonKindOf(identity) === "web" ? identity : undefined;
}

/**
 * C4 (plan 4.2, decision D3): registers a `web` person on a task (PERSON / PERSON_SUBJECT) once they pass the web proof now: a live member of the
 * task's company with a live developer or administrator grant on its project and a current sign-in. Registration grants nothing: a registered web
 * person holds only a role a confirmed People change gives them. A Slack sign-in is never registered here (it is added through Slack).
 */
export async function registerTaskWebPerson(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  developerId: string,
): Promise<{ personId: string; identity: TaskPersonIdentity }> {
  if (!HEX64.test(developerId)) return refuse();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const fresh = stored as unknown as { companyId?: unknown; orgId?: unknown };
  const given = task as unknown as { companyId?: unknown; orgId?: unknown };
  if (fresh.companyId !== given.companyId || fresh.orgId !== given.orgId) return refuse();
  const identity = await webIdentityFromRecord(deps, developerId);
  if (identity === undefined) return refuse();
  const web = await qualifyWeb(deps, stored, identity);
  if (!web.eligible || !web.present) return refuse();
  const persisted = await persistIdentity(deps, stored.taskId, identity);
  if (taskPersonKindOf(persisted) !== "web") return refuse();
  const reverse = await getItem(deps, taskPk(stored.taskId), subjectSk(developerId));
  if (reverse === undefined || reverse.pk !== taskPk(stored.taskId) || reverse.sk !== subjectSk(developerId)
    || reverse.schemaVersion !== 1 || reverse.developerId !== developerId || typeof reverse.personId !== "string" || !UUID.test(reverse.personId)) return refuse();
  return { personId: reverse.personId, identity: persisted };
}

/**
 * C4 (plan 4.2, decision D3): the people a task owner may add from the web, at most `limit` (200), names and opaque ids only. Each is a lead from
 * the project's grant rows, proved live with the web proof (a member of the TASK'S company now, a developer or administrator grant, a current
 * non-Slack sign-in); anyone who fails or cannot be read is left out, so another company's people are never listed. The caller is not listed.
 */
export async function listTaskWebCandidates(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  callerDeveloperId: string,
  limit: number,
): Promise<{ candidates: Array<{ developerId: string; name: string }>; complete: boolean }> {
  if (typeof deps.projectMemberIds !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return unavailable();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId) return refuse();
  let leads: { ids: readonly string[]; complete: boolean };
  try {
    leads = await deps.projectMemberIds(stored.project, limit);
  } catch {
    return unavailable();
  }
  if (!Array.isArray(leads.ids) || leads.ids.length > limit || typeof leads.complete !== "boolean") return unavailable();
  const candidates: Array<{ developerId: string; name: string }> = [];
  for (const developerId of new Set(leads.ids)) {
    if (typeof developerId !== "string" || !HEX64.test(developerId) || developerId === callerDeveloperId) continue;
    try {
      const identity = await webIdentityFromRecord(deps, developerId);
      if (identity === undefined) continue;
      const web = await qualifyWeb(deps, stored, identity);
      if (web.eligible && web.present) candidates.push({ developerId, name: identity.name });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name) || left.developerId.localeCompare(right.developerId));
  return { candidates, complete: leads.complete };
}
