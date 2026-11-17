// The cost report's features (lead 4, A1): names, state, merge, the rule order of a task's feature, the company boundary, and the audit record that commits with every change.
import { describe, expect, it } from "vitest";
import { FEATURE_CANNOT_MERGE, FEATURE_CONFLICT, FEATURE_IS_DONE, FEATURE_LIMIT, FEATURE_NAME_MAX, FEATURE_NAME_TAKEN, FEATURE_NOT_FOUND, FEATURE_SOURCES, FEATURE_SOURCE_RANK, PERSON_FEATURE_SOURCES, REPORT_FEATURES_MAX, reportFeatureKey, reportPartition, reportTaskFeatureKey, type AuditEvent, type FeatureSource, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { cleanFeatureName, createFeatureStore, resolveFeature, type FeatureActor } from "../../packages/broker/src/core/report/feature-store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const TASK = "11111111-1111-4111-8111-111111111111";
const TASK2 = "22222222-2222-4222-8222-222222222222";
const ada: FeatureActor = { type: "person", id: "ada" };

/** A store with an audit sink that writes each event as a row in the same transaction (so a lost transaction loses its audit too). */
function world() {
  const store = new MemoryDocumentStore();
  const events: AuditEvent[] = [];
  let tick = 0;
  let ids = 0;
  const audit = { stage: (event: AuditEvent) => { events.push(event); return [{ kind: "put" as const, item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, entityType: "TEST_AUDIT", action: event.action }, condition: { op: "notExists" as const, path: ["pk"] as const } }]; } };
  const now = () => T0 + tick++;
  const make = (companyId: OrgId) => createFeatureStore({ store, companyId, audit, now, newId: () => `ft_${(++ids).toString(16).padStart(20, "0")}` });
  /** The audit records that were COMMITTED (a staged event of a transaction that failed is not one). */
  const committed = async (companyId: OrgId, action?: string): Promise<number> => (await store.query({ pk: `AUDIT#${companyId}`, limit: 1000 })).items.filter((row) => action === undefined || row["action"] === action).length;
  return { store, events, committed, a: make(A), b: make(B) };
}

describe("feature names", () => {
  it("cleans, collapses and cuts a name", () => {
    expect(cleanFeatureName("  Checkout\u0000 ​V2\n now ")).toBe("Checkout V2 now");
    expect([...cleanFeatureName("x".repeat(200))!]).toHaveLength(FEATURE_NAME_MAX);
    expect(cleanFeatureName(" \u0000 ​ ")).toBeUndefined();
  });
  it("never stores a secret-shaped name as typed", () => {
    const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
    expect(cleanFeatureName(`token ${secret}`)).not.toContain(secret);
  });
});

describe("features: make, rename, state, merge", () => {
  it("makes a feature open, lists it by name, and writes the audit record with the change", async () => {
    const w = world();
    const zeta = await w.a.create({ name: "Zeta" }, ada);
    await w.a.create({ name: "alpha", trackerLink: { tracker: "linear", id: "PRJ-1", url: "https://linear.app/x/project/prj-1" } }, ada);
    expect(zeta).toMatchObject({ name: "Zeta", state: "open", version: 1 });
    expect((await w.a.list()).map((f) => f.name)).toEqual(["alpha", "Zeta"]);
    expect((await w.a.list())[0]!.trackerLink?.tracker).toBe("linear");
    expect(w.events.map((e) => e.action)).toEqual(["report.feature_created", "report.feature_created"]);
    expect(w.events[0]).toMatchObject({ companyId: A, actor: ada, subject: { type: "feature", id: zeta.id } });
    // the audit row is in the store, committed with the feature
    expect(await w.store.get({ pk: `AUDIT#${A}`, sk: w.events[0]!.eventId })).toBeDefined();
  });

  it("refuses a duplicate name in one company (any case) but not in the other company", async () => {
    const w = world();
    await w.a.create({ name: "Checkout V2" }, ada);
    await expect(w.a.create({ name: "checkout v2" }, ada)).rejects.toThrow(FEATURE_NAME_TAKEN);
    await expect(w.b.create({ name: "checkout v2" }, ada)).resolves.toMatchObject({ name: "checkout v2" });
    // a failed make leaves nothing behind: one feature and one audit record in each company
    expect(await w.a.list()).toHaveLength(1);
    expect(await w.committed(A)).toBe(1);
    expect(await w.committed(B)).toBe(1);
  });

  it("refuses a name that is empty after cleaning, and a company that holds as many features as it can", async () => {
    const w = world();
    await expect(w.a.create({ name: "\u0000​" }, ada)).rejects.toThrow(/needs a name/u);
    for (let i = 0; i < REPORT_FEATURES_MAX; i += 1) await w.store.put({ item: { ...reportFeatureKey(A, `ft_${i.toString(16).padStart(20, "0")}`), entityType: "REPORT_FEATURE", companyId: A, id: `ft_${i.toString(16).padStart(20, "0")}`, name: `n${i}`, state: "open", createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z", version: 1 } });
    await expect(w.a.create({ name: "one more" }, ada)).rejects.toThrow(FEATURE_LIMIT);
    // the other company is not held to it
    await expect(w.b.create({ name: "one more" }, ada)).resolves.toBeDefined();
  });

  it("renames: the old name is free, the new one is taken, a clash is refused, a case-only change works", async () => {
    const w = world();
    const one = await w.a.create({ name: "One" }, ada);
    const two = await w.a.create({ name: "Two" }, ada);
    await expect(w.a.rename(one.id, "TWO", ada)).rejects.toThrow(FEATURE_NAME_TAKEN);
    expect((await w.a.get(one.id))!.name).toBe("One");
    const renamed = await w.a.rename(one.id, "Uno", ada);
    expect(renamed).toMatchObject({ name: "Uno", version: 2 });
    await expect(w.a.create({ name: "one" }, ada)).resolves.toBeDefined();
    expect((await w.a.rename(two.id, "TWO", ada)).name).toBe("TWO");
    // the refused rename wrote no audit record: two renames committed, three records of that kind staged
    expect(await w.committed(A, "report.feature_renamed")).toBe(2);
  });

  it("marks a feature done and open again; a task cannot be filed under a done feature", async () => {
    const w = await Promise.resolve(world());
    const f = await w.a.create({ name: "Billing" }, ada);
    expect((await w.a.setState(f.id, "done", ada)).state).toBe("done");
    await expect(w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada)).rejects.toThrow(FEATURE_IS_DONE);
    await w.a.setState(f.id, "open", ada);
    await expect(w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada)).resolves.toMatchObject({ outcome: "set" });
  });

  it("merges: tasks read as the target's, the merged name is free, no assignment is rewritten", async () => {
    const w = world();
    const from = await w.a.create({ name: "Old name" }, ada);
    const into = await w.a.create({ name: "New name" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: from.id, source: "chosen" }, ada);
    const before = await w.store.get(reportTaskFeatureKey(A, TASK));
    await w.a.merge(from.id, into.id, ada);
    expect(await w.store.get(reportTaskFeatureKey(A, TASK))).toEqual(before);
    const all = await w.a.all();
    expect(resolveFeature(all, from.id)!.id).toBe(into.id);
    expect((await w.a.list()).map((f) => f.id)).toEqual([into.id]);
    await expect(w.a.create({ name: "Old name" }, ada)).resolves.toBeDefined();
    // a merged feature takes no more tasks and cannot be renamed
    await expect(w.a.setTaskFeature({ taskId: TASK2, project: "alpha", featureId: from.id, source: "chosen" }, ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    await expect(w.a.rename(from.id, "again", ada)).rejects.toThrow(FEATURE_NOT_FOUND);
  });

  it("refuses to merge a feature into itself, into a merged one, or from a merged one", async () => {
    const w = world();
    const [x, y, z] = [await w.a.create({ name: "X" }, ada), await w.a.create({ name: "Y" }, ada), await w.a.create({ name: "Z" }, ada)];
    await expect(w.a.merge(x.id, x.id, ada)).rejects.toThrow(FEATURE_CANNOT_MERGE);
    await w.a.merge(x.id, y.id, ada);
    await expect(w.a.merge(z.id, x.id, ada)).rejects.toThrow(FEATURE_CANNOT_MERGE);
    await expect(w.a.merge(x.id, z.id, ada)).rejects.toThrow(FEATURE_CANNOT_MERGE);
  });

  it("a chain of merges resolves to the last feature; a loop or a missing end resolves to nothing", () => {
    const rec = (id: string, state: "open" | "merged", mergedInto?: string) => ({ id, name: id, state, createdAt: "t", updatedAt: "t", version: 1, ...(mergedInto === undefined ? {} : { mergedInto }) });
    const map = new Map([["ft_1", rec("ft_1", "merged", "ft_2")], ["ft_2", rec("ft_2", "merged", "ft_3")], ["ft_3", rec("ft_3", "open")], ["ft_4", rec("ft_4", "merged", "ft_5")], ["ft_5", rec("ft_5", "merged", "ft_4")], ["ft_6", rec("ft_6", "merged", "ft_gone")]]);
    expect(resolveFeature(map, "ft_1")!.id).toBe("ft_3");
    expect(resolveFeature(map, "ft_4")).toBeUndefined();
    expect(resolveFeature(map, "ft_6")).toBeUndefined();
    expect(resolveFeature(map, "ft_nope")).toBeUndefined();
  });

  it("two racing makes of one name: exactly one wins", async () => {
    const w = world();
    const results = await Promise.allSettled([w.a.create({ name: "Race" }, ada), w.a.create({ name: "race" }, ada)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await w.a.list())).toHaveLength(1);
  });

  it("a change that lost a race says so, and never overwrites what the other writer saved", async () => {
    const w = world();
    const f = await w.a.create({ name: "Stale" }, ada);
    const other = createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => T0 + 99 });
    const real = w.store.transact.bind(w.store);
    let raced = false;
    w.store.transact = async (items) => {
      // another writer changes the feature after this caller read it and before this caller writes
      if (!raced) { raced = true; await other.setState(f.id, "done", ada); }
      return real(items);
    };
    await expect(w.a.rename(f.id, "Renamed", ada)).rejects.toThrow(FEATURE_CONFLICT);
    expect(await w.a.get(f.id)).toMatchObject({ name: "Stale", state: "done", version: 2 });
    expect(await w.committed(A, "report.feature_renamed")).toBe(0);
  });

  it("a merge whose target was merged away meanwhile is refused (the target is checked in the same transaction)", async () => {
    const w = world();
    const [x, y, z] = [await w.a.create({ name: "X" }, ada), await w.a.create({ name: "Y" }, ada), await w.a.create({ name: "Z" }, ada)];
    const other = createFeatureStore({ store: w.store, companyId: A, audit: { stage: () => [] }, now: () => T0 + 99 });
    const real = w.store.transact.bind(w.store);
    let raced = false;
    w.store.transact = async (items) => {
      if (!raced) { raced = true; await other.merge(y.id, z.id, ada); }
      return real(items);
    };
    await expect(w.a.merge(x.id, y.id, ada)).rejects.toThrow(FEATURE_CONFLICT);
    expect((await w.a.get(x.id))!.state).toBe("open");
  });
});

describe("features: the company boundary", () => {
  it("another company's feature is absent: not listed, not read, not mergeable, not fileable, not changeable", async () => {
    const w = world();
    const mine = await w.a.create({ name: "Mine" }, ada);
    const theirs = await w.b.create({ name: "Theirs" }, ada);
    expect((await w.a.list()).map((f) => f.name)).toEqual(["Mine"]);
    expect(await w.a.get(theirs.id)).toBeUndefined();
    await expect(w.a.rename(theirs.id, "x", ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    await expect(w.a.setState(theirs.id, "done", ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    await expect(w.a.merge(mine.id, theirs.id, ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    await expect(w.a.merge(theirs.id, mine.id, ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    await expect(w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: theirs.id, source: "moved" }, ada)).rejects.toThrow(FEATURE_NOT_FOUND);
    expect(await w.a.taskFeature(TASK)).toBeUndefined();
    // B is untouched
    expect((await w.b.get(theirs.id))!.state).toBe("open");
    expect(reportPartition(A)).not.toBe(reportPartition(B));
  });

  it("a feature row planted in A's partition that names B is not A's feature", async () => {
    const w = world();
    const theirs = await w.b.create({ name: "Theirs" }, ada);
    const row = (await w.store.get(reportFeatureKey(B, theirs.id)))!;
    await w.store.put({ item: { ...row, pk: reportPartition(A) } });
    expect(await w.a.get(theirs.id)).toBeUndefined();
    expect(await w.a.list()).toEqual([]);
  });

  it("a task assignment planted in A's partition that names B is not read", async () => {
    const w = world();
    const f = await w.a.create({ name: "Mine" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada);
    const row = (await w.store.get(reportTaskFeatureKey(A, TASK)))!;
    await w.store.put({ item: { ...row, companyId: B } });
    expect(await w.a.taskFeature(TASK)).toBeUndefined();
  });
});

describe("a task's feature: the rule order", () => {
  const sources = FEATURE_SOURCES;
  const pairs = sources.flatMap((existing) => sources.map((incoming) => [existing, incoming] as const));

  it.each(pairs)("existing %s, incoming %s", async (existing, incoming) => {
    const w = world();
    const first = await w.a.create({ name: "First" }, ada);
    const second = await w.a.create({ name: "Second" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: first.id, source: existing }, ada);
    const answer = await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: second.id, source: incoming }, ada);
    const [old, next] = [FEATURE_SOURCE_RANK[existing], FEATURE_SOURCE_RANK[incoming]];
    const replaces = next > old || (next === old && PERSON_FEATURE_SOURCES.includes(incoming));
    expect(answer.outcome).toBe(replaces ? "set" : "kept");
    expect(answer.record).toMatchObject(replaces ? { featureId: second.id, source: incoming } : { featureId: first.id, source: existing });
    expect(await w.a.taskFeature(TASK)).toEqual(answer.record);
  });

  it("the rank order is moved, chosen, tracker, inherited, confirmed at plan", () => {
    expect(["moved", "chosen", "tracker", "inherited", "confirmed_at_plan"].map((s) => FEATURE_SOURCE_RANK[s as FeatureSource])).toEqual([5, 4, 3, 2, 1]);
  });

  it("'No feature' on purpose is a person's move: a tracker read cannot file the task afterwards; a later move can", async () => {
    const w = world();
    const f = await w.a.create({ name: "F" }, ada);
    const none = await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: null, source: "moved" }, ada);
    expect(none.record.featureId).toBeNull();
    expect((await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "tracker" }, ada)).outcome).toBe("kept");
    expect((await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "moved" }, ada)).outcome).toBe("set");
  });

  it("the same answer again writes nothing more (no new version, no audit record)", async () => {
    const w = world();
    const f = await w.a.create({ name: "F" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada);
    const events = w.events.length;
    const again = await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada);
    expect(again).toMatchObject({ outcome: "kept", record: { version: 1 } });
    expect(w.events).toHaveLength(events);
  });

  it("each change that is written has its own audit record with the source, the feature and the project (and no second one is lost)", async () => {
    const w = world();
    const f = await w.a.create({ name: "F" }, ada);
    const g = await w.a.create({ name: "G" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: g.id, source: "moved" }, ada);
    const filed = w.events.filter((e) => e.action === "report.task_feature_set");
    expect(filed.map((e) => e.eventId)).toHaveLength(2);
    expect(new Set(filed.map((e) => e.eventId)).size).toBe(2);
    expect(filed[1]).toMatchObject({ subject: { type: "task", id: TASK }, details: { featureId: g.id, source: "moved", project: "alpha" } });
  });

  it("inherits: the task takes the feature it came from (as it reads now), or nothing", async () => {
    const w = world();
    const from = await w.a.create({ name: "From" }, ada);
    const into = await w.a.create({ name: "Into" }, ada);
    expect(await w.a.inheritFeature({ from: TASK, to: TASK2, project: "alpha" })).toBeUndefined();
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: from.id, source: "chosen" }, ada);
    await w.a.merge(from.id, into.id, ada);
    const inherited = await w.a.inheritFeature({ from: TASK, to: TASK2, project: "alpha" });
    expect(inherited).toMatchObject({ outcome: "set", record: { featureId: into.id, source: "inherited" } });
    expect(w.events.at(-1)).toMatchObject({ actor: { type: "system" } });
  });

  it("inherits nothing from a task filed under no feature, from a done feature, or over a higher rule", async () => {
    const w = world();
    const f = await w.a.create({ name: "F" }, ada);
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: null, source: "chosen" }, ada);
    expect(await w.a.inheritFeature({ from: TASK, to: TASK2, project: "alpha" })).toBeUndefined();
    await w.a.setTaskFeature({ taskId: TASK, project: "alpha", featureId: f.id, source: "chosen" }, ada);
    await w.a.setTaskFeature({ taskId: TASK2, project: "alpha", featureId: null, source: "chosen" }, ada);
    expect((await w.a.inheritFeature({ from: TASK, to: TASK2, project: "alpha" }))!.outcome).toBe("kept");
    await w.a.setState(f.id, "done", ada);
    expect(await w.a.inheritFeature({ from: TASK, to: "33333333-3333-4333-8333-333333333333", project: "alpha" })).toBeUndefined();
  });

  it("a task id that is not a task id reads as no assignment", async () => {
    const w = world();
    expect(await w.a.taskFeature("not-a-task")).toBeUndefined();
    await expect(w.a.setTaskFeature({ taskId: "not-a-task", project: "alpha", featureId: null, source: "chosen" }, ada)).rejects.toThrow();
  });
});
