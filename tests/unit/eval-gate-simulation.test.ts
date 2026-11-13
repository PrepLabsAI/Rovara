// TE-F3-b (review H1, re-check): seeded simulations at the OWNER'S DEFAULTS: the old code runs 3 times and the new code once, 20 visible + 20 hidden questions, a minimum detectable drop of 0.20 (DECISIONS 186) and the finer 0.05, pass/fail questions at near-ceiling pass rates
// (0.95, 0.97, 0.98, 0.99 and U(0.8, 1)), with and without one strict category of 10 questions. The new code is exactly the old code (same pass rate per question): the gate must almost never call that a regression. And a real
// drop of 0.2 on every question must still be caught most of the time. (Near-ceiling evals at 3 + 1 runs mostly say "cannot detect the agreed drop": that is the honest answer, and it is not counted as a regression.)
// Questions that almost always pass make whole categories, even whole sets, whose old runs never varied; those are the cases that used to give 12 to 97% false regressions.
import { describe, expect, it } from "vitest";
import { evalGate, type EvalGateSetData } from "../../packages/contracts/src/eval-gate.js";
import { evalGatePlanHash, EVAL_GATE_PLAN_DEFAULTS } from "../../packages/contracts/src/eval-gate-inputs.js";
import type { EvalQuestionResult } from "../../packages/contracts/src/measures-file.js";
import { BEFORE_TASK, PLAN, SEED, gateInput } from "../support/eval-gate-world.js";

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
const planWith = (minDetectableDrop: number) => { const plan = { ...PLAN, ...EVAL_GATE_PLAN_DEFAULTS, minDetectableDrop }; return { plan, recordedPlanHash: evalGatePlanHash(plan) }; };
/** The owner's default minimum detectable drop (0.20, DECISIONS 186), and the finer 0.05 a project may ask for. */
const DROPS = [EVAL_GATE_PLAN_DEFAULTS.minDetectableDrop, 0.05] as const;
type Layout = ReadonlyArray<readonly [string, number]>;
/** 20 questions without a strict category, or 20 with one strict category of 10. */
const LAYOUTS: Record<string, Layout> = { "no strict": [["billing", 5], ["search", 5], ["tone", 5], ["other", 5]], "strict of 10": [["billing", 5], ["search", 5], ["safety-refusals", 10]] };
const RATES: Record<string, (random: () => number) => number> = { "0.95": () => 0.95, "0.97": () => 0.97, "0.98": () => 0.98, "0.99": () => 0.99, "U(.8,1)": (random) => 0.8 + 0.2 * random() };

function sampledSet(random: () => number, prefix: string, layout: Layout, rate: (random: () => number) => number, shift: number): EvalGateSetData {
  const base: EvalQuestionResult[] = [];
  const head: EvalQuestionResult[] = [];
  for (const [category, perCategory] of layout) {
    for (let index = 0; index < perCategory; index += 1) {
      const id = `${prefix}-${category}-${String(index)}`;
      const passRate = rate(random);
      const moved = Math.min(1, Math.max(0, passRate + shift));
      for (let run = 0; run < EVAL_GATE_PLAN_DEFAULTS.baseRuns; run += 1) base.push({ id, category, run, score: random() < passRate ? 1 : 0 });
      for (let run = 0; run < EVAL_GATE_PLAN_DEFAULTS.headRuns; run += 1) head.push({ id, category, run, score: random() < moved ? 1 : 0 });
    }
  }
  return { base, head, baseSeed: SEED, headSeed: SEED, setCommittedAt: BEFORE_TASK };
}
function trials(layout: Layout, rate: (random: () => number) => number, shift: number, count: number, seed: number, drop: number): { regression: number; qualified: number } {
  const random = seeded(seed);
  let regression = 0;
  let qualified = 0;
  for (let trial = 0; trial < count; trial += 1) {
    const result = evalGate(gateInput({ ...planWith(drop), visible: sampledSet(random, "q", layout, rate, shift), holdout: sampledSet(random, "h", layout, rate, shift) }));
    if (result.regression) regression += 1;
    if (result.qualified) qualified += 1;
  }
  return { regression: regression / count, qualified: qualified / count };
}
const COUNT = 500;

describe("no-change simulation at the owner's defaults (3 old runs, 1 new run, 20 + 20 questions)", () => {
  for (const drop of DROPS) {
    for (const [layoutName, layout] of Object.entries(LAYOUTS)) {
      for (const [rateName, rate] of Object.entries(RATES)) {
        it(`calls an unchanged system a regression in under 10% of ${String(COUNT)} trials: drop ${String(drop)}, ${layoutName}, pass rate ${rateName}`, () => {
          expect(trials(layout, rate, 0, COUNT, 20261113, drop).regression).toBeLessThan(0.1);
        });
      }
    }
  }
  it("is not just refusing everything: at the default drop of 0.20 and a 0.99 pass rate, more than a fifth of unchanged systems are cleared", () => {
    expect(trials(LAYOUTS["no strict"]!, RATES["0.99"]!, 0, COUNT, 20261113, EVAL_GATE_PLAN_DEFAULTS.minDetectableDrop).qualified).toBeGreaterThan(0.2);
  });
});

describe("real drop at the owner's defaults", () => {
  for (const drop of DROPS) {
    for (const [layoutName, layout] of Object.entries(LAYOUTS)) {
      for (const [rateName, rate] of Object.entries(RATES)) {
        it(`catches a drop of 0.2 on every question at least 70% of the time: drop ${String(drop)}, ${layoutName}, pass rate ${rateName}`, () => {
          expect(trials(layout, rate, -0.2, 300, 7, drop).regression).toBeGreaterThanOrEqual(0.7);
        });
      }
    }
  }
});
