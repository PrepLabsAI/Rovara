// TE-F3 (part A): pacing for the model calls of an eval round, and the facts a round leaves behind. Pure: nothing here opens a socket, reads a clock or draws a random number; the clock is injected.
//
// The rules (the plan block TE-F3, DECISIONS 157, 165 and 165a):
//   - at most four calls at once (a ceiling the settings cannot raise), the task's call budget (default 200) and cost budget (default $2.00), with spacing between starts;
//   - a case whose call settled with a provider limit (`rate_limit`, `quota`, `overloaded`, `key_refused`), a provider error, a refusal or the task's own cap is NOT RUN: never a failed case and never a lower score. The facts say "n of N run";
//   - after a settle with `overrun: true` NO further call is started in the task ("budget exceeded by one call"). Calls already in flight were reserved on the meter before the overrun, so the adapter (not this planner) is what
//     bounds them; with one call at a time exactly one call can be over;
//   - a case is its position and nothing else. No case id, input or output is ever held here.
// The model calls themselves go through the model-egress port (`evalCaseCallVia` is the one place that reads its stream); a test hands the round the fake adapter, and real calls light up when the laptop and Cloud adapters land.
import { NOT_RUN_CLASSES, type ModelEgressNotRunClass } from "./model-egress/classify.js";
import { MODEL_EGRESS_OVERRUN_SENTENCE } from "./model-egress/cost.js";
import type { ModelEgress, ModelEgressScope } from "./ports/model-egress.js";
import type { ModelEgressFrame } from "./model-egress/frame.js";

/** The five classes the model-call ledger calls "not run", plus a provider error: an eval case whose call got no usable answer (an outage, a 5xx, a dropped connection) has no answer to score (DECISIONS 170: "a provider outage gives not run, never a pass"). */
/** And a refusal by the adapter itself (`not_found`, `not_allowed`, `bad_request`, `too_large`, `ssrf`): no model answered, so there is nothing to score. Decided explicitly for every refusal word (a harness fault is not a measured answer). */
export type EvalNotRunClass = ModelEgressNotRunClass | "provider_error" | "refused";
export const EVAL_NOT_RUN_CLASSES: readonly EvalNotRunClass[] = [...NOT_RUN_CLASSES, "provider_error", "refused"];

/** Above this share of cases not run, the whole eval is not run (a score over too few cases says nothing). */
export const EVAL_NOT_RUN_FRACTION_MAX = 0.2;
/** The most calls in flight at once, whatever a project's settings ask for. */
export const EVAL_MAX_IN_FLIGHT_CEILING = 4;

export interface EvalPacingLimits {
  /** Calls at once; at most `EVAL_MAX_IN_FLIGHT_CEILING`. */
  readonly maxInFlight: number;
  /** The task's call budget (D5 default 200). */
  readonly maxCalls: number;
  /** The task's cost budget in micro-dollars (D5 default $2.00). */
  readonly maxCostMicros: number;
  /** The least time between two starts, in milliseconds. */
  readonly spacingMs: number;
}
export const EVAL_PACING_DEFAULTS: EvalPacingLimits = { maxInFlight: 4, maxCalls: 200, maxCostMicros: 2_000_000, spacingMs: 100 };

/** What one call settled as: the evidence class word, the whole micro-dollars it cost, and whether it took the spend past the cap. Structural: the egress port's settle fits it. */
export interface EvalCallSettle {
  readonly class: string;
  readonly costMicros: number;
  readonly overrun?: boolean;
}
/** The injected clock: `now` in milliseconds and a `sleep` that resolves after that many. */
export interface EvalClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
/** One case's call, by position. */
export type EvalCaseCall = (index: number) => Promise<EvalCallSettle>;

export type EvalCaseState = { readonly index: number; readonly state: "ran"; readonly class: string } | { readonly index: number; readonly state: "not_run"; readonly class: EvalNotRunClass };

/** What a round leaves behind about its cases: counts only. */
export interface EvalRoundFacts {
  readonly total: number;
  readonly run: number;
  readonly notRun: number;
  readonly byClass: Readonly<Partial<Record<EvalNotRunClass, number>>>;
  /** A call settled over the task's cap, so no further call was made. */
  readonly overrunStop: boolean;
}

const isNotRunClass = (value: string): value is EvalNotRunClass => (EVAL_NOT_RUN_CLASSES as readonly string[]).includes(value);

/** The facts for a round whose cases each settled with one class word. A word that is not one of the five is a case that ran. */
export function evalFactsFromClasses(classes: readonly string[], overrunStop = false): EvalRoundFacts {
  const byClass: Partial<Record<EvalNotRunClass, number>> = {};
  let notRun = 0;
  for (const word of classes) {
    if (!isNotRunClass(word)) continue;
    byClass[word] = (byClass[word] ?? 0) + 1;
    notRun += 1;
  }
  return { total: classes.length, run: classes.length - notRun, notRun, byClass, overrunStop };
}
/** The facts for a round with no model call that could be refused (an eval that calls nothing outside the process). */
export function evalFactsAllRun(total: number): EvalRoundFacts {
  return { total, run: total, notRun: 0, byClass: {}, overrunStop: false };
}

export interface EvalPacingResult {
  readonly facts: EvalRoundFacts;
  /** One entry per case, in order: its position, whether it ran, and the class word. */
  readonly cases: readonly EvalCaseState[];
  readonly peakInFlight: number;
  readonly started: number;
  readonly spentMicros: number;
  /** "budget exceeded by one call" when the round stopped after an overrun; absent otherwise. */
  readonly overrunSentence?: string;
}

const wholeMicros = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveWhole = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback);

/**
 * Runs `cases` calls with the pacing rules and returns the facts. Never throws for a call that throws (that case is answered as a provider error and ran). A call that settles with an unreadable cost is treated as having used the
 * whole cost budget, so the round stops starting calls (fail closed).
 */
export async function runEvalCasesPaced(args: { readonly cases: number; readonly call: EvalCaseCall; readonly clock: EvalClock; readonly limits?: Partial<EvalPacingLimits> }): Promise<EvalPacingResult> {
  const total = Number.isSafeInteger(args.cases) && args.cases > 0 ? args.cases : 0;
  const limits = {
    maxInFlight: Math.max(1, Math.min(EVAL_MAX_IN_FLIGHT_CEILING, positiveWhole(args.limits?.maxInFlight, EVAL_PACING_DEFAULTS.maxInFlight))),
    maxCalls: positiveWhole(args.limits?.maxCalls, EVAL_PACING_DEFAULTS.maxCalls),
    maxCostMicros: positiveWhole(args.limits?.maxCostMicros, EVAL_PACING_DEFAULTS.maxCostMicros),
    spacingMs: positiveWhole(args.limits?.spacingMs, EVAL_PACING_DEFAULTS.spacingMs),
  };
  const states: Array<EvalCaseState | undefined> = Array.from({ length: total }, () => undefined);
  const running = new Set<Promise<void>>();
  let next = 0;
  let started = 0;
  let lastStart = 0;
  let inFlight = 0;
  let peak = 0;
  let spent = 0;
  let overrun = false;

  const stopped = (): boolean => overrun || started >= limits.maxCalls || spent >= limits.maxCostMicros;
  const launch = (index: number): void => {
    started += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    lastStart = args.clock.now();
    const task = (async () => {
      let settle: EvalCallSettle;
      try {
        settle = await args.call(index);
      } catch {
        settle = { class: "provider_error", costMicros: 0 };
      }
      const word = typeof settle.class === "string" ? settle.class : "provider_error";
      if (wholeMicros(settle.costMicros)) spent += settle.costMicros;
      else spent = limits.maxCostMicros;
      if (settle.overrun === true) overrun = true;
      states[index] = isNotRunClass(word) ? { index, state: "not_run", class: word } : { index, state: "ran", class: word };
    })().finally(() => {
      inFlight -= 1;
      running.delete(task);
    });
    running.add(task);
  };

  while (next < total && !stopped()) {
    if (running.size >= limits.maxInFlight) {
      await Promise.race(running);
      continue;
    }
    const wait = started === 0 ? 0 : lastStart + limits.spacingMs - args.clock.now();
    if (wait > 0) {
      await args.clock.sleep(wait);
      continue;
    }
    launch(next);
    next += 1;
  }
  await Promise.all(running);
  // Every case that was never started is not run: the task's budget (or the one overrun) stopped it.
  for (let index = 0; index < total; index += 1) if (states[index] === undefined) states[index] = { index, state: "not_run", class: "cap" };
  const cases = states as EvalCaseState[];
  const facts = evalFactsFromClasses(cases.map((entry) => (entry.state === "not_run" ? entry.class : "ok")), overrun);
  return { facts, cases, peakInFlight: peak, started, spentMicros: spent, ...(overrun ? { overrunSentence: MODEL_EGRESS_OVERRUN_SENTENCE } : {}) };
}

/**
 * One eval case's call through the model-egress port: forwards the frame for that case and reads the stream to its settle. The settle's class, cost and overrun flag are all that is kept (never a head, header or body). A stream
 * that ends without a settle, or that throws, answers as a provider error. This is the ONE place the round reads the port, so the wiring step when a real adapter lands is handing a `ModelEgress` and a scope to this function.
 */
export function evalCaseCallVia(egress: ModelEgress, scope: ModelEgressScope, frameFor: (index: number) => ModelEgressFrame): EvalCaseCall {
  return async (index) => {
    try {
      for await (const event of egress.forward(scope, frameFor(index))) {
        if (event.kind === "settle") return { class: event.class, costMicros: event.costMicros, ...(event.overrun === true ? { overrun: true } : {}) };
      }
    } catch {
      return { class: "provider_error", costMicros: 0 };
    }
    return { class: "provider_error", costMicros: 0 };
  };
}
