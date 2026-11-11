// The intake records, on the document store port. One item per ticket per project (the key is the ticket's `externalRef`, hashed), so the same ticket is the same item however often a poll or a
// delivery hands it over. Every change is a conditional write, so two polls, two deliveries or two presses of "Start" at once cannot both start the ticket:
//
//   (new) --claim--> waiting --claimStart--> starting --markStarted--> started
//     \--claim as starting-----^                |
//                                               +--giveBack--> waiting   (a start that was refused or could not be made)
//
// `starting` carries a lease: a start that died half way is taken over once its lease ran out, and the start itself is idempotent (its request id is fixed per ticket and member).
// The title is a person's words; it is kept only inert and cut, and read back as text. The key layout is Cloud's (`intakeItemKey` and friends), so one set of rows serves both.
import {
  INDEX_EXPIRY_ATTRIBUTE, INTAKE_MAX_WAITING_PER_PROJECT, change, intakeChangeKey, intakeEventKey, intakeItemKey, when,
  type DocumentKey, type DocumentStore, type IntakeStanding, type IntakeTrackerChannel, type IntakeWaitReason, type OrgId, type StoredDocument, type UpdateOp,
} from "@agentx/contracts";

export interface IntakeTable {
  store: Pick<DocumentStore, "get" | "put" | "update" | "delete" | "query" | "transact">;
  now: () => number;
}

/** `dismissed`: a member said "Not this one". The item stays (without the ticket's words) until it expires, so a poll that sees the ticket again does not ask again. */
export type StoredIntakeState = "waiting" | "starting" | "started" | "dismissed";

/** Whether a ticket's item may be started now: it waits, or a start began and its lease ran out (the process died), which another may take over. */
export const intakeItemIsTakeable = (record: Pick<IntakeItemRecord, "state" | "leaseUntil">, now: number): boolean =>
  record.state === "waiting" || (record.state === "starting" && (record.leaseUntil ?? 0) < now);

export interface IntakeItemRecord {
  orgId: OrgId;
  project: string;
  itemId: string;
  channel: IntakeTrackerChannel;
  system: string;
  id: string;
  url: string;
  title: string;
  /** The ticket's body while it waits (redacted, inert, cut): so the member who says "Start" starts it with the text that was handed over. Gone once it starts. */
  body?: string;
  /** Who wrote the ticket, as the tracker names them (inert, cut): said to the session beside the text, never checked. */
  writer?: string;
  requester: { display: string; standing: IntakeStanding; developerId?: string };
  state: StoredIntakeState;
  reason?: IntakeWaitReason;
  lastRefusal?: string;
  since: string;
  updatedAt: string;
  /** Epoch milliseconds the `starting` lease runs to. */
  leaseUntil?: number;
  startedBy?: string;
  taskId?: string;
  sessionId?: string;
  /** 1 for the ticket's first task; each time the ticket is asked for again after its task ended it is one more (it is part of the start's request id). */
  generation?: number;
  /** The task and session this generation follows (ids only). */
  previousTaskId?: string;
  previousSessionId?: string;
}

/** How long a start may take before another may take it over. A start takes seconds. */
export const INTAKE_START_LEASE_MS = 120_000;
/** A waiting item is forgotten after this long; a ticket that is still asking is handed over again and waits again. */
export const INTAKE_WAITING_KEPT_DAYS = 30;
/** A started item is kept this long, far past any poll's memory, so a ticket that still carries its label is not started a second time. */
export const INTAKE_STARTED_KEPT_DAYS = 400;
/** The most waiting items a project holds (`INTAKE_MAX_WAITING_PER_PROJECT`); more are not stored (the owner is told once). It bounds what a flood of outsiders' tickets can cost. */
export { INTAKE_MAX_WAITING_PER_PROJECT };

const DAY_SECONDS = 86_400;
const iso = (table: IntakeTable): string => new Date(table.now()).toISOString();
const expiryAfter = (table: IntakeTable, days: number): number => Math.floor(table.now() / 1000) + days * DAY_SECONDS;
/** Plain JSON of a record, for a write (a record may hold `undefined` keys, which the store refuses). */
const plain = <T extends object>(value: T): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;

/** A stored item read back: it must belong to the org and project it is read under, and be shaped as written; anything else is not an item. */
function recordOf(raw: StoredDocument | undefined, orgId: OrgId, project: string): IntakeItemRecord | undefined {
  if (raw === undefined || raw["orgId"] !== orgId || raw["project"] !== project || raw["entityType"] !== "INTAKE_ITEM") return undefined;
  const state = raw["state"];
  if (state !== "waiting" && state !== "starting" && state !== "started" && state !== "dismissed") return undefined;
  const requester = raw["requester"] as IntakeItemRecord["requester"] | undefined;
  if (typeof raw["itemId"] !== "string" || typeof raw["system"] !== "string" || typeof raw["id"] !== "string" || typeof raw["url"] !== "string" || requester === undefined) return undefined;
  const record: Record<string, unknown> = { ...raw };
  for (const attribute of ["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]) delete record[attribute];
  // A started ticket keeps no words of the ticket (see `markIntakeStarted`).
  return { title: "", ...record } as unknown as IntakeItemRecord;
}

export async function readIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string): Promise<IntakeItemRecord | undefined> {
  return recordOf(await table.store.get(intakeItemKey(orgId, project, itemId)), orgId, project);
}

export type NewIntakeItem = Pick<IntakeItemRecord, "orgId" | "project" | "itemId" | "channel" | "system" | "id" | "url" | "title" | "requester"> & { body?: string | undefined; writer?: string | undefined } & { state: "waiting" | "starting"; reason?: IntakeWaitReason | undefined; startedBy?: string | undefined };

/**
 * Writes a ticket's item if there is none. "created" when it wrote it; otherwise the item that is there (read again), so a caller learns whether the ticket is new and what became
 * of it. An item that is there but unreadable counts as "unreadable": the caller leaves it alone (fail closed).
 */
export async function claimIntakeItem(table: IntakeTable, input: NewIntakeItem): Promise<{ result: "created" } | { result: "exists"; record: IntakeItemRecord } | { result: "unreadable" }> {
  const at = iso(table);
  const key = intakeItemKey(input.orgId, input.project, input.itemId);
  const record: IntakeItemRecord = {
    orgId: input.orgId, project: input.project, itemId: input.itemId, channel: input.channel, system: input.system, id: input.id, url: input.url, title: input.title, requester: input.requester,
    ...(input.writer === undefined ? {} : { writer: input.writer }),
    state: input.state, since: at, updatedAt: at, generation: 1,
    ...(input.body !== undefined && input.body !== "" ? { body: input.body } : {}),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.state === "starting" ? { leaseUntil: table.now() + INTAKE_START_LEASE_MS, ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }) } : {}),
  };
  const written = await table.store.put({
    item: { ...key, entityType: "INTAKE_ITEM", ...plain(record), [INDEX_EXPIRY_ATTRIBUTE]: expiryAfter(table, input.state === "waiting" ? INTAKE_WAITING_KEPT_DAYS : INTAKE_STARTED_KEPT_DAYS) },
    condition: when.absent(),
  });
  if (written.applied) return { result: "created" };
  const existing = await readIntakeItem(table, input.orgId, input.project, input.itemId);
  return existing === undefined ? { result: "unreadable" } : { result: "exists", record: existing };
}

/** The condition every change to an existing item starts with: it is there, in this org and project. */
const isItem = (orgId: OrgId, project: string) => when.and(when.present(), when.eq("orgId", orgId), when.eq("project", project));

/**
 * Moves a waiting item to `starting`, or takes over a start whose lease ran out: one conditional update, so of two callers only one wins. false when the item is not waiting (and not an
 * abandoned start): somebody else has it, or it is started.
 */
export async function claimIntakeStart(table: IntakeTable, orgId: OrgId, project: string, itemId: string, startedBy: string): Promise<boolean> {
  const result = await table.store.update({
    key: intakeItemKey(orgId, project, itemId),
    ops: [
      change.set("state", "starting"), change.set("leaseUntil", table.now() + INTAKE_START_LEASE_MS), change.set("startedBy", startedBy), change.set("updatedAt", iso(table)),
      change.set(INDEX_EXPIRY_ATTRIBUTE, expiryAfter(table, INTAKE_STARTED_KEPT_DAYS)), change.remove("reason"),
    ],
    condition: when.and(isItem(orgId, project), when.or(when.eq("state", "waiting"), when.and(when.eq("state", "starting"), when.lt("leaseUntil", table.now())))),
  });
  return result.applied;
}

/**
 * The start made a session: `started`, with where it went. Only the start that holds the item (`holder` is the member whose lease it is) can say so; for any other the answer is false and nothing changes. The ticket's words (title, body, writer) and the requester's name are removed: a started ticket is kept for
 * a year only to remember that it was started, as ids and a state.
 */
export async function markIntakeStarted(table: IntakeTable, orgId: OrgId, project: string, itemId: string, started: { holder: string; taskId?: string | undefined; sessionId?: string | undefined; requester: IntakeItemRecord["requester"] }): Promise<boolean> {
  const ops: UpdateOp[] = [
    change.set("state", "started"), change.set("updatedAt", iso(table)), change.set("requester", plain({ ...started.requester, display: "" })),
    ...(started.taskId === undefined ? [] : [change.set("taskId", started.taskId)]), ...(started.sessionId === undefined ? [] : [change.set("sessionId", started.sessionId)]),
    ...["leaseUntil", "reason", "lastRefusal", "body", "title", "writer"].map((name) => change.remove(name)),
  ];
  // Not the holder any more (the lease was taken over, or the item is gone): the start that was made stands, and the item is the new holder's to finish.
  return (await table.store.update({ key: intakeItemKey(orgId, project, itemId), ops, condition: when.and(isItem(orgId, project), when.eq("state", "starting"), when.eq("startedBy", started.holder)) })).applied;
}

/** A start that was refused or could not be made: the item waits again (only for the holder of its lease: a start whose lease was taken over changes nothing) (with the reason, and the refusal's code if there was one), so a member can try again. */
export async function giveBackIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string, holder: string, reason: IntakeWaitReason, refusal?: string): Promise<void> {
  await table.store.update({
    key: intakeItemKey(orgId, project, itemId),
    ops: [
      change.set("state", "waiting"), change.set("reason", reason), change.set("updatedAt", iso(table)), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryAfter(table, INTAKE_WAITING_KEPT_DAYS)),
      ...(refusal === undefined ? [] : [change.set("lastRefusal", refusal)]), change.remove("leaseUntil"), change.remove("startedBy"),
    ],
    // The lease ran out and another start took the item over: it is theirs now (the condition fails, and nothing changes).
    condition: when.and(isItem(orgId, project), when.eq("state", "starting"), when.eq("startedBy", holder)),
  });
}

/** Forgets an item that was created only to be started and never was (the start could not be made at all), so the next hand-over begins afresh. */
export async function releaseIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string, holder: string): Promise<void> {
  await table.store.delete({ key: intakeItemKey(orgId, project, itemId), condition: when.and(isItem(orgId, project), when.eq("state", "starting"), when.eq("startedBy", holder)) });
}

/** The project's waiting items, oldest first, at most `limit` (the partition is bounded by `INTAKE_MAX_WAITING_PER_PROJECT` and the expiry of old items). */
export async function listWaitingIntakeItems(table: IntakeTable, orgId: OrgId, project: string, limit = INTAKE_MAX_WAITING_PER_PROJECT): Promise<IntakeItemRecord[]> {
  const key = intakeItemKey(orgId, project, "0".repeat(32));
  const found: IntakeItemRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await table.store.query({ pk: key.pk, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const raw of page.items) {
      const record = recordOf(raw, orgId, project);
      if (record !== undefined && record.state === "waiting") found.push(record);
    }
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== undefined && pages < 10);
  return found.sort((a, b) => a.since.localeCompare(b.since)).slice(0, limit);
}

/**
 * Takes a label event in: true the first time, false for an event already taken in (a delivery made again, a replay). It is given back with `releaseIntakeEvent` when the ticket could
 * not be handled for a fault that may pass, so the redelivery is handled. Kept for 30 days, far past the age window of an event.
 */
export async function claimIntakeEvent(table: IntakeTable, orgId: OrgId, project: string, itemId: string, eventId: string): Promise<boolean> {
  return (await table.store.put({
    item: { ...intakeEventKey(orgId, project, itemId, eventId), entityType: "INTAKE_EVENT", orgId, project, at: iso(table), [INDEX_EXPIRY_ATTRIBUTE]: expiryAfter(table, 30) },
    condition: when.absent(),
  })).applied;
}

export async function releaseIntakeEvent(table: IntakeTable, orgId: OrgId, project: string, itemId: string, eventId: string): Promise<void> {
  await table.store.delete({ key: intakeEventKey(orgId, project, itemId, eventId) }).catch(() => undefined);
}

/** One tracker act (a change's label or assignee) taken for the company, and the project and ticket that took it. */
export interface IntakeChangeClaim { orgId: OrgId; system: string; site: string; changeId: string; act: { kind: string; value: string }; project: string; itemId: string }

/** How long a tracker change stays claimed: far past the event age window (24 hours), so a replay that is still believed always finds it. */
export const INTAKE_CHANGE_KEPT_DAYS = 7;

/**
 * Takes a tracker's act (a Jira changelog id and what it did) in for the company, once, whichever project's source it came through. Called only AFTER the tracker confirmed the change is real, so a made-up
 * change id never uses one up. The item names the project and ticket that took it:
 *   - "claimed": first time; it is the caller's (given back with `releaseIntakeChange` if the ticket could not be handled for a fault that may pass).
 *   - "same": already taken by this same project and ticket (the same delivery again, or another label of one change on one ticket); the per-event claim after it keeps that idempotent.
 *   - "taken": taken by another project or ticket of the company: the caller must not start work as the person (it waits).
 */
export async function claimIntakeChange(table: IntakeTable, input: IntakeChangeClaim): Promise<"claimed" | "same" | "taken"> {
  const key = intakeChangeKey(input.orgId, input.system, input.site, input.changeId, input.act);
  // Twice at most: a claim given back between our failed write and our read leaves nothing to read, and the write is then made again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const written = await table.store.put({
      item: { ...key, entityType: "INTAKE_CHANGE", orgId: input.orgId, project: input.project, itemId: input.itemId, at: iso(table), [INDEX_EXPIRY_ATTRIBUTE]: expiryAfter(table, INTAKE_CHANGE_KEPT_DAYS) },
      condition: when.absent(),
    });
    if (written.applied) return "claimed";
    const there = await table.store.get(key);
    if (there !== undefined) return there["orgId"] === input.orgId && there["project"] === input.project && there["itemId"] === input.itemId ? "same" : "taken";
  }
  return "taken";
}

/** Gives a change back when the ticket could not be handled for a fault that may pass, so the redelivery is handled. Only the project and ticket that took it can give it back. */
export async function releaseIntakeChange(table: IntakeTable, input: IntakeChangeClaim): Promise<void> {
  await table.store.delete({
    key: intakeChangeKey(input.orgId, input.system, input.site, input.changeId, input.act),
    condition: when.and(when.eq("orgId", input.orgId), when.eq("project", input.project), when.eq("itemId", input.itemId)),
  }).catch(() => undefined);
}

/**
 * A ticket whose task ended is asked for again (a new label event): the item of generation `generation` (which must still be `started`) becomes the next generation, either `starting`
 * under `holder`'s lease (a member's act) or `waiting` (anyone else's), with the new words and the ids of the task it follows. One conditional update, so of two re-labels only one wins.
 */
export async function reopenIntakeItem(
  table: IntakeTable,
  input: {
    orgId: OrgId; project: string; itemId: string; generation: number; to: "waiting" | "starting"; holder?: string | undefined; reason?: IntakeWaitReason | undefined;
    title: string; body?: string | undefined; writer: string; requester: IntakeItemRecord["requester"]; previousSessionId?: string | undefined; previousTaskId?: string | undefined;
  },
): Promise<boolean> {
  const waiting = input.to === "waiting";
  const ops: UpdateOp[] = [
    change.set("state", input.to), change.set("generation", input.generation + 1), change.set("title", input.title), change.set("writer", input.writer), change.set("requester", plain(input.requester)),
    change.set("updatedAt", iso(table)), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryAfter(table, waiting ? INTAKE_WAITING_KEPT_DAYS : INTAKE_STARTED_KEPT_DAYS)),
    change.remove("lastRefusal"), change.remove("taskId"), change.remove("sessionId"),
    ...(input.body !== undefined && input.body !== "" ? [change.set("body", input.body)] : [change.remove("body")]),
    ...(input.previousSessionId === undefined ? [] : [change.set("previousSessionId", input.previousSessionId)]),
    ...(input.previousTaskId === undefined ? [] : [change.set("previousTaskId", input.previousTaskId)]),
    ...(waiting
      ? [change.set("reason", input.reason ?? "outsider"), change.remove("leaseUntil"), change.remove("startedBy")]
      : [change.set("leaseUntil", table.now() + INTAKE_START_LEASE_MS), change.set("startedBy", input.holder ?? ""), change.remove("reason")]),
  ];
  return (await table.store.update({ key: intakeItemKey(input.orgId, input.project, input.itemId), ops, condition: when.and(isItem(input.orgId, input.project), when.eq("state", "started"), when.eq("generation", input.generation)) })).applied;
}

/**
 * How long a dismissed ticket is remembered: as long as a started one. A ticket that only waited because Rovara had just changed it (a real act of the owner's, not told from its echo) must not start by
 * itself once the row is forgotten, so the owner's "Not this one" lasts as long as a start does.
 */
export const INTAKE_DISMISSED_KEPT_DAYS = INTAKE_STARTED_KEPT_DAYS;

/**
 * A member says "Not this one" for a waiting ticket: one conditional update from `waiting` to `dismissed`, which drops the ticket's words (title, body, writer, the requester's name) and keeps ids,
 * who dismissed it and when. false when the ticket does not wait (it was started, is being started, or was dismissed already).
 */
export async function dismissIntakeItem(table: IntakeTable, orgId: OrgId, project: string, itemId: string, by: string): Promise<boolean> {
  return (await table.store.update({
    key: intakeItemKey(orgId, project, itemId),
    ops: [
      change.set("state", "dismissed"), change.set("dismissedBy", by), change.set("updatedAt", iso(table)), change.set(INDEX_EXPIRY_ATTRIBUTE, expiryAfter(table, INTAKE_DISMISSED_KEPT_DAYS)),
      change.set("requester", { display: "", standing: "outsider" }), ...["title", "body", "writer", "reason", "lastRefusal"].map((name) => change.remove(name)),
    ],
    condition: when.and(isItem(orgId, project), when.eq("state", "waiting")),
  })).applied;
}

export type { DocumentKey };
