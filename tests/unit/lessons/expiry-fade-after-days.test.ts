// A lesson fades after N days without helping, and never before its trial period ends. The sweep skips a lesson with a queued helpful mark, recording an outcome holds nothing, and a task end
// delivered again after its mark settled queues nothing. Related cases are in curate.test.ts, lessons-jobs.test.ts and task-end.test.ts.
import { describe, expect, it } from "vitest";
import { activateLesson } from "../../../packages/broker/src/lessons/approve.js";
import { recordTaskOutcome, settleHelpful, type CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { renewLesson, sweepExpired } from "../../../packages/broker/src/lessons/expiry.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { TRIAL_APPROVER, TRIAL_STABLE_AFTER_DAYS } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, Judge, KEY, WS, lessonRecord, seed, settings } from "./lesson-helpers.js";

const DAY = 86_400_000;
const pending = (id: string, type: Lesson["type"] = "convention"): Lesson => lessonRecord({ id, type, tier: 1, status: "pending", approvals: [], pendingExpiresAt: 1_900_000_000_000 });
const trialApproval = [{ approvalId: "t", by: TRIAL_APPROVER, at: 1, mode: "trial" as const }];

async function goLive(over: { id: string; days: number | undefined; action?: "lesson.trial_started" | "lesson.activated"; type?: Lesson["type"] }) {
  const clock = new Clock();
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  await seed(store, pending(over.id, over.type));
  const deps = { store, audit, now: clock.now };
  const live = await activateLesson(deps, KEY, (await store.get(KEY, over.id))!, trialApproval, over.days, over.action ?? "lesson.trial_started", { version: 1, setVersion: await store.setVersion(KEY) });
  return { clock, store, audit, live: live!, created: clock.now(), deps };
}
const alive = async (store: InMemoryLessonStore, audit: Audit, clock: Clock, at: number): Promise<boolean> => {
  clock.t = at;
  await sweepExpired({ now: clock.now, audit }, store, KEY);
  return (await store.get(KEY, "les_fadeone1"))!.status === "active";
};

describe("a lesson fades after N days without helping, and never before its trial period ends", () => {
  it("a new lesson (trial or person-approved) lives until its trial period ends plus N days: 14 + 14 for a 14-day setting, 14 + 90 by default; the fixed 21-day floor is gone", async () => {
    for (const action of ["lesson.trial_started", "lesson.activated"] as const) {
      const short = await goLive({ id: "les_fadeone1", days: 14, action });
      expect(short.live.expiresAt, action).toBe(short.created + (TRIAL_STABLE_AFTER_DAYS + 14) * DAY);
      const normal = await goLive({ id: "les_fadeone1", days: undefined, action });
      expect(normal.live.expiresAt, action).toBe(normal.created + (TRIAL_STABLE_AFTER_DAYS + 90) * DAY);
    }
    // A preference fades after 90 days like every other type (the 180-day default is gone).
    const preference = await goLive({ id: "les_fadeone1", days: undefined, type: "preference", action: "lesson.activated" });
    expect(preference.live.expiresAt).toBe(preference.created + (TRIAL_STABLE_AFTER_DAYS + 90) * DAY);
    expect(await import("../../../packages/broker/src/lessons/trial.js")).not.toHaveProperty("TRIAL_MIN_EXPIRY_DAYS");
  });
  it("N=14 and the lesson is never used: it lives through its trial and fades 14 days after the trial ends (alive on day 27, gone on day 28)", async () => {
    const { store, audit, clock, created } = await goLive({ id: "les_fadeone1", days: 14 });
    expect(await alive(store, audit, clock, created + (TRIAL_STABLE_AFTER_DAYS - 1) * DAY)).toBe(true);
    expect(await alive(store, audit, clock, created + 27 * DAY)).toBe(true);
    expect(await alive(store, audit, clock, created + 28 * DAY + 1)).toBe(false);
  });
  it("a quiet project: a lesson with no use at all is never expired before its trial period ends, whatever N is", async () => {
    for (const days of [14, 30, undefined]) {
      const { store, audit, clock, created } = await goLive({ id: "les_fadeone1", days });
      for (let day = 1; day <= TRIAL_STABLE_AFTER_DAYS; day += 1) expect(await alive(store, audit, clock, created + day * DAY), `N=${String(days)} day ${String(day)}`).toBe(true);
    }
  });
  it("helpful on day 85 with N=90 (the default): alive until day 175, gone after", async () => {
    const { store, audit, clock, created } = await goLive({ id: "les_fadeone1", days: 90 });
    clock.t = created + 85 * DAY;
    await renewLesson(store, KEY, "les_fadeone1", clock.now(), 90, "helpful");
    expect((await store.get(KEY, "les_fadeone1"))!.expiresAt).toBe(created + 175 * DAY);
    expect(await alive(store, audit, clock, created + 174 * DAY)).toBe(true);
    expect(await alive(store, audit, clock, created + 175 * DAY + 1)).toBe(false);
  });
  it("N=14 and the lesson helps every 10 days: it stays for as long as it helps, then fades 14 days after the last help", async () => {
    const { store, audit, clock, created } = await goLive({ id: "les_fadeone1", days: 14 });
    for (let day = 10; day <= 100; day += 10) {
      expect(await alive(store, audit, clock, created + day * DAY), `day ${String(day)}`).toBe(true);
      await renewLesson(store, KEY, "les_fadeone1", clock.now(), 14, "helpful");
    }
    expect(await alive(store, audit, clock, created + 113 * DAY)).toBe(true);
    expect(await alive(store, audit, clock, created + 114 * DAY + 1)).toBe(false);
  });
  it("a help during the trial never shortens the lesson's life below the end of its trial period plus N", async () => {
    const { store, clock, created } = await goLive({ id: "les_fadeone1", days: 14 });
    clock.t = created + 3 * DAY;
    await renewLesson(store, KEY, "les_fadeone1", clock.now(), 14, "helpful");
    expect((await store.get(KEY, "les_fadeone1"))!.expiresAt).toBe(created + 28 * DAY);
  });
  it("a fact renews on validation; a convention's validated load renews nothing", async () => {
    const fact = await goLive({ id: "les_fadeone1", days: 90, type: "fact" });
    fact.clock.t = fact.created + 60 * DAY;
    await renewLesson(fact.store, KEY, "les_fadeone1", fact.clock.now(), 90, "validated");
    expect((await fact.store.get(KEY, "les_fadeone1"))!.expiresAt).toBe(fact.created + 150 * DAY);
    const convention = await goLive({ id: "les_fadeone1", days: 90 });
    const before = convention.live.expiresAt;
    convention.clock.t = convention.created + 60 * DAY;
    await renewLesson(convention.store, KEY, "les_fadeone1", convention.clock.now(), 90, "validated");
    expect((await convention.store.get(KEY, "les_fadeone1"))!.expiresAt).toBe(before);
  });
});

describe("the sweep skips a lesson with a queued helpful mark; recording an outcome holds nothing; a settled task end queues nothing", () => {
  async function setup() {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const created = clock.now();
    await seed(store, lessonRecord({ id: "les_usedlate", type: "convention", tier: 1, status: "active", approvals: [{ approvalId: "p", by: "ann", at: 1, mode: "one" }], expiresAt: created + 90 * DAY }));
    const deps: CounterDeps = { store, audit, now: clock.now, judge: new Judge(), settings: settings({ mode: "On", preset: "standard" }) };
    await store.putManifest({ taskId: "t85", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_usedlate", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
    return { clock, store, audit, created, deps };
  }
  const merged = (clock: Clock, over: Record<string, unknown> = {}) => ({ workspaceId: WS, project: KEY.project, taskId: "t85", outcome: "merged" as const, sendBacks: 0, mergedAt: clock.now(), corrections: [], ...over });

  it("queueing a mark changes no expiry; the sweep leaves the lesson while the mark is queued; a revert ends that, so the next sweep expires it", async () => {
    const { clock, store, audit, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    expect((await recordTaskOutcome(deps, merged(clock))).queuedHelpful).toEqual(["les_usedlate"]);
    expect((await store.get(KEY, "les_usedlate"))!.expiresAt).toBe(created + 90 * DAY);
    clock.t = created + 95 * DAY;
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual([]);
    expect((await store.get(KEY, "les_usedlate"))!.status).toBe("active");
    clock.t = created + 96 * DAY;
    await recordTaskOutcome(deps, merged(clock, { outcome: "reverted", mergedAt: undefined }));
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual(["les_usedlate"]);
  });
  it("the mark that settles renews the lesson from the settle day (day 99 + 90); the sweep after it leaves it", async () => {
    const { clock, store, audit, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    await recordTaskOutcome(deps, merged(clock));
    clock.t = created + 99 * DAY + 1;
    expect(await settleHelpful(deps, KEY)).toBe(1);
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual([]);
    expect((await store.get(KEY, "les_usedlate"))!.expiresAt).toBe(clock.now() + 90 * DAY);
  });
  it("a lesson with a queued mark for ANOTHER lesson is not spared: only its own mark holds it (positive control)", async () => {
    const { clock, store, audit, created } = await setup();
    await seed(store, lessonRecord({ id: "les_otherone", status: "active", expiresAt: created + 1 }));
    await store.addPending({ key: "helpful:tx:les_usedlate", workspaceId: WS, project: KEY.project, lessonId: "les_usedlate", taskId: "tx", dueAt: created + 50 * DAY });
    clock.t = created + 95 * DAY;
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual(["les_otherone"]);
  });
  it("a task end delivered again after its mark settled queues nothing and extends nothing; the lesson fades on its own date", async () => {
    const { clock, store, audit, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    await recordTaskOutcome(deps, merged(clock));
    clock.t = created + 99 * DAY + 1;
    await settleHelpful(deps, KEY);
    const settled = (await store.get(KEY, "les_usedlate"))!;
    expect(settled.counters.helpful).toBe(1);
    clock.t = created + 150 * DAY;
    const again = await recordTaskOutcome(deps, merged(clock, { mergedAt: undefined }));
    expect(again.queuedHelpful).toEqual([]);
    expect(await store.duePending(KEY, created + 400 * DAY, 10)).toEqual([]);
    const after = (await store.get(KEY, "les_usedlate"))!;
    expect(after.expiresAt).toBe(settled.expiresAt);
    expect(after.counters.helpful).toBe(1);
    clock.t = settled.expiresAt + 1;
    expect((await sweepExpired({ now: clock.now, audit }, store, KEY)).expired).toEqual(["les_usedlate"]);
  });
  it("a merged task end delivered again after that task's revert took the mark back queues nothing (the reverted once-key)", async () => {
    const { clock, store, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    expect((await recordTaskOutcome(deps, merged(clock))).queuedHelpful).toEqual(["les_usedlate"]);
    clock.t = created + 86 * DAY;
    await recordTaskOutcome(deps, merged(clock, { outcome: "reverted", mergedAt: undefined }));
    expect(await store.duePending(KEY, created + 400 * DAY, 10)).toEqual([]);
    expect(await store.seenOnce(KEY, "reverted:t85:les_usedlate")).toBe(true);
    clock.t = created + 87 * DAY;
    const again = await recordTaskOutcome(deps, merged(clock));
    expect(again.queuedHelpful).toEqual([]);
    expect(await store.duePending(KEY, created + 400 * DAY, 10)).toEqual([]);
    expect(await settleHelpful(deps, KEY)).toBe(0);
    expect((await store.get(KEY, "les_usedlate"))!.counters.helpful).toBe(0);
  });
  it("a task that was blamed AND reverted still records the revert, so a later merged end for it queues nothing", async () => {
    const { clock, store, created, deps } = await setup();
    clock.t = created + 85 * DAY;
    deps.judge = new Judge("caused");
    await recordTaskOutcome(deps, merged(clock, { outcome: "reverted", mergedAt: undefined, corrections: [{ kind: "send_back", paths: ["src/retry/a.ts"], text: "wrong", at: 1 }] }));
    expect(await store.seenOnce(KEY, "reverted:t85:les_usedlate")).toBe(true);
    deps.judge = new Judge();
    expect((await recordTaskOutcome(deps, merged(clock))).queuedHelpful).toEqual([]);
    expect(await store.duePending(KEY, created + 400 * DAY, 10)).toEqual([]);
  });
  it("Positive control: another task's merged end for the same lesson still queues its mark after this task was reverted", async () => {
    const { clock, store, created, deps } = await setup();
    await store.putManifest({ taskId: "t86", workspaceId: WS, project: KEY.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_usedlate", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
    clock.t = created + 85 * DAY;
    await recordTaskOutcome(deps, merged(clock));
    await recordTaskOutcome(deps, merged(clock, { outcome: "reverted", mergedAt: undefined }));
    expect((await recordTaskOutcome(deps, merged(clock, { taskId: "t86" }))).queuedHelpful).toEqual(["les_usedlate"]);
  });
});
