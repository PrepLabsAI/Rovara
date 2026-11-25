import { rethrowMembershipReadFailure } from "../core/membership-read.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { AgentXError, BUILT_IN_SIGN_IN_METHODS, OWNER_NEEDS_GRANT_WORDS, SlackThreadSchema, agentXError, cleanDisplayName, redactAndCap, slackThreadUrl } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { isHostedTaskProvider, type ProjectAccessSubject, type TaskPersonIdentity } from "./task-person-identity.js";
import type { TaskPeopleDisplayAdmission } from "./task-people-display-budget.js";
import {
  isSlackTaskPerson, parseTaskPeopleEntry, parseTaskPersonIdentity, taskPeopleEntryOf, taskPersonIdentitySuffix, taskPersonKindOf,
  taskPersonNameFallback, taskPersonRowKeys, type TaskPeopleEntry,
} from "./task-person-rows.js";
import { taskKey, taskOwnerKey, type DeveloperTaskRecord } from "./task-records.js";
import { involvedRowDelete, involvedRowPut } from "../core/task-flow/involved.js";

export type TaskRole = "owner" | "commenter" | "viewer";
export type StoredTaskRole = TaskRole | "denied";

export interface TaskPeople {
  schemaVersion: 1;
  revision: number;
  orphaned: boolean;
  /** C1: an entry is `slack` (the pre-C1 { developerId, slackUserId, name, role }) or `web` ({ developerId, name, role, method }). */
  people: TaskPeopleEntry[];
}

export interface TaskPeopleConfiguration { peopleChangesEnabled: boolean }

export interface TaskPersonCheck {
  subject: ProjectAccessSubject;
  identity: TaskPersonIdentity;
  eligible: boolean;
  channelMember: boolean;
  /** ARCH RULING (b): true when the person passes only through the project's Slack channel, with no individual project grant. Absent: not known to be channel-only (a web person always holds a grant). */
  channelOnly?: boolean;
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
  /** `method`: how the person signs in (Q7 follow-up), for a client's label. Absent on an outcome stored before it existed. */
  people: Array<{ personId: string; name: string; role: StoredTaskRole; you: boolean; effectiveRole: TaskRole | null; method?: (typeof BUILT_IN_SIGN_IN_METHODS)[number] }>;
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
type PersonEntry = TaskPeopleEntry;
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

const validEntry = (value: unknown): value is PersonEntry => parseTaskPeopleEntry(value) !== undefined;

function parsePeople(value: unknown): TaskPeople | undefined {
  if (!isRecord(value) || !exactKeys(value, ["pk", "sk", "schemaVersion", "revision", "orphaned", "people"])
    || typeof value.pk !== "string" || value.sk !== PEOPLE_SK || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.orphaned !== "boolean"
    || !Array.isArray(value.people) || !value.people.every(validEntry)) return undefined;
  const people = value.people;
  if (new Set(people.map((person) => person.developerId)).size !== people.length) return undefined;
  return { schemaVersion: 1, revision: Number(value.revision), orphaned: value.orphaned, people };
}

const parseIdentity = parseTaskPersonIdentity;

function samePrincipal(left: TaskPersonIdentity, right: TaskPersonIdentity): boolean {
  return left.developerId === right.developerId && left.slackUserId === right.slackUserId && left.method === right.method
    && left.issuer === right.issuer && left.subject === right.subject;
}

async function get(deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
  return isRecord(response.Item) ? response.Item : undefined;
}

/**
 * THE WORKSPACE SLOT MOVES WITH THE OWNER (TASK-TAKEOVER PR A). A task holds one slot of its member's workspace counter (`DEVELOPER_LIMIT#<person>`, a marker row per task) while it is open. When the task is handed over or
 * taken over, the slot moves to the new owner IN THE SAME TRANSACTION, from that moment: the old person's counter goes down by one and their marker goes, the new owner's goes up by one and gets the marker, and the
 * task's own `charge.member` names the new counter (so the close releases the right one). The organization's count does not change (the task is still one task): nothing is counted twice and nothing stays on the person
 * who left. The new owner's own limit is not asked: a limit gates a START, never a task that is already running. A task that holds no slot (no marker, or a counter that is not a member's own) moves nothing.
 */
export interface SlotMove {
  /** The developer ids the slot moves from and to (the counters are `DEVELOPER_LIMIT#<id>`). */
  fromId: string; toId: string;
  /** The per-task steps: the old marker goes, the new one is written. */
  markers: TransactItem[];
  /** The two counters' steps (the old person's goes down by one, the new owner's up by one). A transaction that moves several tasks of one person adds the counters ONCE, by the number of tasks (`slotCounterSteps`): one item cannot be written twice in a transaction. */
  counters: TransactItem[];
}

async function slotMovePlan(deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName" | "now">, task: DeveloperTaskRecord, toId: string, fromId?: string): Promise<SlotMove | undefined> {
  const member = (task as { charge?: { member?: { pk?: unknown; sk?: unknown } } }).charge?.member;
  const held = typeof member?.pk === "string" && member.sk === "MEMBER" && member.pk.startsWith("DEVELOPER_LIMIT#") ? member.pk.slice("DEVELOPER_LIMIT#".length) : undefined;
  if (held === undefined || held === toId || (fromId !== undefined && held !== fromId)) return undefined;
  const [counter, marker] = await Promise.all([get(deps, { pk: `DEVELOPER_LIMIT#${held}`, sk: "MEMBER" }), get(deps, { pk: `DEVELOPER_LIMIT#${held}`, sk: `TASK#${task.taskId}` })]);
  if (marker === undefined || typeof counter?.["count"] !== "number" || counter["count"] < 1) return undefined;
  const chargedAt = typeof marker["chargedAt"] === "string" ? marker["chargedAt"] : new Date(deps.now()).toISOString();
  return { fromId: held, toId,
    markers: [
      { Delete: { TableName: deps.tableName, Key: { pk: `DEVELOPER_LIMIT#${held}`, sk: `TASK#${task.taskId}` }, ConditionExpression: "attribute_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { pk: `DEVELOPER_LIMIT#${toId}`, sk: `TASK#${task.taskId}`, entityType: "DEVELOPER_LIMIT_TASK", taskId: task.taskId, memberSk: "MEMBER", chargedAt }, ConditionExpression: "attribute_not_exists(pk)" } },
    ],
    counters: slotCounterSteps(deps.tableName, held, toId, 1) };
}

/** How many per-task steps the slot's move adds to a transaction (none for a task that holds no slot). */
const slotMarkerSteps = (slot: SlotMove | undefined): number => slot === undefined ? 0 : slot.markers.length;

/** The two counters' steps for `count` tasks moving from one member's counter to another's: the old one goes down (it must hold that many), the new one goes up. */
export function slotCounterSteps(tableName: string, fromId: string, toId: string, count: number): TransactItem[] {
  return [
    { Update: { TableName: tableName, Key: { pk: `DEVELOPER_LIMIT#${fromId}`, sk: "MEMBER" }, UpdateExpression: "ADD #count :minus", ConditionExpression: "#count >= :count", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":minus": -count, ":count": count } } },
    { Update: { TableName: tableName, Key: { pk: `DEVELOPER_LIMIT#${toId}`, sk: "MEMBER" }, UpdateExpression: "SET #entityType = :entity ADD #count :plus", ExpressionAttributeNames: { "#count": "count", "#entityType": "entityType" }, ExpressionAttributeValues: { ":plus": count, ":entity": "DEVELOPER_LIMIT" } } },
  ];
}

/**
 * The transaction's guard on the task's own row, with the slot's move written onto it when there is one (one item per row: the guard becomes the update), and the slot's own steps after it. `counters: false` leaves the
 * two counters to the caller (a hand-over of several tasks adds them once).
 */
function withSlot(items: TransactItem[], task: DeveloperTaskRecord, slot: SlotMove | undefined, counters = true): TransactItem[] {
  if (slot === undefined) return items;
  let converted = false;
  const out = items.map((item): TransactItem => {
    const check = item.ConditionCheck;
    if (check === undefined || check.Key?.["pk"] !== taskPk(task.taskId) || check.Key["sk"] !== "META") return item;
    converted = true;
    return { Update: { TableName: check.TableName, Key: check.Key, UpdateExpression: "SET charge.#chargeMember = :slotTo", ConditionExpression: `${check.ConditionExpression ?? ""} AND charge.#chargeMember.#chargePk = :slotFrom`,
      ExpressionAttributeNames: { ...check.ExpressionAttributeNames, "#chargeMember": "member", "#chargePk": "pk" },
      ExpressionAttributeValues: { ...check.ExpressionAttributeValues, ":slotTo": { pk: `DEVELOPER_LIMIT#${slot.toId}`, sk: "MEMBER" }, ":slotFrom": `DEVELOPER_LIMIT#${slot.fromId}` } } };
  });
  // The task's own pointer must move with the marker and the counters, or the close would release a marker that is no longer there: no guard on the task row to carry it is a bug of the caller.
  if (!converted) throw new Error("the slot's move needs the guard on the task's own row");
  return [...out, ...slot.markers, ...(counters ? slot.counters : [])];
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
  if (person === undefined || !exactKeys(person, taskPersonRowKeys(person))
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

/** Immutable task-local identity names for page history and pending proposal presentation. No current actor is substituted. */
export async function getTaskPeoplePresentation(
  deps: TaskPeopleDependencies,
  taskId: string,
): Promise<ReadonlyArray<{ personId: string; developerId: string; name: string }>> {
  if (!TASK_ID.test(taskId)) return denied();
  return (await allPeople(deps, taskId)).map(({ personId, identity }) => ({ personId, developerId: identity.developerId, name: identity.name }));
}

async function checkedFresh(deps: Pick<TaskPeopleDependencies, "checkTaskPerson">, task: DeveloperTaskRecord, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonCheck> {
  if (deps.checkTaskPerson === undefined) return denied();
  admission?.admitIdentity(developerId);
  admission?.assertOpen();
  const result = await deps.checkTaskPerson(task, developerId, admission);
  admission?.assertOpen();
  const identity = result.identity;
  // C2: a `web` identity's result comes from the web proof (plan 4.1), with `channelMember` carrying `present`; a malformed identity is refused.
  const kind = taskPersonKindOf(identity);
  if (result.subject.developerId !== developerId || result.subject.slackUserId !== identity.slackUserId
    || identity.developerId !== developerId || kind === undefined
    || typeof identity.name !== "string" || safeName(identity.name, taskPersonNameFallback(identity)) !== identity.name
    || typeof result.eligible !== "boolean" || typeof result.channelMember !== "boolean") return denied();
  if (isSlackTaskPerson(identity)) admission?.noteNativeIdentity(identity.developerId, identity.slackUserId);
  return result;
}

/**
 * C2's contract for C3/C4 (plan 4.1): whether a checked person is "present" on the task. A `slack` identity: in the task's Slack channel, exactly as
 * before (D2). A `web` identity: a live member of the task's company with a live developer or administrator grant on its project (rules 3 and 4).
 * The check result carries it in `channelMember`; an owner keeps the role only while eligible and present.
 */
export function taskPersonPresent(check: Pick<TaskPersonCheck, "channelMember">): boolean {
  return check.channelMember;
}

/**
 * ARCH RULING (b), DEC 254zzz523: whether a checked person may be (stay) a task OWNER. The owner is the step's requester, the one the model gateway charges, so an owner needs an INDIVIDUAL project
 * grant on top of being eligible and present: a person who passes only through the project's Slack channel (`channelOnly`) may be a commenter or a viewer, never an owner. A Slack-native task
 * (provider `slack`) has no gateway payer: its channel IS its project access, so it keeps the channel rule it always had.
 * DELETE WITH THE OLD TASKS: a provider-`slack` task is one the retired spec 056 workflow started (its provider was the caller's sign-in method). Every new task starts on the core (developer-tasks.ts
 * `routeDeveloperTaskRequest`, `POST /v1/dev/tasks`; `core/task-flow/start.ts` checks the grant at `checkStart`), and the core's principals are always `rovara-sign-in` (core-engine-root.ts
 * `deployedCallerFromMembership`), so none can be made again; every route of an existing one answers "no such task" (`routeDeveloperTaskRequest`, the entry branch), so none is acted on or paid for.
 */
export function taskPersonMayOwn(task: Pick<DeveloperTaskRecord, "provider">, check: TaskPersonCheck): boolean {
  return check.eligible && taskPersonPresent(check) && !(task.provider !== "slack" && check.channelOnly === true);
}

/** Refuses, in the one sentence, an owner role for a person who is eligible and present but holds no individual grant. Everything else about their proof is the caller's own refusal. */
function refuseChannelOnlyOwner(task: Pick<DeveloperTaskRecord, "provider">, check: TaskPersonCheck): void {
  if (check.eligible && taskPersonPresent(check) && !taskPersonMayOwn(task, check)) throw agentXError("CONFIG_INVALID", OWNER_NEEDS_GRANT_WORDS);
}

async function checked(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonCheck> {
  if (admission !== undefined) {
    try { return await checkedFresh(deps, task, developerId, admission); } catch { return unavailable(); }
  }
  // A membership or grant read that FAILED is the retryable 503 (membership-read.ts), never a denial: the person is not told "no such task" or "you may not" for it.
  try { return await checkedFresh(deps, task, developerId); } catch (error) { rethrowMembershipReadFailure(error); return denied(); }
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

/**
 * C3 (plan 3 item 5, 4.2 "PEOPLE without a Slack share"): a task gets its People list once its creator passes their own proof path, eligible and
 * present: a `slack` creator through fresh Slack proof (on a task with no share, any eligible creator is present, as before), a `web` creator through
 * the web proof (live membership in the task's company and a live grant). A task with no share sets no addPeopleUrl (viewOf).
 */
async function initialize(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, admission?: TaskPeopleDisplayAdmission): Promise<TaskPeople> {
  if (!enabled(deps) || !open(task) || !Number.isSafeInteger(task.workflow?.revision)) return denied();
  const proof = await checked(deps, task, task.developerId, admission);
  if (!proof.eligible || !taskPersonPresent(proof) || proof.identity.developerId !== task.developerId) return denied();
  const existing = await personByDeveloper(deps, task.taskId, task.developerId);
  if (existing !== undefined && !samePrincipal(existing.identity, proof.identity)) return denied();
  const createdAt = new Date(deps.now()).toISOString();
  const personId = existing?.personId ?? randomUUID();
  const people: TaskPeople = {
    schemaVersion: 1, revision: 1, orphaned: false,
    people: [taskPeopleEntryOf(proof.identity, "owner")],
  };
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...peopleKey(task.taskId), ...people }, ConditionExpression: "attribute_not_exists(pk)" } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      // C3: an unshared task's list is made only while it is still unshared (its creator's presence was proved for that case).
      ConditionExpression: "#developerId = :developerId AND workflow.#revision = :taskRevision AND attribute_not_exists(closedAt)"
        + (task.share === undefined ? " AND attribute_not_exists(#share)" : ""),
      ExpressionAttributeNames: { "#developerId": "developerId", "#revision": "revision", ...(task.share === undefined ? { "#share": "share" } : {}) },
      ExpressionAttributeValues: { ":developerId": task.developerId, ":taskRevision": task.workflow!.revision },
    } },
  ];
  if (existing === undefined) {
    const identity = { ...proof.identity, name: safeName(proof.identity.name, taskPersonNameFallback(proof.identity)) };
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

/** Who a read's own demotion names as its actor: nobody pressed anything. A plain string, so a reader that only checks the field is a string (an older one) still reads the event. */
export const PEOPLE_RECONCILE_ACTOR = "system:people-reconcile";

/** The audit row of a read's demotion of an owner who holds no grant of their own: the same event shape as a role change, `via: "needs_grant"`, by the reconcile itself (`PEOPLE_RECONCILE_ACTOR`). */
function needsGrantEvent(deps: Pick<TaskPeopleDependencies, "tableName" | "now">, task: DeveloperTaskRecord, developerId: string, afterRole: StoredTaskRole): TransactItem {
  const requestId = randomUUID();
  const event = { ...eventKey(task.taskId, requestId), entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId, actorDeveloperId: PEOPLE_RECONCILE_ACTOR, targetDeveloperId: developerId,
    beforeRole: "owner", afterRole, createdAt: new Date(deps.now()).toISOString(), via: "needs_grant" };
  return { Put: { TableName: deps.tableName, Item: event, ConditionExpression: "attribute_not_exists(pk)" } };
}

/** One stored owner as a pass sees them: kept, or demoted with the rows and the audit event that go in the same transaction (an owner who is eligible and present but holds no grant of their own is demoted for THAT reason, ARCH RULING (b)). */
async function reconcileOwner(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, person: PersonEntry,
  admission?: TaskPeopleDisplayAdmission): Promise<{ entry: PersonEntry; items: TransactItem[] }> {
  const proof = await checked(deps, task, person.developerId, admission);
  if (taskPersonMayOwn(task, proof)) return { entry: person, items: [] };
  const role: StoredTaskRole = proof.eligible ? "commenter" : "denied";
  const row = involvedStep(deps, task, person.developerId, role);
  const event = proof.eligible && taskPersonPresent(proof) ? needsGrantEvent(deps, task, person.developerId, role) : undefined;
  return { entry: { ...person, role }, items: [...(row === undefined ? [] : [row]), ...(event === undefined ? [] : [event])] };
}

async function reconcile(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, original: TaskPeople,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskPeople> {
  let current = original;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextEntries: PersonEntry[] = [];
    // Row 3674 #2: an owner this pass demotes stops being involved, so their involved row goes in the SAME transaction as the People change (the creator has none).
    const demotedRows: TransactItem[] = [];
    for (const person of current.people) {
      if (person.role !== "owner") { nextEntries.push(person); continue; }
      const decided = await reconcileOwner(deps, task, person, admission);
      // One transaction holds the People update and at most TRANSACTION_LIMIT - 1 deletes and events: a pass that would exceed it leaves the rest as owners, and the next read demotes them (never a failed read).
      if (demotedRows.length + decided.items.length > TRANSACTION_LIMIT - 1 && decided.items.length > 0) { nextEntries.push(person); continue; }
      nextEntries.push(decided.entry);
      demotedRows.push(...decided.items);
    }
    const orphaned = !nextEntries.some((person) => person.role === "owner");
    if (orphaned === current.orphaned && nextEntries.every((entry, index) => entry.role === current.people[index]!.role)) return current;
    const next: TaskPeople = { schemaVersion: 1, revision: current.revision + 1, orphaned, people: nextEntries };
    const item = { ...peopleKey(task.taskId), ...next };
    preflight([{ Put: { TableName: deps.tableName, Item: item } }, ...demotedRows]);
    try {
      admission?.assertOpen();
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
        TableName: deps.tableName, Key: peopleKey(task.taskId),
        UpdateExpression: "SET #revision = :nextRevision, #orphaned = :orphaned, #people = :people",
        ConditionExpression: "#revision = :expectedRevision",
        ExpressionAttributeNames: { "#revision": "revision", "#orphaned": "orphaned", "#people": "people" },
        ExpressionAttributeValues: { ":nextRevision": next.revision, ":orphaned": next.orphaned, ":people": next.people, ":expectedRevision": current.revision },
      } }, ...demotedRows] }));
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
  // C3: only its creator starts an unshared task's list (no channel makes anyone else present on it).
  if ((ownerOnly || task.share === undefined) && caller.developerId !== task.developerId) return denied();
  const proof = await checked(deps, task, caller.developerId, admission);
  if (!proof.eligible || !taskPersonPresent(proof)) return denied();
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

/**
 * The role a person holds with no PEOPLE entry. A `slack` identity in a Slack-shared task's channel is an implicit commenter, as before (D2).
 * C3: on a task with no share there is no channel, so nobody is an implicit commenter; and a `web` identity holds only a role someone gave it
 * (D3: owners add people explicitly), so being a member with a grant alone reaches no task.
 */
function implicitRole(task: DeveloperTaskRecord, proof: TaskPersonCheck): TaskRole | null {
  return task.share !== undefined && proof.eligible && taskPersonPresent(proof) && taskPersonKindOf(proof.identity) === "slack" ? "commenter" : null;
}

function effectiveRoleFromProof(task: DeveloperTaskRecord, explicit: PersonEntry | undefined, proof: TaskPersonCheck): TaskRole | null {
  if (explicit?.role === "denied" || !proof.eligible) return null;
  if (explicit?.role === "owner") return taskPersonPresent(proof) ? "owner" : null;
  if (explicit?.role === "commenter" || explicit?.role === "viewer") return explicit.role;
  return implicitRole(task, proof);
}

async function effectiveRole(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, people: TaskPeople, developerId: string,
  admission?: TaskPeopleDisplayAdmission): Promise<TaskRole | null> {
  const explicit = people.people.find((person) => person.developerId === developerId);
  const proof = await checked(deps, task, developerId, admission);
  return effectiveRoleFromProof(task, explicit, proof);
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
  // D4 (no account linking): two identities of one Slack user, or (once a `web` identity is on the task) of one name, are told apart by method.
  const sameSlack = new Map<string, number>();
  const sameName = new Map<string, { count: number; web: boolean }>();
  for (const candidate of candidates.values()) {
    const slackUserId = candidate.identity.slackUserId;
    if (slackUserId !== undefined) sameSlack.set(slackUserId, (sameSlack.get(slackUserId) ?? 0) + 1);
    const baseName = candidate.explicit?.name ?? candidate.identity.name;
    const group = sameName.get(baseName) ?? { count: 0, web: false };
    sameName.set(baseName, { count: group.count + 1, web: group.web || taskPersonKindOf(candidate.identity) === "web" });
  }
  const rendered: TaskPeopleView["people"] = [];
  const displayByDeveloper = new Map(displayChecks.map((proof) => [proof.identity.developerId, proof]));
  for (const candidate of candidates.values()) {
    const role = candidate.explicit?.role ?? "commenter";
    const display = displayByDeveloper.get(candidate.identity.developerId);
    const effective = display !== undefined && samePrincipal(display.identity, candidate.identity)
      ? effectiveRoleFromProof(task, candidate.explicit, display)
      : await effectiveRole(deps, task, people, candidate.identity.developerId, admission);
    if (candidate.explicit === undefined && effective !== "commenter") continue;
    const baseName = candidate.explicit?.name ?? candidate.identity.name;
    const slackUserId = candidate.identity.slackUserId;
    const twin = (slackUserId !== undefined && (sameSlack.get(slackUserId) ?? 0) > 1) || ((sameName.get(baseName)?.count ?? 0) > 1 && sameName.get(baseName)?.web === true);
    const suffix = twin ? taskPersonIdentitySuffix(candidate.identity.method) : "";
    const labeledName = suffix === "" ? baseName : `${redactAndCap(baseName, 80 - suffix.length).text}${suffix}`;
    rendered.push({
      personId: candidate.personId,
      name: safeName(labeledName, taskPersonNameFallback(candidate.identity)),
      role, you: candidate.identity.developerId === caller.developerId, effectiveRole: effective, method: candidate.identity.method,
    });
  }
  rendered.sort((left, right) => left.name.localeCompare(right.name) || left.personId.localeCompare(right.personId));
  const callerRole = await effectiveRole(deps, task, people, caller.developerId, admission);
  const takeoverProof = enabled(deps) && open(task) && people.orphaned && callerRole !== null
    ? await checked(deps, task, caller.developerId, admission)
    : undefined;
  const canTakeOwnership = takeoverProof !== undefined && taskPersonMayOwn(task, takeoverProof);
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
    // `method` (Q7 follow-up) is optional: an outcome stored before it existed has none and must still read.
    if (!isRecord(person) || !exactKeys(person, Object.hasOwn(person, "method") ? ["personId", "name", "role", "you", "effectiveRole", "method"] : ["personId", "name", "role", "you", "effectiveRole"])
      || (person.method !== undefined && (typeof person.method !== "string" || !(BUILT_IN_SIGN_IN_METHODS as readonly string[]).includes(person.method)))
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

/**
 * Web task channel (involved wiring): the person's "tasks I'm involved in" pointer, kept in the SAME transaction as the People change so the row and the list never disagree. A person who is an owner
 * after the change (added as owner, promoted, or taking ownership) gets the row `ORG#<company>#INVOLVED#<person>` / `TASK#<createdAt>#<taskId>`; any other role (commenter, viewer, denied) deletes it. The
 * list and the decision cards read only owners (the live owner rule), so only owners have rows. Core tasks only: the row is in the TASK'S company (`companyId` of its record; a task without one is a
 * legacy task and has no involved list), and never for the task's own person (their own list has it). The row is a pointer and grants nothing; the reader re-checks the live task and access.
 */
function involvedStep(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, developerId: string, role: StoredTaskRole): TransactItem | undefined {
  const companyId = (task as unknown as { companyId?: unknown }).companyId;
  if (typeof companyId !== "string" || developerId === task.developerId) return undefined;
  const row = { companyId, personId: developerId, taskId: task.taskId, createdAt: task.createdAt };
  try {
    if (role === "owner") return { Put: { TableName: deps.tableName, Item: involvedRowPut(row, new Date(deps.now()).toISOString()).item } };
    return { Delete: { TableName: deps.tableName, Key: involvedRowDelete(row).key } };
  } catch {
    // A task whose company or creation time is not a valid id has no involved row; the list is a convenience and the People change itself stands.
    return undefined;
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
  /** `via`: how the person became an owner, for a take-over (the step owner's choice reads it: the owner who took over most recently). `slot`: the workspace slot moves to them in this transaction. */
  takeover?: { via: "take_over"; slot: SlotMove | undefined },
): Promise<TaskPeopleView> {
  const outcome = await viewOf(deps, task, next, caller);
  const createdAt = new Date(deps.now()).toISOString();
  const request = { ...requestKey(task.taskId, requestId), entityType: "TASK_PEOPLE_REQUEST", schemaVersion: 1, requestId, actorDeveloperId: caller.developerId, kind, payload, outcome, createdAt };
  const event = { ...eventKey(task.taskId, requestId), entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId, actorDeveloperId: caller.developerId, targetDeveloperId, beforeRole, afterRole, createdAt, ...(takeover === undefined ? {} : { via: takeover.via }) };
  if (!Number.isSafeInteger(task.workflow?.revision) || typeof task.workflow?.stage !== "string") return denied();
  const involved = involvedStep(deps, task, targetDeveloperId, afterRole);
  const items: TransactItem[] = withSlot([
    { Update: {
      TableName: deps.tableName, Key: peopleKey(task.taskId),
      UpdateExpression: "SET #revision = :nextRevision, #orphaned = :orphaned, #people = :people",
      ConditionExpression: "#revision = :expectedRevision",
      ExpressionAttributeNames: { "#revision": "revision", "#orphaned": "orphaned", "#people": "people" },
      ExpressionAttributeValues: { ":nextRevision": next.revision, ":orphaned": next.orphaned, ":people": next.people, ":expectedRevision": current.revision },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      // C3: a change proved on an unshared task (no channel) is written only while the task is still unshared.
      ConditionExpression: "#developerId = :developerId AND workflow.#revision = :taskRevision AND workflow.#stage = :taskStage AND attribute_not_exists(closedAt)"
        + (task.share === undefined ? " AND attribute_not_exists(#share)" : ""),
      ExpressionAttributeNames: { "#developerId": "developerId", "#revision": "revision", "#stage": "stage", ...(task.share === undefined ? { "#share": "share" } : {}) },
      ExpressionAttributeValues: { ":developerId": task.developerId, ":taskRevision": task.workflow.revision, ":taskStage": task.workflow.stage },
    } },
    { Put: { TableName: deps.tableName, Item: event, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: request, ConditionExpression: "attribute_not_exists(pk)" } },
    ...(involved === undefined ? [] : [involved]),
    ...(notification === undefined ? [] : [{ Put: { TableName: deps.tableName, Item: {
      pk: taskPk(task.taskId), sk: `PEOPLE_NOTIFY#${requestId}`, entityType: "TASK_PEOPLE_NOTIFICATION", schemaVersion: 1,
      taskId: task.taskId, requestId, targetDeveloperId, slackUserId: notification.slackUserId, role: notification.role,
      peopleRevision: next.revision, status: "PENDING", attempts: 0, createdAt,
    }, ConditionExpression: "attribute_not_exists(pk)" } }]),
  ], task, takeover?.slot);
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
): Promise<{ role: TaskRole; peopleRevision: number; ownerActorIds: readonly string[]; orphaned: boolean; canTakeOwnership: boolean; implicit: boolean } | undefined> {
  const stored = await loadPeople(deps, task.taskId);
  if (stored === undefined) return undefined;
  const people = await reconcile(deps, task, stored);
  const role = await effectiveRole(deps, task, people, developerId);
  if (role === null) return denied();
  const owners = people.people.filter((person) => person.role === "owner").map((person) => taskOwnerKey(person.developerId, task.taskId));
  const proof = people.orphaned ? await checked(deps, task, developerId) : undefined;
  return {
    role, peopleRevision: people.revision, ownerActorIds: owners, orphaned: people.orphaned,
    // A person the list does not name who reads only because the task is shared into a Slack channel they are in (`implicitRole`): the Slack share's own grant.
    implicit: !people.people.some((person) => person.developerId === developerId),
    canTakeOwnership: people.orphaned && role !== null && proof !== undefined && taskPersonMayOwn(task, proof),
  };
}

/**
 * The developer ids of the task's CURRENT owners (role `owner` in the stored People list), or undefined when the task has no list (People was never opened on it: the creator is its only owner). A list that cannot be
 * read throws, as every People read does. The stored list is read as it is: it is not re-proved against the live directory, so it can only name more owners than a live read would (never fewer).
 */
export async function taskOwnerDevelopers(deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName">, taskId: string): Promise<string[] | undefined> {
  const people = await loadPeople(deps, taskId);
  return people?.people.filter((person) => person.role === "owner").map((person) => person.developerId);
}

/** The no-checker exception is confined to the hosted creator's unchanged, sole-owner list. */
function hostedCreatorOnly(task: DeveloperTaskRecord, people: TaskPeople): boolean {
  const creator = people.people[0];
  return isHostedTaskProvider(task.provider) && people.people.length === 1
    && creator?.role === "owner" && creator.developerId === task.developerId;
}

/**
 * Fresh effective owners for a system successor/final delivery. Missing PEOPLE preserves legacy
 * work. Definite proof loss is ownerless; proof transport or malformed proof remains UNKNOWN and
 * must be parked by the caller without rewriting the sidecar. With no checker, DEC 254zzz393
 * preserves hosted creator-only dispatch, bound to this revision and the creator actor key.
 */
export async function resolveTaskDispatchPeople(
  deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName" | "checkTaskPerson">,
  task: DeveloperTaskRecord,
): Promise<{ peopleRevision: number; ownerActorIds: readonly string[]; status: "ALLOWED" | "OWNERLESS" | "UNKNOWN" } | undefined> {
  const found = await resolveTaskListOwners(deps, task);
  if (found === undefined) return undefined;
  return { peopleRevision: found.peopleRevision, ownerActorIds: found.ownerIds.map((developerId) => taskOwnerKey(developerId, task.taskId)), status: found.status };
}

/**
 * The same proof as `resolveTaskDispatchPeople`, naming the owners by developer id, in the list's order: each `owner` entry of the stored list is proved live now (never taken from its stored role), and the ones
 * that pass are returned. Undefined: the task has no People list. A step runs for one of these people (`hostedTaskAccess.checkStep`).
 */
export async function resolveTaskListOwners(
  deps: Pick<TaskPeopleDependencies, "documentClient" | "tableName" | "checkTaskPerson">,
  task: DeveloperTaskRecord,
): Promise<{ peopleRevision: number; ownerIds: readonly string[]; /** Each owner's name as the list keeps it. */ names: ReadonlyMap<string, string>; /** Every entry the stored list calls an owner, proved or not (a press by one of them who no longer passes is refused). */ listed: readonly string[]; /** The owners whose proof could not be READ (a throw), told apart from the ones it refused. */ unread: readonly string[]; status: "ALLOWED" | "OWNERLESS" | "UNKNOWN" } | undefined> {
  const people = await loadPeople(deps, task.taskId);
  if (people === undefined) return undefined;
  const names = new Map(people.people.map((person) => [person.developerId, person.name]));
  const listed = people.people.filter((person) => person.role === "owner").map((person) => person.developerId);
  if (people.orphaned) return { peopleRevision: people.revision, ownerIds: [], names, listed, unread: [], status: "OWNERLESS" };
  if (deps.checkTaskPerson === undefined) {
    if (hostedCreatorOnly(task, people)) return { peopleRevision: people.revision, ownerIds: [task.developerId], names, listed, unread: [], status: "ALLOWED" };
    return { peopleRevision: people.revision, ownerIds: [], names, listed, unread: [], status: "UNKNOWN" };
  }
  const owners: string[] = [];
  const unread: string[] = [];
  for (const person of people.people) {
    if (person.role !== "owner") continue;
    try {
      const proof = await checkedFresh(deps, task, person.developerId);
      if (taskPersonMayOwn(task, proof)) owners.push(person.developerId);
    } catch {
      unread.push(person.developerId);
    }
  }
  const unknown = unread.length > 0;
  if (owners.length > 0) return { peopleRevision: people.revision, ownerIds: owners, names, listed, unread, status: "ALLOWED" };
  return { peopleRevision: people.revision, ownerIds: [], names, listed, unread, status: unknown ? "UNKNOWN" : "OWNERLESS" };
}

/** Only a task's own reader gets their specific proof refusal on the People view. Shared access checks always mask it. */
async function checkHostedPeopleViewCaller(deps: TaskPeopleDependencies, task: DeveloperTaskRecord, caller: DeveloperCaller,
  admission?: TaskPeopleDisplayAdmission): Promise<void> {
  if (!isHostedTaskProvider(task.provider)) return;
  const people = await loadPeople(deps, task.taskId);
  const entry = people?.people.find(person => person.developerId === caller.developerId);
  if (people === undefined ? caller.developerId !== task.developerId : entry === undefined || entry.role === "denied") return;
  try { await checkedFresh(deps, task, caller.developerId, admission); } catch (error) {
    if (error instanceof AgentXError) throw error;
    return denied();
  }
}

export async function getTaskPeople(deps: TaskPeopleDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView> {
  const optional = deps.createTaskPeopleDisplayAdmission?.();
  if (optional === undefined) return getUnsharedTaskPeople(deps, caller, taskId);
  const admission = optional;
  try {
    admission.assertOpen();
    const task = await loadTask(deps, taskId);
    admission.assertOpen();
    await checkHostedPeopleViewCaller(deps, task, caller, admission);
    const people = await currentPeopleForCaller(deps, task, caller, false, admission);
    await authorizedRead(deps, task, people, caller, admission);
    // C3: a task with no Slack share has no channel directory to list; its People are exactly its registered people, each proved on its own path.
    if (task.share !== undefined && deps.listTaskPeople === undefined) return unavailable();
    const displayChecks = task.share === undefined ? [] : await deps.listTaskPeople!(task, admission);
    admission.assertOpen();
    const view = await viewOf(deps, task, people, caller, displayChecks, admission);
    admission.assertOpen();
    return view;
  } finally {
    admission.close();
  }
}

/**
 * C3: the People view of a task with no Slack share on an install with no Slack display reads (no display admission). A Slack-shared task still
 * needs the admission and its complete channel directory, exactly as before.
 */
async function getUnsharedTaskPeople(deps: TaskPeopleDependencies, caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView> {
  // Hosted tasks preserve the proof/authorization refusal. Legacy/no-task display capability keeps its existing answer.
  let task: DeveloperTaskRecord | undefined;
  try {
    task = await loadTask(deps, taskId);
    if (task.share !== undefined) return unavailable();
    await checkHostedPeopleViewCaller(deps, task, caller);
    const people = await currentPeopleForCaller(deps, task, caller, false);
    await authorizedRead(deps, task, people, caller);
    return await viewOf(deps, task, people, caller, []);
  } catch (error) {
    if (isHostedTaskProvider(task?.provider)) throw error;
    return unavailable();
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
    canTakeOwnership = taskPersonMayOwn(task, proof);
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
    || (input.role === "owner" && !taskPersonPresent(proof))) return denied();
  if (input.role === "owner") refuseChannelOnlyOwner(task, proof);
  const existing = people.people.find((person) => person.developerId === input.targetDeveloperId);
  const beforeRole = existing?.role ?? implicitRole(task, proof);
  if (existing?.role === input.role) throw agentXError("CONFIG_INVALID", "that person already has this task role");
  if (existing?.role === "owner" && input.role !== "owner" && people.people.filter((person) => person.role === "owner").length === 1) {
    throw agentXError("CONFIG_INVALID", "a task must retain an effective owner");
  }
  const entry: PersonEntry = taskPeopleEntryOf({ ...mapping.identity, name: proof.identity.name }, input.role);
  const nextEntries = existing === undefined ? [...people.people, entry] : people.people.map((person) => person.developerId === input.targetDeveloperId ? entry : person);
  const next: TaskPeople = { schemaVersion: 1, revision: people.revision + 1, orphaned: !nextEntries.some((person) => person.role === "owner"), people: nextEntries };
  preflight([{ Put: { TableName: deps.tableName, Item: { ...peopleKey(taskId), ...next } } }]);
  return commitMutation(deps, task, caller, people, next, input.requestId, "change", payload, beforeRole, input.role, input.targetDeveloperId,
    !proof.channelMember && input.role !== "denied" && proof.identity.slackUserId !== undefined ? { slackUserId: proof.identity.slackUserId, role: input.role } : undefined);
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
  if (!proof.eligible || !taskPersonPresent(proof) || !samePrincipal(mapping.identity, proof.identity)) return denied();
  refuseChannelOnlyOwner(task, proof);
  const existing = people.people.find((person) => person.developerId === caller.developerId);
  if (existing?.role === "denied") return denied();
  const beforeRole = existing?.role ?? "commenter";
  const owner: PersonEntry = taskPeopleEntryOf({ ...mapping.identity, name: proof.identity.name }, "owner");
  const nextEntries = existing === undefined ? [...people.people, owner] : people.people.map((person) => person.developerId === caller.developerId ? owner : person);
  const next: TaskPeople = { schemaVersion: 1, revision: people.revision + 1, orphaned: false, people: nextEntries };
  return commitMutation(deps, task, caller, people, next, input.requestId, "takeOwnership", payload, beforeRole, "owner", caller.developerId, undefined,
    { via: "take_over", slot: await slotMovePlan(deps, task, caller.developerId) });
}

/** C4: the task People reads and writes are about, read strongly (the add and candidates routes load it after the owner check). */
export const loadTaskPeopleTask = (deps: TaskPeopleDependencies, taskId: string): Promise<DeveloperTaskRecord> => loadTask(deps, taskId);

/** DEC 254zzz84 (5): why one of a removed person's open tasks is not handed over (it then waits for someone with access to take it over, as any task that lost its owner). */
export type TaskHandOverSkip = "people_off" | "no_people_list" | "not_their_task" | "successor_cannot_own";

/**
 * Member removal with hand-over (DEC 254zzz84 (5)): the steps that make `successorId` an owner of an open task the removed person owns, for the removal's own
 * transaction (company-member-handover.ts adds them to its single commit). The removed person's entry becomes `denied` (a removed person is no longer
 * eligible; reconcile would demote them the same way) and the successor's an owner, under the People revision read here, the task's META as read here and
 * its open state. The successor must already be registered on the task and pass their proof NOW (eligible and present: a live member of the task's company
 * with a live grant on its project): a task they cannot own is skipped with a reason, never handed to someone who could not open it. Read-only until committed.
 */
export async function taskOwnershipHandOverSteps(
  deps: TaskPeopleDependencies,
  task: DeveloperTaskRecord,
  input: { leaverId: string; successorId: string; removalId: string; by: string; preview?: boolean },
): Promise<{ items: TransactItem[]; steps: number; slot: SlotMove | undefined } | { skipped: TaskHandOverSkip }> {
  if (!HEX64.test(input.leaverId) || !HEX64.test(input.successorId) || !HEX64.test(input.by) || !REQUEST_ID.test(input.removalId) || input.leaverId === input.successorId) return denied();
  if (!enabled(deps) || !open(task) || !Number.isSafeInteger(task.workflow?.revision) || typeof task.workflow?.stage !== "string") return { skipped: "people_off" };
  // A People list or a person row that does not read is skipped, never a reason to keep a removed person in the company.
  let people: TaskPeople | undefined;
  try { people = await loadPeople(deps, task.taskId); } catch { people = undefined; }
  if (people === undefined) return { skipped: "no_people_list" };
  const leaver = people.people.find((person) => person.developerId === input.leaverId);
  if (leaver?.role !== "owner") return { skipped: "not_their_task" };
  let mapping: { personId: string; identity: TaskPersonIdentity } | undefined;
  try { mapping = await personByDeveloper(deps, task.taskId, input.successorId); } catch { mapping = undefined; }
  let proof: TaskPersonCheck;
  try { proof = await checkedFresh(deps, task, input.successorId); } catch { return { skipped: "successor_cannot_own" }; }
  if (!taskPersonMayOwn(task, proof) || (mapping !== undefined && !samePrincipal(mapping.identity, proof.identity))) return { skipped: "successor_cannot_own" };
  const before = people.people.find((person) => person.developerId === input.successorId);
  if (before?.role === "denied") return { skipped: "successor_cannot_own" };
  // The preview writes nothing: a successor who passes the proof now is registered on the task when the removal is made. It still counts the steps the
  // commit will write (People, META check, event, and each involved row), so the size check made BEFORE anyone is removed holds for the commit too.
  // The workspace slot the leaver held moves to the successor in the same transaction (slotMovePlan), so the preview counts its steps too.
  const slot = await slotMovePlan(deps, task, input.successorId, input.leaverId);
  if (input.preview === true) {
    const involved = [input.successorId, input.leaverId].filter((developerId) => involvedStep(deps, task, developerId, developerId === input.successorId ? "owner" : "denied") !== undefined).length;
    return { items: [], steps: 3 + involved + slotMarkerSteps(slot), slot };
  }
  if (mapping === undefined) return { skipped: "successor_cannot_own" };
  const owner: PersonEntry = taskPeopleEntryOf({ ...mapping.identity, name: proof.identity.name }, "owner");
  const entries = people.people.map((person) => person.developerId === input.leaverId ? { ...person, role: "denied" as const } : person.developerId === input.successorId ? owner : person);
  const nextEntries = before === undefined ? [...entries, owner] : entries;
  const next: TaskPeople = { schemaVersion: 1, revision: people.revision + 1, orphaned: false, people: nextEntries };
  const createdAt = new Date(deps.now()).toISOString();
  const event = { ...eventKey(task.taskId, input.removalId), entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, requestId: input.removalId, actorDeveloperId: input.by,
    targetDeveloperId: input.successorId, beforeRole: before?.role ?? implicitRole(task, proof), afterRole: "owner", createdAt, via: "hand_over" };
  const items: TransactItem[] = [
    { Update: {
      TableName: deps.tableName, Key: peopleKey(task.taskId),
      UpdateExpression: "SET #revision = :nextRevision, #orphaned = :orphaned, #people = :people",
      ConditionExpression: "#revision = :expectedRevision",
      ExpressionAttributeNames: { "#revision": "revision", "#orphaned": "orphaned", "#people": "people" },
      ExpressionAttributeValues: { ":nextRevision": next.revision, ":orphaned": next.orphaned, ":people": next.people, ":expectedRevision": people.revision },
    } },
    { ConditionCheck: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      ConditionExpression: "#developerId = :developerId AND workflow.#revision = :taskRevision AND workflow.#stage = :taskStage AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#developerId": "developerId", "#revision": "revision", "#stage": "stage" },
      ExpressionAttributeValues: { ":developerId": task.developerId, ":taskRevision": task.workflow.revision, ":taskStage": task.workflow.stage },
    } },
    { Put: { TableName: deps.tableName, Item: event, ConditionExpression: "attribute_not_exists(pk)" } },
  ];
  for (const [developerId, role] of [[input.successorId, "owner"], [input.leaverId, "denied"]] as const) {
    const row = involvedStep(deps, task, developerId, role);
    if (row !== undefined) items.push(row);
  }
  // The two counters' steps are the caller's (one transaction moves all of a person's tasks: `slotCounterSteps` once, by the number of tasks).
  const moved = withSlot(items, task, slot, false);
  preflight([{ Put: { TableName: deps.tableName, Item: { ...peopleKey(task.taskId), ...next } } }, ...moved]);
  return { items: moved, steps: moved.length, slot };
}

/** Get-only authority for a stable, already initialized People list. Never reconciles. */
export async function resolveTaskPeopleReadAccess(
  deps: { get(key: { pk: string; sk: string }): Promise<unknown>; checkTaskPerson: CheckTaskPerson },
  task: DeveloperTaskRecord,
  developerId: string,
): Promise<{ role: TaskRole; people: TaskPeople; proofs: TaskPersonCheck[] }> {
  const raw = await deps.get(peopleKey(task.taskId));
  const people = parsePeople(raw);
  if (people === undefined || !isRecord(raw) || raw.pk !== taskPk(task.taskId)) return unavailable();
  const owners = people.people.filter(person => person.role === "owner");
  if (people.orphaned) return denied();
  if (owners.length === 0) return unavailable();
  const proofs: TaskPersonCheck[] = [];
  for (const owner of owners) {
    const proof = await checkedFresh(deps, task, owner.developerId);
    proofs.push(proof);
    if (taskPersonKindOf(proof.identity) !== "web") return unavailable();
    if (!proof.eligible || !taskPersonPresent(proof)) return unavailable();
  }
  const proof = await checkedFresh(deps, task, developerId);
  if (taskPersonKindOf(proof.identity) !== "web") return unavailable();
  const explicit = people.people.find(person => person.developerId === developerId);
  const role = effectiveRoleFromProof(task, explicit, proof);
  if (role === null || !taskPersonPresent(proof)) return denied();
  if (!isDeepStrictEqual(raw, await deps.get(peopleKey(task.taskId)))) return unavailable();
  return { role, people, proofs: [...proofs, proof] };
}
