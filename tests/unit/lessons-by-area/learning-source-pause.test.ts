// Lead 4 L4-LP3W / L4-LP3Wc: Pause on "Where Rovara learns from" is a STOP. A paused kind of evidence is recorded in the project's `stoppedKinds`; it touches no other kind, deletes nothing and is recorded
// first (no record, no change). What a stop does to each capture path (nothing read, stored or paid for; resume brings nothing back) is in learning-pause-stop.test.ts.
import { describe, expect, it } from "vitest";
import { LEARNING_SOURCE_KEYS } from "../../../packages/contracts/src/index.js";
import { buildLearningSources, setLearningSourcePause, SOURCE_KINDS } from "../../../packages/broker/src/lessons/learning-sources.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { SPAN_KINDS } from "../../../packages/broker/src/lessons/types.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, allowAllAccess, autoSettings, directory, embedder, facts, uniqueDraft, verifier } from "../lessons/lesson-helpers.js";

function setup() {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), coldStartLessons: 0, facts: facts(), settings: autoSettings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, audit, clock, pause: (key: (typeof LEARNING_SOURCE_KEYS)[number], paused: boolean, actor = "owner") => setLearningSourcePause({ store, audit, now: clock.now }, KEY, actor, key, paused) };
}
const kinded = (i: number, kinds: LessonDraft["provenance"]["sourceKinds"]): LessonDraft => uniqueDraft(i, { sources: ["member:ann"], inputSources: ["member:ann"], authors: [], memberSignal: false, sourceKinds: kinds, measured: true });
const flagsOf = async (store: InMemoryLessonStore) => Object.keys((await store.flags(KEY)).stoppedKinds ?? {}).sort();

describe("what each row stands for", () => {
  it("every row names kinds that exist, no kind is in two rows, and every row has a pause key per kind", () => {
    const seen = new Set<string>();
    for (const key of LEARNING_SOURCE_KEYS) {
      expect(SOURCE_KINDS[key].length).toBeGreaterThan(0);
      for (const kind of SOURCE_KINDS[key]) { expect(SPAN_KINDS).toContain(kind); expect(seen.has(kind), kind).toBe(false); seen.add(kind);  }
    }
  });
});

describe("pause and resume", () => {
  it("pausing a row records one person-reason pause per kind of the row, and no other kind", async () => {
    const { store, pause } = setup();
    expect(await pause("task_decisions", true)).toEqual({ ok: true, paused: true, changed: true });
    expect(await flagsOf(store)).toEqual(["close_reason", "send_back"]);
    // The person's stop is kept apart from the flood guard's holds on sources.
    expect((await store.flags(KEY)).pausedSources).toBeUndefined();
  });

  it("resuming clears the pause, settles nothing and puts nothing live (the stop's own behaviour is in learning-pause-stop.test.ts)", async () => {
    const { deps, store, pause } = setup();
    const lesson = await processDraft(deps, KEY, kinded(1, ["human_edit"]));
    await pause("task_decisions", true);
    expect(await pause("task_decisions", false)).toEqual({ ok: true, paused: false, changed: true });
    expect(await flagsOf(store)).toEqual([]);
    expect(await store.get(KEY, lesson.lesson!.id)).toMatchObject({ status: "active" });
  });

  it("it deletes nothing, and records the person's action BEFORE the change (no record, no change)", async () => {
    const { deps, store, audit, pause } = setup();
    await processDraft(deps, KEY, kinded(1, ["human_edit"]));
    const before = (await store.list(KEY)).length;
    const emit = audit.emit.bind(audit);
    audit.emit = async () => { throw new Error("audit down"); };
    expect(await pause("remember", true)).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await flagsOf(store)).toEqual([]);
    audit.emit = emit;
    expect(await pause("remember", true)).toMatchObject({ ok: true, changed: true });
    expect(audit.events.filter((e) => e.action === "lesson.learning_source_switched")).toMatchObject([{ actor: "owner", facts: { source: "remember", paused: true } }]);
    expect((await store.list(KEY)).length).toBe(before);
    // Resuming is recorded first too: with the record down, it stays paused.
    audit.emit = async () => { throw new Error("audit down"); };
    expect(await pause("remember", false)).toEqual({ ok: false, code: "audit_unavailable" });
    expect(await flagsOf(store)).toEqual(["remembered"]);
    audit.emit = emit;
    expect(await pause("remember", false)).toMatchObject({ ok: true, changed: true });
    expect(audit.events.filter((e) => e.action === "lesson.learning_source_switched").map((e) => e.facts["paused"])).toEqual([true, false]);
  });

  it("is idempotent, and a spike pause of a member is not touched", async () => {
    const { store, pause } = setup();
    await store.setFlags(KEY, { pausedSources: { "member:ann": { at: 1, reason: "spike" } } });
    expect(await pause("ci", true)).toMatchObject({ changed: true });
    expect(await pause("ci", true)).toEqual({ ok: true, paused: true, changed: false });
    expect(await flagsOf(store)).toEqual(["ci_failure"]);
    expect(await pause("ci", false)).toMatchObject({ changed: true });
    expect(await pause("ci", false)).toEqual({ ok: true, paused: false, changed: false });
    expect(await flagsOf(store)).toEqual([]);
    expect(Object.keys((await store.flags(KEY)).pausedSources ?? {})).toEqual(["member:ann"]);
  });

  it("another project's lessons and pauses are separate", async () => {
    const { deps, store, pause } = setup();
    await pause("task_decisions", true);
    const otherKey = { workspaceId: KEY.workspaceId, project: "proj-2" };
    expect((await store.flags(otherKey)).pausedSources).toBeUndefined();
    const lesson = await processDraft(deps, otherKey, kinded(5, ["send_back"]));
    expect(lesson.lesson!.status).toBe("active");
  });
});

describe("the row as a person reads it", () => {
  it("shows paused only while every kind of the row is held", async () => {
    const { deps, store } = setup();
    const view = { store, directory: directory(), access: allowAllAccess, now: deps.now };
    await store.setFlags(KEY, { stoppedKinds: { send_back: { at: 1 } } });
    const row = async (key: string) => (await buildLearningSources(view, { orgId: KEY.workspaceId, developerId: "ann" }, KEY.project, { canPause: true })).sources.find((r) => r.key === key)!;
    expect((await row("task_decisions")).paused).toBe(false);
    await store.setFlags(KEY, { stoppedKinds: { send_back: { at: 1 }, close_reason: { at: 1 } } });
    expect((await row("task_decisions")).paused).toBe(true);
    expect((await row("ci")).paused).toBe(false);
  });
});
