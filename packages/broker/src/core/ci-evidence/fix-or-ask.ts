// TE-E0 option A: what Rovara does about a marked check that did not pass. Three answers, in a fixed order:
//  1. "your environment": the run failed before any test ran (a deploy step), or the same check is red on the main branch's latest run. Rovara does not touch the code; it says so with a link to re-run.
//  2. "ask a person": no result in time, the fix rounds are used up, a red check that says nothing about which test failed, or a fix that would weaken a test.
//  3. "fix": an assertion failure on Rovara's own head, within the cap: two rounds for a long or paid check (each costs the customer a run), and each round must pass the full sandbox suite before
//     it is pushed; three rounds otherwise, as today.
// Pure: the caller reads the facts (the per-test report, the main branch's run, the rounds used) and does what this says.
import type { CiEvidenceAskReason, EnvironmentReason } from "@agentx/contracts";
import type { MarkedState } from "./marked-checks.js";

/** Fix rounds Rovara may try on its own for a long or paid marked check (a normal check keeps `CI_FIX_ROUNDS_MAX`). */
export const LONG_CHECK_FIX_ROUNDS_MAX = 2;

/** The main branch's latest run of the same check, on the base commit: red, green, or not known (not found, not readable). */
export type MainRun = "failed" | "passed" | "unknown";

export type MarkedVerdict =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "environment"; reason: EnvironmentReason }
  | { kind: "ask"; reason: CiEvidenceAskReason }
  | { kind: "fix"; roundsMax: number; fullSandboxPassFirst: boolean };

/**
 * The verdict on one marked check. `testsRan` is the number of tests the run's per-test report holds (undefined: no report was read). `logShared` says a log tail of the run may be given to the model
 * (the customer turned logs on, and the host can hand it out): with neither a report nor a log, a red check says nothing a fix could be based on. `roundsUsed` counts this task's CI fix rounds; `roundsMax`
 * is the cap for a normal check (today's three).
 */
export function decideMarkedCheck(input: {
  state: MarkedState;
  longOrPaid: boolean;
  testsRan: number | undefined;
  /** How many tests the report says failed (undefined: no report). A red check whose report has no failed test (a coverage gate, a step after the tests) gives nothing to fix from. */
  testsFailed: number | undefined;
  logShared: boolean;
  mainRun: MainRun;
  roundsUsed: number;
  roundsMax: number;
}): MarkedVerdict {
  const { state } = input;
  if (state.kind === "passed") return { kind: "none" };
  if (state.kind === "waiting") return { kind: "wait" };
  // Nothing answered, or the pipeline skipped the check (a draft-skipping pipeline, a path filter): not a failure and nothing to fix, but CI cannot pass without it, so a person looks.
  if (state.kind === "not_run") return { kind: "ask", reason: state.reason === "timed_out" ? "timed_out" : "skipped" };
  if (input.testsRan === 0) return { kind: "environment", reason: "failed_before_tests" };
  if (input.mainRun === "failed") return { kind: "environment", reason: "red_on_main" };
  if (input.testsRan === undefined && !input.logShared) return { kind: "ask", reason: "no_detail" };
  if (input.testsRan !== undefined && (input.testsFailed === undefined || input.testsFailed === 0) && !input.logShared) return { kind: "ask", reason: "no_detail" };
  // Counts that are not counts never open an uncapped round.
  const counted = (value: number, min: number): boolean => Number.isSafeInteger(value) && value >= min;
  if (!counted(input.roundsUsed, 0) || !counted(input.roundsMax, 1)) return { kind: "ask", reason: "cap_reached" };
  const cap = input.longOrPaid ? Math.min(LONG_CHECK_FIX_ROUNDS_MAX, input.roundsMax) : input.roundsMax;
  if (input.roundsUsed >= cap) return { kind: "ask", reason: "cap_reached" };
  return { kind: "fix", roundsMax: cap, fullSandboxPassFirst: input.longOrPaid };
}

/** Whether a fix round for a marked check may be pushed: never one that weakens a test (a person decides), and for a long or paid check only after the full sandbox suite passed. */
export function judgeMarkedFixPush(input: { weakensTest: boolean; fullSandboxPassFirst: boolean; fullSandboxPassed: boolean }): { kind: "push" } | { kind: "ask"; reason: "weakens_test" } | { kind: "hold"; reason: "sandbox_not_passed" } {
  if (input.weakensTest) return { kind: "ask", reason: "weakens_test" };
  if (input.fullSandboxPassFirst && !input.fullSandboxPassed) return { kind: "hold", reason: "sandbox_not_passed" };
  return { kind: "push" };
}
