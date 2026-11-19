// Renewal on a validated load for trial/stable lessons, the sweep's fresh re-check, the promotion's audit and retry rules, the trial lifetime floor
// A stale citation blocks stable and publishing, and the read pages through every lesson., and the paged read. The nightly job's own tests are in lessons-jobs.test.ts, the task-end counting in task-end.test.ts.
import { describe, expect, it } from "vitest";
import { activateLesson } from "../../../packages/broker/src/lessons/approve.js";
import { applyLoadReport, type CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { renewLesson, sweepExpired, SWEEP_PAGE } from "../../../packages/broker/src/lessons/expiry.js";
import { InMemoryLessonStore, type LessonStore } from "../../../packages/broker/src/lessons/store.js";
import { TRIAL_APPROVER, TRIAL_STABLE_AFTER_DAYS, isPublishable, promoteIfStable, promoteStableTrials, trialIsStable } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, Judge, KEY, WS, lessonRecord, seed, settings } from "./lesson-helpers.js";

const DAY = 86_400_000;
const trial = (over: Partial<Lesson> = {}, clock = new Clock()): Lesson => lessonRecord({
  id: "les_trial001", type: "convention", tier: 1, status: "active", approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }],
  trial: { state: "trial", startedAt: clock.now() - (TRIAL_STABLE_AFTER_DAYS + 1) * DAY }, counters: { loaded: 3, helpful: 0, harmful: 0, citationStale: 0 }, expiresAt: clock.now() + 90 * DAY, ...over,
});

describe("a validated load renews a fact only; every other type is renewed by a validated helpful use", () => {
  it("a validated load renews a fact and nothing else (a trial or stable convention, a person-approved convention); a helpful use renews any type", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const old = clock.now() + 2 * DAY;
    await seed(store, trial({ id: "les_trialconv", expiresAt: old }, clock), trial({ id: "les_stableconv", expiresAt: old, trial: { state: "stable", startedAt: 1, stableAt: 2 } }, clock),
      lessonRecord({ id: "les_personconv", type: "convention", tier: 1, status: "active", approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }], expiresAt: old }),
      lessonRecord({ id: "les_fact", type: "fact", status: "active", expiresAt: old }));
    for (const id of ["les_trialconv", "les_stableconv", "les_personconv", "les_fact"]) await renewLesson(store, KEY, id, clock.now(), undefined, "validated");
    const expiry = async (id: string) => (await store.get(KEY, id))!.expiresAt;
    expect(await expiry("les_fact")).toBe(clock.now() + 90 * DAY);
    for (const id of ["les_trialconv", "les_stableconv", "les_personconv"]) expect(await expiry(id)).toBe(old);
    for (const id of ["les_trialconv", "les_stableconv", "les_personconv"]) await renewLesson(store, KEY, id, clock.now(), undefined, "helpful");
    for (const id of ["les_trialconv", "les_stableconv", "les_personconv"]) expect(await expiry(id)).toBe(clock.now() + 90 * DAY);
  });
  it("a stable convention that is only loaded (never marked helpful) lapses at day 90 however often it was loaded; a fact that keeps validating survives", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const created = clock.now();
    const stable = (id: string, type: Lesson["type"]): Lesson => trial({ id, type, trial: { state: "stable", startedAt: created, stableAt: created + 14 * DAY }, expiresAt: created + 90 * DAY, counters: { loaded: 3, helpful: 0, harmful: 0, citationStale: 0 } }, clock);
    await seed(store, stable("les_loaded01", "convention"), stable("les_factload", "fact"));
    const deps: CounterDeps = { store, audit, now: clock.now, judge: new Judge(), settings: settings({ mode: "On", preset: "standard" }) };
    for (let day = 10; day <= 100; day += 10) {
      clock.t = created + day * DAY;
      await store.putManifest({ taskId: `t${day}`, workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: clock.now(), lessons: ["les_loaded01", "les_factload"].map((id) => ({ id, version: 1, score: 0.5, why: "scope", citation: "valid" as const })), bytes: 10 });
      await applyLoadReport(deps, { workspaceId: WS, project: KEY.project, taskId: `t${day}`, stage: "IMPLEMENT", round: 1, report: { stage: "IMPLEMENT", lessons: ["les_loaded01", "les_factload"].map((id) => ({ id, version: 1, citation: "valid" })) } as never });
    }
    clock.t = created + 100 * DAY;
    const swept = await sweepExpired({ now: clock.now, audit }, store, KEY);
    expect(swept.expired).toEqual(["les_loaded01"]);
    expect((await store.get(KEY, "les_factload"))!.status).toBe("active");
  });
});

describe("the sweep checks the rule again on the fresh copy", () => {
  const stale = (store: InMemoryLessonStore, old: Lesson): LessonStore => Object.assign(Object.create(store) as InMemoryLessonStore, {
    // The page was read before the change: it shows the lesson as due.
    listPage: async (key: typeof KEY, filter: Parameters<LessonStore["listPage"]>[1]) => ({ ...(await store.listPage(key, filter)), lessons: [old] }),
  });
  it("a pending lesson approved since the page was read, and an active lesson renewed since, are not expired", async () => {
    const clock = new Clock();
    const audit = new Audit();
    const store = new InMemoryLessonStore();
    const pendingThen = lessonRecord({ id: "les_wasPend1", status: "pending", approvals: [], pendingExpiresAt: clock.now() - DAY, expiresAt: clock.now() + 90 * DAY });
    const activeThen = lessonRecord({ id: "les_wasAct01", status: "active", expiresAt: clock.now() - DAY });
    // Now: the first was approved (active, a new expiry), the second renewed.
    await seed(store, lessonRecord({ id: "les_wasPend1", status: "active", expiresAt: clock.now() + 90 * DAY }), lessonRecord({ id: "les_wasAct01", status: "active", expiresAt: clock.now() + 90 * DAY }));
    for (const old of [pendingThen, activeThen]) {
      expect((await sweepExpired({ now: clock.now, audit }, stale(store, old), KEY)).expired).toEqual([]);
      expect((await store.get(KEY, old.id))!.status).toBe("active");
    }
    expect(audit.events).toEqual([]);
  });
  it("positive control: a lesson that is still due on the fresh copy is expired and audited", async () => {
    const clock = new Clock();
    const audit = new Audit();
    const store = new InMemoryLessonStore();
    const due = lessonRecord({ id: "les_stillDue1", status: "active", expiresAt: clock.now() - DAY });
    await seed(store, due);
    expect((await sweepExpired({ now: clock.now, audit }, stale(store, due), KEY)).expired).toEqual(["les_stillDue1"]);
    expect(audit.actions()).toEqual(["lesson.expired"]);
  });
  it("the pages are walked to the end, the limit and the stop hold, and a pinned or held lesson is skipped", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const lessons = Array.from({ length: SWEEP_PAGE * 2 + 5 }, (_, i) => lessonRecord({ id: `les_${String(i).padStart(5, "0")}`, status: "active", expiresAt: clock.now() - DAY }));
    await seed(store, ...lessons);
    const deps = { now: clock.now, audit: new Audit() };
    const pinned = new Set(["les_00000"]);
    expect((await sweepExpired(deps, store, KEY, { limit: 7, pinned })).expired).toHaveLength(7);
    expect((await store.get(KEY, "les_00000"))!.status).toBe("active");
    let calls = 0;
    const cut = await sweepExpired(deps, store, KEY, { pinned, stop: () => (calls += 1) > 3 });
    expect(cut).toMatchObject({ stopped: true });
    expect(cut.expired).toHaveLength(3);
    expect((await sweepExpired(deps, store, KEY, { pinned })).expired).toHaveLength(lessons.length - 7 - 3 - 1);
    expect((await store.get(KEY, "les_00000"))!.status).toBe("active");
  });
});

describe("promotion writes its ledger line once, never for a refused commit, and does not retry a fence", () => {
  async function promoting(over: Partial<Lesson> = {}, wrap?: (store: InMemoryLessonStore) => LessonStore) {
    const clock = new Clock();
    const base = new InMemoryLessonStore();
    const audit = new Audit();
    await seed(base, trial(over, clock));
    const store = wrap === undefined ? base : wrap(base);
    return { clock, base, store, audit, deps: { store, audit, now: clock.now } };
  }
  it("a lesson that names an erased person writes no trial_stable line, tries no commit, and stays on trial", async () => {
    let commits = 0;
    const w = await promoting({ provenance: { ...lessonRecord().provenance, authors: ["dev-gone"] } }, (base) => Object.assign(Object.create(base) as InMemoryLessonStore, { commit: async (...args: Parameters<LessonStore["commit"]>) => { commits += 1; return base.commit(...args); } }));
    await w.base.fence(KEY, { people: ["dev-gone"] });
    expect(await promoteIfStable(w.deps, KEY, "les_trial001")).toBe(false);
    expect(w.audit.actions()).toEqual([]);
    expect(commits).toBe(0);
    expect((await w.base.get(KEY, "les_trial001"))!.trial?.state).toBe("trial");
  });
  it("a commit the fence refuses ('fenced', 'erased') is tried ONCE; the single trial_stable line is followed by a promote_failed line", async () => {
    for (const reason of ["fenced", "erased"] as const) {
      let commits = 0;
      const w = await promoting({}, (base) => Object.assign(Object.create(base) as InMemoryLessonStore, { commit: async () => { commits += 1; return { ok: false as const, reason }; } }));
      expect(await promoteIfStable(w.deps, KEY, "les_trial001")).toBe(false);
      expect(commits, reason).toBe(1);
      expect(w.audit.actions(), reason).toEqual(["lesson.trial_stable", "lesson.promote_failed"]);
    }
  });
  it("a lost race is read again and tried again, with the ledger line written once for the whole call", async () => {
    let commits = 0;
    const w = await promoting({}, (base) => Object.assign(Object.create(base) as InMemoryLessonStore, { commit: async (...args: Parameters<LessonStore["commit"]>) => { commits += 1; return commits < 3 ? { ok: false as const, reason: "conflict" as const } : base.commit(...args); } }));
    expect(await promoteIfStable(w.deps, KEY, "les_trial001")).toBe(true);
    expect(commits).toBe(3);
    expect(w.audit.actions()).toEqual(["lesson.trial_stable"]);
    expect((await w.base.get(KEY, "les_trial001"))!.trial?.state).toBe("stable");
  });
  it("a ledger that cannot take the line refuses the promotion before any commit", async () => {
    const w = await promoting();
    w.audit.emit = async () => { throw new Error("no ledger"); };
    expect(await promoteIfStable(w.deps, KEY, "les_trial001")).toBe(false);
    expect((await w.base.get(KEY, "les_trial001"))!.trial?.state).toBe("trial");
  });
});

describe("a short expiry setting cannot block stable; a stale citation blocks stable and publishing", () => {
  it("a lesson that goes live under a 14-day expiry setting lives its trial window plus the 14 days (the trial window is added to the expiry, not a fixed floor; more in expiry-fade-after-days.test.ts)", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const pending = (id: string): Lesson => lessonRecord({ id, type: "convention", tier: 1, status: "pending", approvals: [], pendingExpiresAt: clock.now() + DAY });
    await seed(store, pending("les_goTrial1"), pending("les_goPerson"));
    const deps = { store, audit, now: clock.now };
    const sv = await store.setVersion(KEY);
    const trialLive = await activateLesson(deps, KEY, (await store.get(KEY, "les_goTrial1"))!, [{ approvalId: "t", by: TRIAL_APPROVER, at: 1, mode: "trial" }], 14, "lesson.trial_started", { version: 1, setVersion: sv });
    expect(trialLive!.expiresAt).toBe(clock.now() + (TRIAL_STABLE_AFTER_DAYS + 14) * DAY);
    const personLive = await activateLesson(deps, KEY, (await store.get(KEY, "les_goPerson"))!, [{ approvalId: "a", by: "ann", at: 1, mode: "one" }], 14, "lesson.activated", { version: 1, setVersion: await store.setVersion(KEY) });
    expect(personLive!.expiresAt).toBe(clock.now() + (TRIAL_STABLE_AFTER_DAYS + 14) * DAY);
  });
  it("a trial lesson with a stale citation does not become stable, in the single call or the nightly pass; a stable one with a stale citation is not publishable", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const staleChecks = [{ index: 0, result: "stale" as const, at: 1 }];
    await seed(store, trial({ id: "les_staleTri1", citationChecks: staleChecks }, clock), trial({ id: "les_freshTri1" }, clock));
    const deps = { store, audit: new Audit(), now: clock.now };
    expect(trialIsStable((await store.get(KEY, "les_staleTri1"))!, clock.now())).toBe(false);
    expect(await promoteIfStable(deps, KEY, "les_staleTri1")).toBe(false);
    expect(await promoteStableTrials(deps, KEY)).toEqual(["les_freshTri1"]);
    const stable = (checks: Lesson["citationChecks"]): Lesson => trial({ citationChecks: checks, trial: { state: "stable", startedAt: 1, stableAt: 2 }, provenance: { ...lessonRecord().provenance, fromSharedTask: true, audience: { kind: "project" } } }, clock);
    expect(isPublishable(stable([{ index: 0, result: "valid", at: 1 }]), [])).toBe(true);
    expect(isPublishable(stable(staleChecks), [])).toBe(false);
  });
});
