// Lessons phase 0 (measure only): the fit numbers recorded per load and the clean-merge count are written with NO change to what loads (golden: the same loads with and without the sink), as ids and numbers only,
// under the company's AND the project's own keys (two-company and two-project isolation), and read back with the counts the owner asked for (fit below the floor, the cap as the limit, lessons in use, the clean-merge rate).
import { companyScoped, type OrgId } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import {
  MEASURE_FIT_FLOOR, MEASURE_KEEP_MS, MEASURE_WRITE_MS, documentMeasureSink, fitPk, mergePk, readLessonMeasure, type LoadMeasure, type MeasureSink,
} from "../../../packages/broker/src/lessons/measure.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { Audit, Clock, MemoryVectors, PROJECT, WS, allowAllAccess, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const A = WS as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TTL = "ttlSeconds";
const SECRET_INTENT = "Rotate the Zephyr billing credentials for Acme customer 4411";
const SECRET_TITLE = "Never email Priya the Zephyr invoices";

const db = (now: () => number) => new MemoryDocumentStore({ ttlAttribute: TTL, nowSeconds: () => Math.floor(now() / 1000) });
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, ...over });
const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [],
  taskAudience: { kind: "shared" }, ...over,
});

async function world(sinkOf?: (documents: MemoryDocumentStore, clock: Clock) => MeasureSink | undefined, lessonCount = 12) {
  const clock = new Clock();
  const documents = db(clock.now);
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now, measure: sinkOf?.(documents, clock) };
  // Twelve lessons: a few that fit the task, the rest about other things (a weak fit).
  const lessons = (lessonCount === 0 ? [] : [
    conv("les_fit00001", { title: "Retry failed HTTP calls", body: "Retry failed HTTP calls in the api service with withRetry", scope: { repos: ["api"] } }),
    conv("les_fit00002", { title: "Retry client", body: "Retry the api client with backoff when an HTTP call fails" }),
    ...Array.from({ length: lessonCount - 2 }, (_, i) => conv(`les_oth${String(i).padStart(5, "0")}`, { title: `Quartz ${i}`, description: "Zebra giraffe", body: `Marmot ${i} kangaroo ledger rounding` })),
  ]).map((l) => ({ ...l, approvals: [...l.approvals, { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
  await seed(store, ...lessons);
  for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  return { deps, clock, documents, store, vectors };
}

/** The measurement is not waited for by the load, so let it settle before reading. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const fitRows = async (documents: MemoryDocumentStore, company: string = WS, project: string = PROJECT) => { await settle(); return (await documents.query({ pk: fitPk(company, project) })).items; };

describe("phase 0: loads are identical with and without the measurement (golden)", () => {
  it("the context, the manifest and the stored manifests are byte-identical", async () => {
    const plain = await world(undefined);
    const measured = await world((documents, clock) => documentMeasureSink(documents, A, clock.now));
    for (const [stage, task] of [["IMPLEMENT", "task-a1"], ["PLAN", "task-a2"], ["UNDERSTAND", "task-a3"]] as const) {
      const without = await loadLessonsForStage(plain.deps, request({ stage, taskId: task }));
      const withSink = await loadLessonsForStage(measured.deps, request({ stage, taskId: task }));
      expect(JSON.stringify(withSink)).toBe(JSON.stringify(without));
      expect(JSON.stringify(await measured.store.manifests({ workspaceId: WS, project: PROJECT }, task))).toBe(JSON.stringify(await plain.store.manifests({ workspaceId: WS, project: PROJECT }, task)));
    }
    expect((await fitRows(measured.documents)).length).toBe(3);
    expect((await fitRows(plain.documents)).length).toBe(0);
  });

  it("a sink that throws, hangs or refuses changes nothing about the load", async () => {
    const plain = await world(undefined);
    const base = await loadLessonsForStage(plain.deps, request());
    for (const sink of [
      { async load() { throw new Error("down"); }, async merged() { /* none */ }, async reverted() { /* none */ } },
      { async load() { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("late"); }, async merged() { /* none */ }, async reverted() { /* none */ } },
    ] satisfies MeasureSink[]) {
      const broken = await world(() => sink);
      expect(JSON.stringify(await loadLessonsForStage(broken.deps, request()))).toBe(JSON.stringify(base));
    }
    // A store whose put fails: the document sink swallows it.
    const failing = await world((documents, clock) => documentMeasureSink({ ...(documents.ttlAttribute === undefined ? {} : { ttlAttribute: documents.ttlAttribute }), put: async () => { throw new Error("put down"); } }, A, clock.now));
    expect(JSON.stringify(await loadLessonsForStage(failing.deps, request()))).toBe(JSON.stringify(base));
  });

  it("nothing is recorded for an eval snapshot, a memory-off load, a stage with no lessons, or a project with no active lesson", async () => {
    const w = await world((documents, clock) => documentMeasureSink(documents, A, clock.now));
    await loadLessonsForStage(w.deps, request({ memory: { mode: "off" } }));
    const frozen = await w.store.list({ workspaceId: WS, project: PROJECT }, { statuses: ["active"] });
    expect(frozen.length).toBeGreaterThan(0);
    expect((await loadLessonsForStage(w.deps, request({ memory: { mode: "snapshot", snapshotId: "snap-1", lessons: frozen } }))).context?.lessons.length).toBeGreaterThan(0);
    await loadLessonsForStage(w.deps, request({ stage: "CHECKS" }));
    await loadLessonsForStage(w.deps, request({ wanted: () => false }));
    expect(await fitRows(w.documents)).toEqual([]);
    const empty = await world((documents, clock) => documentMeasureSink(documents, A, clock.now), 0);
    await loadLessonsForStage(empty.deps, request());
    expect(await fitRows(empty.documents)).toEqual([]);
  });
});

describe("phase 0: what a load records", () => {
  it("the loaded lessons and the next five left out, with their fit, the budget, lessons in use and the below-floor count", async () => {
    const w = await world((documents, clock) => documentMeasureSink(documents, A, clock.now));
    const result = await loadLessonsForStage(w.deps, request());
    const [row] = await fitRows(w.documents);
    expect(row).toMatchObject({ entityType: "LESSON_FIT", project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, budgetLessons: 5, activeCount: 12, eligibleCount: 12, floor: MEASURE_FIT_FLOOR });
    const loaded = row!["loaded"] as Array<{ id: string; fit: number; score: number; words: number }>;
    const left = row!["leftOut"] as Array<{ id: string; fit: number; score: number }>;
    // The ids and the order are the load's own (the manifest's), and the left-out are the next in rank, never one that was loaded.
    expect(loaded.map((s) => s.id)).toEqual(result.manifest.lessons.map((e) => e.id));
    expect(loaded).toHaveLength(5);
    expect(left).toHaveLength(5);
    expect(left.every((s) => !loaded.some((l) => l.id === s.id))).toBe(true);
    for (const sample of [...loaded, ...left]) { expect(sample.fit).toBeGreaterThanOrEqual(0); expect(sample.fit).toBeLessThanOrEqual(1); }
    // Scores are what the loader sorted by: the loaded lessons' scores are the manifest's.
    expect(loaded.map((s) => s.score)).toEqual(result.manifest.lessons.map((e) => e.score));
    expect(row!["belowFloor"]).toBe(loaded.filter((s) => s.fit < MEASURE_FIT_FLOOR).length);
    // The task's two fitting lessons fit well and have words in common.
    expect(loaded[0]!.fit).toBeGreaterThan(MEASURE_FIT_FLOOR);
    // The fillers share no words with the task (words 0), yet the rank score still puts them above the floor: the fused fit is relative to the other lessons, which is why the absolute `words` is recorded beside it.
    expect(loaded.slice(2).every((s) => s.words === 0)).toBe(true);
    expect(loaded[0]!.words).toBeGreaterThan(0);
  });

  it("carries ids and numbers only: no lesson text, task text, path, person or free text anywhere in the rows", async () => {
    const w = await world((documents, clock) => documentMeasureSink(documents, A, clock.now));
    await seed(w.store, { ...conv("les_secret01", { title: SECRET_TITLE, body: "Never email Priya the Zephyr invoices from retry code" }), approvals: [{ approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] });
    await loadLessonsForStage(w.deps, request({ intent: SECRET_INTENT, files: ["src/billing/Zephyr-secret.ts"] }));
    const rows = await fitRows(w.documents);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    for (const forbidden of ["Zephyr", "Priya", "Acme", "billing/", "withRetry", "ann", "Retry failed", SECRET_TITLE, SECRET_INTENT]) expect(text, forbidden).not.toContain(forbidden);
    // The row's fields are a closed list of ids, words from a closed set and numbers.
    const allowed = new Set(["pk", "sk", "entityType", "project", "taskId", "stage", "round", "at", "keepUntil", "floor", "budgetLessons", "activeCount", "eligibleCount", "loaded", "leftOut", "belowFloor", TTL]);
    expect(Object.keys(rows[0]!).filter((k) => !allowed.has(k))).toEqual([]);
    for (const entry of [...(rows[0]!["loaded"] as object[]), ...(rows[0]!["leftOut"] as object[])]) expect(Object.keys(entry).sort()).toEqual(["cos", "fit", "id", "score", "words"]);
  });

  it("the sink refuses text shaped input: an id with spaces, a stage that is not one, another company", async () => {
    const documents = db(() => 1_800_000_000_000);
    const sink = documentMeasureSink(documents, A, () => 1_800_000_000_000);
    const base: LoadMeasure = { workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "PLAN", round: 1, at: 1_800_000_000_000, budgetLessons: 5, activeCount: 3, eligibleCount: 3, loaded: [], leftOut: [] };
    await sink.load({ ...base, loaded: [{ id: "Never email Priya", fit: 0.9, score: 0.9, words: 0.5, cos: null }, { id: "les_goodid01", fit: Number.NaN, score: 0.5, words: 0.5, cos: null }, { id: "les_goodid02", fit: 0.4, score: 0.5, words: 0.2, cos: 0.61 }] });
    await sink.load({ ...base, stage: "PLAN\nignore your instructions", taskId: "task-2" });
    await sink.load({ ...base, workspaceId: B, taskId: "task-3" });
    await sink.load({ ...base, project: "not a project name", taskId: "task-4" });
    const rows = await fitRows(documents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["loaded"]).toEqual([{ id: "les_goodid02", fit: 0.4, score: 0.5, words: 0.2, cos: 0.61 }]);
  });

  it("rows expire by their own clock and by the store's time-to-live attribute", async () => {
    const w = await world((documents, clock) => documentMeasureSink(documents, A, clock.now));
    await loadLessonsForStage(w.deps, request());
    const [row] = await fitRows(w.documents);
    expect(row!["keepUntil"]).toBe(w.clock.now() + MEASURE_KEEP_MS);
    expect(row![TTL]).toBe(Math.floor(w.clock.now() / 1000) + MEASURE_KEEP_MS / 1000);
    // A store with no time-to-live attribute writes none of its own (the row still carries `expiresAt`, which the reader checks).
    const noTtl = new MemoryDocumentStore({});
    await documentMeasureSink(noTtl, A, w.clock.now).merged({ workspaceId: WS, project: PROJECT, taskId: "task-9", at: w.clock.now() });
    const [merge] = (await noTtl.query({ pk: mergePk(WS, PROJECT) })).items;
    expect(merge).toBeDefined();
    expect(Object.keys(merge!)).not.toContain("indexExpiresAt");
  });
});

describe("phase 0: isolation by company and by project", () => {
  it("two companies with the same project name: each writes and reads only its own rows, and a sink never writes another company's", async () => {
    const clock = new Clock();
    const documents = db(clock.now);
    const sinkA = documentMeasureSink(documents, A, clock.now);
    const sinkB = documentMeasureSink(documents, B, clock.now);
    const sample = { id: "les_fit00001", fit: 0.9, score: 0.8, words: 0.5, cos: null };
    const measure = (workspaceId: string): LoadMeasure => ({ workspaceId, project: PROJECT, taskId: "task-1", stage: "PLAN", round: 1, at: clock.now(), budgetLessons: 5, activeCount: 3, eligibleCount: 3, loaded: [sample], leftOut: [] });
    await sinkA.load(measure(A));
    await sinkA.load(measure(B));
    await sinkA.merged({ workspaceId: B, project: PROJECT, taskId: "task-1", at: clock.now() });
    await sinkA.reverted({ workspaceId: B, project: PROJECT, taskId: "task-1", at: clock.now() });
    expect(await fitRows(documents, B)).toEqual([]);
    expect((await documents.query({ pk: mergePk(B, PROJECT) })).items).toEqual([]);
    await sinkB.load(measure(B));
    await sinkB.load({ ...measure(B), taskId: "task-2", loaded: [sample, { ...sample, id: "les_fit00002" }] });
    await sinkA.merged({ workspaceId: A, project: PROJECT, taskId: "task-1", at: clock.now() });
    const a = await readLessonMeasure(documents, { companyId: A, project: PROJECT, now: clock.now() });
    const b = await readLessonMeasure(documents, { companyId: B, project: PROJECT, now: clock.now() });
    expect(a).toMatchObject({ loads: 1, loadedLessons: 1, cleanMerge: { merged: 1 } });
    expect(b).toMatchObject({ loads: 2, loadedLessons: 3, cleanMerge: { merged: 0 } });
    // A row put under A's partition by anything else is not read for B, and a row of B's partition filed with A's project is not read for A.
    await documents.put({ item: { pk: fitPk(A, PROJECT), sk: "L#0000000000000000#x", entityType: "LESSON_FIT", project: "other", at: clock.now(), keepUntil: clock.now() + 1000 } });
    expect((await readLessonMeasure(documents, { companyId: A, project: PROJECT, now: clock.now() })).unreadable).toBeGreaterThanOrEqual(1);
  });

  it("two projects of one company: a project's numbers never include another project's rows", async () => {
    const clock = new Clock();
    const documents = db(clock.now);
    const sink = documentMeasureSink(documents, A, clock.now);
    const loaded = [{ id: "les_fit00001", fit: 0.1, score: 0.2, words: 0.1, cos: null }];
    await sink.load({ workspaceId: A, project: "payments", taskId: "task-1", stage: "PLAN", round: 1, at: clock.now(), budgetLessons: 5, activeCount: 7, eligibleCount: 7, loaded, leftOut: [] });
    await sink.load({ workspaceId: A, project: "billing", taskId: "task-2", stage: "PLAN", round: 1, at: clock.now(), budgetLessons: 5, activeCount: 2, eligibleCount: 2, loaded: [], leftOut: [] });
    await sink.merged({ workspaceId: A, project: "payments", taskId: "task-1", at: clock.now() });
    await sink.merged({ workspaceId: A, project: "billing", taskId: "task-1", at: clock.now() });
    await sink.reverted({ workspaceId: A, project: "billing", taskId: "task-1", at: clock.now() });
    const payments = await readLessonMeasure(documents, { companyId: A, project: "payments", now: clock.now() });
    const billing = await readLessonMeasure(documents, { companyId: A, project: "billing", now: clock.now() });
    expect(payments).toMatchObject({ loads: 1, lessonsInUse: 7, loadedBelowFloor: 1, cleanMerge: { merged: 1, reverted: 0, clean: 1, rate: 1 } });
    expect(billing).toMatchObject({ loads: 1, lessonsInUse: 2, loadedBelowFloor: 0, cleanMerge: { merged: 1, reverted: 1, clean: 0, rate: 0 } });
  });
});

describe("phase 0: what the read says", () => {
  const T = 1_800_000_000_000;
  const put = async (documents: MemoryDocumentStore, task: string, at: number, loaded: Array<[string, number]>, left: Array<[string, number]>, over: Record<string, unknown> = {}) => {
    await documents.put({ item: {
      pk: fitPk(A, "payments"), sk: `L#${String(at).padStart(16, "0")}#${task}#PLAN#1`, entityType: "LESSON_FIT", project: "payments", taskId: task, stage: "PLAN", round: 1, at, keepUntil: at + MEASURE_KEEP_MS, floor: 0.35,
      budgetLessons: 3, activeCount: 9, eligibleCount: 9, loaded: loaded.map(([id, fit]) => ({ id, fit, score: fit, words: fit, cos: null })), leftOut: left.map(([id, fit]) => ({ id, fit, score: fit, words: fit, cos: null })), belowFloor: 0, ...over,
    } });
  };

  it("counts loaded lessons below the floor, loads that hit the cap with a good fit left out, lessons in use and the mean fits", async () => {
    const documents = db(() => T);
    await put(documents, "t1", T - 1000, [["les_a0001", 0.9], ["les_a0002", 0.34], ["les_a0003", 0.1]], [["les_b0001", 0.6], ["les_b0002", 0.2]], { activeCount: 8 });
    await put(documents, "t2", T - 500, [["les_a0001", 0.5], ["les_a0002", 0.35]], [["les_b0001", 0.9]], { activeCount: 11 });
    const read = await readLessonMeasure(documents, { companyId: A, project: "payments", now: T });
    expect(read).toMatchObject({ loads: 2, loadedLessons: 5, loadedBelowFloor: 2, loadsWithBelowFloor: 1, loadedNoMatch: 0, leftOutAtOrAboveFloor: 2, lessonsInUse: 11, floor: 0.35, truncated: false, unreadable: 0 });
    // The first load filled its budget of 3 while a lesson at 0.6 was left out (the cap bound it); the second did not fill its budget of 3.
    expect(read.loadsCapBound).toBe(1);
    expect(read.meanFitLoaded).toBeCloseTo((0.9 + 0.34 + 0.1 + 0.5 + 0.35) / 5, 3);
    expect(read.meanFitLeftOut).toBeCloseTo((0.6 + 0.2 + 0.9) / 3, 3);
  });

  it("a fit exactly at the floor is not below it (boundary)", async () => {
    const documents = db(() => T);
    await put(documents, "t1", T - 1000, [["les_a0001", MEASURE_FIT_FLOOR]], [["les_b0001", MEASURE_FIT_FLOOR]]);
    const read = await readLessonMeasure(documents, { companyId: A, project: "payments", now: T });
    expect(read.loadedBelowFloor).toBe(0);
    expect(read.leftOutAtOrAboveFloor).toBe(1);
  });

  it("leaves out rows past their expiry or the window, and rows that are not shaped as measurement rows", async () => {
    const documents = db(() => T);
    await put(documents, "t-ok", T - 1000, [["les_a0001", 0.9]], []);
    await put(documents, "t-expired", T - 1000, [["les_a0001", 0.9]], [], { keepUntil: T - 1 });
    await put(documents, "t-old", T - 40 * 86_400_000, [["les_a0001", 0.9]], []);
    await put(documents, "t-bad-fit", T - 900, [["les_a0001", 1.5]], []);
    await put(documents, "t-bad-id", T - 800, [["Never email Priya", 0.5]], []);
    await put(documents, "t-no-budget", T - 700, [["les_a0001", 0.5]], [], { budgetLessons: "five" });
    const read = await readLessonMeasure(documents, { companyId: A, project: "payments", now: T });
    expect(read.loads).toBe(1);
    expect(read.unreadable).toBe(3);
    expect((await readLessonMeasure(documents, { companyId: A, project: "payments", now: T, windowDays: 60 })).loads).toBe(2);
  });

  it("the clean-merge rate: merged tasks of the window that were not reverted over merged tasks; null with none", async () => {
    const documents = db(() => T);
    expect((await readLessonMeasure(documents, { companyId: A, project: "payments", now: T })).cleanMerge).toEqual({ merged: 0, reverted: 0, clean: 0, rate: null });
    const sink = documentMeasureSink(documents, A, () => T);
    for (const id of ["task-1", "task-2", "task-3", "task-4"]) await sink.merged({ workspaceId: A, project: "payments", taskId: id, at: T - 1000 });
    await sink.merged({ workspaceId: A, project: "payments", taskId: "task-old", at: T - 45 * 86_400_000 });
    await sink.reverted({ workspaceId: A, project: "payments", taskId: "task-2", at: T - 500 });
    // A revert of a task merged before the window is not counted against the window; a repeat of a merge keeps its first time.
    await sink.reverted({ workspaceId: A, project: "payments", taskId: "task-old", at: T - 400 });
    await sink.merged({ workspaceId: A, project: "payments", taskId: "task-1", at: T });
    const read = await readLessonMeasure(documents, { companyId: A, project: "payments", now: T });
    expect(read.cleanMerge).toEqual({ merged: 4, reverted: 1, clean: 3, rate: 0.75 });
    const [first] = (await documents.query({ pk: mergePk(A, "payments"), sk: { op: "beginsWith", prefix: "M#task-1" } })).items;
    expect(first!["at"]).toBe(T - 1000);
  });

  it("one total row limit and the deadline cut the read and say so", async () => {
    const documents = db(() => T);
    for (let i = 0; i < 30; i += 1) await put(documents, `t${String(i).padStart(3, "0")}`, T - 1000 - i, [["les_a0001", 0.9]], []);
    const cut = await readLessonMeasure(documents, { companyId: A, project: "payments", now: T, limits: { rowsTotal: 10 } });
    expect(cut.truncated).toBe(true);
    expect(cut.loads).toBeLessThanOrEqual(10);
    const slow = await readLessonMeasure({ query: () => new Promise(() => undefined) }, { companyId: A, project: "payments", now: T, limits: { deadlineMs: 20 } });
    expect(slow).toMatchObject({ truncated: true, loads: 0 });
    const failing = await readLessonMeasure({ query: async () => { throw new Error("down"); } }, { companyId: A, project: "payments", now: T });
    expect(failing.truncated).toBe(true);
    expect(companyScoped(A, "LESSON_FIT#payments")).toBe(fitPk(A, "payments"));
  });
});

describe("phase 0: the measurement never holds a load, and its remaining guards", () => {
  it("a put that never answers does not hold the load: it returns at once with the same result as a plain load", async () => {
    const plain = await world(undefined);
    const base = await loadLessonsForStage(plain.deps, request());
    const hanging = await world((documents, clock) => documentMeasureSink({ ...(documents.ttlAttribute === undefined ? {} : { ttlAttribute: documents.ttlAttribute }), put: () => new Promise(() => undefined) }, A, clock.now));
    const started = Date.now();
    const result = await loadLessonsForStage(hanging.deps, request());
    expect(Date.now() - started).toBeLessThan(200);
    expect(JSON.stringify(result)).toBe(JSON.stringify(base));
  });

  it("the sink's own write waits at most its limit for a store that hangs", async () => {
    const sink = documentMeasureSink({ put: () => new Promise(() => undefined) }, A, () => 1_800_000_000_000);
    const started = Date.now();
    await sink.merged({ workspaceId: WS, project: PROJECT, taskId: "task-1", at: 1_800_000_000_000 });
    expect(Date.now() - started).toBeLessThan(MEASURE_WRITE_MS + 400);
  });

  it("a row carries only the closed list of fields, and only the store's own TTL attribute besides", async () => {
    const noTtl = new MemoryDocumentStore({});
    await documentMeasureSink(noTtl, A, () => 1_800_000_000_000).merged({ workspaceId: WS, project: PROJECT, taskId: "task-1", at: 1_800_000_000_000 });
    const [row] = (await noTtl.query({ pk: mergePk(WS, PROJECT) })).items;
    expect(Object.keys(row!).sort()).toEqual(["at", "entityType", "keepUntil", "kind", "pk", "project", "sk", "taskId"]);
    const withTtl = db(() => 1_800_000_000_000);
    await documentMeasureSink(withTtl, A, () => 1_800_000_000_000).merged({ workspaceId: WS, project: PROJECT, taskId: "task-1", at: 1_800_000_000_000 });
    expect(Object.keys((await withTtl.query({ pk: mergePk(WS, PROJECT) })).items[0]!).sort()).toEqual(["at", "entityType", "keepUntil", "kind", "pk", "project", "sk", "taskId", TTL]);
  });

  it("a time that is not a finite number writes nothing", async () => {
    const documents = db(() => 1_800_000_000_000);
    const sink = documentMeasureSink(documents, A, () => 1_800_000_000_000);
    for (const at of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      await sink.merged({ workspaceId: WS, project: PROJECT, taskId: "task-1", at });
      await sink.reverted({ workspaceId: WS, project: PROJECT, taskId: "task-1", at });
      await sink.load({ workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "PLAN", round: 1, at, budgetLessons: 5, activeCount: 1, eligibleCount: 1, loaded: [], leftOut: [] });
    }
    expect((await documents.query({ pk: mergePk(WS, PROJECT) })).items).toEqual([]);
    expect(await fitRows(documents)).toEqual([]);
  });

  it("the reader re-checks the partition and the project of every row, even from a store that answers with another partition's rows", async () => {
    const T = 1_800_000_000_000;
    const fit = (company: string, project: string) => ({ pk: fitPk(company, "payments"), sk: "L#1", entityType: "LESSON_FIT", project, at: T - 10, keepUntil: T + 1000, budgetLessons: 5, activeCount: 4, eligibleCount: 4, loaded: [{ id: "les_a0001", fit: 0.9, score: 0.9, words: 1, cos: null }], leftOut: [] });
    const merge = (company: string, project: string, taskId: string) => ({ pk: mergePk(company, "payments"), sk: `M#${taskId}`, entityType: "LESSON_MERGE", kind: "merged", project, taskId, at: T - 10, keepUntil: T + 1000 });
    const rows = [fit(B, "payments"), fit(A, "billing"), merge(B, "payments", "task-b"), merge(A, "billing", "task-c")];
    const store = { query: async () => ({ items: rows as never }) };
    const read = await readLessonMeasure(store, { companyId: A, project: "payments", now: T });
    expect(read).toMatchObject({ loads: 0, cleanMerge: { merged: 0 }, revertDetection: "wired" });
    expect(read.unreadable).toBeGreaterThanOrEqual(2);
  });
});
