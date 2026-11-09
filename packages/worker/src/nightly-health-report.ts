// Setup and test health SH27/SH28 (worker side): what a nightly run reports about its own steps. PURE: the run's facts go in, the counts of the nightly result AND the `health` block come out of the SAME tally, so
// the two always agree (the broker reads a result whose counts differ as "unclear", never as passed). The broker classifies the block with its own rules (`classifyNightlyHealth`); nothing here decides a verdict, and
// no log, message or test name goes in: fixed step words, flags and counts only.
import { NIGHTLY_STEP_WORDS, NightlyHealthReportSchema, type NightlyHealthReport, type NightlyRanFrom, type NightlyStepWord } from "@agentx/contracts";

export type NightlyStepStatus = "passed" | "failed" | "skipped";

export interface NightlyRunFacts {
  steps: ReadonlyArray<{ step: NightlyStepWord; status: NightlyStepStatus }>;
  checks: ReadonlyArray<{ runsTests: boolean; started: boolean; timedOut: boolean; reportApproved: boolean; reportWritten: boolean; testsCollected: number }>;
  /** The final tally, after the one rerun: `failures` are assertion failures, `errors` are collection or import errors. */
  tally: { passed: number; failures: number; errors: number; skipped: number };
  /** Where the code and tools came from; left out, it is read as a fresh setup. */
  ranFrom?: NightlyRanFrom | undefined;
}

const SEVERITY: Readonly<Record<NightlyStepStatus, number>> = { skipped: 0, passed: 1, failed: 2 };

/** The `tests` of the nightly result (`failed` is failures and errors together) and its `health` block, from one tally. */
export function nightlyCountsAndHealth(facts: NightlyRunFacts): { tests: { total: number; passed: number; failed: number; skipped: number }; health: NightlyHealthReport } {
  const { passed, failures, errors, skipped } = facts.tally;
  const total = passed + failures + errors + skipped;
  // A step reported twice is one step: the worse status stands (a failure is never hidden by a later pass).
  const worst = new Map<NightlyStepWord, NightlyStepStatus>();
  for (const { step, status } of facts.steps) {
    const known = worst.get(step);
    if (known === undefined || SEVERITY[status] > SEVERITY[known]) worst.set(step, status);
  }
  const steps = NIGHTLY_STEP_WORDS.flatMap((step) => { const status = worst.get(step); return status === undefined ? [] : [{ step, status }]; });
  const health = NightlyHealthReportSchema.parse({
    steps, checks: facts.checks.map((check) => ({ ...check })), tests: { total, passed, failures, errors, skipped }, ...(facts.ranFrom === undefined ? {} : { ranFrom: facts.ranFrom }),
  });
  return { tests: { total, passed, failed: failures + errors, skipped }, health };
}
