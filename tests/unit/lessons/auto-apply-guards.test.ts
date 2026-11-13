// Two brakes on tier-0 AUTO-APPLY, both behind it (automatic go-live stays off by default).
// - project brake: when the project's volume alert fires, tier-0 lessons go to the one-tap queue for the next day; no source is paused.
// - cold start: a source cannot auto-apply until a PERSON has approved nine of its lessons.
import { describe, expect, it } from "vitest";
import { curateDraft } from "../../../packages/lessons/src/curate.js";
import { AUTO_APPLY_GUARDS } from "../../../packages/lessons/src/policy.js";
import { processDraft, type ProcessDeps } from "../../../packages/lessons/src/process.js";
import { coldSourcesOf, projectBrakeOn } from "../../../packages/lessons/src/sources.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import type { LessonDraft } from "../../../packages/lessons/src/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, autoSettings, embedder, facts, lessonRecord, seed, settings, uniqueDraft, verifier } from "./lesson-helpers.js";

const DAY = 86_400_000;
function setup(over: { settings?: ReturnType<typeof settings>; coldStartLessons?: number } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const alerts = new Alerts();
  const counted: Array<{ name: string; tags?: Record<string, string> | undefined }> = [];
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts, now: clock.now, metrics: { count: (name, tags) => { counted.push({ name, tags }); } },
    verifier: verifier("valid"), facts: facts(), settings: over.settings ?? autoSettings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
    ...(over.coldStartLessons === undefined ? {} : { coldStartLessons: over.coldStartLessons }),
  };
  return { deps, store, audit, clock, alerts, counted };
}
const unique = (i: number, sources: string[], over: Partial<LessonDraft["provenance"]> = {}): LessonDraft =>
  uniqueDraft(i, { sources, inputSources: sources, authors: [], memberSignal: false, sourceKinds: ["send_back"], measured: true, ...over });
/** Lessons a person approved, from `source`: what warms it. */
const approvedFrom = (source: string, count: number, by = "ann", offset = 0) => Array.from({ length: count }, (_, i) => lessonRecord({
  id: `les_warm${String(offset + i).padStart(4, "0")}`, status: "active", provenance: { ...lessonRecord().provenance, sources: [source], inputSources: [source], authors: [] }, approvals: [{ approvalId: `w${offset + i}`, by, at: 1, mode: "one" }],
}));

describe("the project brake", () => {
  it("projectBrakeOn: on for a day after the volume alert, off before one and after; a clock before the alert counts as on", () => {
    expect(projectBrakeOn({}, 1_000)).toBe(false);
    expect(projectBrakeOn({ volumeAlertedAt: 1_000 }, 1_000 + AUTO_APPLY_GUARDS.brakeMs - 1)).toBe(true);
    expect(projectBrakeOn({ volumeAlertedAt: 1_000 }, 1_000 + AUTO_APPLY_GUARDS.brakeMs)).toBe(false);
    expect(projectBrakeOn({ volumeAlertedAt: 5_000 }, 4_000)).toBe(true);
  });

  it("with the alert fresh, a tier-0 lesson that would have gone live waits for a person, and stays with a person; no source is paused", async () => {
    const { deps, store, clock, audit, counted } = setup({ coldStartLessons: 0 });
    await store.setFlags(KEY, { volumeAlertedAt: clock.now() - 3_600_000 });
    const out = await processDraft(deps, KEY, unique(1, ["member:ann"]));
    expect(out.lesson).toMatchObject({ status: "pending", tier: 0, reviewRequired: true });
    expect(audit.actions()).not.toContain("lesson.auto_applied");
    expect((await store.flags(KEY)).pausedSources).toBeUndefined();
    // Once the day has passed it is still with a person: a later settle does not apply it by itself.
    clock.advance(2 * DAY);
    const again = await processDraft(deps, KEY, unique(1, ["member:ann"]));
    expect(again.lesson?.status).toBe("pending");
    expect(counted.some((c) => c.name === "learning_auto_apply_held") || again.lesson?.reviewRequired === true).toBe(true);
  });

  it("a day after the alert (or with no alert) the same lesson goes live by itself", async () => {
    const stale = setup({ coldStartLessons: 0 });
    await stale.store.setFlags(KEY, { volumeAlertedAt: stale.clock.now() - 2 * DAY });
    expect((await processDraft(stale.deps, KEY, unique(1, ["member:ann"]))).lesson).toMatchObject({ status: "active" });
    const none = setup({ coldStartLessons: 0 });
    expect((await processDraft(none.deps, KEY, unique(1, ["member:ann"]))).lesson).toMatchObject({ status: "active" });
  });

  it("is reached from a REAL volume alert spread thinly over many sources: the next tier-0 lesson waits, and nobody is paused", async () => {
    const { deps, store, alerts } = setup({ coldStartLessons: 0 });
    for (let i = 0; i < 31; i += 1) await curateDraft(deps, KEY, unique(i, [`member:m${i}`]));
    expect(alerts.sent).toContain("project_volume_spike");
    expect((await store.flags(KEY)).volumeAlertedAt).toBeDefined();
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual([]);
    const next = await processDraft(deps, KEY, unique(500, ["member:late"]));
    expect(next.lesson).toMatchObject({ status: "pending", reviewRequired: true });
  });

  it("behind auto-apply: with the pilot default (a person approves tier 0) the brake changes nothing and marks nothing", async () => {
    const { deps, store, clock } = setup({ settings: settings(), coldStartLessons: 0 });
    await store.setFlags(KEY, { volumeAlertedAt: clock.now() - 1_000 });
    const out = await processDraft(deps, KEY, unique(1, ["member:ann"]));
    expect(out.lesson?.status).toBe("pending");
    expect(out.lesson?.reviewRequired).toBeUndefined();
  });
});

describe("the cold-start rule", () => {
  it("a new source cannot auto-apply: its lesson waits for a person (default of nine)", async () => {
    const { deps, store, counted } = setup();
    const out = await processDraft(deps, KEY, unique(1, ["member:newbie"]));
    expect(out.lesson).toMatchObject({ status: "pending", tier: 0 });
    expect(counted).toContainEqual({ name: "learning_auto_apply_held", tags: { reason: "cold_start" } });
    expect((await store.list(KEY, { statuses: ["active"] }))).toHaveLength(0);
  });

  it("eight person-approved lessons are not enough; nine are", async () => {
    const eight = setup();
    await seed(eight.store, ...approvedFrom("member:ann", 8));
    expect((await processDraft(eight.deps, KEY, unique(1, ["member:ann"]))).lesson?.status).toBe("pending");
    const nine = setup();
    await seed(nine.store, ...approvedFrom("member:ann", 9));
    expect((await processDraft(nine.deps, KEY, unique(1, ["member:ann"]))).lesson).toMatchObject({ status: "active" });
  });

  it("an automatic go-live proves nothing: nine auto-applied lessons do not warm a source", async () => {
    const { deps, store } = setup();
    await seed(store, ...approvedFrom("member:ann", 9).map((l) => ({ ...l, approvals: [{ approvalId: "x", by: "system:auto", at: 1, mode: "auto" as const }] })));
    expect((await processDraft(deps, KEY, unique(1, ["member:ann"]))).lesson?.status).toBe("pending");
  });

  it("every source that vouches for the lesson must be warm: a warm member and a cold CI feed is cold", async () => {
    const { deps, store } = setup();
    await seed(store, ...approvedFrom("member:ann", 9));
    expect((await processDraft(deps, KEY, unique(1, ["member:ann", "ci"]))).lesson?.status).toBe("pending");
    await seed(store, ...approvedFrom("ci", 9, "bob", 100));
    expect((await processDraft(deps, KEY, unique(2, ["member:ann", "ci"]))).lesson?.status).toBe("active");
  });

  it("a lesson with no source to vouch for it does not auto-apply (fail closed)", async () => {
    const { deps, counted } = setup({ coldStartLessons: 9 });
    const out = await processDraft(deps, KEY, unique(1, []));
    expect(out.lesson?.status).toBe("pending");
    expect(counted).toContainEqual({ name: "learning_auto_apply_held", tags: { reason: "no_source" } });
  });

  it("coldSourcesOf: the lesson being settled is not counted toward its own source, and spellings of a member source are one source", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, ...approvedFrom("member:Ann", 3));
    expect((await coldSourcesOf(store, KEY, ["member:ann"], "other", 3)).cold).toEqual([]);
    expect((await coldSourcesOf(store, KEY, ["member:ann"], "les_warm0000", 3)).cold).toEqual(["member:ann"]);
  });
});
