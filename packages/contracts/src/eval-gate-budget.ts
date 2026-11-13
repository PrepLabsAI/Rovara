// TE-F3-b (L4): the TASK's budget (calls and micro-dollars) is shared by every model call of the eval: the old-code runs (base) and the new-code runs (head), visible and holdout. The caller hands the REMAINING budget to the pacer for
// each round (`evalPacingLimitsFrom`) and subtracts what the round used (`evalBudgetAfter`), so the later rounds can never spend what the earlier ones did. A budget that is not a plain whole number is empty (fail closed): no call is made.
import { EVAL_PACING_DEFAULTS, type EvalPacingLimits, type EvalPacingResult } from "./eval-pacing.js";

export interface EvalTaskBudget {
  /** Calls the task may still make. */
  readonly calls: number;
  /** Micro-dollars the task may still spend. */
  readonly micros: number;
}
const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

/** The pacer's limits for a round that may spend at most what is left of the task's budget (the spacing stays the default 100 ms). */
export function evalPacingLimitsFrom(budget: EvalTaskBudget, spacingMs: number = EVAL_PACING_DEFAULTS.spacingMs): Partial<EvalPacingLimits> {
  return { maxCalls: whole(budget?.calls), maxCostMicros: whole(budget?.micros), spacingMs };
}
/** What is left after a round: its started calls and its spend come off, never below zero. */
export function evalBudgetAfter(budget: EvalTaskBudget, used: Pick<EvalPacingResult, "started" | "spentMicros">): EvalTaskBudget {
  const calls = whole(budget?.calls);
  const micros = whole(budget?.micros);
  const started = Number.isSafeInteger(used.started) && used.started > 0 ? used.started : 0;
  const spent = Number.isSafeInteger(used.spentMicros) && used.spentMicros > 0 ? used.spentMicros : 0;
  return { calls: Math.max(0, calls - started), micros: Math.max(0, micros - spent) };
}
