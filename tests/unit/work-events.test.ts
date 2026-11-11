// Work events (U3): the shape is closed and holds no content; the key, the retention and the id are exact; one change gives one event, in the change's own transaction, once.
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, WORK_EVENT_BLOCK_CAUSES, WORK_EVENT_FAILURE_CAUSES, WORK_EVENT_KINDS, WORK_EVENT_SHARDS, WorkEventSchema, queryAll, workEventCauseIsFailure, workEventExpiresAt, workEventId, workEventKey, workEventMonths, workEventPartition, workEventPartitions, workEventShard,
  type DocumentStore, type WorkEventInput, type WorkEventKind,
} from "@agentx/contracts";
import { WORK_EVENTS_PER_CHANGE_MAX, listWorkEvents, recordWorkEvent, workEventItem, workEventItems, workEventRow } from "../../packages/broker/src/core/work-events/work-events.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const orgId = IMPLICIT_COMPANY_ID;
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const at = "2026-11-10T09:30:00.000Z";
const person = { kind: "person", personId: "dev_0123456789abcdef" } as const;
const common = (kind: WorkEventKind, source: string, overrides: Record<string, unknown> = {}) => ({ version: 1 as const, id: workEventId({ kind, taskId, source }), at, orgId, project: "billing-service", taskId, actor: person, ...overrides });

/** One valid event of every kind. */
const SAMPLES: Record<WorkEventKind, WorkEventInput> = {
  task_started: { ...common("task_started", "start"), kind: "task_started", path: "FULL", origin: "web" },
  plan_approved: { ...common("plan_approved", "r1"), kind: "plan_approved", risk: "medium" },
  step_started: { ...common("step_started", "op1"), kind: "step_started", step: "coding" },
  step_ended: { ...common("step_ended", "op1"), kind: "step_ended", step: "coding", outcome: "stopped", cause: "cancelled", actor: { kind: "agent" } },
  decision_asked: { ...common("decision_asked", "d1"), kind: "decision_asked", decisionId: "card-1", decision: "plan", risk: "low", actor: { kind: "system" } },
  decision_answered: { ...common("decision_answered", "d1"), kind: "decision_answered", decisionId: "card-1", decision: "plan", outcome: "approved", place: "web" },
  pr_opened: { ...common("pr_opened", "acme/api#7"), kind: "pr_opened", repository: "acme/api", number: 7, actor: { kind: "agent" } },
  pr_merged: { ...common("pr_merged", "acme/api#7"), kind: "pr_merged", repository: "acme/api", number: 7, actor: { kind: "system" } },
  pr_closed: { ...common("pr_closed", "acme/api#7"), kind: "pr_closed", repository: "acme/api", number: 7, actor: { kind: "system" } },
  task_failed: { ...common("task_failed", "f1"), kind: "task_failed", cause: "checks_failed", actor: { kind: "system" } },
  task_closed: { ...common("task_closed", "r9"), kind: "task_closed", outcome: "merged", actor: { kind: "system" } },
  review_requested: { ...common("review_requested", "acme/api#7"), kind: "review_requested", repository: "acme/api", number: 7, actor: { kind: "system" } },
  review_approved: { ...common("review_approved", "acme/api#7"), kind: "review_approved", repository: "acme/api", number: 7 },
  waiting_changed: { ...common("waiting_changed", "w1"), kind: "waiting_changed", waitingOn: "person", personIds: ["dev_0123456789abcdef"], reason: "plan_review", actor: { kind: "system" } },
  cost_settled: { ...common("cost_settled", "op1"), kind: "cost_settled", micros: 1_250_000, currency: "USD", source: "model", actor: { kind: "system" } },
};

describe("the work event contract", () => {
  it("has one valid sample for every kind of the closed set, and nothing else", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...WORK_EVENT_KINDS].sort());
    for (const kind of WORK_EVENT_KINDS) expect(WorkEventSchema.parse(SAMPLES[kind])).toMatchObject({ kind, version: 1 });
  });

  it("refuses an unknown kind, an unknown version and an unknown field (nothing can carry content)", () => {
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, kind: "task_renamed" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, version: 2 }).success).toBe(false);
    for (const field of ["text", "title", "prompt", "comment", "branch", "path", "error", "token", "email", "name"]) {
      for (const kind of WORK_EVENT_KINDS) expect(WorkEventSchema.safeParse({ ...SAMPLES[kind], [field]: "anything" }).success, `${kind} + ${field}`).toBe(false);
    }
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, actor: { kind: "person", personId: "dev_01", name: "Priya Shah" } }).success).toBe(false);
  });

  it("holds only ids for people: a name, an email or a chat handle is not a person id", () => {
    for (const personId of ["Priya Shah", "priya@example.com", "@priya", "", "a b", "x".repeat(129)]) {
      expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, actor: { kind: "person", personId } }).success, personId).toBe(false);
    }
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, actor: { kind: "person" } }).success).toBe(false);
  });

  it("holds free text nowhere: every short code and reference refuses spaces, capitals and sentences", () => {
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_failed, cause: "The build failed because of a missing file." }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, reason: "Waiting for Priya to review" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.step_started, step: "Coding Step" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.decision_asked, decisionId: "a decision about the plan" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.pr_opened, repository: "https://example.com/acme/api?token=1" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.cost_settled, currency: "usd" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.cost_settled, micros: -1 }).success).toBe(false);
  });

  it("tells a failure from a stop: task_failed takes only a failure cause, and a finished step has no cause", () => {
    for (const cause of WORK_EVENT_FAILURE_CAUSES) expect(WorkEventSchema.safeParse({ ...SAMPLES.task_failed, cause }).success, cause).toBe(true);
    for (const cause of WORK_EVENT_BLOCK_CAUSES.filter((cause) => !workEventCauseIsFailure(cause))) {
      expect(WorkEventSchema.safeParse({ ...SAMPLES.task_failed, cause }).success, `${cause} is a stop, not a failure`).toBe(false);
      expect(WorkEventSchema.safeParse({ ...SAMPLES.step_ended, outcome: "stopped", cause }).success, cause).toBe(true);
    }
    expect(WorkEventSchema.safeParse({ ...SAMPLES.step_ended, outcome: "done", cause: "cancelled" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.step_ended, outcome: "done", cause: undefined }).success).toBe(true);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.step_ended, outcome: "superseded" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_failed, cause: undefined }).success).toBe(false);
  });

  it("ends a task with one of the closed outcomes", () => {
    for (const outcome of ["merged", "closed_unmerged", "answered", "plan_rejected", "passed", "skipped", "changes_requested"]) expect(WorkEventSchema.safeParse({ ...SAMPLES.task_closed, outcome }).success, outcome).toBe(true);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_closed, outcome: "It was merged on Friday" }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.task_closed, outcome: undefined }).success).toBe(false);
  });

  it("names who the work waits on, with person ids only when it waits on a person", () => {
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, waitingOn: "agent", personIds: undefined }).success).toBe(true);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, waitingOn: "none", personIds: undefined, reason: undefined }).success).toBe(true);
    // A person may be the one waited for with no one named yet (a merge nobody has taken).
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, waitingOn: "person", personIds: undefined }).success).toBe(true);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, waitingOn: "agent", personIds: ["dev_01"] }).success).toBe(false);
    expect(WorkEventSchema.safeParse({ ...SAMPLES.waiting_changed, waitingOn: "robot" }).success).toBe(false);
  });

  it("takes time only as a UTC instant with milliseconds, so text order is time order", () => {
    for (const bad of ["2026-11-10", "2026-11-10T09:30:00Z", "2026-11-10T09:30:00.000+01:00", "2026-13-10T09:30:00.000Z", "yesterday"]) {
      expect(WorkEventSchema.safeParse({ ...SAMPLES.task_started, at: bad }).success, bad).toBe(false);
    }
  });

  it("derives an id from the change: the same change is the same id, another change another", () => {
    expect(workEventId({ kind: "pr_merged", taskId, source: "acme/api#7" })).toBe(workEventId({ kind: "pr_merged", taskId, source: "acme/api#7" }));
    expect(workEventId({ kind: "pr_merged", taskId, source: "acme/api#7" })).not.toBe(workEventId({ kind: "pr_closed", taskId, source: "acme/api#7" }));
    expect(workEventId({ kind: "pr_merged", taskId, source: "acme/api#7" })).not.toBe(workEventId({ kind: "pr_merged", taskId, source: "acme/api#8" }));
    expect(workEventId({ kind: "pr_merged", taskId, source: "x" })).toMatch(/^wev_[a-f0-9]{32}$/u);
    expect(() => workEventId({ kind: "pr_merged", taskId, source: "" })).toThrow();
    for (const source of ["undefined", "r4.undefined", "acme/api#undefined.r4", "null"]) expect(() => workEventId({ kind: "pr_merged", taskId, source }), source).toThrow();
    expect(workEventId({ kind: "pr_merged", taskId, source: "acme/undefined-repo#7.r4" })).toMatch(/^wev_/u);
  });
});

describe("where an event lives, and for how long", () => {
  it("keys an event by company and month, then by time and id", () => {
    const event = WorkEventSchema.parse(SAMPLES.task_started);
    expect(workEventKey(event)).toEqual({ pk: `ORG#${orgId}#WORK_EVENTS#2026-11#${String(workEventShard(taskId))}`, sk: `${at}#${event.id}` });
    expect(workEventPartition(orgId, "2027-01", 3)).toBe(`ORG#${orgId}#WORK_EVENTS#2027-01#3`);
    expect(() => workEventPartition(orgId, "2027-13", 0)).toThrow();
    expect(() => workEventPartition(orgId, "2027-01", WORK_EVENT_SHARDS)).toThrow();
  });

  it("spreads tasks over the shards, keeps one task in one shard, and reads a month from every shard", () => {
    expect(workEventShard(taskId)).toBe(workEventShard(taskId));
    const shards = new Set(Array.from({ length: 64 }, (_, index) => workEventShard(`${index.toString(16).padStart(2, "0")}579b4b-eaa7-4bf2-87bc-6da86b97c9e6`)));
    expect(shards.size).toBe(WORK_EVENT_SHARDS);
    expect(workEventPartitions(orgId, "2026-11")).toHaveLength(WORK_EVENT_SHARDS);
    expect(new Set(workEventPartitions(orgId, "2026-11")).size).toBe(WORK_EVENT_SHARDS);
    expect(workEventShard("not-a-uuid")).toBe(0);
  });

  it("lists the months of a range", () => {
    expect(workEventMonths("2026-11-30T23:59:59.999Z", "2027-02-01T00:00:00.000Z")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(workEventMonths(at, at)).toEqual(["2026-11"]);
    expect(() => workEventMonths("2027-01-01T00:00:00.000Z", at)).toThrow();
  });

  it("expires an event at the start of the 14th month after its own: at least 13 whole months are kept", () => {
    expect(new Date(workEventExpiresAt("2026-11-10T09:30:00.000Z") * 1000).toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(new Date(workEventExpiresAt("2026-12-31T23:59:59.999Z") * 1000).toISOString()).toBe("2028-02-01T00:00:00.000Z");
    expect(new Date(workEventExpiresAt("2026-01-01T00:00:00.000Z") * 1000).toISOString()).toBe("2027-03-01T00:00:00.000Z");
    // The first instant of a month is still kept 13 whole months past that month's end.
    expect(workEventExpiresAt("2026-01-01T00:00:00.000Z") - Date.parse("2026-02-01T00:00:00.000Z") / 1000).toBeGreaterThanOrEqual(13 * 28 * 86_400);
  });

  it("stores the row with the store's expiry attribute and nothing but the event", () => {
    const row = workEventRow(SAMPLES.pr_merged);
    expect(row).toMatchObject({ entityType: "WORK_EVENT", kind: "pr_merged", repository: "acme/api", number: 7, [INDEX_EXPIRY_ATTRIBUTE]: workEventExpiresAt(at) });
    expect(Object.keys(row).sort()).toEqual(["actor", "at", "entityType", "id", INDEX_EXPIRY_ATTRIBUTE, "kind", "number", "orgId", "pk", "project", "repository", "sk", "taskId", "version"].sort());
  });
});

describe("writing events", () => {
  const store = (): DocumentStore => new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
  const rowsOf = async (s: DocumentStore) => (await Promise.all(workEventPartitions(orgId, "2026-11").map((pk) => queryAll(s, { pk })))).flat();

  it("is one put with no condition, so an event can never be the reason a change is refused", () => {
    const item = workEventItem(SAMPLES.task_started);
    expect(item).toMatchObject({ kind: "put", item: { entityType: "WORK_EVENT", kind: "task_started" } });
    expect(item).not.toHaveProperty("condition");
    expect(workEventItems([SAMPLES.step_started, SAMPLES.cost_settled])).toHaveLength(2);
    expect(workEventItems([])).toEqual([]);
  });

  it("never throws inside a business write: an invalid, repeated or surplus event is left out and reported", () => {
    const skipped: string[] = [];
    const items = workEventItems([SAMPLES.task_started, { ...SAMPLES.task_started }, { ...SAMPLES.step_started, text: "a plan" } as unknown as WorkEventInput, SAMPLES.cost_settled], (reason) => skipped.push(reason));
    expect(items).toHaveLength(2);
    expect(skipped).toEqual(["duplicate", "invalid"]);
    const many = Array.from({ length: WORK_EVENTS_PER_CHANGE_MAX + 3 }, (_, index) => ({ ...SAMPLES.step_started, id: workEventId({ kind: "step_started", taskId, source: `s${String(index)}` }) }));
    const surplus: string[] = [];
    expect(workEventItems(many, (reason) => surplus.push(reason))).toHaveLength(WORK_EVENTS_PER_CHANGE_MAX);
    expect(surplus).toEqual(["too_many", "too_many", "too_many"]);
  });

  it("writes nothing for an event that is not valid", () => {
    expect(() => workEventItem({ ...SAMPLES.task_started, actor: { kind: "person", personId: "Priya Shah" } })).toThrow();
    expect(() => workEventItem({ ...SAMPLES.task_started, text: "a plan" } as unknown as WorkEventInput)).toThrow();
  });

  it("commits with the change that caused it, and a change that does not commit leaves no event", async () => {
    const s = store();
    await s.put({ item: { pk: "TASK#1", sk: "META", state: "WAITING" } });
    const ok = await s.transact([{ kind: "update", key: { pk: "TASK#1", sk: "META" }, ops: [{ op: "set", path: ["state"], value: "RUNNING" }], condition: { op: "eq", path: ["state"], value: "WAITING" } }, ...workEventItems([SAMPLES.step_started])]);
    expect(ok.applied).toBe(true);
    expect(await rowsOf(s)).toHaveLength(1);
    // The same change again: its source condition fails, so the whole transaction is refused and no second event appears.
    const lost = await s.transact([{ kind: "update", key: { pk: "TASK#1", sk: "META" }, ops: [{ op: "set", path: ["state"], value: "RUNNING" }], condition: { op: "eq", path: ["state"], value: "WAITING" } }, ...workEventItems([{ ...SAMPLES.step_started, id: workEventId({ kind: "step_started", taskId, source: "op2" }) }])]);
    expect(lost.applied).toBe(false);
    expect(await rowsOf(s)).toHaveLength(1);
  });

  it("keeps one event when the same change is recorded twice (the id is the change's), and a second write never fails", async () => {
    const s = store();
    expect((await recordWorkEvent(s, SAMPLES.pr_merged)).applied).toBe(true);
    expect((await recordWorkEvent(s, SAMPLES.pr_merged)).applied).toBe(true);
    expect(await rowsOf(s)).toHaveLength(1);
    // Inside a transaction too: the repeat does not cancel the change it rides with.
    expect((await s.transact([...workEventItems([SAMPLES.pr_merged]), { kind: "put", item: { pk: "TASK#1", sk: "META", n: 1 } }])).applied).toBe(true);
    expect(await rowsOf(s)).toHaveLength(1);
  });
});

describe("reading events", () => {
  it("lists a company's events in a range, oldest first, by kind and task, across months, and never another company's", async () => {
    const s = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const other = "org_zzzzzzzzzzzzzzzzzzzz";
    const early = { ...SAMPLES.task_started, at: "2026-10-31T23:00:00.000Z", id: workEventId({ kind: "task_started", taskId, source: "early" }) } as WorkEventInput;
    const late = { ...SAMPLES.step_started, at: "2026-11-02T01:00:00.000Z" } as WorkEventInput;
    const foreign = { ...SAMPLES.step_started, orgId: other } as WorkEventInput;
    const elsewhere = { ...SAMPLES.pr_merged, taskId: "11111111-1111-4111-8111-111111111111", id: workEventId({ kind: "pr_merged", taskId: "11111111-1111-4111-8111-111111111111", source: "x" }) } as WorkEventInput;
    for (const event of [late, early, foreign, elsewhere, SAMPLES.task_started]) await recordWorkEvent(s, event);
    const all = await listWorkEvents(s, { orgId, from: "2026-10-01T00:00:00.000Z", to: "2026-11-30T00:00:00.000Z" });
    expect(all.unreadable).toBe(0);
    const days = all.events.map((event) => `${event.kind}:${event.at.slice(0, 10)}`);
    expect(days.slice(0, 2)).toEqual(["task_started:2026-10-31", "step_started:2026-11-02"]);
    expect(days.slice(2).sort()).toEqual(["pr_merged:2026-11-10", "task_started:2026-11-10"]);
    expect(all.events.every((event) => event.orgId === orgId)).toBe(true);
    const merged = await listWorkEvents(s, { orgId, from: "2026-11-01T00:00:00.000Z", to: at, kinds: ["pr_merged", "task_started"], taskId });
    expect(merged.events.map((event) => event.kind)).toEqual(["task_started"]);
    // The range's end is inclusive.
    expect((await listWorkEvents(s, { orgId, from: at, to: at })).events.map((event) => event.id).sort()).toEqual([SAMPLES.task_started, elsewhere].map((event) => event.id).sort());
  });

  it("does not return a row past its expiry that the store has not swept yet", async () => {
    const s = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => 0 });
    await recordWorkEvent(s, SAMPLES.task_started);
    const range = { orgId, from: at, to: at } as const;
    expect((await listWorkEvents(s, { ...range, now: Date.parse(at) })).events).toHaveLength(1);
    expect((await listWorkEvents(s, { ...range, now: workEventExpiresAt(at) * 1000 })).events).toEqual([]);
  });

  it("counts a row it cannot read instead of failing the read", async () => {
    const s = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    await s.put({ item: { ...workEventRow(SAMPLES.task_started), version: 2 } });
    expect(await listWorkEvents(s, { orgId, from: at, to: at })).toEqual({ events: [], unreadable: 1 });
  });
});
