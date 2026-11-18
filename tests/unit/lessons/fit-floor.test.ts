// Lessons phase 1, the fit floor (research Q1): a lesson is loaded only when it fits the task on an ABSOLUTE measure (a scope path matched, the shared-word share, or the embedder's cosine), so a step gets FEWER than 5 when few
// fit. The fused rank score is relative (phase 0 found it), so it is never what the floor looks at.
import { describe, expect, it } from "vitest";
import { passesFitFloor, fitOrder } from "../../../packages/broker/src/lessons/fit.js";
import { FIT_FLOOR_COSINE, FIT_FLOOR_WORDS, resolveRanking } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { NO_FIT_FLOOR, PROJECT, WS, closeEmbedder } from "./lesson-helpers.js";
import { fitting, ids, unrelated, world } from "./phase12-helpers.js";

describe("the floor on an absolute fit", () => {
  it("passes a lesson whose path matched, or whose words share enough, or whose cosine is close; nothing else", () => {
    expect(passesFitFloor({ words: 0, cos: undefined, byPath: true })).toBe(true);
    expect(passesFitFloor({ words: FIT_FLOOR_WORDS, cos: undefined, byPath: false })).toBe(true);
    expect(passesFitFloor({ words: FIT_FLOOR_WORDS - 0.01, cos: undefined, byPath: false })).toBe(false);
    expect(passesFitFloor({ words: 0, cos: FIT_FLOOR_COSINE, byPath: false })).toBe(true);
    expect(passesFitFloor({ words: 0.2, cos: FIT_FLOOR_COSINE - 0.01, byPath: false })).toBe(false);
    expect(passesFitFloor({ words: Number.NaN, cos: Number.NaN, byPath: false })).toBe(false);
  });

  it("orders the best fit first: a path match, then the larger of the words share and the cosine scaled to its floor", () => {
    expect(fitOrder({ words: 0.1, cos: undefined, byPath: true })).toBeGreaterThan(fitOrder({ words: 1, cos: undefined, byPath: false }));
    expect(fitOrder({ words: 0.5, cos: undefined, byPath: false })).toBeGreaterThan(fitOrder({ words: 0.4, cos: undefined, byPath: false }));
    expect(fitOrder({ words: 0, cos: 0.9, byPath: false })).toBeGreaterThan(fitOrder({ words: 0, cos: 0.8, byPath: false }));
  });

  it("a setting out of range, or not a number, is ignored (the default stands): a bad setting never turns the floor off", () => {
    expect(resolveRanking({ fitFloorWords: 1.5, fitFloorCosine: Number.NaN }).fitFloorWords).toBe(FIT_FLOOR_WORDS);
    expect(resolveRanking({ fitFloorWords: -1 }).fitFloorWords).toBe(FIT_FLOOR_WORDS);
    expect(resolveRanking({ fitFloorWords: 0.5 }).fitFloorWords).toBe(0.5);
    expect(resolveRanking({ fitFloorWords: 0 }).fitFloorWords).toBe(0);
  });
});

describe("what a step is loaded with", () => {
  const eight = () => [fitting("les_fit00001"), fitting("les_fit00002", { title: "Retries use withRetry", body: "HTTP calls that fail are retried in the api service with withRetry" }), ...Array.from({ length: 6 }, (_, i) => unrelated(`les_oth0000${i}`))];

  it("with eight lessons and two that fit, the step gets two (never filled up to 5 with lessons about other things)", async () => {
    const w = await world();
    await w.add(...eight());
    const loaded = ids(await w.load());
    expect(loaded.sort()).toEqual(["les_fit00001", "les_fit00002"]);
  });

  it("MUTANT: with the floor removed (the floor settings at 0) the same project loads five, the weak ones included", async () => {
    const w = await world();
    await w.add(...eight());
    const loaded = ids(await w.load({}, { ranking: NO_FIT_FLOOR }));
    expect(loaded).toHaveLength(5);
    expect(loaded.filter((id) => id.startsWith("les_oth")).length).toBeGreaterThan(0);
  });

  it("when nothing fits the step is given no lessons at all, and the load says why (no_lessons)", async () => {
    const w = await world();
    await w.add(...Array.from({ length: 6 }, (_, i) => unrelated(`les_oth0000${i}`)));
    const result = await w.load();
    expect(result.context).toBeUndefined();
    expect(result.skipped).toBe("no_lessons");
    // Nothing loaded means nothing was recorded as loaded: the manifest names no lesson.
    expect(result.manifest.lessons).toEqual([]);
  });

  it("a lesson whose scope path matches a file the task touches always passes, however few words it shares", async () => {
    const w = await world();
    await w.add(unrelated("les_path0001", { scope: { repos: ["api"], paths: ["src/retry/**"] } }), unrelated("les_far00001", { scope: { repos: ["api"], paths: ["docs/**"] } }));
    const result = await w.load();
    expect(ids(result)).toEqual(["les_path0001"]);
    expect(result.manifest.lessons[0]!.why).toBe("path");
  });

  it("with an embedder, a lesson that shares no words but is close in meaning (cosine over the floor) passes", async () => {
    const w = await world({ embedder: true });
    await w.add(unrelated("les_sem00001"));
    const none = await w.load();
    expect(ids(none)).toEqual([]);
    // An embedder that finds every text exactly as close as every other: the cosine is 1, over the floor (the lesson's vector is of that embedder's own spec).
    await w.vectors.put(WS, PROJECT, closeEmbedder.spec, "les_sem00001", { hash: "stale", vector: [1, 0, 0, 0] });
    const close = await w.load({ taskId: "task-2" }, { embedder: closeEmbedder });
    expect(ids(close)).toEqual(["les_sem00001"]);
  });

  it("a lesson that fits only the stage's other kind is still held to the stage rule, and the floor never loads what the stage forbids", async () => {
    const w = await world();
    await w.add(fitting("les_rchk0001", { type: "review_check", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] }), fitting("les_conv0001"));
    expect(ids(await w.load())).toEqual(["les_conv0001"]);
  });

  it("the measure still records every lesson that was ranked, so phase 0's numbers go on (the floor changes what loads, not what is measured)", async () => {
    const recorded: Array<{ loaded: number; left: number }> = [];
    const w = await world();
    await w.add(...eight());
    await w.load({}, { measure: { load: async (m) => { recorded.push({ loaded: m.loaded.length, left: m.leftOut.length }); }, merged: async () => undefined, reverted: async () => undefined } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded).toEqual([{ loaded: 2, left: 5 }]);
  });
});

describe("isolation: the floor reads only this load's own lessons", () => {
  it("another project's lessons that fit never load here, and the load's signals are read for this company and project only", async () => {
    const w = await world();
    await w.add(fitting("les_mine0001"), fitting("les_other001", { project: "proj-2" }));
    expect(ids(await w.load())).toEqual(["les_mine0001"]);
  });
});
