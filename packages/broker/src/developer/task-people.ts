import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { SlackThreadSchema, SlackUserIdSchema, agentXError, cleanDisplayName, redactAndCap, slackThreadUrl } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { ProjectAccessSubject, TaskPersonIdentity } from "./task-person-identity.js";
import type { TaskPeopleDisplayAdmission } from "./task-people-display-budget.js";
import { taskKey, taskOwnerKey, type DeveloperTaskRecord } from "./task-records.js";

export type TaskRole = "owner" | "commenter" | "viewer";
export type StoredTaskRole = TaskRole | "denied";

export interface TaskPeople {
  schemaVersion: 1;
  revision: number;
  orphaned: boolean;
  people: Array<{ developerId: string; slackUserId: string; name: string; role: StoredTaskRole }>;
}

export interface TaskPeopleConfiguration { peopleChangesEnabled: boolean }

export interface TaskPersonCheck {
  subject: ProjectAccessSubject;
  identity: TaskPersonIdentity;
  eligible: boolean;
  channelMember: boolean;
}

export type CheckTaskPerson = (task: DeveloperTaskRecord, developerId: string, admission?: TaskPeopleDisplayAdmission) => Promise<TaskPersonCheck>;

export interface TaskPeopleDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  taskPeopleConfiguration?: TaskPeopleConfiguration;
  checkTaskPerson?: CheckTaskPerson;
  /** Complete directory checks for display only. Never used by authorization, reconciliation, or mutation. */
  listTaskPeople?: (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => Promise<readonly TaskPersonCheck[]>;
  /** Starts the whole-view 20 second / 100 Slack call / 100 identity admission. */
  createTaskPeopleDisplayAdmission?: () => TaskPeopleDisplayAdmission;
}

export interface TaskPeopleView {
  revision: number;
  orphaned: boolean;
  people: Array<{ personId: string; name: string; role: StoredTaskRole; you: boolean; effectiveRole: TaskRole | null }>;
  canManage: boolean;
  canTakeOwnership: boolean;
  addPeopleUrl?: string;
}

export interface ChangeTaskPeopleInput {
  requestId: string;
  expectedPeopleRevision: number;
  targetDeveloperId: string;
  role: StoredTaskRole;
}

export interface TakeTaskOwnershipInput { requestId: string; expectedPeopleRevision: number }

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type PersonEntry = TaskPeople["people"][number];
type PersonRecord = TaskPersonIdentity & { pk: string; sk: string; schemaVersion: 1; personId: string; createdAt: string };
type SubjectRecord = { pk: string; sk: string; schemaVersion: 1; personId: string; developerId: string; createdAt: string };

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const REQUEST_ID = UUID;
const ITEM_LIMIT = 409_600;
const TRANSACTION_LIMIT = 100;
const PEOPLE_SK = "PEOPLE";

const denied = (): never => { throw agentXError("TASK_ACCESS_DENIED", "task access could not be verified"); };
const unavailable = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", "Task People is unavailable in this deployment"); };
const stale = (): never => { throw agentXError("IDEMPOTENCY_CONFLICT", "People changed; refresh the task and try again"); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const taskPk = (taskId: string) => `DEVTASK#${taskId}`;
const peopleKey = (taskId: string) => ({ pk: taskPk(taskId), sk: PEOPLE_SK });
const personKey = (taskId: string, personId: string) => ({ pk: taskPk(taskId), sk: `PERSON#${personId}` });
const subjectKey = (taskId: string, developerId: string) => ({ pk: taskPk(taskId), sk: `PERSON_SUBJECT#${developerId}` });
const requestKey = (taskId: string, requestId: string) => ({ pk: taskPk(taskId), sk: `PEOPLE_REQUEST#${requestId}` });
const eventKey = (taskId: string, requestId: string) => ({ pk: taskPk(taskId), sk: `PEOPLE_EVENT#${requestId}` });
const safeName = (value: string, fallback: string) => cleanDisplayName(redactAndCap(value, 80).text) ?? fallback;
const enabled = (deps: TaskPeopleDependencies) => deps.taskPeopleConfiguration?.peopleChangesEnabled === true;
const open = (task: DeveloperTaskRecord) => task.closedAt === undefined && task.workflow?.stage !== "CLOSED" && task.workflow?.stage !== "MERGED";
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

function validEntry(value: unknown): value is PersonEntry {
  if (!isRecord(value) || !exactKeys(value, ["developerId", "slackUserId", "name", "role"])) return false;
  return typeof value.developerId === "string" && HEX64.test(value.developerId)
    && SlackUserIdSchema.safeParse(value.slackUserId).success
    && typeof value.name === "string" && safeName(value.name, String(value.slackUserId)) === value.name
    && (value.role === "owner" || value.role === "commenter" || value.role === "viewer" || value.role === "denied");
}

function parsePeople(value: unknown): TaskPeople | undefined {
  if (!isRecord(value) || !exactKeys(value, ["pk", "sk", "schemaVersion", "revision", "orphaned", "people"])
    || typeof value.pk !== "string" || value.sk !== PEOPLE_SK || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.orphaned !== "boolean"
    || !Array.isArray(value.people) || !value.people.every(validEntry)) return undefined;
  const people = value.people;
  if (new Set(people.map((person) => person.developerId)).size !== people.length) return undefined;
  return { schemaVersion: 1, revision: Number(value.revision), orphaned: value.orphaned, people };
}

function parseIdentity(value: Record<string, unknown>): TaskPersonIdentity | undefined {
  if (!HEX64.test(String(value.developerId)) || !SlackUserIdSchema.safeParse(value.slackUserId).success
    || typeof value.name !== "string" || safeName(value.name, String(value.slackUserId)) !== value.name
    || (value.method !== "slack" && value.method !== "oidc") || typeof value.issuer !== "string" || value.issuer.length === 0 || value.issuer.length > 2048
    || typeof value.subject !== "string" || value.subject.length === 0 || value.subject.length > 512) return undefined;
  return {
    developerId: String(value.developerId), slackUserId: String(value.slackUserId), name: value.name,
    method: value.method, issuer: value.issuer, subject: value.subject,
  };
}

function samePrincipal(left: TaskPersonIdentity, right: TaskPersonIdentity): boolean {
  return left.developerId === right.developerId && left.slackUserId === right.slackUserId && left.method === right.method
    && left.issuer === right.issuer && left.subject === right.subject;
}

async function get(deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
  return isRecord(response.Item) ? response.Item : undefined;
}

async function loadTask(deps: TaskPeopleDependencies, taskId: string): Promise<DeveloperTaskRecord> {
  if (!TASK_ID.test(taskId)) return denied();
  const item = await get(deps, taskKey(taskId));
  if (item?.pk !== taskPk(taskId) || item.sk !== "META" || item.entityType !== "DEVELOPER_TASK" || item.taskId !== taskId
    || !HEX64.test(String(item.developerId)) || typeof item.project !== "string") return denied();
  return item as unknown as DeveloperTaskRecord;
}

async function loadPeople(deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName">, taskId: string): Promise<TaskPeople | undefined> {
  const item = await get(deps, peopleKey(taskId));
  if (item === undefined) return undefined;
  const parsed = parsePeople(item);
  if (parsed === undefined || item.pk !== taskPk(taskId)) return denied();
  return parsed;
}

async function personByDeveloper(deps: TaskPeopleDependencies, taskId: string, developerId: string): Promise<{ personId: string; identity: TaskPersonIdentity } | undefined> {
  const reverse = await get(deps, subjectKey(taskId, developerId));
  if (reverse === undefined) return undefined;
  if (!exactKeys(reverse, ["pk", "sk", "schemaVersion", "personId", "developerId", "createdAt"])
    || reverse.pk !== taskPk(taskId) || reverse.sk !== subjectKey(taskId, developerId).sk || reverse.schemaVersion !== 1
    || reverse.developerId !== developerId || typeof reverse.personId !== "string" || !UUID.test(reverse.personId)
    || typeof reverse.createdAt !== "string" || !Number.isFinite(Date.parse(reverse.createdAt))) return denied();
  const person = await get(deps, personKey(taskId, reverse.personId));
  if (person === undefined || !exactKeys(person, ["pk", "sk", "schemaVersion", "personId", "developerId", "slackUserId", "name", "method", "issuer", "subject", "createdAt"])
    || person.pk !== taskPk(taskId) || person.sk !== personKey(taskId, reverse.personId).sk || person.schemaVersion !== 1
    || person.personId !== reverse.personId || person.createdAt !== reverse.createdAt) return denied();
  const identity = parseIdentity(person);
  if (identity === undefined || identity.developerId !== developerId) return denied();
  return { personId: reverse.personId, identity };
}

async function allPeople(deps: TaskPeopleDependencies, taskId: string): Promise<Array<{ personId: string; identity: TaskPersonIdentity }>> {
  const found: Array<{ personId: string; identity: TaskPersonIdentity }> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :person)",
      ExpressionAttributeValues: { ":pk": taskPk(taskId), ":person": "PERSON#" }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    if (!Array.isArray(response.Items)) return denied();
    for (const item of response.Items) {
      if (!isRecord(item) || typeof item.developerId !== "string") return denied();
      const mapped = await personByDeveloper(deps, taskId, item.developerId);
      if (mapped === undefined || item.sk !== `PERSON#${mapped.personId}`) return denied();
      found.push(mapped);
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  if (new Set(found.map((entry) => entry.identity.developerId)).size !== found.length) return denied();
  return found;
}

async function checkedFresh(deps: Pick<TaskPeopleDependencies, "checkTaskPerson">, task: DeveloperTaskRecord, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonCheck> {
  if (deps.checkTaskPerson === undefined) return denied();
  admission?.admitIdentity(developerId);
  admission?.assertOpen();
  const result = await deps.checkTaskPerson(task, developerId, admission);
  admission?.assertOpen();
  const identity = result.identity;
  if (result.subject.developerId !== developerId || result.subject.slackUserId !== identity.slackUserId
    || identity.developerId !== developerId || !SlackUserIdSchema.safeParse(identity.slackUserId).success
    || typeof identity.name !== "string" || safeName(identity.name, identity.slackUserId) !== identity.name
    || typeof result.eligible !== "boolean" || typeof result.channelMember !== "boolean") return denied();
  admission?.noteNativeIdentity(identity.developerId, identity.slackUserId);
  return result;
}

async function checked(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonCheck> {
  if (admission !== undefined) {
    try { return await checkedFresh(deps, task, developerId, admission); } catch { return unavailable(); }
  }
  try { return await checkedFresh(deps, task, developerId); } catch { return denied(); }
}

function preflight(items: readonly TransactItem[]): void {
  if (items.length > TRANSACTION_LIMIT || items.some((item) => {
    const operation = Object.values(item)[0] as { Item?: unknown } | undefined;
    return operation?.Item !== undefined && Buffer.byteLength(JSON.stringify(operation.Item), "utf8") > ITEM_LIMIT;
  })) throw agentXError("CONFIG_INVALID", "People change is too large to store safely");
}

async function transact(deps: TaskPeopleDependencies, items: readonly TransactItem[]): Promise<void> {
  preflight(items);
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...items] }));
}

async function initialize(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, admission?: TaskPeopleDisplayAdmission): Promise<TaskPeople> {
  if (!enabled(deps) || !open(task) || task.share === undefined || !Number.isSafeInteger(task.workflow?.revision)) return denied();
  const proof = await checked(deps, task, task.developerId, admission);
  if (!proof.eligible || !proof.channelMember || proof.identity.developerId !== task.developerId) return denied();
  const existing = await personByDeveloper(deps, task.taskId, task.developerId);
  if (existing !== undefined && !samePrincipal(existing.identity, proof.identity)) return denied();
  const createdAt = new Date(deps.now()).toISOString();
  const personId = existing?.personId ?? randomUUID();
  const people: TaskPeople = {
    schemaVersion: 1, revision: 1, orphaned: false,
    people: [{ developerId: proof.identity.developerId, slackUserId: proof.identity.slackUserId, name: safeName(proof.identity.name, proof.identity.slackUserId), role: "owner" }],
  };
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...peopleKey(task.taskId), ...people }, ConditionExpression: "attribute_not_exists(pk)" } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      ConditionExpression: "#developerId = :developerId AND workflow.#revision = :taskRevision AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#developerId": "developerId", "#revision": "revision" },
      ExpressionAttributeValues: { ":developerId": task.developerId, ":taskRevision": task.workflow!.revision },
    } },
  ];
  if (existing === undefined) {
    const identity = { ...proof.identity, name: safeName(proof.identity.name, proof.identity.slackUserId) };
    const person: PersonRecord = { ...personKey(task.taskId, personId), schemaVersion: 1, personId, ...identity, createdAt };
    const reverse: SubjectRecord = { ...subjectKey(task.taskId, identity.developerId), schemaVersion: 1, personId, developerId: identity.developerId, createdAt };
    items.push(
      { Put: { TableName: deps.tableName, Item: person, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: reverse, ConditionExpression: "attribute_not_exists(pk)" } },
    );
  }
  try {
    admission?.assertOpen();
    await transact(deps, items);
    return people;
  } catch (error) {
    if (!conditional(error)) throw error;
    const winner = await loadPeople(deps, task.taskId);
    return winner ?? stale();
  }
}

async function reconcile(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, original: TaskPeople,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPeople> {
  let current = original;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextEntries: PersonEntry[] = [];
    for (const person of current.people) {
      if (person.role !== "owner") { nextEntries.push(person); continue; }
      const proof = await checked(deps, task, person.developerId, admission);
      nextEntries.push(proof.eligible && proof.channelMember ? person : { ...person, role: proof.eligible ? "commenter" : "denied" });
    }
    const orphaned = !nextEntries.some((person) => person.role === "owner");
    if (orphaned === current.orphaned && nextEntries.every((entry, index) => entry.role === current.people[index]!.role)) return current;
    const next: TaskPeople = { schemaVersion: 1, revision: current.revision + 1, orphaned, people: nextEntries };
    const item = { ...peopleKey(task.taskId), ...next };
    preflight([{ Put: { TableName: deps.tableName, Item: item } }]);
    try {
      admission?.assertOpen();
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
        TableName: deps.tableName, Key: peopleKey(task.taskId),
        UpdateExpression: "SET #revision = :nextRevision, #orphaned = :orphaned, #people = :people",
        ConditionExpression: "#revision = :expectedRevision",
        ExpressionAttributeNames: { "#revision": "revision", "#orphaned": "orphaned", "#people": "people" },
        ExpressionAttributeValues: { ":nextRevision": next.revision, ":orphaned": next.orphaned, ":people": next.people, ":expectedRevision": current.revision },
      } }] }));
      return next;
    } catch (error) {
      if (!conditional(error)) throw error;
      const raced = await loadPeople(deps, task.taskId);
      if (raced === undefined) return denied();
      current = raced;
    }
  }
  return stale();
}

async function currentPeople(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, admission?: TaskPeopleDisplayAdmission): Promise<TaskPeople> {
  const stored = await loadPeople(deps, task.taskId);
  if (stored === undefined) return denied();
  return reconcile(deps, task, stored, admission);
}

async function authorizeColdInitialization(
  deps: TaskPeopleDependencies,
  task: DeveloperTaskRecord,
  caller: DeveloperCaller,
  ownerOnly: boolean,
  admission?: TaskPeopleDisplayAdmission,
): Promise<void> {
  if (ownerOnly && caller.developerId !== task.developerId) return denied();
  const proof = await checked(deps, task, caller.developerId, admission);
  if (!proof.eligible || !proof.channelMember) return denied();
}

async function currentPeopleForCaller(
  deps: TaskPeopleDependencies,
  task: DeveloperTaskRecord,
  caller: DeveloperCaller,
  ownerOnly: boolean,
  admission?: TaskPeopleDisplayAdmission,
): Promise<TaskPeople> {
  const stored = await loadPeople(deps, task.taskId);
  if (stored !== undefined) return reconcile(deps, task, stored, admission);
  if (!enabled(deps)) return unavailable();
  await authorizeColdInitialization(deps, task, caller, ownerOnly, admission);
  return reconcile(deps, task, await initialize(deps, task, admission), admission);
}

function effectiveRoleFromProof(explicit: PersonEntry | undefined, proof: TaskPersonCheck): TaskRole | null {
  if (explicit?.role === "denied" || !proof.eligible) return null;
  if (explicit?.role === "owner") return proof.channelMember ? "owner" : null;
  if (explicit?.role === "commenter" || explicit?.role === "viewer") return explicit.role;
  return proof.channelMember ? "commenter" : null;
}

async function effectiveRole(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, people: TaskPeople, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskRole | null> {
  const explicit = people.people.find((person) => person.developerId === developerId);
  const proof = await checked(deps, task, developerId, admission);
  return effectiveRoleFromProof(explicit, proof);
}

async function viewOf(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, people: TaskPeople, caller: DeveloperCaller,
  displayChecks: readonly TaskPersonCheck[] = [], admission?: TaskPeopleDisplayAdmission): Promise<TaskPeopleView> {
  const mappings = await allPeople(deps, task.taskId);
  const byDeveloper = new Map(mappings.map((mapping) => [mapping.identity.developerId, mapping]));
  for (const person of people.people) if (!byDeveloper.has(person.developerId)) return denied();
  const candidates = new Map<string, { personId: string; identity: TaskPersonIdentity; explicit?: PersonEntry }>();
  for (const mapping of mappings) {
    const explicit = people.people.find((person) => person.developerId === mapping.identity.developerId);
    candidates.set(mapping.identity.developerId, { ...mapping, ...(explicit === undefined ? {} : { explicit }) });
  }
  const sameSlack = new Map<string, number>();
  for (const candidate of candidates.values()) sameSlack.set(candidate.identity.slackUserId, (sameSlack.get(candidate.identity.slackUserId) ?? 0) + 1);
  const rendered: TaskPeopleView["people"] = [];
  const displayByDeveloper = new Map(displayChecks.map((proof) => [proof.identity.developerId, proof]));
  for (const candidate of candidates.values()) {
    const role = candidate.explicit?.role ?? "commenter";
    const display = displayByDeveloper.get(candidate.identity.developerId);
    const effective = display !== undefined && samePrincipal(display.identity, candidate.identity)
      ? effectiveRoleFromProof(candidate.explicit, display)
      : await effectiveRole(deps, task, people, candidate.identity.developerId, admission);
    if (candidate.explicit === undefined && effective !== "commenter") continue;
    const suffix = (sameSlack.get(candidate.identity.slackUserId) ?? 0) > 1 ? (candidate.identity.method === "slack" ? " (Slack identity)" : " (OIDC identity)") : "";
    const baseName = candidate.explicit?.name ?? candidate.identity.name;
    const labeledName = suffix === "" ? baseName : `${redactAndCap(baseName, 80 - suffix.length).text}${suffix}`;
    rendered.push({
      personId: candidate.personId,
      name: safeName(labeledName, candidate.identity.slackUserId),
      role, you: candidate.identity.developerId === caller.developerId, effectiveRole: effective,
    });
  }
  rendered.sort((left, right) => left.name.localeCompare(right.name) || left.personId.localeCompare(right.personId));
  const callerRole = await effectiveRole(deps, task, people, caller.developerId, admission);
  const takeoverProof = enabled(deps) && open(task) && people.orphaned && callerRole !== null
    ? await checked(deps, task, caller.developerId, admission)
    : undefined;
  const canTakeOwnership = takeoverProof?.eligible === true && takeoverProof.channelMember;
  const thread = task.share === undefined ? undefined : SlackThreadSchema.safeParse({
    teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs,
  });
  return {
    revision: people.revision, orphaned: people.orphaned, people: rendered,
    canManage: enabled(deps) && open(task) && callerRole === "owner",
    canTakeOwnership,
    ...(thread?.success === true ? { addPeopleUrl: slackThreadUrl(thread.data) } : {}),
  };
}

function parseView(value: unknown): TaskPeopleView | undefined {
  const keys = value !== null && typeof value === "object" && Object.hasOwn(value, "addPeopleUrl")
    ? ["revision", "orphaned", "people", "canManage", "canTakeOwnership", "addPeopleUrl"]
    : ["revision", "orphaned", "people", "canManage", "canTakeOwnership"];
  if (!isRecord(value) || !exactKeys(value, keys)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.orphaned !== "boolean"
    || typeof value.canManage !== "boolean" || typeof value.canTakeOwnership !== "boolean"
    || (value.addPeopleUrl !== undefined && typeof value.addPeopleUrl !== "string")
    || !Array.isArray(value.people)) return undefined;
  for (const person of value.people) {
    if (!isRecord(person) || !exactKeys(person, ["personId", "name", "role", "you", "effectiveRole"])
      || typeof person.personId !== "string" || !UUID.test(person.personId) || typeof person.name !== "string"
      || (person.role !== "owner" && person.role !== "commenter" && person.role !== "viewer" && person.role !== "denied")
      || typeof person.you !== "boolean" || (person.effectiveRole !== null && person.effectiveRole !== "owner" && person.effectiveRole !== "commenter" && person.effectiveRole !== "viewer")) return undefined;
  }
  return value as unknown as TaskPeopleView;
}

async function authorizedRead(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, people: TaskPeople, caller: DeveloperCaller,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskRole> {
  const role = await effectiveRole(deps, task, people, caller.developerId, admission);
  return role ?? denied();
}

async function priorOutcome(
  deps: TaskPeopleDependencies,
  taskId: string,
  requestId: string,
  actorDeveloperId: string,
  kind: "change" | "takeOwnership",
  payload: Record<string, unknown>,
): Promise<TaskPeopleView | undefined> {
  const request = await get(deps, requestKey(taskId, requestId));
  if (request === undefined) return undefined;
  if (request.schemaVersion !== 1 || request.requestId !== requestId || request.actorDeveloperId !== actorDeveloperId || request.kind !== kind
    || !isDeepStrictEqual(request.payload, payload)) throw agentXError("IDEMPOTENCY_CONFLICT", "this People request ID was already used");
  return parseView(request.outcome) ?? denied();
}

async function readablePriorOutcome(
  deps: TaskPeopleDependencies,
  taskId: string,
  caller: DeveloperCaller,
  requestId: string,
  kind: "change" | "takeOwnership",
  payload: Record<string, unknown>,
): Promise<TaskPeopleView | undefined> {
  const outcome = await priorOutcome(deps, taskId, requestId, caller.developerId, kind, payload);
  if (outcome === undefined) return undefined;
  const currentTask = await loadTask(deps, taskId);
  const current = await currentPeople(deps, currentTask);
  await authorizedRead(deps, currentTask, current, caller);
  return outcome;
}

/** Reads an exact historical People mutation only after reauthorizing the current caller. */
export async function getTaskPeopleRequestOutcome(
  deps: TaskPeopleDependencies,
  caller: DeveloperCaller,
  taskId: string,
  requestId: string,
  kind: "change" | "takeOwnership",
  payload: Record<string, unknown>,
): Promise<TaskPeopleView | undefined> {
  return readablePriorOutcome(deps, taskId, caller, requestId, kind, payload);
}

function mutationInput(input: ChangeTaskPeopleInput): void {
  if (!REQUEST_ID.test(input.requestId) || !Number.isSafeInteger(input.expectedPeopleRevision) || input.expectedPeopleRevision < 1
    || !HEX64.test(input.targetDeveloperId) || (input.role !== "owner" && input.role !== "commenter" && input.role !== "viewer" && input.role !== "denied")) {
    throw agentXError("CONFIG_INVALID", "People change is invalid");
  }
}

async function commitMutation(
  deps: TaskPeopleDependencies,
  task: DeveloperTaskRecord,
  caller: DeveloperCaller,
  current: TaskPeople,
  next: TaskPeople,
  requestId: string,
  kind: "change" | "takeOwnership",
  payload: Record<string, unknown>,
  beforeRole: StoredTaskRole | null,
  afterRole: StoredTaskRole,
  targetDeveloperId: string,
  notification?: { slackUserId: string; role: StoredTaskRole },
): Promise<TaskPeopleView> {
  const outcome = await viewOf(deps, task, next, caller);
  const createdAt = new Date(deps.now()).toISOString();
  const request = { ...requestKey(task.taskId, requestId), entityType: "TASK_PEOPLE_REQUEST", schemaVersion: 1, requestId, actorDeveloperId: caller.developerId, kind, payload, outcome, createdAt };
  const event = { ...eventKey(task.taskId, requestId), entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId, actorDeveloperId: caller.developerId, targetDeveloperId, beforeRole, afterRole, createdAt };
  if (!Number.isSafeInteger(task.workflow?.revision) || typeof task.workflow?.stage !== "string") return denied();
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: peopleKey(task.taskId),
      UpdateExpression: "SET #revision = :nextRevision, #orphaned = :orphaned, #people = :people",
      ConditionExpression: "#revision = :expectedRevision",
      ExpressionAttributeNames: { "#revision": "revision", "#orphaned": "orphaned", "#people": "people" },
      ExpressionAttributeValues: { ":nextRevision": next.revision, ":orphaned": next.orphaned, ":people": next.people, ":expectedRevision": current.revision },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      ConditionExpression: "#developerId = :developerId AND workflow.#revision = :taskRevision AND workflow.#stage = :taskStage AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#developerId": "developerId", "#revision": "revision", "#stage": "stage" },
      ExpressionAttributeValues: { ":developerId": task.developerId, ":taskRevision": task.workflow.revision, ":taskStage": task.workflow.stage },
    } },
    { Put: { TableName: deps.tableName, Item: event, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: request, ConditionExpression: "attribute_not_exists(pk)" } },
    ...(notification === undefined ? [] : [{ Put: { TableName: deps.tableName, Item: {
      pk: taskPk(task.taskId), sk: `PEOPLE_NOTIFY#${requestId}`, entityType: "TASK_PEOPLE_NOTIFICATION", schemaVersion: 1,
      taskId: task.taskId, requestId, targetDeveloperId, slackUserId: notification.slackUserId, role: notification.role,
      peopleRevision: next.revision, status: "PENDING", attempts: 0, createdAt,
    }, ConditionExpression: "attribute_not_exists(pk)" } }]),
  ];
  try {
    await transact(deps, items);
    return outcome;
  } catch (error) {
    if (!conditional(error)) throw error;
    const replay = await readablePriorOutcome(deps, task.taskId, caller, requestId, kind, payload);
    return replay ?? stale();
  }
}

export function taskAccessFence(tableName: string, taskId: string, peopleRevision?: number): TransactItem {
  const base = { TableName: tableName, Key: peopleKey(taskId) };
  return peopleRevision === undefined
    ? { ConditionCheck: { ...base, ConditionExpression: "attribute_not_exists(pk)" } }
    : { ConditionCheck: { ...base, ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": peopleRevision } } };
}

export async function resolveTaskPeopleAccess(
  deps: TaskPeopleDependencies,
  task: DeveloperTaskRecord,
  developerId: string,
): Promise<{ role: TaskRole; peopleRevision: number; ownerActorIds: readonly string[]; orphaned: boolean; canTakeOwnership: boolean } | undefined> {
  const stored = await loadPeople(deps, task.taskId);
  if (stored === undefined) return undefined;
  const people = await reconcile(deps, task, stored);
  const role = await effectiveRole(deps, task, people, developerId);
  if (role === null) return denied();
  const owners = people.people.filter((person) => person.role === "owner").map((person) => taskOwnerKey(person.developerId, task.taskId));
  const proof = people.orphaned ? await checked(deps, task, developerId) : undefined;
  return {
    role, peopleRevision: people.revision, ownerActorIds: owners, orphaned: people.orphaned,
    canTakeOwnership: people.orphaned && role !== null && proof?.eligible === true && proof.channelMember,
  };
}

/**
 * Fresh effective owners for a system successor/final delivery. Missing PEOPLE preserves legacy
 * work. Definite proof loss is ownerless; proof transport or malformed proof remains UNKNOWN and
 * must be parked by the caller without rewriting the sidecar.
 */
export async function resolveTaskDispatchPeople(
  deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName" | "checkTaskPerson">,
  task: DeveloperTaskRecord,
): Promise<{ peopleRevision: number; ownerActorIds: readonly string[]; status: "ALLOWED" | "OWNERLESS" | "UNKNOWN" } | undefined> {
  const people = await loadPeople(deps, task.taskId);
  if (people === undefined) return undefined;
  if (people.orphaned) return { peopleRevision: people.revision, ownerActorIds: [], status: "OWNERLESS" };
  if (deps.checkTaskPerson === undefined) return { peopleRevision: people.revision, ownerActorIds: [], status: "UNKNOWN" };
  const owners: string[] = [];
  let unknown = false;
  for (const person of people.people) {
    if (person.role !== "owner") continue;
    try {
      const proof = await checkedFresh(deps, task, person.developerId);
      if (proof.eligible && proof.channelMember) owners.push(taskOwnerKey(person.developerId, task.taskId));
    } catch {
      unknown = true;
    }
  }
  if (owners.length > 0) return { peopleRevision: people.revision, ownerActorIds: owners, status: "ALLOWED" };
  return { peopleRevision: people.revision, ownerActorIds: [], status: unknown ? "UNKNOWN" : "OWNERLESS" };
}

export async function getTaskPeople(deps: TaskPeopleDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView> {
  const admission = deps.createTaskPeopleDisplayAdmission?.() ?? unavailable();
  try {
    admission.assertOpen();
    const task = await loadTask(deps, taskId);
    admission.assertOpen();
    const people = await currentPeopleForCaller(deps, task, caller, false, admission);
    await authorizedRead(deps, task, people, caller, admission);
    if (deps.listTaskPeople === undefined) return unavailable();
    const displayChecks = await deps.listTaskPeople(task, admission);
    admission.assertOpen();
    const view = await viewOf(deps, task, people, caller, displayChecks, admission);
    admission.assertOpen();
    return view;
  } finally {
    admission.close();
  }
}

/** A polling-safe capability read: it checks only META, PEOPLE and the caller's current proof. */
export async function getTaskPeopleCapabilities(
  deps: TaskPeopleDependencies,
  caller: DeveloperCaller,
  taskId: string,
): Promise<{ peopleRevision?: number; canManagePeople: boolean; canTakeOwnership: boolean }> {
  const task = await loadTask(deps, taskId);
  const people = await loadPeople(deps, taskId);
  if (people === undefined) return { canManagePeople: false, canTakeOwnership: false };
  const current = await reconcile(deps, task, people);
  const role = await effectiveRole(deps, task, current, caller.developerId);
  if (role === null) return denied();
  let canTakeOwnership = false;
  if (enabled(deps) && open(task) && current.orphaned) {
    const proof = await checked(deps, task, caller.developerId);
    canTakeOwnership = proof.eligible && proof.channelMember;
  }
  return {
    peopleRevision: current.revision,
    canManagePeople: enabled(deps) && open(task) && role === "owner",
    canTakeOwnership,
  };
}

/** Snapshot used only to condition an external People effect claim against current authority and lifecycle. */
export async function getTaskPeopleEffectAdmission(
  deps: TaskPeopleDependencies,
  caller: DeveloperCaller,
  taskId: string,
): Promise<{ peopleRevision: number; taskRevision: number; taskStage: string; taskShare: { teamId: string; channelId: string; threadTs: string } }> {
  const task = await loadTask(deps, taskId);
  const people = await loadPeople(deps, taskId);
  const taskShare = SlackThreadSchema.safeParse(task.share === undefined ? undefined : {
    teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs,
  });
  if (people === undefined || !enabled(deps) || !open(task) || !Number.isSafeInteger(task.workflow?.revision) || typeof task.workflow?.stage !== "string"
    || !taskShare.success) return denied();
  const current = await reconcile(deps, task, people);
  if (await effectiveRole(deps, task, current, caller.developerId) !== "owner") return denied();
  return { peopleRevision: current.revision, taskRevision: task.workflow.revision, taskStage: task.workflow.stage, taskShare: taskShare.data };
}

/** Resolves an opaque public person ID to a freshly-qualified internal target. */
export async function resolveTaskPeopleTarget(
  deps: TaskPeopleDependencies,
  taskId: string,
  personId: string,
): Promise<{ developerId: string }> {
  if (!UUID.test(personId)) return denied();
  const task = await loadTask(deps, taskId);
  const person = await get(deps, personKey(taskId, personId));
  if (person === undefined || person.pk !== taskPk(taskId) || person.sk !== personKey(taskId, personId).sk || person.personId !== personId) return denied();
  const identity = parseIdentity(person);
  if (identity === undefined) return denied();
  const proof = await checked(deps, task, identity.developerId);
  if (!proof.eligible || !samePrincipal(identity, proof.identity)) return denied();
  return { developerId: identity.developerId };
}

export async function changeTaskPeople(
  deps: TaskPeopleDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: ChangeTaskPeopleInput,
): Promise<TaskPeopleView> {
  mutationInput(input);
  const task = await loadTask(deps, taskId);
  let people = await currentPeopleForCaller(deps, task, caller, true);
  const callerRole = await authorizedRead(deps, task, people, caller);
  const payload = { expectedPeopleRevision: input.expectedPeopleRevision, targetDeveloperId: input.targetDeveloperId, role: input.role };
  const replay = await readablePriorOutcome(deps, taskId, caller, input.requestId, "change", payload);
  if (replay !== undefined) return replay;
  if (!enabled(deps) || !open(task) || callerRole !== "owner") return denied();
  if (people.revision !== input.expectedPeopleRevision) return stale();
  people = await reconcile(deps, task, people);
  if (people.revision !== input.expectedPeopleRevision) return stale();
  const mapping = await personByDeveloper(deps, taskId, input.targetDeveloperId);
  if (mapping === undefined) return denied();
  const proof = await checked(deps, task, input.targetDeveloperId);
  if (!samePrincipal(mapping.identity, proof.identity) || (input.role !== "denied" && !proof.eligible)
    || (input.role === "owner" && !proof.channelMember)) return denied();
  const existing = people.people.find((person) => person.developerId === input.targetDeveloperId);
  const beforeRole = existing?.role ?? (proof.eligible && proof.channelMember ? "commenter" : null);
  if (existing?.role === input.role) throw agentXError("CONFIG_INVALID", "that person already has this task role");
  if (existing?.role === "owner" && input.role !== "owner" && people.people.filter((person) => person.role === "owner").length === 1) {
    throw agentXError("CONFIG_INVALID", "a task must retain an effective owner");
  }
  const entry: PersonEntry = { developerId: mapping.identity.developerId, slackUserId: mapping.identity.slackUserId, name: safeName(proof.identity.name, proof.identity.slackUserId), role: input.role };
  const nextEntries = existing === undefined ? [...people.people, entry] : people.people.map((person) => person.developerId === input.targetDeveloperId ? entry : person);
  const next: TaskPeople = { schemaVersion: 1, revision: people.revision + 1, orphaned: !nextEntries.some((person) => person.role === "owner"), people: nextEntries };
  preflight([{ Put: { TableName: deps.tableName, Item: { ...peopleKey(taskId), ...next } } }]);
  return commitMutation(deps, task, caller, people, next, input.requestId, "change", payload, beforeRole, input.role, input.targetDeveloperId,
    !proof.channelMember && input.role !== "denied" ? { slackUserId: proof.identity.slackUserId, role: input.role } : undefined);
}

export async function takeTaskOwnership(
  deps: TaskPeopleDependencies,
  caller: DeveloperCaller,
  taskId: string,
  input: TakeTaskOwnershipInput,
): Promise<TaskPeopleView> {
  if (!REQUEST_ID.test(input.requestId) || !Number.isSafeInteger(input.expectedPeopleRevision) || input.expectedPeopleRevision < 1) {
    throw agentXError("CONFIG_INVALID", "ownership request is invalid");
  }
  const task = await loadTask(deps, taskId);
  const people = await currentPeople(deps, task);
  await authorizedRead(deps, task, people, caller);
  const payload = { expectedPeopleRevision: input.expectedPeopleRevision };
  const replay = await readablePriorOutcome(deps, taskId, caller, input.requestId, "takeOwnership", payload);
  if (replay !== undefined) return replay;
  if (!enabled(deps) || !open(task) || !people.orphaned || people.revision !== input.expectedPeopleRevision) return denied();
  const mapping = await personByDeveloper(deps, taskId, caller.developerId);
  if (mapping === undefined) return denied();
  const proof = await checked(deps, task, caller.developerId);
  if (!proof.eligible || !proof.channelMember || !samePrincipal(mapping.identity, proof.identity)) return denied();
  const existing = people.people.find((person) => person.developerId === caller.developerId);
  if (existing?.role === "denied") return denied();
  const beforeRole = existing?.role ?? "commenter";
  const owner: PersonEntry = { developerId: mapping.identity.developerId, slackUserId: mapping.identity.slackUserId, name: safeName(proof.identity.name, proof.identity.slackUserId), role: "owner" };
  const nextEntries = existing === undefined ? [...people.people, owner] : people.people.map((person) => person.developerId === caller.developerId ? owner : person);
  const next: TaskPeople = { schemaVersion: 1, revision: people.revision + 1, orphaned: false, people: nextEntries };
  return commitMutation(deps, task, caller, people, next, input.requestId, "takeOwnership", payload, beforeRole, "owner", caller.developerId);
}
