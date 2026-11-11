// The trigger store: a trigger's record, the index rows that find it (by target, by creator, by the hook that receives its events, and the company's directory), what it did (activity, which expires) and the
// notices stored for the person who should hear of it. Every multi-row write is one transaction, written with the request row when the request has one, so a repeat is answered from it and writes nothing.
// A write that depends on what it read is conditional on the record's `revision`: a lost race is a conflict, never an overwrite. The keys are the shared layout, unchanged.
import { z } from "zod";
import {
  EventTriggerSpecSchema, INDEX_EXPIRY_ATTRIBUTE, MAX_TRIGGERS_PER_TARGET, OrgIdSchema, ScheduleTriggerSpecSchema, TRIGGER_ACTIVITY_TTL_DAYS, TriggerTargetSchema, change, newPrefixedId, orgScoped, pendingTriggerScheduleKey, queryAll,
  targetTriggerCountKey, targetTriggersKey, triggerActivityKey, triggerKey, triggerMatchKey, triggerNoticeKey, triggerTargetKey, triggersByCreatorKey, when,
  type DocumentKey, type EventTriggerSpec, type OrgId, type ScheduleTriggerSpec, type TransactItem, type TriggerOutcome, type TriggerTarget,
} from "@agentx/contracts";
import { coded, commit, deleteRow, iso, overwriteRow, putRow, strip, transact, type Item, type RequestMark, type Table } from "../automation/kit.js";

export type TriggerSpec = EventTriggerSpec | ScheduleTriggerSpec;

/** A trigger as stored. `revision` counts its writes, for the writes that depend on what they read. */
export interface TriggerRecord {
  orgId: OrgId;
  triggerId: string;
  target: TriggerTarget;
  project: string;
  spec: TriggerSpec;
  /** The hook that receives the events of a non-code-host event trigger. */
  hookId?: string;
  enabled: boolean;
  disabledReason?: string;
  maxRunsPerHour: number;
  /** A schedule trigger's schedule: `ok` once the scheduler has it, `pending` until it does (a sweep repairs one that is pending). */
  scheduleStatus?: "ok" | "pending";
  lastFiredAt?: string;
  /** Set when the trigger starts work, so the no-overlap check can read the open run or task. */
  lastRunId?: string;
  lastTaskId?: string;
  /** A schedule slot's start under way: written with a conditional update on the revision before the work is started, so two fires that both saw no open work cannot both start. A stale one (a start cut short) is ignored. */
  startClaim?: { slot: string; at: string };
  /** The version of its target (a chain's or an agent's published version) the owner turned the trigger on for. A trigger runs only while its target is still at it: a publish turns the trigger off. */
  approvedVersion?: number;
  /** The owner's request to turn this trigger on that may still be confirmed (a newer request, a turn-off or a change of spec closes it). */
  pendingApprovalId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** What a stored trigger must hold to be acted on. A record that was damaged or written by something else is left out (and reported to a caller that asks) instead of failing the read of every other trigger beside it. */
const TriggerRecordSchema = z.object({
  orgId: z.string().min(1), triggerId: z.string().min(1), target: TriggerTargetSchema, project: z.string().min(1), spec: z.union([EventTriggerSpecSchema, ScheduleTriggerSpecSchema]),
  hookId: z.string().optional(), enabled: z.boolean(), maxRunsPerHour: z.number(), createdBy: z.string().min(1), createdAt: z.string().min(1), updatedAt: z.string(), revision: z.number(),
}).passthrough();

export interface TriggerActivityEntry { at: string; eventKey: string; outcome: TriggerOutcome; runId?: string; taskId?: string; reason?: string }

/** A notice for the owner, kept for the page to show. */
export interface TriggerNotice { at: string; triggerId: string; developerId: string; text: string }

export interface TriggerStoreInput extends Table { newId?: () => string }

type Request = { request?: RequestMark; result?: unknown };

const CONFLICT_TEXT = "Someone else changed this trigger just now. Reload it and make your change again.";
const conflict = () => coded("CONFIG_INVALID", CONFLICT_TEXT);
/** Whether `error` is the store saying the trigger moved since it was read: the write is to be made again from a fresh read. */
export const isTriggerConflict = (error: unknown): boolean => (error as { code?: unknown; message?: unknown } | null)?.code === "CONFIG_INVALID" && String((error as { message?: unknown }).message).includes(CONFLICT_TEXT);

/** The fields of a record a change may take away. */
export type ClearableField = "hookId" | "disabledReason" | "scheduleStatus" | "lastFiredAt" | "lastRunId" | "lastTaskId" | "startClaim" | "pendingApprovalId" | "approvedVersion";
const full = (what: string) => coded("CONFIG_INVALID", `${what} already has the most triggers it can have (${String(MAX_TRIGGERS_PER_TARGET)}). Remove one first.`);
const DAY_SECONDS = 86_400;

const isPending = (record: Pick<TriggerRecord, "spec" | "scheduleStatus">): boolean => record.spec.kind === "schedule" && record.scheduleStatus === "pending";

/** The hook segment of a trigger's match key: the hook's id, or `github` for the events a code host's own connection delivers (they have none). */
export const hookSegmentOf = (record: Pick<TriggerRecord, "hookId">): string => record.hookId ?? "github";

const directoryKey = (orgId: OrgId, triggerId: string): DocumentKey => ({ pk: orgScoped(orgId, "TRIGGERS"), sk: triggerId });
const recipientKey = (orgId: OrgId, developerId: string): DocumentKey => ({ pk: orgScoped(orgId, "TRIGGER_NOTICE_RECIPIENTS"), sk: developerId });
const EARLY = "2000-01-01T00:00:00.000Z";

export class TriggerStore {
  private readonly newId: () => string;

  constructor(private readonly input: TriggerStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("ctr"));
  }

  newTriggerId(): string { return this.newId(); }

  // ---- reads

  private async queryRows(pk: string, options: { skPrefix?: string; limit?: number; descending?: boolean } = {}): Promise<Item[]> {
    const rows = await queryAll(this.input.store, {
      pk, ...(options.skPrefix === undefined ? {} : { sk: { op: "beginsWith" as const, prefix: options.skPrefix } }), ...(options.descending === true ? { descending: true } : {}),
    });
    return options.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  /** The trigger, read under `orgId` (a trigger of another company is none). */
  async get(orgId: OrgId, triggerId: string): Promise<TriggerRecord | undefined> {
    const item = await this.input.store.get(triggerKey(orgId, triggerId));
    return item === undefined || item["orgId"] !== orgId ? undefined : (strip(item) as unknown as TriggerRecord);
  }

  /** The records the index names, oldest first. One that is not there (or is another company's) is left out; one that does not parse is left out too and handed to `onUnreadable` by its id. */
  private async recordsOf(orgId: OrgId, index: Item[], onUnreadable?: (triggerId: string) => void): Promise<TriggerRecord[]> {
    const found = await Promise.all(index.map(async (entry) => {
      const triggerId = String(entry["sk"]);
      return { triggerId, item: await this.input.store.get(triggerKey(orgId, triggerId)) };
    }));
    const records: TriggerRecord[] = [];
    for (const { triggerId, item } of found) {
      if (item === undefined || item["orgId"] !== orgId) continue;
      const parsed = TriggerRecordSchema.safeParse(strip(item));
      if (parsed.success) records.push(parsed.data as unknown as TriggerRecord);
      else onUnreadable?.(triggerId);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.triggerId.localeCompare(b.triggerId));
  }

  async listForTarget(orgId: OrgId, target: TriggerTarget): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryRows(targetTriggersKey(orgId, triggerTargetKey(target), "x").pk, { skPrefix: "ctr_" }));
  }

  async listByCreator(orgId: OrgId, developerId: string): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryRows(triggersByCreatorKey(orgId, developerId, "x").pk));
  }

  /** The triggers of the receiving hook (`hookId` undefined for the code host's): what dispatch reads, and no other hook's. */
  async listForMatch(orgId: OrgId, source: EventTriggerSpec["source"], project: string, hookId: string | undefined, onUnreadable?: (triggerId: string) => void): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryRows(triggerMatchKey(orgId, source, project, hookId ?? "github", "x").pk), onUnreadable);
  }

  /** Every trigger of the company, from its directory. */
  async listAll(orgId: OrgId): Promise<TriggerRecord[]> {
    return this.recordsOf(orgId, await this.queryRows(directoryKey(orgId, "x").pk));
  }

  /** The triggers (company and id) whose schedule is still pending, from the global list, at most `limit`. Nothing is read from a trigger here: the list names it and the reader reads it under its company. */
  async listPendingSchedules(limit: number): Promise<Array<{ orgId: OrgId; triggerId: string }>> {
    const found: Array<{ orgId: OrgId; triggerId: string }> = [];
    for (const item of await this.queryRows(pendingTriggerScheduleKey(OrgIdSchema.parse("org_00000000000000000000"), "x").pk, { limit })) {
      const org = OrgIdSchema.safeParse(item["orgId"]);
      const triggerId = String(item["triggerId"]);
      if (org.success && String(item["sk"]) === `${org.data}#${triggerId}`) found.push({ orgId: org.data, triggerId });
    }
    return found;
  }

  /** Takes a trigger off the pending list without touching its record (the list names a trigger that is gone). */
  async dropPending(orgId: OrgId, triggerId: string): Promise<void> {
    await this.input.store.delete({ key: pendingTriggerScheduleKey(orgId, triggerId) });
  }

  /** The newest `limit` items of a trigger's activity, newest first. */
  async listActivity(orgId: OrgId, triggerId: string, limit = 100): Promise<TriggerActivityEntry[]> {
    const items = await this.queryRows(triggerActivityKey(orgId, triggerId, EARLY, "x").pk, { limit, descending: true });
    return items.map((item) => strip(item) as unknown as TriggerActivityEntry);
  }

  async listNotices(orgId: OrgId, developerId: string): Promise<TriggerNotice[]> {
    const items = await this.queryRows(triggerNoticeKey(orgId, developerId, EARLY, "x").pk);
    return items.map((item) => strip(item) as unknown as TriggerNotice);
  }

  // ---- row builders (a caller adds them to the transaction of the change they belong to)

  /** What the counter of a target's triggers does: `+1` held to the most a target may have, or `-1` while there is one. */
  private count(orgId: OrgId, target: TriggerTarget, delta: 1 | -1): TransactItem {
    return {
      kind: "update", key: targetTriggerCountKey(orgId, triggerTargetKey(target)), ops: [change.add(["count"], delta)],
      condition: delta === 1 ? when.or(when.notExists("count"), when.lt("count", MAX_TRIGGERS_PER_TARGET)) : when.and(when.exists("count"), when.gte("count", 1)),
    };
  }

  /** The index rows of a record: its place under its target, its creator, the company's directory and, for an event trigger, the hook that receives its events. */
  private indexItems(record: TriggerRecord): TransactItem[] {
    const { orgId, triggerId } = record;
    const items: TransactItem[] = [
      putRow(targetTriggersKey(orgId, triggerTargetKey(record.target), triggerId), "TARGET_TRIGGER", { orgId, triggerId }),
      putRow(triggersByCreatorKey(orgId, record.createdBy, triggerId), "TRIGGER_BY_CREATOR", { orgId, triggerId }),
      putRow(directoryKey(orgId, triggerId), "TRIGGER_DIRECTORY", { orgId, triggerId }),
    ];
    if (record.spec.kind === "event") items.push(putRow(triggerMatchKey(orgId, record.spec.source, record.project, hookSegmentOf(record), triggerId), "TRIGGER_MATCH", { orgId, triggerId, enabled: record.enabled }));
    if (isPending(record)) items.push(putRow(pendingTriggerScheduleKey(orgId, triggerId), "TRIGGER_SCHEDULE_PENDING", { orgId, triggerId }));
    return items;
  }

  private removeIndexItems(record: TriggerRecord): TransactItem[] {
    const { orgId, triggerId } = record;
    const items: TransactItem[] = [
      deleteRow(targetTriggersKey(orgId, triggerTargetKey(record.target), triggerId)),
      deleteRow(triggersByCreatorKey(orgId, record.createdBy, triggerId)),
      deleteRow(directoryKey(orgId, triggerId)),
    ];
    if (record.spec.kind === "event") items.push(deleteRow(triggerMatchKey(orgId, record.spec.source, record.project, hookSegmentOf(record), triggerId)));
    if (record.spec.kind === "schedule") items.push(deleteRow(pendingTriggerScheduleKey(orgId, triggerId)));
    return items;
  }

  /** One thing the trigger did or was told, to add to a transaction. It expires with `TRIGGER_ACTIVITY_TTL_DAYS`. */
  activityItem(orgId: OrgId, triggerId: string, entry: Omit<TriggerActivityEntry, "at"> & { at?: string }): TransactItem {
    const at = entry.at ?? iso(this.input);
    return overwriteRow(triggerActivityKey(orgId, triggerId, at, entry.eventKey), "TRIGGER_ACTIVITY", {
      orgId, triggerId, ...entry, at: new Date(at).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(this.input.now() / 1000) + TRIGGER_ACTIVITY_TTL_DAYS * DAY_SECONDS,
    });
  }

  /** A notice for `developerId` and the row that lists them as a recipient (so closing the company finds it), to add to a transaction. */
  noticeItems(orgId: OrgId, triggerId: string, developerId: string, text: string): TransactItem[] {
    const at = iso(this.input);
    return [
      overwriteRow(triggerNoticeKey(orgId, developerId, at, triggerId), "TRIGGER_NOTICE", { orgId, triggerId, developerId, text, at }),
      overwriteRow(recipientKey(orgId, developerId), "TRIGGER_NOTICE_RECIPIENT", { orgId, developerId }),
    ];
  }

  // ---- writes

  /** Stores a new trigger with its index rows. A target already at the most it may have refuses it. */
  async create(input: Request & { record: Omit<TriggerRecord, "revision" | "createdAt" | "updatedAt"> & { createdAt?: string }; extra?: TransactItem[] }): Promise<TriggerRecord> {
    const now = iso(this.input);
    const record: TriggerRecord = { ...input.record, createdAt: input.record.createdAt ?? now, updatedAt: now, revision: 1 };
    await commit(this.input, [
      putRow(triggerKey(record.orgId, record.triggerId), "TRIGGER", record as unknown as Item),
      this.count(record.orgId, record.target, 1),
      ...this.indexItems(record), ...(input.extra ?? []),
    ], (failed) => (failed.has(0) ? conflict() : failed.has(1) ? full("this chain or agent") : undefined), input.request, input.result ?? record);
    return record;
  }

  /**
   * Changes the fields in `patch` (and takes away those in `clear`) of a trigger, while it is still at `trigger.revision`; `revision` and `updatedAt` are the store's. A change of target, creator, project,
   * source or hook moves the index rows in the same transaction. `extra` joins the transaction (activity, notices).
   */
  async update(input: Request & { trigger: TriggerRecord; patch: Partial<Omit<TriggerRecord, "orgId" | "triggerId" | "revision" | "updatedAt">>; clear?: ClearableField[]; extra?: TransactItem[]; refuse?: (failed: ReadonlySet<number>) => Error | undefined }): Promise<TriggerRecord> {
    const before = input.trigger;
    const after: TriggerRecord = { ...before, ...input.patch, revision: before.revision + 1, updatedAt: iso(this.input) };
    for (const field of input.clear ?? []) delete after[field];
    const targetMoved = triggerTargetKey(before.target) !== triggerTargetKey(after.target);
    const creatorMoved = before.createdBy !== after.createdBy;
    const matchBefore = before.spec.kind === "event" ? triggerMatchKey(before.orgId, before.spec.source, before.project, hookSegmentOf(before), before.triggerId) : undefined;
    const matchAfter = after.spec.kind === "event" ? triggerMatchKey(after.orgId, after.spec.source, after.project, hookSegmentOf(after), after.triggerId) : undefined;
    const items: TransactItem[] = [{ ...overwriteRow(triggerKey(after.orgId, after.triggerId), "TRIGGER", after as unknown as Item), condition: when.eq("revision", before.revision) }];
    let newCount: number | undefined;
    if (targetMoved) {
      items.push(this.count(before.orgId, before.target, -1), deleteRow(targetTriggersKey(before.orgId, triggerTargetKey(before.target), before.triggerId)));
      newCount = items.length;
      items.push(this.count(after.orgId, after.target, 1), overwriteRow(targetTriggersKey(after.orgId, triggerTargetKey(after.target), after.triggerId), "TARGET_TRIGGER", { orgId: after.orgId, triggerId: after.triggerId }));
    }
    if (creatorMoved) {
      items.push(deleteRow(triggersByCreatorKey(before.orgId, before.createdBy, before.triggerId)), overwriteRow(triggersByCreatorKey(after.orgId, after.createdBy, after.triggerId), "TRIGGER_BY_CREATOR", { orgId: after.orgId, triggerId: after.triggerId }));
    }
    if (matchBefore !== undefined && (matchAfter === undefined || matchBefore.pk !== matchAfter.pk)) items.push(deleteRow(matchBefore));
    if (matchAfter !== undefined) items.push(overwriteRow(matchAfter, "TRIGGER_MATCH", { orgId: after.orgId, triggerId: after.triggerId, enabled: after.enabled }));
    // The sweep that repairs schedules finds the ones still pending through this list: it holds exactly the triggers whose record says so.
    if (isPending(after) && !isPending(before)) items.push(overwriteRow(pendingTriggerScheduleKey(after.orgId, after.triggerId), "TRIGGER_SCHEDULE_PENDING", { orgId: after.orgId, triggerId: after.triggerId }));
    else if (!isPending(after) && isPending(before)) items.push(deleteRow(pendingTriggerScheduleKey(before.orgId, before.triggerId)));
    items.push(...(input.extra ?? []));
    await commit(this.input, items, (failed) => {
      if (failed.has(0)) return conflict();
      if (newCount !== undefined && failed.has(newCount)) return full("the chain or agent you are moving it to");
      return input.refuse?.(failed);
    }, input.request, input.result ?? after);
    return after;
  }

  /** Deletes a trigger and its index rows (its activity expires on its own). */
  async delete(input: Request & { trigger: TriggerRecord; extra?: TransactItem[] }): Promise<void> {
    const { trigger } = input;
    await commit(this.input, [
      { kind: "delete", key: triggerKey(trigger.orgId, trigger.triggerId), condition: when.eq("revision", trigger.revision) },
      this.count(trigger.orgId, trigger.target, -1),
      ...this.removeIndexItems(trigger),
      ...(input.extra ?? []),
    ], (failed) => (failed.has(0) || failed.has(1) ? conflict() : undefined), input.request, input.result ?? { deleted: true });
  }

  /** Records one thing a trigger did, on its own (dispatch and the scheduler write it with the run they started, through `activityItem`). */
  async recordActivity(orgId: OrgId, triggerId: string, entry: Omit<TriggerActivityEntry, "at"> & { at?: string }): Promise<void> {
    await transact(this.input, [this.activityItem(orgId, triggerId, entry)]);
  }

  /** Deletes everything of a company's: its triggers, their index rows, their activity and the notices of the people who were told. Repeatable: closing again finishes what a failed close left. */
  async deleteOrg(orgId: OrgId): Promise<{ triggers: number }> {
    const triggers = await this.listAll(orgId);
    const sweep = async (key: DocumentKey): Promise<void> => { await this.input.store.delete({ key }); };
    for (const trigger of triggers) {
      for (const entry of await this.queryRows(triggerActivityKey(orgId, trigger.triggerId, EARLY, "x").pk)) await sweep({ pk: String(entry["pk"]), sk: String(entry["sk"]) });
      for (const row of this.removeIndexItems(trigger)) if (row.kind === "delete") await sweep(row.key);
      await sweep(targetTriggerCountKey(orgId, triggerTargetKey(trigger.target)));
      await sweep(triggerKey(orgId, trigger.triggerId));
    }
    for (const recipient of await this.queryRows(recipientKey(orgId, "x").pk)) {
      const developerId = String(recipient["sk"]);
      for (const notice of await this.queryRows(triggerNoticeKey(orgId, developerId, EARLY, "x").pk)) await sweep({ pk: String(notice["pk"]), sk: String(notice["sk"]) });
      await sweep(recipientKey(orgId, developerId));
    }
    return { triggers: triggers.length };
  }
}
