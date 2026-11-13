// Counters from outcomes, the two task-page buttons, auto-retire, the worker's load report, expiry and the panel rows.
import { describe, expect, it } from "vitest";
import { modelCorrectionJudge } from "../../../packages/lessons/src/judge-model.js";
import { applyLoadReport, recordFeedback, recordTaskOutcome, settleHelpful, REVERT_WINDOW_MS, type CounterDeps, type TaskOutcome } from "../../../packages/lessons/src/counters.js";
import { expiryWindowMs, renewLesson, sweepExpired } from "../../../packages/lessons/src/expiry.js";
import { lessonPanelRows } from "../../../packages/lessons/src/panel.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/lessons/src/store.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { Alerts, Audit, Clock, Judge, ScriptedModel, Spend, KEY, PROJECT, WS, lessonRecord, seed, settings, allowAllAccess, type FeedbackDeps } from "./lesson-helpers.js";

const DAY = 86_400_000;
function setup(judge = new Judge(), s = settings()) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const alerts = new Alerts();
  const clock = new Clock();
  const deps: FeedbackDeps = { access: allowAllAccess, store, judge, settings: s, audit, alerts, now: clock.now };
  return { deps, store, audit, alerts, clock, judge };
}
const manifest = (taskId: string, ids: string[], over: Partial<LoadManifest> = {}): LoadManifest => ({
  taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
  lessons: ids.map((id) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const })), bytes: 100, ...over,
});
const outcome = (over: Partial<TaskOutcome> = {}): TaskOutcome => ({ ...KEY, taskId: "task-1", outcome: "merged", sendBacks: 0, mergedAt: 1_800_000_000_000, corrections: [], ...over });
const correction = (over: Record<string, unknown> = {}) => ({ kind: "send_back" as const, paths: ["src/retry/a.ts"], text: "use the shared retry helper", at: 1, authorId: "dev-ann", ...over });
const counters = async (store: InMemoryLessonStore, id = "les_aaaa1111") => (await store.get(KEY, id))!.counters;

describe("helpful: queued at merge, applied after the 14-day revert window", () => {
  it("merged with at most one send-back and no contradicting correction", async () => {
    const { deps, store, clock } = setup();
    await seed(store, lessonRecord({ expiresAt: clock.now() + 5 * DAY }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    expect(await recordTaskOutcome(deps, outcome({ sendBacks: 1 }))).toEqual({ harmful: [], queuedHelpful: ["les_aaaa1111"] });
    expect(await settleHelpful(deps, KEY)).toBe(0);
    expect((await counters(store)).helpful).toBe(0);
    clock.advance(REVERT_WINDOW_MS + 1000);
    expect(await settleHelpful(deps, KEY)).toBe(1);
    const lesson = (await store.get(KEY, "les_aaaa1111"))!;
    expect(lesson.counters.helpful).toBe(1);
    expect(lesson.lastHelpfulAt).toBe(clock.now());
    expect(lesson.expiresAt).toBe(clock.now() + 90 * DAY);
    expect(await settleHelpful(deps, KEY)).toBe(0);
    await recordTaskOutcome(deps, outcome({ sendBacks: 1 }));
    clock.advance(REVERT_WINDOW_MS + 1000);
    await settleHelpful(deps, KEY);
    expect((await counters(store)).helpful).toBe(1);
  });

  it("not helpful: two send-backs, a task not merged, an eval run, mode Off, a lesson that was not loaded", async () => {
    for (const [name, o, s] of [
      ["two send-backs", outcome({ sendBacks: 2 }), settings()], ["closed", outcome({ outcome: "closed" }), settings()],
      ["eval run", outcome({ evalRun: true }), settings()], ["mode Off", outcome(), settings({ mode: "Off" })], ["not loaded", outcome({ taskId: "task-9" }), settings()],
    ] as const) {
      const { deps, store, clock, judge } = setup(new Judge(), s);
      await seed(store, lessonRecord());
      await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
      const result = await recordTaskOutcome(deps, o);
      clock.advance(REVERT_WINDOW_MS + 1000);
      await settleHelpful(deps, KEY);
      expect(result.queuedHelpful, name).toEqual([]);
      expect((await counters(store)).helpful, name).toBe(0);
      expect(judge.calls, name).toBe(0);
    }
  });

  it("a revert inside the window cancels the queued helpful mark", async () => {
    const { deps, store, clock } = setup();
    await seed(store, lessonRecord());
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await recordTaskOutcome(deps, outcome());
    await recordTaskOutcome(deps, outcome({ outcome: "reverted", corrections: [correction({ kind: "revert", text: "reverts the retry change" })] }));
    clock.advance(REVERT_WINDOW_MS + 1000);
    expect(await settleHelpful(deps, KEY)).toBe(0);
    expect((await counters(store)).helpful).toBe(0);
    expect((await counters(store)).harmful).toBe(0);
  });
});

describe("harmful: judged corrections and the two buttons", () => {
  it.each(["caused", "contradicts"] as const)("a correction rated '%s' adds one harmful mark, once", async (rating) => {
    const { deps, store } = setup(new Judge(rating));
    await seed(store, lessonRecord());
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    const first = await recordTaskOutcome(deps, outcome({ corrections: [correction()] }));
    await recordTaskOutcome(deps, outcome({ corrections: [correction()] }));
    expect(first.harmful).toEqual(["les_aaaa1111"]);
    expect(await counters(store)).toMatchObject({ harmful: 1, helpful: 0 });
    expect(first.queuedHelpful).toEqual([]);
  });

  it("an unrelated correction is neither; 'same_ignored' blocks the helpful mark; a failing judge adds nothing and blocks the helpful mark", async () => {
    for (const [answer, queued] of [["unrelated", 1], ["same_ignored", 0], [new Error("judge down"), 0]] as const) {
      const { deps, store } = setup(new Judge(answer));
      await seed(store, lessonRecord());
      await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
      const result = await recordTaskOutcome(deps, outcome({ corrections: [correction()] }));
      expect(result.harmful).toEqual([]);
      expect(result.queuedHelpful).toHaveLength(queued);
      expect((await counters(store)).harmful).toBe(0);
    }
  });

  it("only corrections in the lesson's path scope are judged", async () => {
    const { deps, store, judge } = setup(new Judge("caused"));
    await seed(store, lessonRecord({ scope: { repos: ["api"], paths: ["docs/**"] } }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await recordTaskOutcome(deps, outcome({ corrections: [correction({ paths: ["src/x.ts"] })] }));
    expect(judge.calls).toBe(0);
  });

  it("a tier-0 lesson auto-retires when harmful >= 2 and harmful > helpful, and the two marks are two different people's", async () => {
    const { deps, store, audit } = setup(new Judge("caused"));
    await seed(store, lessonRecord());
    for (const [task, authorId] of [["t1", "dev-ann"], ["t2", "dev-bob"]] as const) {
      await store.putManifest(manifest(task, ["les_aaaa1111"]));
      await recordTaskOutcome(deps, outcome({ taskId: task, corrections: [correction({ authorId })] }));
    }
    expect((await store.get(KEY, "les_aaaa1111"))!.status).toBe("retired");
    expect(audit.actions()).toContain("lesson.auto_retired");
  });

  it("one person's corrections on two tasks are ONE harmful mark ever, so they cannot retire a tier-0 lesson alone; a correction with no known author blames nobody", async () => {
    const { deps, store, audit } = setup(new Judge("caused"));
    await seed(store, lessonRecord());
    for (const task of ["t1", "t2", "t3"]) {
      await store.putManifest(manifest(task, ["les_aaaa1111"]));
      await recordTaskOutcome(deps, outcome({ taskId: task, corrections: [correction({ text: "nit: rename this" })] }));
    }
    expect(await counters(store)).toMatchObject({ harmful: 1 });
    expect((await store.get(KEY, "les_aaaa1111"))!.status).toBe("active");
    expect(audit.actions()).not.toContain("lesson.auto_retired");
    await store.putManifest(manifest("t4", ["les_aaaa1111"]));
    const nobody = await recordTaskOutcome(deps, outcome({ taskId: "t4", corrections: [correction({ authorId: undefined })] }));
    expect(nobody.harmful).toEqual([]);
    expect(await counters(store)).toMatchObject({ harmful: 1 });
    // The person's mark is the same one their buttons make: after a comment's harm, their "Wrong here" on the lesson is a repeat.
    const feedback = await recordFeedback(deps, { ...KEY, taskId: "t1", lessonId: "les_aaaa1111", userId: "dev-ann", viewer: { principals: [], groups: [], developerId: "dev-ann" }, kind: "wrong_here" });
    expect(feedback).toEqual({ ok: false, code: "repeat" });
  });

  it("a correction that names a file is judged only against lessons that reach it", async () => {
    const { deps, store, judge } = setup(new Judge("contradicts"));
    await seed(store, lessonRecord({ id: "les_retry001", scope: { repos: ["api"], paths: ["src/retry/**"] } }), lessonRecord({ id: "les_wide0001", scope: { repos: ["api"] } }));
    await store.putManifest(manifest("task-1", ["les_retry001", "les_wide0001"]));
    const result = await recordTaskOutcome(deps, outcome({ corrections: [correction({ kind: "review_comment", paths: ["docs/README.md"], text: "say the opposite here" })] }));
    expect(judge.calls).toBe(1);
    expect(result.harmful).toEqual(["les_wide0001"]);
  });

  it("a lesson a task already blamed gets no helpful mark from the same task, even when the judge changes its mind", async () => {
    const answers = new Judge("caused");
    const { deps, store, clock } = setup(answers);
    await seed(store, lessonRecord({ tier: 1 }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    const first = await recordTaskOutcome(deps, outcome({ corrections: [correction()] }));
    answers.answer = "unrelated";
    const second = await recordTaskOutcome(deps, outcome({ corrections: [correction()] }));
    expect(first.harmful).toEqual(["les_aaaa1111"]);
    expect(second.queuedHelpful).toEqual([]);
    clock.advance(REVERT_WINDOW_MS + 1000);
    await settleHelpful(deps, KEY);
    expect(await counters(store)).toMatchObject({ harmful: 1, helpful: 0 });
  });

  it("the 20 calls are spent on path matches first, then in an order that changes from task to task, not on the same lessons by id", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `les_${String(i).padStart(8, "0")}`);
    const queuedBy = async (taskId: string) => {
      const { deps, store, judge } = setup(new Judge("unrelated"));
      await seed(store, ...ids.map((id) => lessonRecord({ id })));
      await store.putManifest(manifest(taskId, ids));
      const r = await recordTaskOutcome(deps, outcome({ taskId, corrections: [correction({ authorId: "a", text: "first" }), correction({ authorId: "b", text: "second" })] }));
      expect(judge.calls).toBe(20);
      return r.queuedHelpful;
    };
    const first = await queuedBy("task-1"), second = await queuedBy("task-2");
    expect(first).toHaveLength(10);
    expect(first).not.toEqual(ids.slice(0, 10));
    expect(first).not.toEqual(second);
    // A lesson whose files a correction names is judged first, whatever its id.
    const { deps, store, judge } = setup(new Judge("unrelated"));
    await seed(store, ...ids.map((id) => lessonRecord({ id, scope: { repos: ["api"] } })), lessonRecord({ id: "les_zzzzzzzz", scope: { repos: ["api"], paths: ["src/**"] } }));
    await store.putManifest(manifest("task-9", [...ids, "les_zzzzzzzz"]));
    await recordTaskOutcome(deps, outcome({ taskId: "task-9", corrections: Array.from({ length: 5 }, (_, i) => correction({ paths: ["src/a.ts"], text: `fix ${i}` })) }));
    expect(judge.calls).toBe(20);
    expect(judge.lessons.slice(0, 5)).toEqual(Array(5).fill("les_zzzzzzzz"));
  });

  it("a tier-1 lesson gets a retire proposal for a person, and stays active; helpful marks can keep it", async () => {
    const { deps, store, audit, alerts } = setup(new Judge("caused"));
    await seed(store, lessonRecord({ tier: 1, counters: { loaded: 9, helpful: 0, harmful: 1, citationStale: 0 } }), lessonRecord({ id: "les_good0001", tier: 1, counters: { loaded: 9, helpful: 3, harmful: 1, citationStale: 0 } }));
    await store.putManifest(manifest("t2", ["les_aaaa1111", "les_good0001"]));
    await recordTaskOutcome(deps, outcome({ taskId: "t2", corrections: [correction()] }));
    const bad = (await store.get(KEY, "les_aaaa1111"))!;
    expect(bad).toMatchObject({ status: "active", counters: { harmful: 2 } });
    expect(bad.retireProposedAt).toBeDefined();
    expect((await store.get(KEY, "les_good0001"))!.retireProposedAt).toBeUndefined();
    expect(audit.actions()).toContain("lesson.retire_proposed");
    expect(alerts.sent).toContain("retire_proposed");
  });

  it("caps the judge calls per task", async () => {
    const { deps, store, judge } = setup(new Judge("unrelated"));
    const ids = Array.from({ length: 12 }, (_, i) => `les_cap${String(i).padStart(5, "0")}`);
    await seed(store, ...ids.map((id) => lessonRecord({ id })));
    await store.putManifest(manifest("task-1", ids));
    await recordTaskOutcome(deps, outcome({ corrections: [correction({ text: "one more" }), correction({ text: "two more" }), correction({ text: "three more" })] }));
    expect(judge.calls).toBe(20);
  });
});

describe("what retired a lesson is remembered only when corrections did it", () => {
  it("the version that harmful marks of corrections auto-retired says so; one that two people's 'Wrong here' buttons retired does not", async () => {
    const byCorrections = setup(new Judge("caused"));
    await seed(byCorrections.store, lessonRecord());
    for (const [task, authorId] of [["t1", "dev-ann"], ["t2", "dev-bob"]] as const) {
      await byCorrections.store.putManifest(manifest(task, ["les_aaaa1111"]));
      await recordTaskOutcome(byCorrections.deps, outcome({ taskId: task, corrections: [correction({ authorId })] }));
    }
    const retired = (await byCorrections.store.get(KEY, "les_aaaa1111"))!;
    expect(retired).toMatchObject({ status: "retired" });
    expect(retired.retiredByHarm).toBe(retired.version);
    const byButtons = setup();
    await seed(byButtons.store, lessonRecord());
    await byButtons.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    for (const userId of ["dev-ann", "dev-bob"]) await recordFeedback(byButtons.deps, { ...KEY, taskId: "task-1", lessonId: "les_aaaa1111", userId, viewer: { principals: [], groups: [], developerId: userId }, kind: "wrong_here" });
    const pressed = (await byButtons.store.get(KEY, "les_aaaa1111"))!;
    expect(pressed.status).toBe("retired");
    expect(pressed.retiredByHarm).toBeUndefined();
  });
});

describe("Helpful and Wrong here buttons", () => {
  it("count once per person and lesson, only for a lesson loaded into the task; Wrong here opens a retire suggestion", async () => {
    const { deps, store, audit } = setup();
    await seed(store, lessonRecord());
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    const base = { ...KEY, taskId: "task-1", lessonId: "les_aaaa1111" };
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, userId: "ann", kind: "helpful" })).toEqual({ ok: true });
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, userId: "ann", kind: "helpful" })).toEqual({ ok: false, code: "repeat" });
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, userId: "bob", kind: "helpful" })).toEqual({ ok: true });
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, taskId: "task-2", userId: "ann", kind: "helpful" })).toEqual({ ok: false, code: "not_loaded" });
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, lessonId: "les_zzzz0000", userId: "ann", kind: "helpful" })).toEqual({ ok: false, code: "not_loaded" });
    expect((await counters(store)).helpful).toBe(2);
    // Ann has marked this lesson: neither kind counts again, and not from another task either.
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, userId: "ann", kind: "wrong_here" })).toEqual({ ok: false, code: "repeat" });
    expect(await recordFeedback(deps, { viewer: { principals: [], groups: [] }, ...base, userId: "carl", kind: "wrong_here" })).toEqual({ ok: true });
    const lesson = (await store.get(KEY, "les_aaaa1111"))!;
    expect(lesson.counters.harmful).toBe(1);
    expect(lesson.retireProposedAt).toBeDefined();
    expect(lesson.status).toBe("active");
    expect(audit.events.find((e) => e.action === "lesson.wrong_here")).toMatchObject({ actor: "carl", facts: { task: "task-1" } });
  });
});

describe("load report from the worker", () => {
  const report = (lessons: Array<Record<string, unknown>>) => ({ v: 1 as const, stage: "IMPLEMENT" as const, lessons: lessons.map((l) => ({ version: 1, ...l })) }) as never;
  const apply = (deps: CounterDeps, lessons: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => applyLoadReport(deps, { ...KEY, taskId: "task-1", stage: "IMPLEMENT", round: 1, report: report(lessons), ...over });

  it("valid: stamps the validation time and renews a fact's expiry", async () => {
    const { deps, store, clock } = setup();
    await seed(store, lessonRecord({ expiresAt: clock.now() + DAY }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await apply(deps, [{ id: "les_aaaa1111", citation: "valid" }]);
    const lesson = (await store.get(KEY, "les_aaaa1111"))!;
    expect(lesson.lastValidatedAt).toBe(clock.now());
    expect(lesson.expiresAt).toBe(clock.now() + 90 * DAY);
    expect((await store.manifests(KEY, "task-1"))[0]!.lessons[0]!.citation).toBe("valid");
  });

  it("moved: the corrected lines become a new lesson version, audited", async () => {
    const { deps, store, audit } = setup();
    await seed(store, lessonRecord());
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await apply(deps, [{ id: "les_aaaa1111", citation: "moved", corrected: [{ index: 0, startLine: 40, endLine: 58 }] }]);
    const lesson = (await store.get(KEY, "les_aaaa1111"))!;
    expect(lesson).toMatchObject({ version: 2 });
    expect(lesson.citations[0]).toMatchObject({ startLine: 40, endLine: 58 });
    expect(audit.actions()).toContain("lesson.citation_moved");
  });

  it("stale: three in 14 days make the lesson stale; spread wider they do not; unchecked results change nothing", async () => {
    const { deps, store, clock, audit } = setup();
    await seed(store, lessonRecord());
    for (let i = 1; i <= 3; i += 1) {
      await store.putManifest(manifest(`t${i}`, ["les_aaaa1111"]));
      await apply(deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: `t${i}` });
      clock.advance(DAY);
    }
    expect(await store.get(KEY, "les_aaaa1111")).toMatchObject({ status: "stale", counters: { citationStale: 3 } });
    expect(audit.actions()).toContain("lesson.stale");

    const wide = setup();
    await seed(wide.store, lessonRecord());
    for (let i = 1; i <= 3; i += 1) {
      await wide.store.putManifest(manifest(`t${i}`, ["les_aaaa1111"]));
      await apply(wide.deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: `t${i}` });
      wide.clock.advance(10 * DAY);
    }
    expect((await wide.store.get(KEY, "les_aaaa1111"))!.status).toBe("active");

    const slow = setup();
    await seed(slow.store, lessonRecord());
    await slow.store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await apply(slow.deps, [{ id: "les_aaaa1111", citation: "unchecked_dropped" }]);
    expect((await slow.store.get(KEY, "les_aaaa1111"))).toMatchObject({ counters: { citationStale: 0 }, version: 1 });
  });

  it("only lessons in the stage's manifest, at the manifest's version, are touched; a report applies once", async () => {
    const { deps, store } = setup();
    await seed(store, lessonRecord(), lessonRecord({ id: "les_other001" }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111"]));
    await apply(deps, [{ id: "les_other001", citation: "stale_dropped" }, { id: "les_aaaa1111", version: 7, citation: "stale_dropped" }]);
    expect((await counters(store, "les_other001")).citationStale).toBe(0);
    expect((await counters(store)).citationStale).toBe(0);
    // The first report for a stage is the only one applied, so a repeated or replayed report cannot count twice.
    await store.putManifest(manifest("task-2", ["les_aaaa1111"]));
    await apply(deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: "task-2" });
    await apply(deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: "task-2" });
    expect((await counters(store)).citationStale).toBe(1);
    await apply(deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: "task-2", stage: "PLAN" });
    await apply(deps, [{ id: "les_aaaa1111", citation: "stale_dropped" }], { taskId: "no-manifest" });
    expect((await counters(store)).citationStale).toBe(1);
  });
});

describe("expiry", () => {
  it("default 90 days for every type, preferences included, configurable 14 to 365 (out of range falls back)", () => {
    expect(expiryWindowMs("fact", undefined)).toBe(90 * DAY);
    expect(expiryWindowMs("preference", undefined)).toBe(90 * DAY);
    for (const type of ["fact", "convention", "preference", "pitfall", "procedure"] as const) expect(expiryWindowMs(type as never, undefined), type).toBe(90 * DAY);
    expect(expiryWindowMs("fact", 30)).toBe(30 * DAY);
    expect(expiryWindowMs("preference", 30)).toBe(30 * DAY);
    expect(expiryWindowMs("fact", 5)).toBe(90 * DAY);
    expect(expiryWindowMs("fact", 400)).toBe(90 * DAY);
  });

  it("a helpful use renews; it never shortens; a non-fact is not renewed by validation alone", async () => {
    const { store, clock } = setup();
    await seed(store, lessonRecord({ expiresAt: clock.now() + 200 * DAY }), lessonRecord({ id: "les_conv0001", type: "convention", expiresAt: clock.now() + 2 * DAY }));
    await renewLesson(store, KEY, "les_aaaa1111", clock.now(), undefined, "helpful");
    expect((await store.get(KEY, "les_aaaa1111"))!.expiresAt).toBe(clock.now() + 200 * DAY);
    await renewLesson(store, KEY, "les_conv0001", clock.now(), undefined, "validated");
    expect((await store.get(KEY, "les_conv0001"))!.expiresAt).toBe(clock.now() + 2 * DAY);
    await renewLesson(store, KEY, "les_conv0001", clock.now(), undefined, "helpful");
    expect((await store.get(KEY, "les_conv0001"))!.expiresAt).toBe(clock.now() + 90 * DAY);
  });

  it("the sweep expires active lessons past their time and pending ones nobody decided; pinned lessons are kept; it is bounded", async () => {
    const { deps, store, clock, audit } = setup();
    const now = clock.now();
    await seed(store, lessonRecord({ id: "les_old00001", expiresAt: now - 1 }), lessonRecord({ id: "les_pin00001", expiresAt: now - 1 }), lessonRecord({ id: "les_new00001" }),
      lessonRecord({ id: "les_pend0001", status: "pending", pendingExpiresAt: now - 1 }), lessonRecord({ id: "les_pend0002", status: "pending", pendingExpiresAt: now + DAY }));
    const result = await sweepExpired(deps, store, KEY, { pinned: new Set(["les_pin00001"]) });
    expect(result.expired.sort()).toEqual(["les_old00001", "les_pend0001"]);
    expect((await store.get(KEY, "les_pin00001"))!.status).toBe("active");
    expect((await store.get(KEY, "les_pend0002"))!.status).toBe("pending");
    expect(audit.actions().filter((a) => a === "lesson.expired")).toHaveLength(2);
    const bounded = setup();
    await seed(bounded.store, ...Array.from({ length: 5 }, (_, i) => lessonRecord({ id: `les_bnd${String(i).padStart(5, "0")}`, expiresAt: 1 })));
    expect((await sweepExpired(bounded.deps, bounded.store, KEY, { limit: 2 })).expired).toHaveLength(2);
  });
});

describe("panel rows", () => {
  it("shows lessons with counters, and hides the text of a lesson from a restricted source from a viewer who cannot see it", async () => {
    const { store } = setup();
    const restricted = { ...lessonRecord().provenance, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals: ["U-member"], capturedAt: "x", liveCheck: "none" as const } } };
    await seed(store, lessonRecord({ counters: { loaded: 3, helpful: 2, harmful: 0, citationStale: 0 } }), lessonRecord({ id: "les_rest0001", provenance: restricted, title: "Secret channel lesson" }));
    await store.putManifest(manifest("task-1", ["les_aaaa1111", "les_rest0001", "les_gone0001"]));
    const asStranger = await lessonPanelRows(store, KEY, "task-1", { principals: ["U-stranger"], groups: [] }, allowAllAccess);
    expect(asStranger.map((r) => [r.lessonId, r.visible, r.canMark])).toEqual([["les_aaaa1111", true, true], ["les_rest0001", false, false], ["les_gone0001", false, false]]);
    expect(JSON.stringify(asStranger)).not.toContain("Secret channel lesson");
    expect(asStranger[0]).toMatchObject({ title: "Retries use withRetry", helpful: 2, citation: "valid", why: "scope" });
    const asMember = await lessonPanelRows(store, KEY, "task-1", { principals: ["U-member"], groups: [] }, allowAllAccess);
    expect(asMember[1]).toMatchObject({ visible: true, title: "Secret channel lesson" });
  });
});

export type { Lesson };

describe("model-backed correction judge", () => {
  it("answers a fixed code, with no tools; anything else throws so the correction stays unjudged (the path, caps and failure counts are in outcome-judge.test.ts)", async () => {
    const model = new ScriptedModel(['{"rating":"caused"}', '```json\n{"rating":"unrelated"}\n```', '{"rating":"maybe"}', "not json"]);
    const judge = modelCorrectionJudge({ model, spend: new Spend() });
    const input = { workspaceId: WS, project: "proj-1", lesson: lessonRecord(), correctionKind: "send_back" as const, correctionText: "use the helper" };
    expect(await judge.rate(input)).toBe("caused");
    expect(await judge.rate(input)).toBe("unrelated");
    await expect(judge.rate(input)).rejects.toThrow();
    await expect(judge.rate(input)).rejects.toThrow();
    expect(Object.keys(model.calls[0]!).sort()).toEqual(["budgetUsd", "maxHoldUsd", "maxOutputTokens", "project", "purpose", "system", "user", "workspaceId"]);
    expect(model.calls[0]!.purpose).toBe("outcome");
  });
});
