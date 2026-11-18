// Lessons phase 2, honest evidence (research Q3, decisions 9 to 11): one clean merge is ONE credit shared (1/k) among the lessons the agent reported using whose area the change touched; a revert changes nothing on a lesson
// whose area it did not touch and is NEVER a mark against; a correction that came back although the lesson was loaded is an "against" and a repeat; "the correction stopped coming back" is counted per lesson.
import { describe, expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { recordKnowledgeUseReport } from "../../../packages/broker/src/lessons/knowledge-use.js";
import { readTaskUseReports } from "../../../packages/broker/src/lessons/use-reports.js";
import { betaStrength } from "../../../packages/broker/src/lessons/strength.js";
import { recordFeedback, recordTaskOutcome, settleHelpful, REVERT_WINDOW_MS, type TaskOutcome } from "../../../packages/broker/src/lessons/counters.js";
import { lessonAreaOverlap, lessonCreditShares, lessonIdOfUnit } from "../../../packages/broker/src/lessons/credit.js";
import { readEvidenceTotals } from "../../../packages/broker/src/lessons/evidence.js";
import { Judge, KEY, PROJECT, WS, allowAllAccess, lessonRecord } from "./lesson-helpers.js";
import { A, B, DAY, manifest, world } from "./phase12-helpers.js";

const outcome = (over: Partial<TaskOutcome> = {}): TaskOutcome => ({ ...KEY, taskId: "task-1", outcome: "merged", sendBacks: 0, mergedAt: 1_800_000_000_000, corrections: [], ...over });
const lesson = (id: string, paths?: string[]) => lessonRecord({ id, scope: paths === undefined ? { repos: ["api"] } : { repos: ["api"], paths } });
const totalsOf = async (w: Awaited<ReturnType<typeof world>>) => readEvidenceTotals(w.documents, { companyId: A, project: PROJECT, now: w.clock.now(), windowMs: 180 * DAY });

describe("the pure credit rule", () => {
  const lessons = new Map([["les_aaaa1111", lesson("les_aaaa1111", ["src/billing/**"])], ["les_bbbb2222", lesson("les_bbbb2222", ["src/search/**"])], ["les_cccc3333", lesson("les_cccc3333")]]);
  const loaded = new Set(lessons.keys());

  it("area overlap: unknown files do not rule a lesson out; known files must touch a scoped lesson's area; a lesson with no area is touched by any change", () => {
    expect(lessonAreaOverlap(lesson("x", ["src/billing/**"]), undefined)).toBe(true);
    expect(lessonAreaOverlap(lesson("x", ["src/billing/**"]), ["src/billing/money.ts"])).toBe(true);
    expect(lessonAreaOverlap(lesson("x", ["src/billing/**"]), ["src/search/index.ts"])).toBe(false);
    expect(lessonAreaOverlap(lesson("x"), ["README.md"])).toBe(true);
    expect(lessonAreaOverlap(lesson("x", ["src/billing/**"]), [])).toBe(false);
    expect(lessonAreaOverlap(lesson("x"), [])).toBe(false);
  });

  it("with no report, the credit is shared 1/k among the loaded lessons whose area the change touched (golden)", () => {
    const shares = lessonCreditShares({ lessons, loaded, reports: undefined, touched: ["src/billing/money.ts"] });
    expect([...shares]).toEqual([["les_aaaa1111", 0.5], ["les_cccc3333", 0.5]]);
  });

  it("with a report, only the lessons the agent said it used and whose area was touched share it; the agent's claim cannot add credit (golden)", () => {
    const reports = [{ reported: true, units: [
      { id: "L-les_aaaa1111", kind: "lesson", used: true, areaTouched: true },
      { id: "L-les_bbbb2222", kind: "lesson", used: false, areaTouched: true },
      { id: "L-les_cccc3333", kind: "lesson", used: true, areaTouched: false },
      { id: "F-fact00001", kind: "fact", used: true, areaTouched: true },
    ] }];
    expect([...lessonCreditShares({ lessons, loaded, reports, touched: undefined })]).toEqual([["les_aaaa1111", 1]]);
    // The broker's own check of the changed files must agree with the worker's `areaTouched`.
    expect([...lessonCreditShares({ lessons, loaded, reports, touched: ["src/search/x.ts"] })]).toEqual([]);
  });

  it("an agent that made no report falls back to the worker's own area check; a lesson that never reached the prompt earns nothing whatever a report says", () => {
    const reports = [{ reported: false, units: [{ id: "les_aaaa1111", used: undefined, areaTouched: true }, { id: "les_bbbb2222", areaTouched: false }] }];
    expect([...lessonCreditShares({ lessons, loaded, reports, touched: undefined })]).toEqual([["les_aaaa1111", 1]]);
    expect([...lessonCreditShares({ lessons, loaded: new Set(["les_bbbb2222"]), reports: [{ reported: true, units: [{ id: "les_aaaa1111", used: true, areaTouched: true }] }], touched: undefined })]).toEqual([]);
  });

  it("only a lesson unit is scored this way: a rule, a fact and a skill are not", () => {
    expect(lessonIdOfUnit({ id: "L-les_aaaa1111", kind: "lesson" })).toBe("les_aaaa1111");
    expect(lessonIdOfUnit({ id: "F-fact00001", kind: "fact" })).toBeUndefined();
    expect(lessonIdOfUnit({ id: "S-skill0001" })).toBeUndefined();
    expect(lessonIdOfUnit({ id: "les_aaaa1111" })).toBe("les_aaaa1111");
  });
});

describe("a clean merge is one credit, shared (1/k)", () => {
  it("two loaded lessons, both touched: each is queued at a half and settles as a half after the 14-day window (golden)", async () => {
    const w = await world();
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111", "les_bbbb2222"]));
    await w.add(lesson("les_aaaa1111", ["src/**"]), lesson("les_bbbb2222", ["src/**"]));
    const queued = await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/retry/client.ts"] }));
    expect(queued.queuedHelpful.sort()).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    expect((await w.store.duePending(KEY, w.clock.now() + REVERT_WINDOW_MS + 1, 10)).map((p) => p.weight)).toEqual([0.5, 0.5]);
    w.clock.advance(REVERT_WINDOW_MS + 1000);
    expect(await settleHelpful(w.counters, KEY)).toBe(2);
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 0.5, againstW: 0 });
    // The counter still counts the mark (it renews the lesson); the strength counts the share.
    expect((await w.store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(1);
  });

  it("WITH overlap the lesson is credited; WITHOUT overlap it is not (mutant: credit by presence would credit the second)", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/billing/**"]), lesson("les_bbbb2222", ["src/search/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111", "les_bbbb2222"]));
    const result = await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/billing/money.ts"] }));
    expect(result.queuedHelpful).toEqual(["les_aaaa1111"]);
    w.clock.advance(REVERT_WINDOW_MS + 1000);
    await settleHelpful(w.counters, KEY);
    expect((await totalsOf(w)).evidence.get("les_bbbb2222")).toBeUndefined();
    expect((await w.store.get(KEY, "les_bbbb2222"))!.counters.helpful).toBe(0);
    // A whole mark for the one that earned it (k = 1).
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 1, againstW: 0 });
  });

  it("a lesson the agent did not report as used gets no credit even in a touched area; the reporting lessons share it (golden)", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/**"]), lesson("les_bbbb2222", ["src/**"]), lesson("les_cccc3333", ["src/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111", "les_bbbb2222", "les_cccc3333"]));
    const counters = { ...w.counters, useReports: async () => [{ reported: true, units: [{ id: "L-les_aaaa1111", kind: "lesson", used: true, areaTouched: true }, { id: "L-les_bbbb2222", kind: "lesson", used: true, areaTouched: true }, { id: "L-les_cccc3333", kind: "lesson", used: false, areaTouched: true }] }] };
    expect((await recordTaskOutcome(counters, outcome())).queuedHelpful.sort()).toEqual(["les_aaaa1111", "les_bbbb2222"]);
    expect((await w.store.duePending(KEY, w.clock.now() + REVERT_WINDOW_MS + 1, 10)).map((p) => p.weight)).toEqual([0.5, 0.5]);
  });

  it("a mark queued before shares existed (no weight) settles as a whole one", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111"));
    await w.store.addPending({ key: "helpful:old-task:les_aaaa1111", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "old-task", dueAt: w.clock.now() - 1 });
    expect(await settleHelpful(w.counters, KEY)).toBe(1);
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 1, againstW: 0 });
  });

  it("a person's Helpful and Wrong here buttons are whole 'for' and 'against' pieces of evidence, once per person", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111"), lesson("les_bbbb2222"));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111", "les_bbbb2222"]));
    const deps = { ...w.counters, access: allowAllAccess };
    expect(await recordFeedback(deps, { ...KEY, taskId: "task-1", lessonId: "les_aaaa1111", userId: "dev-ann", viewer: { principals: [], groups: [] }, kind: "helpful" })).toEqual({ ok: true });
    expect(await recordFeedback(deps, { ...KEY, taskId: "task-1", lessonId: "les_bbbb2222", userId: "dev-ann", viewer: { principals: [], groups: [] }, kind: "wrong_here" })).toEqual({ ok: true });
    expect(await recordFeedback(deps, { ...KEY, taskId: "task-1", lessonId: "les_aaaa1111", userId: "dev-ann", viewer: { principals: [], groups: [] }, kind: "helpful" })).toEqual({ ok: false, code: "repeat" });
    const totals = await totalsOf(w);
    expect(totals.evidence.get("les_aaaa1111")).toEqual({ forW: 1, againstW: 0 });
    expect(totals.evidence.get("les_bbbb2222")).toEqual({ forW: 0, againstW: 1 });
  });
});

describe("reverts never count against a lesson", () => {
  it("a revert of a merged task takes the queued credit back and writes no 'against' row, whatever the overlap (golden)", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/billing/**"]), lesson("les_bbbb2222", ["src/search/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111", "les_bbbb2222"]));
    await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/billing/money.ts"] }));
    // The revert's own correction has code's words (`fixed`): counted, never rated.
    const reverted = await recordTaskOutcome(w.counters, outcome({ outcome: "reverted", corrections: [{ kind: "revert", paths: [], text: "The task was corrected.", at: 1, fixed: true }] }));
    expect(reverted.harmful).toEqual([]);
    w.clock.advance(REVERT_WINDOW_MS + 1000);
    expect(await settleHelpful(w.counters, KEY)).toBe(0);
    const totals = await totalsOf(w);
    expect([...totals.evidence.values()].every((e) => e.againstW === 0 && e.forW === 0)).toBe(true);
    for (const id of ["les_aaaa1111", "les_bbbb2222"]) {
      const after = (await w.store.get(KEY, id))!;
      expect(after.counters).toEqual({ loaded: 0, helpful: 0, harmful: 0, citationStale: 0 });
      expect(after.status).toBe("active");
    }
    // A merged delivery that arrives again after the revert queues nothing (the revert is remembered).
    expect((await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/billing/money.ts"] }))).queuedHelpful).toEqual([]);
  });

  it("MUTANT guard: no path writes an 'against' row for a revert even when the revert overlaps a lesson's area", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/billing/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await recordTaskOutcome(w.counters, outcome({ outcome: "reverted", touchedPaths: ["src/billing/money.ts"], corrections: [{ kind: "revert", paths: ["src/billing/money.ts"], text: "The task was corrected.", at: 1, fixed: true }] }));
    expect((await totalsOf(w)).evidence.size).toBe(0);
  });
});

describe("the correction stopped coming back", () => {
  it("each task that ends with the lesson loaded is a matching task; a correction that came back although the lesson said it is an 'against' and a repeat, once per task (golden)", async () => {
    const judge = new Judge();
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/**"]));
    const counters = { ...w.counters, judge };
    for (const taskId of ["task-1", "task-2", "task-3"]) {
      await w.store.putManifest(manifest(taskId, ["les_aaaa1111"]));
      await recordTaskOutcome(counters, outcome({ taskId, touchedPaths: ["src/a.ts"] }));
    }
    let totals = await totalsOf(w);
    expect(totals.repeats.get("les_aaaa1111")).toEqual({ matched: 3, back: 0 });
    // A fourth task: a person's correction in the lesson's area, which the judge finds the lesson already said (it was ignored).
    judge.answer = "same_ignored";
    await w.store.putManifest(manifest("task-4", ["les_aaaa1111"]));
    const again = { kind: "send_back" as const, paths: ["src/a.ts"], text: "use the shared retry helper", at: 1, authorId: "dev-ann" };
    await recordTaskOutcome(counters, outcome({ taskId: "task-4", corrections: [again] }));
    // The task's end is delivered again later (a redelivery, a retry after a time cut): the clock has moved, and still nothing is counted twice.
    w.clock.advance(3 * DAY);
    await recordTaskOutcome(counters, outcome({ taskId: "task-4", corrections: [again] }));
    w.clock.advance(3 * DAY);
    await recordTaskOutcome(counters, outcome({ taskId: "task-4", corrections: [again] }));
    totals = await totalsOf(w);
    expect(totals.repeats.get("les_aaaa1111")).toEqual({ matched: 4, back: 1 });
    expect(totals.evidence.get("les_aaaa1111")).toEqual({ forW: 0, againstW: 1 });
  });

  it("a revert or a task that was not merged or closed writes no repeat row", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111"));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await recordTaskOutcome(w.counters, outcome({ outcome: "reverted", corrections: [{ kind: "revert", paths: [], text: "x", at: 1, fixed: true }] }));
    await recordTaskOutcome(w.counters, outcome({ taskId: "task-2", outcome: "abandoned" }));
    expect((await totalsOf(w)).repeats.size).toBe(0);
  });
});

describe("two companies, two projects", () => {
  it("evidence of company A's project never appears in company B's or in another project's totals", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111"));
    await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", kind: "for", weight: 1, at: w.clock.now(), id: "t" });
    expect((await readEvidenceTotals(w.documents, { companyId: B, project: PROJECT, now: w.clock.now(), windowMs: 180 * DAY })).evidence.size).toBe(0);
    expect((await readEvidenceTotals(w.documents, { companyId: A, project: "proj-2", now: w.clock.now(), windowMs: 180 * DAY })).evidence.size).toBe(0);
    expect((await totalsOf(w)).evidence.size).toBe(1);
  });

  it("a sink built for one company writes nothing for another's key, and a lesson id or task id that is not shaped as one writes nothing", async () => {
    const w = await world();
    expect(await w.evidence.note({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", project: PROJECT, lessonId: "les_aaaa1111", kind: "for", weight: 1, at: 1, id: "x" })).toBe(false);
    expect(await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "bad id", kind: "for", weight: 1, at: 1, id: "x" })).toBe(false);
    expect(await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", kind: "for", weight: 0, at: 1, id: "x" })).toBe(false);
    expect(await w.evidence.repeat({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "../bad", back: false, at: 1 })).toBe(false);
    expect((await totalsOf(w)).evidence.size).toBe(0);
  });
});

describe("evidence is written once, whenever it is delivered", () => {
  it("the same piece of evidence delivered again at another time is the same row (the sort key holds no time)", async () => {
    const w = await world();
    expect(await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", kind: "against", weight: 1, at: w.clock.now(), id: "ignored:task-1" })).toBe(true);
    for (let i = 0; i < 5; i += 1) { w.clock.advance(DAY); await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", kind: "against", weight: 1, at: w.clock.now(), id: "ignored:task-1" }); }
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 0, againstW: 1 });
    // A different id is a different piece.
    await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", kind: "against", weight: 1, at: w.clock.now(), id: "ignored:task-2" });
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 0, againstW: 2 });
  });

  it("a repeat result that came back is never turned back to 'did not come back' by a later delivery", async () => {
    const w = await world();
    const note = { workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "task-1", at: w.clock.now() };
    await w.evidence.repeat({ ...note, back: true });
    await w.evidence.repeat({ ...note, back: false });
    expect((await totalsOf(w)).repeats.get("les_aaaa1111")).toEqual({ matched: 1, back: 1 });
  });
});

describe("the first evidence row keeps the counters the lesson already had (the baseline)", () => {
  it("a lesson with 30 helpful marks keeps its strength when its first shared credit settles (strength never falls for earning evidence)", async () => {
    const w = await world();
    await w.add(lessonRecord({ id: "les_aaaa1111", counters: { loaded: 40, helpful: 30, harmful: 0, citationStale: 0 }, lastHelpfulAt: w.clock.now() }));
    const before = betaStrength({ forW: 30, againstW: 0 }, 0.5);
    await w.store.addPending({ key: "helpful:t1:les_aaaa1111", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "t1", dueAt: w.clock.now() - 1, weight: 1 / 3 });
    await settleHelpful(w.counters, KEY);
    const totals = (await totalsOf(w)).evidence.get("les_aaaa1111")!;
    expect(totals.forW).toBeCloseTo(30 + 1 / 3, 3);
    expect(betaStrength(totals, 0.5)).toBeGreaterThanOrEqual(before);
    // A second settle does not write the baseline again.
    await w.store.addPending({ key: "helpful:t2:les_aaaa1111", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "t2", dueAt: w.clock.now() - 1, weight: 1 });
    await settleHelpful(w.counters, KEY);
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")!.forW).toBeCloseTo(31 + 1 / 3, 3);
  });

  it("the baseline of a lesson with harmful marks keeps them as 'against' when its first mark is written", async () => {
    const w = await world();
    await w.add(lessonRecord({ id: "les_aaaa1111", counters: { loaded: 10, helpful: 2, harmful: 3, citationStale: 0 } }));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await recordFeedback({ ...w.counters, access: allowAllAccess }, { ...KEY, taskId: "task-1", lessonId: "les_aaaa1111", userId: "dev-ann", viewer: { principals: [], groups: [] }, kind: "wrong_here" });
    expect((await totalsOf(w)).evidence.get("les_aaaa1111")).toEqual({ forW: 2, againstW: 4 });
  });

  it("the baseline ages out with the window like any evidence", async () => {
    const w = await world();
    await w.add(lessonRecord({ id: "les_aaaa1111", counters: { loaded: 40, helpful: 30, harmful: 0, citationStale: 0 }, lastHelpfulAt: w.clock.now() }));
    await w.store.addPending({ key: "helpful:t1:les_aaaa1111", workspaceId: WS, project: PROJECT, lessonId: "les_aaaa1111", taskId: "t1", dueAt: w.clock.now() - 1, weight: 1 });
    await settleHelpful(w.counters, KEY);
    w.clock.advance(181 * DAY);
    expect((await totalsOf(w)).evidence.size).toBe(0);
  });
});

describe("the task's use reports are read exactly, and a read that fails defers the credit", () => {
  const delivery = (w: Awaited<ReturnType<typeof world>>, op: string, over: Record<string, unknown> = {}) => w.documents.put({ item: { pk: companyScoped(A, "KNOWLEDGE_GIVEN"), sk: op, entityType: "KNOWLEDGE_GIVEN", v: 1, stage: "IMPLEMENT", taskId: "task-1", project: PROJECT, pushed: ["L-les_aaaa1111"], pulled: [], ...over } });
  const report = { v: 1 as const, stage: "IMPLEMENT" as const, reported: true, units: [{ id: "L-les_aaaa1111", kind: "lesson" as const, given: "push" as const, areaTouched: true, used: true }] };

  it("a kept report is found under its task and project, and not under another task, project or company", async () => {
    const w = await world();
    await delivery(w, "op-1");
    await delivery(w, "op-2", { taskId: "task-2" });
    for (const op of ["op-1", "op-2"]) await recordKnowledgeUseReport({ store: w.documents, companyId: A, operationId: op, report, now: w.clock.now, ttlSeconds: 1000, ttl: () => ({}) });
    expect(await readTaskUseReports(w.documents, { companyId: A, project: PROJECT, taskId: "task-1" })).toEqual([{ reported: true, units: [{ id: "L-les_aaaa1111", kind: "lesson", used: true, areaTouched: true }] }]);
    expect(await readTaskUseReports(w.documents, { companyId: A, project: "proj-2", taskId: "task-1" })).toEqual([]);
    expect(await readTaskUseReports(w.documents, { companyId: B, project: PROJECT, taskId: "task-1" })).toEqual([]);
    expect(await readTaskUseReports(w.documents, { companyId: A, project: PROJECT, taskId: "../x" })).toEqual([]);
  });

  it("a Plan-stage report is not a Build report: only Build and Fix steps credit a merged change", async () => {
    const w = await world();
    await delivery(w, "op-1", { stage: "PLAN" });
    await recordKnowledgeUseReport({ store: w.documents, companyId: A, operationId: "op-1", report: { ...report, stage: "PLAN" }, now: w.clock.now, ttlSeconds: 1000, ttl: () => ({}) });
    expect(await readTaskUseReports(w.documents, { companyId: A, project: PROJECT, taskId: "task-1" })).toEqual([]);
  });

  it("a read that fails or runs out of time throws (it is never read as 'no report')", async () => {
    const slow = { query: () => new Promise<never>(() => undefined) };
    await expect(readTaskUseReports(slow as never, { companyId: A, project: PROJECT, taskId: "task-1", deadlineMs: 20 })).rejects.toThrow();
    await expect(readTaskUseReports({ query: async () => { throw new Error("db down"); } }, { companyId: A, project: PROJECT, taskId: "task-1" })).rejects.toThrow();
  });

  it("when the reports cannot be read the merged task is counted later: nothing is queued now, and the delivery says deferred", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    const counters = { ...w.counters, useReports: async () => { throw new Error("store down"); } };
    expect(await recordTaskOutcome(counters, outcome({ touchedPaths: ["src/a.ts"] }))).toEqual({ harmful: [], queuedHelpful: [], deferred: true });
    expect((await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/a.ts"] }))).queuedHelpful).toEqual(["les_aaaa1111"]);
  });

  it("with no report, only the lessons a Build step was given share the credit (a lesson only a Plan step or a reviewer was given earns none)", async () => {
    const w = await world();
    await w.add(lesson("les_aaaa1111", ["src/**"]), lesson("les_bbbb2222", ["src/**"]));
    await w.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await w.store.putManifest(manifest("task-1", ["les_bbbb2222"], { stage: "PLAN" }));
    expect((await recordTaskOutcome(w.counters, outcome({ touchedPaths: ["src/a.ts"] }))).queuedHelpful).toEqual(["les_aaaa1111"]);
    expect((await w.store.duePending(KEY, w.clock.now() + REVERT_WINDOW_MS + 1, 10)).map((p) => p.weight)).toEqual([1]);
  });
});
