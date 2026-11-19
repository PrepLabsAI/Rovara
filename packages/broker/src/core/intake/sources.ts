// The places a project's work is asked for that are READ ON A TIMER (a tracker with no webhook of ours: on a laptop, every tracker). This is the project's intake rule. One record per source, in a global
// partition (`intakeSourceKey`) so the poll finds every due source with one query. The owner sets the sources of a project; the poll keeps its own state on the record (when it is next due, how many
// reads in a row failed, when it last told the owner). The record names a connection by name only: never an address, never a secret. The key layout is Cloud's.
import { createHash } from "node:crypto";
import {
  agentXError, change, IntakeChannelRefSchema, intakeSourceCountKey, intakeSourceKey, intakeSystemOf, when,
  type IntakeChannelRef, type OrgId, type StoredDocument, type TransactItem,
} from "@agentx/contracts";
import type { IntakeTable } from "./store.js";

export interface IntakeSourceRecord {
  orgId: OrgId;
  project: string;
  sourceId: string;
  ref: IntakeChannelRef;
  /** The member who set it. */
  setBy: string;
  createdAt: string;
  updatedAt: string;
  /** Epoch ms the source is next due. */
  nextPollAt: number;
  /** Reads in a row that failed (0 when the last one worked). */
  failures: number;
  /** Epoch ms the current run of failures began. */
  failingSince?: number;
  /** The code of the last failure (a code, never the error's words). */
  lastError?: string;
  lastPolledAt?: number;
  /** Epoch ms the owner was last told this source is failing. */
  noticedAt?: number;
}

/** The most sources one project has. */
export const INTAKE_MAX_SOURCES_PER_PROJECT = 8;

/** The one partition every source is in. */
export const INTAKE_SOURCES_PK = "INTAKE_SOURCES";

/** A source's id: the same channel, system and connection is the same source. */
export function intakeSourceIdOf(ref: IntakeChannelRef): string {
  return createHash("sha256").update(`${ref.channel}\0${intakeSystemOf(ref)}\0${ref.connection ?? ""}`).digest("hex").slice(0, 24);
}

/** Plain JSON of a record, for a write (the store refuses `undefined`). */
const plain = (value: object): StoredDocument => JSON.parse(JSON.stringify(value)) as StoredDocument;

/** A stored source read back; undefined for an item that is not one (a ref that no longer parses, or a key that is not the record's own: fail closed). */
function sourceOf(raw: StoredDocument | undefined): IntakeSourceRecord | undefined {
  if (raw === undefined || raw["entityType"] !== "INTAKE_SOURCE" || typeof raw["orgId"] !== "string" || typeof raw["project"] !== "string" || typeof raw["sourceId"] !== "string") return undefined;
  const ref = IntakeChannelRefSchema.safeParse(raw["ref"]);
  if (!ref.success || typeof raw["nextPollAt"] !== "number") return undefined;
  const key = intakeSourceKey(raw["orgId"], raw["project"], raw["sourceId"]);
  if (raw["pk"] !== key.pk || raw["sk"] !== key.sk) return undefined;
  const rest: Record<string, unknown> = { ...raw };
  for (const attribute of ["pk", "sk", "entityType"]) delete rest[attribute];
  return { ...(rest as unknown as IntakeSourceRecord), ref: ref.data };
}

export async function readIntakeSource(table: IntakeTable, orgId: OrgId, project: string, sourceId: string): Promise<IntakeSourceRecord | undefined> {
  return sourceOf(await table.store.get(intakeSourceKey(orgId, project, sourceId)));
}

async function listBy(table: IntakeTable, prefix: string, pages: number): Promise<IntakeSourceRecord[]> {
  const found: IntakeSourceRecord[] = [];
  let cursor: string | undefined;
  let read = 0;
  do {
    const page = await table.store.query({ pk: INTAKE_SOURCES_PK, ...(prefix === "" ? {} : { sk: { op: "beginsWith" as const, prefix } }), limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const raw of page.items) {
      const record = sourceOf(raw);
      if (record !== undefined) found.push(record);
    }
    cursor = page.cursor;
    read += 1;
  } while (cursor !== undefined && read < pages);
  return found;
}

/** A project's sources. */
export async function listIntakeSources(table: IntakeTable, orgId: OrgId, project: string): Promise<IntakeSourceRecord[]> {
  return (await listBy(table, `${orgId}#${project}#`, 2)).filter((record) => record.orgId === orgId && record.project === project);
}

/** Every source of every company, at most `pages` pages of 100, for the poll. A source beyond that is read by the next tick (the order is the key's, and a due source is polled first). */
export async function listAllIntakeSources(table: IntakeTable, pages = 10): Promise<IntakeSourceRecord[]> {
  return listBy(table, "", pages);
}

/**
 * Replaces a project's sources with `refs`: a source already there keeps its poll state (a change of settings does not make it due at once or forget its failures), a new one is due
 * now, and one that is not named any more is deleted. At most `INTAKE_MAX_SOURCES_PER_PROJECT`, each a different channel, system and connection.
 */
export async function replaceIntakeSources(table: IntakeTable, input: { orgId: OrgId; project: string; refs: readonly IntakeChannelRef[]; setBy: string }): Promise<IntakeSourceRecord[]> {
  const refs = input.refs.map((ref) => IntakeChannelRefSchema.parse(ref));
  if (refs.length > INTAKE_MAX_SOURCES_PER_PROJECT) throw new Error("too many intake sources");
  const wanted = new Map(refs.map((ref) => [intakeSourceIdOf(ref), ref] as const));
  if (wanted.size !== refs.length) throw new Error("an intake source is named twice");
  const countKey = intakeSourceCountKey(input.orgId, input.project);
  // One transaction writes the whole set and the count kept beside it, conditional on the count being what was read: a source added at the same moment (which raises the count) makes this one read
  // again, so the count cannot drift from the sources.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = table.now();
    const at = new Date(now).toISOString();
    const have = new Map((await listIntakeSources(table, input.orgId, input.project)).map((record) => [record.sourceId, record] as const));
    const counted = await table.store.get(countKey);
    const items: TransactItem[] = [];
    const result: IntakeSourceRecord[] = [];
    for (const [sourceId, ref] of wanted) {
      const key = intakeSourceKey(input.orgId, input.project, sourceId);
      const current = have.get(sourceId);
      if (current === undefined) {
        const record: IntakeSourceRecord = { orgId: input.orgId, project: input.project, sourceId, ref, setBy: input.setBy, createdAt: at, updatedAt: at, nextPollAt: now, failures: 0 };
        items.push({ kind: "put", item: { ...key, entityType: "INTAKE_SOURCE", ...plain(record) }, condition: when.absent() });
        result.push(record);
      } else {
        items.push({ kind: "update", key, ops: [change.set("ref", plain(ref)), change.set("setBy", input.setBy), change.set("updatedAt", at)], condition: when.present() });
        result.push({ ...current, ref, setBy: input.setBy, updatedAt: at });
      }
    }
    for (const [sourceId] of have) {
      if (!wanted.has(sourceId)) items.push({ kind: "delete", key: intakeSourceKey(input.orgId, input.project, sourceId) });
    }
    items.push({
      kind: "put", item: { ...countKey, entityType: "INTAKE_SOURCE_COUNT", orgId: input.orgId, project: input.project, count: result.length },
      condition: counted === undefined ? when.absent() : when.eq("count", counted["count"] ?? null),
    });
    if ((await table.store.transact(items)).applied) return result;
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "The intake sources are being changed by someone else. Try again in a moment.");
}

/**
 * Adds ONE source to a project's sources without touching the others. Idempotent: a source that is already there is left as it is (`already_set`), and one with other settings is `differs`, never
 * overwritten. At most `INTAKE_MAX_SOURCES_PER_PROJECT` (a ninth is refused in fixed words). A new source is due at once, like one set from the sources editor.
 */
export async function addIntakeSource(table: IntakeTable, input: { orgId: OrgId; project: string; ref: IntakeChannelRef; setBy: string }): Promise<"added" | "already_set" | "differs"> {
  const ref = IntakeChannelRefSchema.parse(input.ref);
  const sourceId = intakeSourceIdOf(ref);
  const have = await listIntakeSources(table, input.orgId, input.project);
  // A source is a channel, a system and a connection; the same place with other settings (another label) is the owner's to change, never overwritten by an add.
  const same = have.find((record) => record.sourceId === sourceId);
  if (same !== undefined) return JSON.stringify(same.ref) === JSON.stringify(ref) ? "already_set" : "differs";
  const full = (): never => { throw agentXError("CONFIG_INVALID", "This project already has the most intake sources it can have. Remove one before adding another."); };
  if (have.length >= INTAKE_MAX_SOURCES_PER_PROJECT) return full();
  const now = table.now();
  const at = new Date(now).toISOString();
  const record: IntakeSourceRecord = { orgId: input.orgId, project: input.project, sourceId, ref, setBy: input.setBy, createdAt: at, updatedAt: at, nextPollAt: now, failures: 0 };
  const countKey = intakeSourceCountKey(input.orgId, input.project);
  // The count of the project's sources is kept beside them. It starts from what is there, and a place is taken in ONE transaction that raises it only while it is under the most, so two adds at once
  // cannot both take the last place.
  await table.store.put({ item: { ...countKey, entityType: "INTAKE_SOURCE_COUNT", orgId: input.orgId, project: input.project, count: have.length }, condition: when.absent() });
  const taken = await table.store.transact([
    { kind: "update", key: countKey, ops: [change.add("count", 1)], condition: when.and(when.present(), when.lt("count", INTAKE_MAX_SOURCES_PER_PROJECT)) },
    { kind: "put", item: { ...intakeSourceKey(input.orgId, input.project, sourceId), entityType: "INTAKE_SOURCE", ...plain(record) }, condition: when.absent() },
  ]);
  if (taken.applied) return "added";
  // Lost a race: look again. The same place is there now, or the project is full.
  const there = (await listIntakeSources(table, input.orgId, input.project)).find((source) => source.sourceId === sourceId);
  if (there !== undefined) return JSON.stringify(there.ref) === JSON.stringify(ref) ? "already_set" : "differs";
  return full();
}

