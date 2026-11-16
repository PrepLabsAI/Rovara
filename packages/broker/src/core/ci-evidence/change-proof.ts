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
  noBase?: "no_base_run" | "base_commit_differs" | "head_commit_differs" | "report_too_large" | undefined;
}

/** The most tests one run's comparison looks at (the report adapters' own cap). */
export const PIPELINE_PROOF_TESTS_MAX = 50_000;

/**
 * `noBase` says why no test can be proof: no base run, a base run for another commit, a head report for another commit than `headCommit` (nothing listed), or a report over the cap (nothing listed when it is
 * the head's). Compares the head's per-test outcomes with the base commit's latest main-branch run of the same check. `base` is undefined when that run could not be found or read; it counts only when it is on
 * `baseCommit` (a shared environment's newer main run is not this base). More than `PIPELINE_PROOF_TESTS_MAX` tests in either run proves nothing (refused whole, never cut).
 */
export function pipelineProof(input: { head: PipelineTestRun; headCommit: string; base: PipelineTestRun | undefined; baseCommit: string; addedTests: ReadonlySet<string> }): PipelineProof {
  const proof: PipelineProof = { proven: [], addedByChange: [], passedNotProof: [], failed: [] };
  // A head report for another commit (an earlier push) says nothing about this head, and a report too large to read whole is not read: both are refused whole, with their own reason.
  if (input.head.commit !== input.headCommit) return { ...proof, noBase: "head_commit_differs" };
  if (input.head.tests.size > PIPELINE_PROOF_TESTS_MAX) return { ...proof, noBase: "report_too_large" };
  const noBase = input.base === undefined ? "no_base_run" as const
    : input.base.tests.size > PIPELINE_PROOF_TESTS_MAX ? "report_too_large" as const
      : input.base.commit !== input.baseCommit ? "base_commit_differs" as const : undefined;
  if (noBase !== undefined) proof.noBase = noBase;
  for (const [test, outcome] of input.head.tests) {
    if (outcome === "failed") { proof.failed.push(test); continue; }
    if (outcome !== "passed") continue;
    if (input.addedTests.has(test)) proof.addedByChange.push(test);
    else if (noBase === undefined && input.base!.tests.get(test) === "failed") proof.proven.push(test);
    else proof.passedNotProof.push(test);
  }
  return proof;
}
