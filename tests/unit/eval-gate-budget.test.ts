// TE-F3-b (L4): one task budget shared by the base and head rounds.
import { describe, expect, it } from "vitest";
import { evalBudgetAfter, evalBudgetAfterHidden, evalPacingLimitsFrom } from "../../packages/contracts/src/eval-gate-budget.js";
import { EVAL_GATE_PLAN_DEFAULTS, evalCallsNeeded } from "../../packages/contracts/src/eval-gate-inputs.js";
import { EVAL_MIN_QUESTIONS } from "../../packages/contracts/src/eval-check.js";
import { EVAL_PACING_DEFAULTS, runEvalCasesPaced, type EvalClock } from "../../packages/contracts/src/eval-pacing.js";

const clock = (): EvalClock => { let now = 0; return { now: () => now, sleep: (ms) => { now += ms; return Promise.resolve(); } }; };
const cheap = () => Promise.resolve({ class: "ok", costMicros: 1_000 });

describe("the task budget", () => {
  it("gives the pacer what is left, with the 100 ms spacing", () => {
    expect(evalPacingLimitsFrom({ calls: 7, micros: 9_000 })).toEqual({ maxCalls: 7, maxCostMicros: 9_000, spacingMs: 100 });
    expect(evalPacingLimitsFrom({ calls: 0, micros: -3 })).toEqual({ maxCalls: 0, maxCostMicros: 0, spacingMs: 100 });
    expect(evalPacingLimitsFrom({ calls: Number.NaN, micros: 1.5 })).toMatchObject({ maxCalls: 0, maxCostMicros: 0 });
    expect(evalPacingLimitsFrom(undefined as never)).toMatchObject({ maxCalls: 0 });
  });
  it("is shared: the head round gets only what the base round left, and the rest of its cases are not run", async () => {
    const start = { calls: 10, micros: 1_000_000 };
    const base = await runEvalCasesPaced({ cases: 6, call: cheap, clock: clock(), limits: evalPacingLimitsFrom(start) });
    expect(base.facts.notRun).toBe(0);
    const left = evalBudgetAfter(start, base);
    expect(left).toEqual({ calls: 4, micros: 1_000_000 - 6_000 });
    const head = await runEvalCasesPaced({ cases: 6, call: cheap, clock: clock(), limits: evalPacingLimitsFrom(left) });
    expect(head.started).toBe(4);
    expect(head.facts).toMatchObject({ run: 4, notRun: 2, byClass: { cap: 2 } });
  });
  it("is shared in dollars too, and never goes below zero", async () => {
    const start = { calls: 100, micros: 5_000 };
    const base = await runEvalCasesPaced({ cases: 20, call: cheap, clock: clock(), limits: evalPacingLimitsFrom(start) });
    expect(base.started).toBe(5);
    expect(evalBudgetAfter(start, base)).toEqual({ calls: 95, micros: 0 });
    expect(evalBudgetAfter({ calls: 1, micros: 1 }, { started: 9, spentMicros: 9 })).toEqual({ calls: 0, micros: 0 });
    expect(evalBudgetAfter({ calls: 5, micros: 5 }, { started: Number.NaN, spentMicros: -4 })).toEqual({ calls: 5, micros: 5 });
  });
  it("respects an overrun: a round that went over the cap leaves nothing", async () => {
    const start = { calls: 100, micros: 2_000 };
    const over = await runEvalCasesPaced({ cases: 10, call: () => Promise.resolve({ class: "ok", costMicros: 5_000, overrun: true }), clock: clock(), limits: evalPacingLimitsFrom(start) });
    expect(over.facts.overrunStop).toBe(true);
    expect(evalBudgetAfter(start, over)).toEqual({ calls: 0, micros: 0 });
    expect(evalBudgetAfter({ calls: 50, micros: 50 }, { started: 1, spentMicros: 1, facts: { overrunStop: true } })).toEqual({ calls: 0, micros: 0 });
  });
  it("charges a hidden round a FIXED reservation, so what it really used says nothing, and never less than it used", () => {
    const start = { calls: 100, micros: 100_000 };
    const reservation = { calls: 40, micros: 40_000 };
    const small = evalBudgetAfterHidden(start, reservation, { started: 5, spentMicros: 500 });
    const large = evalBudgetAfterHidden(start, reservation, { started: 38, spentMicros: 30_000 });
    expect(small).toEqual({ calls: 60, micros: 60_000 });
    expect(large).toEqual(small);
    expect(evalBudgetAfterHidden(start, reservation, { started: 70, spentMicros: 90_000 })).toEqual({ calls: 30, micros: 10_000 });
    expect(evalBudgetAfterHidden(start, reservation, { started: 1, spentMicros: 1, facts: { overrunStop: true } })).toEqual({ calls: 0, micros: 0 });
  });
});

describe("the default plan and the 200-call task budget", () => {
  it("runs the old code 3 times and the new code once", () => {
    expect(EVAL_GATE_PLAN_DEFAULTS).toEqual({ baseRuns: 3, headRuns: 1, minDetectableDrop: 0.15 });
  });
  it("fits a minimum eval (20 visible and 20 hidden questions) on a cache miss: 160 calls of the shared 200", async () => {
    const questions = EVAL_MIN_QUESTIONS;
    expect(evalCallsNeeded({ visibleQuestions: questions, hiddenQuestions: questions, ...EVAL_GATE_PLAN_DEFAULTS, baselineCached: false })).toBe(160);
    expect(evalCallsNeeded({ visibleQuestions: questions, hiddenQuestions: questions, ...EVAL_GATE_PLAN_DEFAULTS, baselineCached: true })).toBe(40);
    // For real, through the pacer: the two old-code rounds, then the two new-code rounds, one shared budget.
    let budget = { calls: EVAL_PACING_DEFAULTS.maxCalls, micros: EVAL_PACING_DEFAULTS.maxCostMicros };
    const results = [];
    for (const cases of [questions * 3, questions * 3, questions, questions]) {
      const round = await runEvalCasesPaced({ cases, call: cheap, clock: clock(), limits: evalPacingLimitsFrom(budget) });
      results.push(round);
      budget = evalBudgetAfter(budget, round);
    }
    expect(results.every((round) => round.facts.notRun === 0)).toBe(true);
    expect(results.reduce((sum, round) => sum + round.started, 0)).toBe(160);
    expect(budget.calls).toBe(40);
  });
  it("would not fit with 5 old runs and 3 new ones (the old defaults): the last rounds are not run", async () => {
    expect(evalCallsNeeded({ visibleQuestions: 20, hiddenQuestions: 20, baseRuns: 5, headRuns: 3, baselineCached: false })).toBe(320);
  });
});
