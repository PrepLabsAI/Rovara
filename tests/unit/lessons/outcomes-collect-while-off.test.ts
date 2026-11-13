// Collect while off, for the outcomes judge: while the install's lessons switch is off, or cannot be read, a finished task with member comments makes NO judge call and NO model call, and no helpful mark is
// queued. With the switch on the same task is judged as before. Two locks are tested apart: the capped mode in `recordTaskOutcome`, and the gated model inside `modelCorrectionJudge`.
import { afterEach, describe, expect, it } from "vitest";
import { recordTaskOutcome, REVERT_WINDOW_MS, settleHelpful, type CounterDeps } from "../../../packages/lessons/src/counters.js";
import { modelCorrectionJudge } from "../../../packages/lessons/src/judge-model.js";
import { LESSONS_SWITCHED_OFF } from "../../../packages/lessons/src/model-gate.js";
import { setLearnedLessonsGate } from "../../../packages/lessons/src/policy.js";
import { InMemoryLessonStore, type LoadManifest } from "../../../packages/lessons/src/store.js";
import type { PipelineModel } from "../../../packages/lessons/src/ports.js";
import { Alerts, Audit, Clock, Judge, KEY, PROJECT, ScriptedModel, Spend, WS, lessonRecord, seed, settings } from "./lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(() => true); });

const OFF_STATES = { off: () => false, unreadable: () => { throw new Error("the environment cannot be read"); } } as const;
const offStates = Object.entries(OFF_STATES) as Array<[keyof typeof OFF_STATES, () => boolean]>;

const manifest = (taskId: string): LoadManifest => ({
  taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1,
  lessons: [{ id: "les_aaaa1111", version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const }], bytes: 100,
});
const comment = { kind: "review_comment" as const, paths: ["src/retry/a.ts"], text: "use the shared retry helper here", at: 1, authorId: "dev-ann" };
const merged = (over: Record<string, unknown> = {}) => ({ ...KEY, taskId: "task-1", outcome: "merged" as const, sendBacks: 0, mergedAt: 1_800_000_000_000, corrections: [comment], ...over });

/** A model that counts quotes and completions both. */
class CountingModel extends ScriptedModel implements PipelineModel {
  quotes = 0;
  quote = async (): Promise<{ ok: true; usd: number }> => { this.quotes += 1; return { ok: true, usd: 0.01 }; };
}

async function setup(judge: CounterDeps["judge"], mode: "On" | "Suggest" = "On") {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  await seed(store, lessonRecord({ expiresAt: clock.now() + 5 * 86_400_000 }));
  await store.putManifest(manifest("task-1"));
  const deps: CounterDeps = { store, judge, settings: settings({ mode }), audit: new Audit(), alerts: new Alerts(), now: clock.now };
  return { deps, store, clock };
}

describe("recordTaskOutcome while the lessons switch is off", () => {
  it.each(offStates)("switch %s: a merged task with a member comment makes zero judge calls and queues no helpful mark; the stored mode stays On", async (_name, gate) => {
    setLearnedLessonsGate(gate);
    const judge = new Judge("unrelated");
    const { deps, store } = await setup(judge);
    expect(await recordTaskOutcome(deps, merged())).toEqual({ harmful: [], queuedHelpful: [] });
    expect(judge.calls).toBe(0);
    expect(await store.duePending(KEY, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    // A merge with no comment queues no helpful mark while off either.
    expect(await recordTaskOutcome(deps, merged({ taskId: "task-1", corrections: [] }))).toEqual({ harmful: [], queuedHelpful: [] });
    expect(await store.duePending(KEY, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it.each(offStates)("switch %s: the real model-backed judge sends no quote and no completion, whoever calls it; it says it is not usable", async (_name, gate) => {
    setLearnedLessonsGate(gate);
    const model = new CountingModel([{ text: '{"rating":"caused"}', costUsd: 0.01 }]);
    const spend = new Spend();
    const judge = modelCorrectionJudge({ model, spend });
    await expect(judge.rate({ workspaceId: WS, project: PROJECT, lesson: lessonRecord(), correctionKind: "review_comment", correctionText: "use the helper" })).rejects.toThrow();
    expect(await judge.usable!(KEY)).toBe(false);
    expect([model.quotes, model.calls.length, spend.asked.length]).toEqual([0, 0, 0]);
    // Through the counters on a task with a member comment, with the real judge in place: still zero.
    const { deps } = await setup(judge);
    expect(await recordTaskOutcome(deps, merged())).toEqual({ harmful: [], queuedHelpful: [] });
    expect([model.quotes, model.calls.length, spend.asked.length]).toEqual([0, 0, 0]);
  });

  it("the judge's own gate holds even when the mode cap is bypassed (stored On read directly, as a caller that skipped resolveLearning would): zero provider calls", async () => {
    setLearnedLessonsGate(() => false);
    const model = new CountingModel([{ text: '{"rating":"caused"}', costUsd: 0.01 }]);
    const judge = modelCorrectionJudge({ model, spend: new Spend() });
    await expect(judge.rate({ workspaceId: WS, project: PROJECT, lesson: lessonRecord(), correctionKind: "review_comment", correctionText: "x" })).rejects.toThrow();
    expect([model.quotes, model.calls.length]).toEqual([0, 0]);
    expect(LESSONS_SWITCHED_OFF).toContain("switched off");
  });
});

describe("a revert while the lessons switch is off still takes back a queued helpful mark", () => {
  it.each(offStates)("mark queued with the switch on, switch %s, task reverted: settle gives nothing, nothing is judged, and a late merged delivery queues nothing", async (_name, gate) => {
    setLearnedLessonsGate(() => true);
    const judge = new Judge("unrelated");
    const { deps, store, clock } = await setup(judge);
    expect((await recordTaskOutcome(deps, merged({ corrections: [] }))).queuedHelpful).toEqual(["les_aaaa1111"]);
    const callsBefore = judge.calls;
    setLearnedLessonsGate(gate);
    expect(await recordTaskOutcome(deps, merged({ outcome: "reverted", corrections: [comment] }))).toEqual({ harmful: [], queuedHelpful: [] });
    expect(judge.calls).toBe(callsBefore);
    clock.advance(REVERT_WINDOW_MS + 1000);
    expect(await settleHelpful(deps, KEY)).toBe(0);
    expect((await store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(0);
    // Back on, a late merged delivery for the reverted task queues nothing.
    setLearnedLessonsGate(() => true);
    expect((await recordTaskOutcome(deps, merged({ corrections: [] }))).queuedHelpful).toEqual([]);
  });

  it("switch off, merged: no mark is queued (unchanged)", async () => {
    setLearnedLessonsGate(() => false);
    const { deps, store } = await setup(new Judge("unrelated"));
    expect((await recordTaskOutcome(deps, merged({ corrections: [] }))).queuedHelpful).toEqual([]);
    expect(await store.duePending(KEY, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });
});

describe("with the lessons switch on, the outcome is judged as before (positive controls)", () => {
  it("a comment is rated by the judge and a clean merge queues the helpful mark", async () => {
    setLearnedLessonsGate(() => true);
    const judge = new Judge("unrelated");
    const { deps, store } = await setup(judge);
    expect(await recordTaskOutcome(deps, merged())).toEqual({ harmful: [], queuedHelpful: ["les_aaaa1111"] });
    expect(judge.calls).toBe(1);
    expect(await store.duePending(KEY, Number.MAX_SAFE_INTEGER, 10)).toHaveLength(1);
  });

  it("the real model-backed judge reaches the model once (quote, then completion)", async () => {
    setLearnedLessonsGate(() => true);
    const model = new CountingModel([{ text: '{"rating":"caused"}', costUsd: 0.01 }]);
    const judge = modelCorrectionJudge({ model, spend: new Spend() });
    expect(await judge.usable!(KEY)).toBe(true);
    const { deps } = await setup(judge);
    const result = await recordTaskOutcome(deps, merged());
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ purpose: "outcome" });
    expect(result.queuedHelpful).toEqual([]);
  });
});
