// Lessons tuning report (lane L4-WK): suggested starting values for the phase 1 and 2 settings from the phase 0 rows. Read only; "not enough data yet (N of M loads)" until there are enough; every number comes from
// the asking company's own project rows (two-company and two-project isolation); ids and numbers only; the suggestions are computed from fixtures with known answers.
import type { OrgId } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { documentMeasureSink, fitPk, mergePk, type FitSample } from "../../../packages/broker/src/lessons/measure.js";
import {
  CAP_BOUND_SHARE, OUTCOME_MIN_TASKS, TUNING_MIN_LESSONS, TUNING_MIN_LOADS, TUNING_MIN_MERGED, TUNING_MIN_SAMPLES, TUNING_NOTE, TUNING_STARTING_VALUES, percentile, readTuningReport, type TuningReport, type TuningSetting,
} from "../../../packages/broker/src/lessons/tuning.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-18T06:00:00.000Z");
const DAY = 86_400_000;
const db = (): MemoryDocumentStore => new MemoryDocumentStore({ ttlAttribute: "ttlSeconds", nowSeconds: () => Math.floor(NOW / 1000) });

interface Spec {
  loads: number; company?: OrgId; project?: string; perLoad?: number; lessons?: number; budget?: number;
  words?: (k: number) => number; cos?: (k: number) => number | null; leftOut?: () => FitSample[]; at?: (i: number) => number;
}
const sample = (id: string, words: number, cos: number | null): FitSample => ({ id, fit: 0.5, score: 0.5, words, cos });
const lessonId = (k: number, lessons: number): string => `les_${String(k % lessons).padStart(4, "0")}`;

/** `loads` loads, each of `perLoad` lessons: the k-th loaded lesson (counting across loads) has words `words(k)` and cosine `cos(k)`. */
async function seedLoads(documents: MemoryDocumentStore, spec: Spec): Promise<void> {
  const sink = documentMeasureSink(documents, spec.company ?? A, () => NOW);
  const per = spec.perLoad ?? 5;
  const lessons = spec.lessons ?? 50;
  for (let i = 0; i < spec.loads; i += 1) {
    const loaded = Array.from({ length: per }, (_unused, j) => { const k = i * per + j; return sample(lessonId(k, lessons), (spec.words ?? (() => 0.4))(k), (spec.cos ?? (() => null))(k)); });
    await sink.load({
      workspaceId: spec.company ?? A, project: spec.project ?? "payments", taskId: `task-${String(i)}`, stage: "IMPLEMENT", round: 1, at: (spec.at ?? ((n: number) => NOW - n * 60_000))(i),
      budgetLessons: spec.budget ?? 5, activeCount: lessons, eligibleCount: lessons, loaded, leftOut: spec.leftOut?.() ?? [],
    });
  }
}
async function seedMerges(documents: MemoryDocumentStore, merged: number, revertedFrom: number, company: OrgId = A, project = "payments"): Promise<void> {
  const sink = documentMeasureSink(documents, company, () => NOW);
  for (let i = 0; i < merged; i += 1) await sink.merged({ workspaceId: company, project, taskId: `task-${String(i)}`, at: NOW - i * 60_000 });
  for (let i = revertedFrom; i < merged; i += 1) await sink.reverted({ workspaceId: company, project, taskId: `task-${String(i)}`, at: NOW - i * 30_000 });
}
const report = (documents: MemoryDocumentStore, over: Partial<Parameters<typeof readTuningReport>[1]> = {}): Promise<TuningReport> => readTuningReport(documents, { companyId: A, project: "payments", now: NOW, ...over });
const suggestion = (r: TuningReport, setting: TuningSetting) => r.suggestions.find((one) => one.setting === setting)!;

/** Words that make the 20th percentile of the loaded lessons land where the test wants it (50 distinct values, three loads of each across 30 loads of 5). */
const wordsAt = (low: number, step: number) => (k: number): number => low + (k % 50) * step;

describe("not enough data yet", () => {
  it("no rows at all: the report says so with the count and suggests nothing", async () => {
    const r = await report(db());
    expect(r).toMatchObject({ project: "payments", windowDays: 30, ready: false, message: `not enough data yet (0 of ${String(TUNING_MIN_LOADS)} loads)`, note: TUNING_NOTE });
    for (const setting of ["fitFloorWords", "fitFloorCosine", "priorWeightUses", "stepLessonCap"] as const) {
      expect(suggestion(r, setting)).toMatchObject({ status: "not_enough_data", suggested: null, current: TUNING_STARTING_VALUES[setting], evidence: { have: 0, needed: TUNING_MIN_LOADS, unit: "loads" }, message: "not enough data yet (0 of 20 loads)" });
    }
    expect(suggestion(r, "weeklyPicks")).toMatchObject({ status: "no_data_source", suggested: null, current: 5 });
    expect(r.evidence).toMatchObject({ loads: 0, mergedTasks: 0, cleanMergeRate: null, meanWordsCleanTasks: null, meanWordsRevertedTasks: null, truncated: false, unreadable: 0 });
  });

  it("one load short of the limit is still not enough; the limit itself is enough", async () => {
    const short = db();
    await seedLoads(short, { loads: TUNING_MIN_LOADS - 1, words: wordsAt(0.3, 0.006) });
    const r = await report(short);
    expect(r).toMatchObject({ ready: false, message: "not enough data yet (19 of 20 loads)" });
    expect(r.suggestions.filter((one) => one.status === "suggested" || one.status === "keep")).toEqual([]);
    const enough = db();
    await seedLoads(enough, { loads: TUNING_MIN_LOADS, words: wordsAt(0.3, 0.006) });
    expect((await report(enough)).ready).toBe(true);
  });

  it("enough loads but too few matches of one kind: that one setting says so with its own count", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: () => 0, cos: () => null });
    await seedMerges(documents, 4, 4);
    const r = await report(documents);
    expect(r.ready).toBe(true);
    expect(suggestion(r, "fitFloorWords")).toMatchObject({ status: "not_enough_data", suggested: null, evidence: { have: 0, needed: TUNING_MIN_SAMPLES }, message: "not enough data yet (0 of 30 loaded lessons that matched on words)" });
    expect(suggestion(r, "fitFloorCosine")).toMatchObject({ status: "not_enough_data", evidence: { have: 0, needed: TUNING_MIN_SAMPLES }, message: "not enough data yet (0 of 30 loaded lessons with a meaning score)" });
    expect(suggestion(r, "priorWeightUses")).toMatchObject({ status: "not_enough_data", evidence: { have: 4, needed: TUNING_MIN_MERGED, unit: "merged tasks" }, message: "not enough data yet (4 of 5 merged tasks)" });
  });

  it("the prior also waits for enough distinct lessons", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, lessons: TUNING_MIN_LESSONS - 1, words: wordsAt(0.3, 0.006) });
    await seedMerges(documents, 8, 7);
    expect(suggestion(await report(documents), "priorWeightUses")).toMatchObject({ status: "not_enough_data", evidence: { have: 9, needed: 10, unit: "lessons loaded" } });
  });
});

describe("suggestions from fixtures", () => {
  it("a project whose loaded lessons fit well keeps the words floor; the cosine floor, the prior and the step cap are suggested from their own rows", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006), cos: wordsAt(0.6, 0.006), leftOut: () => [sample("les_left1", 0.5, null), sample("les_left2", 0.1, null)] });
    await seedMerges(documents, 8, 7);
    const r = await report(documents);
    expect(r).toMatchObject({ ready: true, message: "30 loads in the last 30 days." });
    // 150 loaded lessons, three of each of 50 word values from 0.300 up: the 30th smallest is 0.354, which rounds to the 0.35 already in force.
    expect(suggestion(r, "fitFloorWords")).toMatchObject({ status: "keep", current: 0.35, suggested: 0.35, evidence: { have: 150, needed: 30 } });
    expect(suggestion(r, "fitFloorCosine")).toMatchObject({ status: "suggested", current: 0.72, suggested: 0.65, evidence: { have: 150, needed: 30 } });
    expect(suggestion(r, "priorWeightUses")).toMatchObject({ status: "suggested", current: 4, suggested: 3, evidence: { have: 50, needed: 10, unit: "lessons loaded" } });
    // Every step was full (5 of 5) and a left-out lesson passes the words floor: the cap bound in every load.
    expect(suggestion(r, "stepLessonCap")).toMatchObject({ status: "suggested", current: 5, suggested: 6, evidence: { have: 30, needed: 20, unit: "loads" } });
    expect(r.evidence).toMatchObject({ loads: 30, loadedLessons: 150, lessonsLoaded: 50, mergedTasks: 8, revertedTasks: 1, cleanMergeRate: 0.875 });
    expect(suggestion(r, "weeklyPicks")).toMatchObject({ status: "no_data_source", suggested: null, current: 5 });
  });

  it("a project whose loads fit weakly gets a LOWER words floor; one whose loads fit strongly gets a HIGHER one; both inside the clamp", async () => {
    const weak = db();
    await seedLoads(weak, { loads: 30, words: wordsAt(0.02, 0.01) });
    expect(suggestion(await report(weak), "fitFloorWords")).toMatchObject({ status: "suggested", suggested: 0.2, current: 0.35 });
    const strong = db();
    await seedLoads(strong, { loads: 30, words: wordsAt(0.55, 0.005) });
    expect(suggestion(await report(strong), "fitFloorWords")).toMatchObject({ status: "suggested", suggested: 0.5, current: 0.35 });
    const mid = db();
    await seedLoads(mid, { loads: 30, words: wordsAt(0.45, 0.005) });
    expect(suggestion(await report(mid), "fitFloorWords")).toMatchObject({ suggested: 0.5 });
    const low = db();
    await seedLoads(low, { loads: 30, words: wordsAt(0.22, 0.01) });
    expect(suggestion(await report(low), "fitFloorWords")).toMatchObject({ suggested: 0.3, status: "suggested" });
  });

  it("the step cap stays when the left-out lessons do not pass the floors in force, and a floor the caller passes in is the one compared against", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0.1, null)] });
    const r = await report(documents);
    expect(suggestion(r, "stepLessonCap")).toMatchObject({ status: "keep", current: 5, suggested: 5 });
    expect(suggestion(r, "stepLessonCap").message).toContain("only 0 of 30 loads");
    // The same left-out lesson passes a looser floor the operator has applied: now the cap binds.
    const looser = await report(documents, { current: { fitFloorWords: 0.05 } });
    expect(suggestion(looser, "stepLessonCap")).toMatchObject({ status: "suggested", suggested: 6 });
    expect(suggestion(looser, "fitFloorWords")).toMatchObject({ current: 0.05, suggested: 0.35, status: "suggested" });
    // A step that was not full never counts as the cap binding.
    const roomy = db();
    await seedLoads(roomy, { loads: 30, budget: 8, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0.9, null)] });
    expect(suggestion(await report(roomy), "stepLessonCap")).toMatchObject({ status: "keep", current: 8, suggested: 8 });
  });

  it("a left-out lesson passes the current floors on meaning as well as on words", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0, 0.8)] });
    expect(suggestion(await report(documents), "stepLessonCap")).toMatchObject({ status: "suggested", suggested: 6 });
    const below = db();
    await seedLoads(below, { loads: 30, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0, 0.7)] });
    expect(suggestion(await report(below), "stepLessonCap")).toMatchObject({ status: "keep", suggested: 5 });
    // Never above the ceiling.
    const full = db();
    await seedLoads(full, { loads: 30, budget: 8, perLoad: 8, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0.9, null)] });
    expect(suggestion(await report(full), "stepLessonCap")).toMatchObject({ status: "keep", current: 8, suggested: 8 });
    // A budget above the ceiling is kept, never lowered (review finding 1).
    const big = db();
    await seedLoads(big, { loads: 30, budget: 10, perLoad: 10, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0.9, null)] });
    expect(suggestion(await report(big), "stepLessonCap")).toMatchObject({ status: "keep", current: 10, suggested: 10 });
    // A budget of zero never counts as the cap binding.
    const zero = db();
    await seedLoads(zero, { loads: 30, budget: 0, perLoad: 0, leftOut: () => [sample("les_left1", 0.9, null)] });
    expect(suggestion(await report(zero), "stepLessonCap")).toMatchObject({ status: "keep", current: 0, suggested: 0 });
  });

  it("only loads made with the current budget decide whether it binds; a caller's own budget is the one compared", async () => {
    const documents = db();
    // Twenty loads with budget 5 that did not bind, plus ten older ones with budget 3 that all did: the modal budget is 5 and the binding loads of the other budget do not count.
    await seedLoads(documents, { loads: 20, budget: 5, words: wordsAt(0.3, 0.006), leftOut: () => [sample("les_left1", 0.1, null)] });
    const sink = documentMeasureSink(documents, A, () => NOW);
    for (let i = 0; i < 10; i += 1) {
      await sink.load({ workspaceId: A, project: "payments", taskId: `old-${String(i)}`, stage: "IMPLEMENT", round: 1, at: NOW - 1_000_000 - i * 60_000, budgetLessons: 3, activeCount: 50, eligibleCount: 50,
        loaded: [sample("les_0001", 0.5, null), sample("les_0002", 0.5, null), sample("les_0003", 0.5, null)], leftOut: [sample("les_left1", 0.9, null)] });
    }
    expect(suggestion(await report(documents), "stepLessonCap")).toMatchObject({ status: "keep", current: 5, suggested: 5 });
    // The operator says the budget in force is 3: now those ten loads are the ones that count, and they all bound.
    expect(suggestion(await report(documents, { current: { stepLessonCap: 3 } }), "stepLessonCap")).toMatchObject({ status: "suggested", current: 3, suggested: 4 });
  });

  it("the cap share has a threshold: a quarter of the loads binds, fewer does not", async () => {
    const mixed = (binding: number) => async (): Promise<TuningReport> => {
      const documents = db();
      await seedLoads(documents, { loads: 20, words: wordsAt(0.3, 0.006), leftOut: () => [] });
      // Replace the first `binding` loads' left-out lists by writing them again with a fitting lesson.
      const sink = documentMeasureSink(documents, A, () => NOW);
      for (let i = 0; i < binding; i += 1) {
        await sink.load({ workspaceId: A, project: "payments", taskId: `task-${String(i)}`, stage: "IMPLEMENT", round: 1, at: NOW - i * 60_000, budgetLessons: 5, activeCount: 50, eligibleCount: 50,
          loaded: Array.from({ length: 5 }, (_unused, j) => sample(lessonId(i * 5 + j, 50), 0.5, null)), leftOut: [sample("les_left1", 0.9, null)] });
      }
      return report(documents);
    };
    expect(CAP_BOUND_SHARE).toBe(0.25);
    expect(suggestion(await mixed(5)(), "stepLessonCap")).toMatchObject({ status: "suggested", suggested: 6 });
    expect(suggestion(await mixed(4)(), "stepLessonCap")).toMatchObject({ status: "keep", suggested: 5 });
  });

  it("the prior's suggestion is the typical number of loads per lesson, kept between 2 and 12", async () => {
    const few = db();
    await seedLoads(few, { loads: 30, lessons: 150, words: wordsAt(0.3, 0.006) });
    await seedMerges(few, 8, 8);
    expect(suggestion(await report(few), "priorWeightUses")).toMatchObject({ status: "suggested", suggested: 2, current: 4 });
    const many = db();
    await seedLoads(many, { loads: 30, lessons: 10, words: wordsAt(0.3, 0.006) });
    await seedMerges(many, 8, 8);
    expect(suggestion(await report(many), "priorWeightUses")).toMatchObject({ status: "suggested", suggested: 12 });
    const same = db();
    await seedLoads(same, { loads: 30, lessons: 38, words: wordsAt(0.3, 0.006) });
    await seedMerges(same, 8, 8);
    // 150 loads over 38 lessons: most lessons got 4.
    expect(suggestion(await report(same), "priorWeightUses")).toMatchObject({ status: "keep", suggested: 4, current: 4 });
  });

  it("the clean-merge rows give the outcome comparison, shown only with enough tasks on each side", async () => {
    const documents = db();
    const words = (k: number): number => (Math.floor(k / 5) >= 5 ? 0.2 : 0.6);
    await seedLoads(documents, { loads: 30, words });
    await seedMerges(documents, 8, 5);
    const r = await report(documents);
    expect(OUTCOME_MIN_TASKS).toBe(3);
    expect(r.evidence).toMatchObject({ mergedTasks: 8, revertedTasks: 3, cleanMergeRate: 0.625, meanWordsCleanTasks: 0.6, meanWordsRevertedTasks: 0.2 });
    const one = db();
    await seedLoads(one, { loads: 30, words });
    await seedMerges(one, 8, 7);
    // Seven clean tasks (five with words 0.6, two with 0.2) and one reverted: the clean side is shown, the reverted side has too few tasks.
    expect((await report(one)).evidence).toMatchObject({ meanWordsCleanTasks: 0.486, meanWordsRevertedTasks: null });
    // A reverted task with no merge row in the window is not counted against a merged one.
    const orphan = db();
    await seedLoads(orphan, { loads: 30, words });
    await documentMeasureSink(orphan, A, () => NOW).reverted({ workspaceId: A, project: "payments", taskId: "task-1", at: NOW });
    expect((await report(orphan)).evidence).toMatchObject({ mergedTasks: 0, revertedTasks: 0, cleanMergeRate: null });
  });

  it("values the caller passes in are the 'current' ones; a value that is not a usable number leaves the starting value", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006) });
    const r = await report(documents, { current: { fitFloorWords: 0.5, priorWeightUses: 8, weeklyPicks: 3, fitFloorCosine: Number.NaN, stepLessonCap: -1 } });
    expect(suggestion(r, "fitFloorWords")).toMatchObject({ current: 0.5, suggested: 0.35 });
    expect(suggestion(r, "fitFloorCosine").current).toBe(0.72);
    // A caller's budget that is not usable leaves the most common budget the loads had (5).
    expect(suggestion(r, "stepLessonCap").current).toBe(5);
    expect(suggestion(await report(documents, { current: { stepLessonCap: 7 } }), "stepLessonCap")).toMatchObject({ current: 7 });
    expect(suggestion(r, "weeklyPicks")).toMatchObject({ current: 3, suggested: null });
    expect(suggestion(r, "weeklyPicks").message).toContain("keep 3");
  });

  it("percentile is the nearest rank", () => {
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([5], 0.2)).toBe(5);
    expect(percentile([4, 1, 3, 2, 5], 0.2)).toBe(1);
    expect(percentile([4, 1, 3, 2, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });
});

describe("what it reads", () => {
  it("only the asking company's rows of only the asking project: two companies with one project name, and two projects, are apart", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, company: B, words: wordsAt(0.02, 0.01) });
    await seedMerges(documents, 8, 5, B);
    await seedLoads(documents, { loads: 30, project: "other", words: wordsAt(0.02, 0.01) });
    await seedMerges(documents, 8, 5, A, "other");
    const mine = await report(documents);
    expect(mine).toMatchObject({ ready: false, message: "not enough data yet (0 of 20 loads)", evidence: { loads: 0, mergedTasks: 0 } });
    expect((await report(documents, { companyId: B })).evidence).toMatchObject({ loads: 30, mergedTasks: 8, revertedTasks: 3 });
    expect((await report(documents, { project: "other" })).evidence).toMatchObject({ loads: 30, mergedTasks: 8 });
    // B's report is B's words (weak); A's own rows, once there, are A's own.
    await seedLoads(documents, { loads: 30, words: wordsAt(0.55, 0.005) });
    expect(suggestion(await report(documents), "fitFloorWords").suggested).toBe(0.5);
    expect(suggestion(await report(documents, { companyId: B }), "fitFloorWords").suggested).toBe(0.2);
  });

  it("a row planted in the project's partition that belongs to another project or is not a row of this module is left out and counted as unreadable", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 25, words: wordsAt(0.3, 0.006) });
    await documents.put({ item: { pk: fitPk(A, "payments"), sk: "L#planted-1", entityType: "LESSON_FIT", project: "other", taskId: "task-x1", at: NOW, keepUntil: NOW + DAY, budgetLessons: 5, activeCount: 1, eligibleCount: 1, loaded: [], leftOut: [] } });
    await documents.put({ item: { pk: fitPk(A, "payments"), sk: "L#planted-2", entityType: "SOMETHING_ELSE", project: "payments", at: NOW, keepUntil: NOW + DAY } });
    await documents.put({ item: { pk: fitPk(A, "payments"), sk: "L#planted-3", entityType: "LESSON_FIT", project: "payments", taskId: "task-x3", at: NOW, keepUntil: NOW + DAY, budgetLessons: 5, activeCount: 1, eligibleCount: 1, loaded: [{ id: "no", fit: 9, score: 0, words: 0, cos: null }], leftOut: [] } });
    await documents.put({ item: { pk: mergePk(A, "payments"), sk: "M#bad", entityType: "LESSON_MERGE", project: "other", kind: "merged", taskId: "task-1", at: NOW, keepUntil: NOW + DAY } });
    const r = await report(documents);
    expect(r.evidence).toMatchObject({ loads: 25, mergedTasks: 0, unreadable: 4 });
  });

  it("rows older than the window or past their own keepUntil are not read; a longer window reads the older ones, capped at 60 days", async () => {
    const old = db();
    await seedLoads(old, { loads: 25, words: wordsAt(0.3, 0.006), at: (i) => NOW - 40 * DAY - i * 60_000 });
    expect((await report(old)).evidence.loads).toBe(0);
    expect(await report(old, { windowDays: 45 })).toMatchObject({ windowDays: 45, evidence: { loads: 25 } });
    expect((await report(old, { windowDays: 500 })).windowDays).toBe(60);
    // Merged rows older than the window do not make the clean-merge rate either.
    const oldMerges = db();
    const sink = documentMeasureSink(oldMerges, A, () => NOW);
    for (let i = 0; i < 6; i += 1) await sink.merged({ workspaceId: A, project: "payments", taskId: `task-${String(i)}`, at: NOW - 40 * DAY - i * 60_000 });
    expect((await report(oldMerges)).evidence).toMatchObject({ mergedTasks: 0, cleanMergeRate: null });
    expect((await report(oldMerges, { windowDays: 45 })).evidence).toMatchObject({ mergedTasks: 6, cleanMergeRate: 1 });
    // A row inside the window whose own keepUntil has passed is not read, whether or not the store has swept it (and it is not "unreadable": it is just old).
    const expired = db();
    await seedLoads(expired, { loads: 25, words: wordsAt(0.3, 0.006) });
    await expired.put({ item: { pk: fitPk(A, "payments"), sk: "L#expired-1", entityType: "LESSON_FIT", project: "payments", taskId: "task-x1", at: NOW - DAY, keepUntil: NOW - 1, budgetLessons: 5, activeCount: 1, eligibleCount: 1, loaded: [sample("les_0001", 0.5, null)], leftOut: [] } });
    expect((await report(expired)).evidence).toMatchObject({ loads: 25, unreadable: 0 });
  });

  it("the row limit and the deadline cut the read and say so", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006) });
    const cut = await report(documents, { limits: { rowsTotal: 25 } });
    expect(cut.evidence.truncated).toBe(true);
    expect(cut.evidence.loads).toBeLessThanOrEqual(25);
    expect((await report(documents, { limits: { deadlineMs: 0 } })).evidence).toMatchObject({ truncated: true, loads: 0 });
    expect((await report(documents)).evidence.truncated).toBe(false);
  });

  it("a store that fails or hangs gives a truncated 'not enough data' report, never a throw", async () => {
    const failing = { query: async () => { throw new Error("down"); } };
    expect(await readTuningReport(failing, { companyId: A, project: "payments", now: NOW })).toMatchObject({ ready: false, evidence: { loads: 0, truncated: true } });
    const hanging = { query: () => new Promise<never>(() => undefined) };
    expect(await readTuningReport(hanging, { companyId: A, project: "payments", now: NOW, limits: { deadlineMs: 30 } })).toMatchObject({ ready: false, evidence: { truncated: true } });
  });

  it("nothing is written or deleted, and the answer carries no lesson id, task id or text", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006), cos: wordsAt(0.6, 0.006), leftOut: () => [sample("les_left1", 0.5, null)] });
    await seedMerges(documents, 8, 5);
    const put = vi.spyOn(documents, "put");
    const del = vi.spyOn(documents, "delete");
    const update = vi.spyOn(documents, "update");
    const transact = vi.spyOn(documents, "transact");
    const r = await report(documents);
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();
    const text = JSON.stringify(r);
    expect(text).not.toContain("les_");
    expect(text).not.toContain("task-");
    expect(text).not.toContain(A);
    expect(Object.keys(r).sort()).toEqual(["evidence", "message", "note", "project", "ready", "suggestions", "windowDays"]);
  });

  it("every suggestion states its own evidence, and the note says nothing is applied", async () => {
    const documents = db();
    await seedLoads(documents, { loads: 30, words: wordsAt(0.3, 0.006) });
    const r = await report(documents);
    for (const one of r.suggestions) {
      expect(typeof one.evidence.have).toBe("number");
      expect(typeof one.evidence.needed).toBe("number");
      expect(one.message.length).toBeGreaterThan(0);
      expect(one.status === "not_enough_data" || one.status === "no_data_source" ? one.suggested === null : typeof one.suggested === "number").toBe(true);
    }
    expect(r.note).toMatch(/suggestions only/u);
    expect(r.suggestions.map((one) => one.setting)).toEqual(["fitFloorWords", "fitFloorCosine", "priorWeightUses", "stepLessonCap", "weeklyPicks"]);
  });
});
