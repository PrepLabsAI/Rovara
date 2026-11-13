// Per-test states of a parsed report, and the one split of "failed once, then the rerun" that the nightly run and a task round share (TE-C6 moved `splitFailures` here from nightly-run.ts, which re-exports it).
import { testIdOf } from "@agentx/contracts";
import type { ParsedTestReport } from "./test-report.js";

/** Failures once, then the rerun's: a test that failed again is failing, one that passed on the rerun is flaky (the same rule as the broker's `splitFailures`). */
export function splitFailures(firstRunFailures: readonly string[], rerunFailures: readonly string[]): { failed: string[]; flaky: string[] } {
  const again = new Set(rerunFailures);
  const first = [...new Set(firstRunFailures)];
  return { failed: first.filter((id) => again.has(id)).sort(), flaky: first.filter((id) => !again.has(id)).sort() };
}

export type TestState = "passed" | "failed" | "errored" | "skipped";
const WORSE: Record<TestState, number> = { skipped: 0, passed: 1, errored: 2, failed: 3 };

/** One report's tests by id; a test that appears twice is the worse of its two states. */
export function testStatesOf(report: ParsedTestReport): Map<string, TestState> {
  const states = new Map<string, TestState>();
  for (const test of report.tests) {
    const id = testIdOf(test);
    const state: TestState = test.status === "failed" ? "failed" : test.status === "errored" ? "errored" : test.status === "skipped" ? "skipped" : "passed";
    const was = states.get(id);
    if (was === undefined || WORSE[state] > WORSE[was]) states.set(id, state);
  }
  return states;
}

export const isFailingState = (state: TestState | undefined): boolean => state === "failed" || state === "errored";
