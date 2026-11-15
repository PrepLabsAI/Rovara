// TE-E0 option A, the honesty rule: a pipeline pass is not change proof. A test in a marked check counts toward change proof only when the SAME named test FAILED on the base commit's latest
// main-branch run of the same check (read for free from what GitHub already holds) and passes on the head. Rovara never pays for an old-code run in the customer's environment. A test the change
// added cannot have run on the old code there, so it keeps the proof it got in the sandbox, labelled by what answered. A check-level pass with no test names proves nothing on its own.
// Pure and bounded: one pass over each list, a Map lookup per test.

/** One test's outcome in a pipeline's per-test report. */
export type PipelineTestOutcome = "passed" | "failed" | "skipped";

/** A run's per-test outcomes, keyed by the test's full name as the report gives it. */
export interface PipelineTestRun {
  /** The commit the run was on. */
  commit: string;
  tests: ReadonlyMap<string, PipelineTestOutcome>;
}

/** What one marked check's per-test results prove about the change. */
export interface PipelineProof {
  /** Passed on the head, failed by the same name on the base commit's latest main run of this check: change proof, "reported by your pipeline". */
  proven: string[];
  /** Passed on the head, added by the change: their proof stays the sandbox one. */
  addedByChange: string[];
  /** Passed on the head, but the base run passed it too, skipped it, did not have it, or could not be read: a Real check that passed, not proof. */
  passedNotProof: string[];
  /** Failed on the head. */
  failed: string[];
  /** Why no test of this check can be proof at all, when that is so (no base run, or the base run is for another commit). */
  noBase?: "no_base_run" | "base_commit_differs" | undefined;
}

/** The most tests one run's comparison looks at (the report adapters' own cap). */
export const PIPELINE_PROOF_TESTS_MAX = 50_000;

/**
 * Compares the head's per-test outcomes with the base commit's latest main-branch run of the same check. `base` is undefined when that run could not be found or read; it counts only when it is on
 * `baseCommit` (a shared environment's newer main run is not this base). More than `PIPELINE_PROOF_TESTS_MAX` tests in either run proves nothing (refused whole, never cut).
 */
export function pipelineProof(input: { head: PipelineTestRun; base: PipelineTestRun | undefined; baseCommit: string; addedTests: ReadonlySet<string> }): PipelineProof {
  const proof: PipelineProof = { proven: [], addedByChange: [], passedNotProof: [], failed: [] };
  const tooMany = input.head.tests.size > PIPELINE_PROOF_TESTS_MAX || (input.base?.tests.size ?? 0) > PIPELINE_PROOF_TESTS_MAX;
  const noBase = input.base === undefined || tooMany ? "no_base_run" as const : input.base.commit !== input.baseCommit ? "base_commit_differs" as const : undefined;
  if (noBase !== undefined) proof.noBase = noBase;
  if (input.head.tests.size > PIPELINE_PROOF_TESTS_MAX) return proof;
  for (const [test, outcome] of input.head.tests) {
    if (outcome === "failed") { proof.failed.push(test); continue; }
    if (outcome !== "passed") continue;
    if (input.addedTests.has(test)) proof.addedByChange.push(test);
    else if (noBase === undefined && input.base!.tests.get(test) === "failed") proof.proven.push(test);
    else proof.passedNotProof.push(test);
  }
  return proof;
}
