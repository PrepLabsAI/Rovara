// BROWSER-SKIP-HONESTY (DEC 540): the words every surface uses when a browser or application round was NOT run because the install has no browser runner (no executor image, so no
// qualified runtime and no worker that lists the browser checks). One table, so the task's block reason, its Testing view, the plan finding, the evidence pack and the pull request read the same fact.
// A skipped round is never "passed" and is never left out without a word.

/** The one sentence. It is true when no web or API runtime of the project is READY (the install never qualified one) or the worker handed the step lists no browser checks. */
export const BROWSER_RUNNER_NOT_RUN = "Browser checks not run: this install has no browser runner.";

export const BROWSER_RUNNER_WORDS = {
  /** The task and its checks. */
  notRun: BROWSER_RUNNER_NOT_RUN,
  /** A planned check or scenario that needed a browser and was not run; the reason in a "what wasn't tested" row. */
  notTestedReason: "browser checks not run, this install has no browser runner",
  /** The worker that was handed the step lists no browser checks (its executor image is not set, not pulled, or its host has no shared runtime directory). Said of that worker, never of the install. */
  workerNotRun: "Browser checks not run: the worker for this task has no browser runner ready.",
  /** The Testing view's reason (a fixed sentence, lower case, after "blocked by environment"). */
  testingReason: "browser checks did not run: there is no browser runner",
  /** TE-H1 before and after pictures, asked for by a project's recipe, on a machine that has no executor image. */
  evidenceNotRun: "Browser evidence not run: this install has no browser runner.",
  /** The plan finding: a target could not run browser or API scenarios now (future tense: nothing ran yet). */
  planWillNotRun: "Browser checks will not run: this install has no browser runner.",
} as const;

/** The worker features that only a worker with a usable executor image lists (it withholds them otherwise: `createApplicationChecksFeatureMonitor`). */
export const BROWSER_RUNNER_CHECK_FEATURES = ["task.workflowE2EApplicationChecks", "task.workflowE2EApplicationChecks.v2", "task.workflowE2EBaselineChecks"] as const;
/** A worker that lists this one is new enough to know the application checks; missing the checks beside it means it withholds them, not that it is old. */
const APPLICATION_PLAN_FEATURE = "task.workflowE2EApplicationPlan";

/**
 * The words for a step refused because the worker lacks features, when what it lacks is the browser runner and nothing else (a worker that lists the application plan feature knows the checks and withholds them).
 * Undefined for any other lack: the caller keeps its own words ("too old; upgrade it").
 */
export function browserRunnerMissingWords(missing: readonly string[], listed: readonly string[]): string | undefined {
  const family: readonly string[] = BROWSER_RUNNER_CHECK_FEATURES;
  const extras = ["task.workflowE2EAgentSteps.v1", "task.workflowE2EReplayChecks.v1", "task.workflowE2EMidStepSync.v1", "task.workflowPlanDryRun.v1", "task.workflowE2EModelFreeLimits.v1"];
  if (!missing.includes("task.workflowE2EApplicationChecks") || !listed.includes(APPLICATION_PLAN_FEATURE)) return undefined;
  return missing.every((feature) => family.includes(feature) || extras.includes(feature)) ? BROWSER_RUNNER_WORDS.workerNotRun : undefined;
}

/** The sentence a block reason carries about the browser runner (the install's or the worker's), or undefined when it carries none. */
export const browserRunnerSentenceOf = (reason: string | undefined): string | undefined =>
  reason?.includes(BROWSER_RUNNER_WORDS.notRun) === true ? BROWSER_RUNNER_WORDS.notRun : reason?.includes(BROWSER_RUNNER_WORDS.workerNotRun) === true ? BROWSER_RUNNER_WORDS.workerNotRun : undefined;

/** Whether a block reason says the browser checks were not run for want of a browser runner (either sentence). */
export const isBrowserRunnerBlock = (reason: string | undefined): boolean => browserRunnerSentenceOf(reason) !== undefined;
