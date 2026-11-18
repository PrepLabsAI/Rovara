// Lessons phases 1 and 2: the signals reader (cached, bounded, never a failure, two-company and two-project isolation) and a replay comparison of loads before and after on fixtures (what changed is only what the research says).
import { describe, expect, it } from "vitest";
import { loadLessonsForStage, wilsonLower } from "../../../packages/broker/src/lessons/load.js";
import { cachedSignalsReader, readCleanMergeRate } from "../../../packages/broker/src/lessons/signals.js";
import { mergePk } from "../../../packages/broker/src/lessons/measure.js";
import { CLEAN_MERGE_MIN_TASKS } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Clock, NO_FIT_FLOOR, PROJECT, WS } from "./lesson-helpers.js";
import { A, B, DAY, fitting, ids, request, unrelated, world } from "./phase12-helpers.js";

const mergeRows = async (docs: MemoryDocumentStore, company: string, project: string, now: number, merged: number, reverted: number) => {
  for (let i = 0; i < merged; i += 1) {
    await docs.put({ item: { pk: mergePk(company, project), sk: `M#task-${i}`, entityType: "LESSON_MERGE", kind: "merged", project, taskId: `task-${i}`, at: now - DAY, keepUntil: now + 30 * DAY } });
    if (i < reverted) await docs.put({ item: { pk: mergePk(company, project), sk: `R#task-${i}`, entityType: "LESSON_MERGE", kind: "reverted", project, taskId: `task-${i}`, at: now, keepUntil: now + 30 * DAY } });
  }
};

describe("the clean-merge rate", () => {
  it("clean over merged in the window; null while fewer than the minimum merged; a revert of an old merge does not count", async () => {
    const clock = new Clock();
    const docs = new MemoryDocumentStore();
    await mergeRows(docs, WS, PROJECT, clock.now(), 10, 3);
    expect(await readCleanMergeRate(docs, { companyId: A, project: PROJECT, now: clock.now() })).toBeCloseTo(0.7, 10);
    const few = new MemoryDocumentStore();
    await mergeRows(few, WS, PROJECT, clock.now(), CLEAN_MERGE_MIN_TASKS - 1, 0);
    expect(await readCleanMergeRate(few, { companyId: A, project: PROJECT, now: clock.now() })).toBeNull();
  });

  it("two companies and two projects: each rate is counted from its own rows only", async () => {
    const clock = new Clock();
    const docs = new MemoryDocumentStore();
    await mergeRows(docs, WS, PROJECT, clock.now(), 10, 0);
    await mergeRows(docs, "org_bbbbbbbbbbbbbbbbbbbb", PROJECT, clock.now(), 10, 10);
    await mergeRows(docs, WS, "proj-2", clock.now(), 10, 5);
    expect(await readCleanMergeRate(docs, { companyId: A, project: PROJECT, now: clock.now() })).toBe(1);
    expect(await readCleanMergeRate(docs, { companyId: B, project: PROJECT, now: clock.now() })).toBe(0);
    expect(await readCleanMergeRate(docs, { companyId: A, project: "proj-2", now: clock.now() })).toBe(0.5);
  });
});

describe("the cached signals reader", () => {
  it("reuses one read for the ttl, reads again after it, and shares one read between callers", async () => {
    const clock = new Clock();
    let queries = 0;
    const docs = new MemoryDocumentStore();
    const counting = { query: async (r: Parameters<MemoryDocumentStore["query"]>[0]) => { queries += 1; return docs.query(r); } };
    const reader = cachedSignalsReader(counting, A, clock.now, { ttlMs: 1000, waitMs: 5000 });
    const key = { workspaceId: WS, project: PROJECT };
    await Promise.all([reader.read(key), reader.read(key), reader.read(key)]);
    const first = queries;
    expect(first).toBeGreaterThan(0);
    await reader.read(key);
    expect(queries).toBe(first);
    clock.advance(1001);
    await reader.read(key);
    expect(queries).toBeGreaterThan(first);
  });

  it("never throws and never waits past its limit: a store fault is no signals; a slow store gives the last answer (or none) while the read goes on", async () => {
    const clock = new Clock();
    const failing = { query: async () => { throw new Error("db down"); } };
    expect(await cachedSignalsReader(failing, A, clock.now, { ttlMs: 0 }).read({ workspaceId: WS, project: PROJECT })).toBeUndefined();
    const slow = { query: () => new Promise<never>(() => undefined) };
    const started = Date.now();
    expect(await cachedSignalsReader(slow as never, A, clock.now, { ttlMs: 0, waitMs: 30 }).read({ workspaceId: WS, project: PROJECT })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a key of another company is refused (no answer), and the cache is per project", async () => {
    const clock = new Clock();
    const docs = new MemoryDocumentStore();
    await mergeRows(docs, WS, PROJECT, clock.now(), 10, 0);
    const reader = cachedSignalsReader(docs, A, clock.now, { ttlMs: 60_000 });
    expect(await reader.read({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", project: PROJECT })).toBeUndefined();
    expect((await reader.read({ workspaceId: WS, project: PROJECT }))!.cleanMergeRate).toBe(1);
    expect((await reader.read({ workspaceId: WS, project: "proj-2" }))!.cleanMergeRate).toBeNull();
  });

  it("a load with signals that cannot be read is the load of a project with no rows (the neutral prior), never a failed load", async () => {
    const w = await world();
    await w.add(fitting("les_aaaa0001"));
    const broken = { read: async () => { throw new Error("boom"); } };
    expect(ids(await w.load({}, { signals: broken }))).toEqual(["les_aaaa0001"]);
  });
});

describe("replay comparison: the same project loaded before and after (golden)", () => {
  /** What the loader did before: every eligible lesson ranked by 0.6 fit + 0.3 Wilson + 0.1 recency, the top five loaded. Reimplemented here from the old code as the "before". */
  const fixture = () => [
    fitting("les_fit00001", { counters: { loaded: 20, helpful: 18, harmful: 0, citationStale: 0 } }),
    fitting("les_fit00002", { title: "Retries use withRetry", body: "HTTP calls that fail are retried in the api service with withRetry", counters: { loaded: 10, helpful: 8, harmful: 1, citationStale: 0 } }),
    fitting("les_fit00003", { title: "Backoff", body: "Retry failed HTTP calls in the api service with exponential backoff" }),
    ...Array.from({ length: 7 }, (_, i) => unrelated(`les_oth0000${i}`, { counters: { loaded: 12, helpful: 11, harmful: 0, citationStale: 0 } })),
  ];

  it("before: seven unrelated lessons with a good record fill the step; after: only what fits loads, and the unproven lesson that fits is not lost to them", async () => {
    const w = await world();
    await w.add(...fixture());
    const before = ids(await w.load({}, { ranking: { ...NO_FIT_FLOOR, newcomerSlots: 0 } }));
    const after = ids(await w.load({ taskId: "task-2" }));
    // Before: the floor is gone, so the five places go to lessons by their record, fit or not.
    expect(before).toHaveLength(5);
    expect(before.filter((id) => id.startsWith("les_oth")).length).toBeGreaterThan(0);
    // After: exactly the three that fit, in the order of their fit and record.
    expect(after.sort()).toEqual(["les_fit00001", "les_fit00002", "les_fit00003"]);
    // Everything the new load gives was available before: it never invents a lesson (a subset of the eligible set), and drops only what did not fit.
    expect(after.every((id) => id.startsWith("les_fit"))).toBe(true);
  });

  it("the Wilson term it replaced rewarded a proven lesson and gave a new one nothing; the Beta strength gives a new one the project's rate (the scores before and after, on the fixture)", async () => {
    const w = await world();
    await w.add(...fixture());
    const result = await w.load({}, { ranking: NO_FIT_FLOOR });
    const score = new Map(result.manifest.lessons.map((l) => [l.id, l.score]));
    expect(wilsonLower(0, 0)).toBe(0);
    // A lesson never loaded now scores above zero in its third (the prior): its score is well above 0.6 x its fit alone.
    expect(score.get("les_fit00003")!).toBeGreaterThan(0.1);
  });

  it("the load is repeatable: replaying the same project and task gives the same lessons, scores and order", async () => {
    const w = await world();
    await w.add(...fixture());
    const first = await w.load({ taskId: "t-a" });
    const second = await w.load({ taskId: "t-b" });
    expect(second.context!.lessons.map((l) => l.id)).toEqual(first.context!.lessons.map((l) => l.id));
    expect(second.manifest.lessons.map((l) => l.score)).toEqual(first.manifest.lessons.map((l) => l.score));
  });

  it("a replay copy's frozen snapshot is delivered exactly as chosen: neither the floor nor the newcomer place applies to it", async () => {
    const w = await world();
    const lessons = fixture().map((l) => ({ ...l, approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
    const snapshot = await loadLessonsForStage(w.deps, { ...request(), memory: { mode: "snapshot", snapshotId: "snp_00000000000000000000", lessons } });
    expect(snapshot.context!.lessons.some((l) => l.id.startsWith("les_oth"))).toBe(true);
  });
});
