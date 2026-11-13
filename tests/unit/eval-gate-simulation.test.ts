// TE-F3-b (review H1): a seeded NO-CHANGE simulation. The new code is exactly the old code (same per-question pass rates); the gate must almost never call that a regression. Questions that almost always pass make whole categories
// whose old runs never varied (zero standard error); those used to get p = 0 and were always "rejected" by Holm (97% false regressions). Now they get p = 1.
import { describe, expect, it } from "vitest";
import { evalGate, type EvalGateSetData } from "../../packages/contracts/src/eval-gate.js";
import type { EvalQuestionResult } from "../../packages/contracts/src/measures-file.js";
import { evalGatePlanHash } from "../../packages/contracts/src/eval-gate-inputs.js";
import { BEFORE_TASK, PLAN, gateInput } from "../support/eval-gate-world.js";

const PLAN_COARSE = { ...PLAN, minDetectableDrop: 0.1 };
const coarse = { plan: PLAN_COARSE, recordedPlanHash: evalGatePlanHash(PLAN_COARSE) };

/** A small seeded generator (mulberry32): the same numbers every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CATEGORIES = ["billing", "search", "tone", "safety-refusals"] as const;
const RATE: Record<(typeof CATEGORIES)[number], (random: () => number) => number> = {
  billing: () => 0.98, search: () => 0.97, tone: (random) => 0.3 + 0.6 * random(), "safety-refusals": () => 0.99,
};
function sampledSet(random: () => number, prefix: string): EvalGateSetData {
  const base: EvalQuestionResult[] = [];
  const head: EvalQuestionResult[] = [];
  for (const category of CATEGORIES) {
    for (let index = 0; index < 10; index += 1) {
      const id = `${prefix}-${category}-${String(index)}`;
      const rate = RATE[category](random);
      for (let run = 0; run < 5; run += 1) base.push({ id, category, run, score: random() < rate ? 1 : 0 });
      for (let run = 0; run < 3; run += 1) head.push({ id, category, run, score: random() < rate ? 1 : 0 });
    }
  }
  return { base, head, baseSeed: "seed-1", headSeed: "seed-1", setCommittedAt: BEFORE_TASK };
}

describe("no-change simulation", () => {
  it("calls an unchanged system a regression in well under 10% of 300 seeded trials", () => {
    const random = seeded(20261113);
    let regressions = 0;
    let judged = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const result = evalGate(gateInput({ ...coarse, visible: sampledSet(random, "q"), holdout: sampledSet(random, "h") }));
      if (result.regression) regressions += 1;
      if (result.qualified) judged += 1;
    }
    expect(regressions / 300).toBeLessThan(0.1);
    // And it is not just refusing everything: a good share of unchanged systems are cleared.
    expect(judged / 300).toBeGreaterThan(0.5);
  });
  it("still catches a real drop in the same setting", () => {
    const random = seeded(7);
    let caught = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const visible = sampledSet(random, "q");
      const worse = { ...visible, head: visible.head.map((row) => (row.category === "tone" && random() < 0.5 ? { ...row, score: 0 } : row)) };
      if (evalGate(gateInput({ ...coarse, visible: worse, holdout: sampledSet(random, "h") })).regression) caught += 1;
    }
    expect(caught).toBeGreaterThan(40);
  });
});
