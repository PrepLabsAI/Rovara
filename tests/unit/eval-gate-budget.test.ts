// TE-F3-b (L4): one task budget shared by the base and head rounds.
import { describe, expect, it } from "vitest";
import { evalBudgetAfter, evalPacingLimitsFrom } from "../../packages/contracts/src/eval-gate-budget.js";
import { runEvalCasesPaced, type EvalClock } from "../../packages/contracts/src/eval-pacing.js";

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
});
