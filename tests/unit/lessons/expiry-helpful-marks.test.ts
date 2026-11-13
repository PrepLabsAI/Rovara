// A lesson with a queued helpful mark is not expired before the mark settles (the sweep leaves it), and a correction with no file list is in scope for every lesson.
// The task-end tests are in task-end.test.ts, the merge rule in curate.test.ts, the sweep and the project-wide check in lessons-jobs.test.ts and task-project-wide.test.ts.
import { describe, expect, it } from "vitest";
import { recordTaskOutcome, settleHelpful, type CounterDeps } from "../../../packages/lessons/src/counters.js";
import { sweepExpired } from "../../../packages/lessons/src/expiry.js";
import { InMemoryLessonStore, type LessonStore } from "../../../packages/lessons/src/store.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { Audit, Clock, Judge, KEY, WS, lessonRecord, seed, settings } from "./lesson-helpers.js";

const DAY = 86_400_000;

describe("a lesson used in its last 14 days is not expired before its helpful mark settles; an unused one still is", () => {
  const convention = (id: string, expiresAt: number): Lesson => lessonRecord({ id, type: "convention", tier: 1, status: "active", approvals: [{ approvalId: "p", by: "ann", at: 1, mode: "one" }], expiresAt });
  async function setup() {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const created = clock.now();
    await seed(store, convention("les_usedlate", created + 90 * DAY), convention("les_neverused", created + 90 * DAY));
    const deps: CounterDeps = { store, audit, now: clock.now, judge: new Judge(), settings: settings({ mode: "On", preset: "standard" }) };
    return { clock, store, audit, created, deps };
  }
  const loadedIn = async (store: InMemoryLessonStore, taskId: string, at: number): Promise<void> => {
    await store.putManifest({ taskId, workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at, lessons: [{ id: "les_usedlate", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
  };

  it("used on day 85 (merged clean): the sweep on day 91 leaves it, the settle on day 99 renews it; the lesson nobody used expired on day 91", async () => {
    const { clock, store, audit, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    await loadedIn(store, "t85", clock.now());
    expect((await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "t85", outcome: "merged", sendBacks: 0, mergedAt: clock.now(), corrections: [] })).queuedHelpful).toEqual(["les_usedlate"]);
    clock.t = created + 91 * DAY;
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual(["les_neverused"]);
    expect((await store.get(KEY, "les_usedlate"))!.status).toBe("active");
    // The mark falls due on day 99 (85 + 14); the nightly run settles it before it sweeps, so the lesson is renewed and survives.
    clock.t = created + 99 * DAY + 1;
    expect(await settleHelpful(deps, KEY)).toBe(1);
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual([]);
    const renewed = (await store.get(KEY, "les_usedlate"))!;
    expect(renewed.status).toBe("active");
    expect(renewed.counters.helpful).toBe(1);
    expect(renewed.expiresAt).toBe(clock.now() + 90 * DAY);
  });
  it("the queued mark is the whole hold and no expiry is moved: a use the revert window took back ends the hold, and the lesson then expires on the next sweep (the earlier expiry hold is gone)", async () => {
    const { clock, store, audit, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    await loadedIn(store, "t85", clock.now());
    await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "t85", outcome: "merged", sendBacks: 0, mergedAt: clock.now(), corrections: [] });
    expect((await store.get(KEY, "les_usedlate"))!.expiresAt).toBe(created + 90 * DAY);
    // Reverted on day 90: the mark is taken back; the lesson is no longer held and the next sweep expires it.
    clock.t = created + 90 * DAY + 1;
    await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "t85", outcome: "reverted", sendBacks: 0, corrections: [] });
    expect(await settleHelpful(deps, KEY)).toBe(0);
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired.sort()).toEqual(["les_neverused", "les_usedlate"]);
  });
  it("an expiry is never moved by recording an outcome, and a closed task (no mark) holds nothing", async () => {
    const { clock, store, audit, deps, created } = await setup();
    await seed(store, convention("les_longlife1", created + 300 * DAY));
    await store.putManifest({ taskId: "t1", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: ["les_longlife1", "les_neverused"].map((id) => ({ id, version: 1, score: 0.5, why: "scope", citation: "valid" as const })), bytes: 10 });
    await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "t1", outcome: "merged", sendBacks: 0, mergedAt: clock.now(), corrections: [] });
    expect((await store.get(KEY, "les_longlife1"))!.expiresAt).toBe(created + 300 * DAY);
    expect((await store.get(KEY, "les_neverused"))!.expiresAt).toBe(created + 90 * DAY);
    await store.putManifest({ taskId: "t2", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_neverused", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
    await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "t2", outcome: "closed", sendBacks: 0, corrections: [] });
    // Only t1's mark is queued for les_neverused; remove it and the closed task adds none, so the lesson expires on day 91.
    await store.removePending(KEY, "helpful:t1:les_neverused");
    clock.t = created + 91 * DAY;
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired.sort()).toEqual(["les_neverused", "les_usedlate"]);
  });
});

describe("a correction with no file list is in scope for every lesson", () => {
  const manifestFor = async (store: InMemoryLessonStore, ids: string[]): Promise<void> => {
    await store.putManifest({ taskId: "task-1", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: ids.map((id) => ({ id, version: 1, score: 0.5, why: "scope", citation: "valid" as const })), bytes: 10 });
  };
  async function run(corrections: Array<{ paths: string[] }>, judge: Judge) {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await seed(store, lessonRecord({ id: "les_pathscope", scope: { repos: ["api"], paths: ["docs/**"] } }), lessonRecord({ id: "les_repowide1", scope: { repos: ["api"] } }));
    await manifestFor(store, ["les_pathscope", "les_repowide1"]);
    const deps: CounterDeps = { store, audit: new Audit(), now: clock.now, judge, settings: settings({ mode: "On", preset: "standard" }) };
    const result = await recordTaskOutcome(deps, { workspaceId: WS, project: KEY.project, taskId: "task-1", outcome: "merged", sendBacks: 1, mergedAt: clock.now(), corrections: corrections.map((c) => ({ kind: "send_back" as const, paths: c.paths, text: "use the shared helper", at: clock.now() })) });
    return { result, judge };
  }
  const refusing = (): Judge => new Judge(new Error("no model"));

  it("a send-back that names no file leaves a path-scoped lesson unjudged, so it gets no helpful mark (the refusing judge was asked about it)", async () => {
    const { result, judge } = await run([{ paths: [] }], refusing());
    expect(result.queuedHelpful).toEqual([]);
    expect(judge.calls).toBe(2);
  });
  it("positive controls: a correction naming a file the lesson does not cover is out of scope for the path-scoped lesson (judged for the repo-wide one only), and no correction at all queues both", async () => {
    const out = await run([{ paths: ["src/other.ts"] }], refusing());
    expect(out.judge.calls).toBe(1);
    expect(out.result.queuedHelpful).toEqual(["les_pathscope"]);
    const none = await run([], refusing());
    expect(none.judge.calls).toBe(0);
    expect(none.result.queuedHelpful.sort()).toEqual(["les_pathscope", "les_repowide1"]);
  });
});

describe("the sweep does not retry a commit the erasure fence refused; a lost race is read again", () => {
  const dueLesson = (clock: Clock): Lesson => lessonRecord({ id: "les_fenced001", status: "active", expiresAt: clock.now() - DAY });
  const withCommit = (store: InMemoryLessonStore, results: Array<"conflict" | "fenced" | "erased" | "ok">): { store: LessonStore; calls: () => number } => {
    let calls = 0;
    const real = store.commit.bind(store);
    const wrapped = Object.assign(Object.create(store) as InMemoryLessonStore, {
      commit: async (...args: Parameters<LessonStore["commit"]>) => {
        const next = results[calls] ?? "conflict";
        calls += 1;
        return next === "ok" ? real(...args) : { ok: false as const, reason: next };
      },
    });
    return { store: wrapped, calls: () => calls };
  };
  it.each(["fenced", "erased"] as const)("a '%s' refusal is tried once: the lesson stays active, nothing is audited as expired", async (reason) => {
    const clock = new Clock();
    const audit = new Audit();
    const store = new InMemoryLessonStore();
    await seed(store, dueLesson(clock));
    const wrapped = withCommit(store, [reason, "ok", "ok"]);
    expect((await sweepExpired({ now: clock.now, audit }, wrapped.store, KEY)).expired).toEqual([]);
    expect(wrapped.calls()).toBe(1);
    expect((await store.get(KEY, "les_fenced001"))!.status).toBe("active");
    expect(audit.events).toEqual([]);
  });
  it("positive control: a lost race ('conflict') is read again and the lesson is expired on the next try", async () => {
    const clock = new Clock();
    const audit = new Audit();
    const store = new InMemoryLessonStore();
    await seed(store, dueLesson(clock));
    const wrapped = withCommit(store, ["conflict", "ok"]);
    expect((await sweepExpired({ now: clock.now, audit }, wrapped.store, KEY)).expired).toEqual(["les_fenced001"]);
    expect(wrapped.calls()).toBe(2);
    expect((await store.get(KEY, "les_fenced001"))!.status).toBe("expired");
  });
});
