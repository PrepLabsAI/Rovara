// The nightly run as a health check. PURE: one run's step results and counts go in, one of four fixed answers comes out:
//   passed        nothing failed;
//   environment   the setup, not the tests, is broken ("Setup needs repair", a Fix setup card);
//   tests         real assertion failures while other tests passed (the already-failing set, and a proposed fix task if the project wants one);
//   unclear       shown as tests with "Rovara isn't sure", and the card offers a light diagnosis.
//
// The rules, in order (code first; nothing here reads a log, a message or a test name):
//   1. A step before the tests failed (pull, update, setup, build, boot, mocks, pre-prod probe): environment.
//   2. A check never started, timed out as a whole, collected zero tests, or wrote no report where one is approved: environment.
//   3. Every failure is an error (collection or import) and none is an assertion failure, and more than 20% of the tests are affected: environment.
//   4. Some tests failed with assertion failures while others passed: tests.
//   5. Anything else, including input that cannot be read: unclear. Nothing unreadable is ever "passed".
// The input is built by the broker from the stored nightly result (the result carries the step words); it holds fixed words and counts only.
import { z } from "zod";

/** The steps of a nightly run, in the Prove step words plus the two that come first. The first seven are about the setup; `smoke` and `full_suite` are tests. */
export const NIGHTLY_HEALTH_SETUP_STEPS = ["pull", "update", "setup", "build", "boot", "mocks", "preprod_probe"] as const;
export const NIGHTLY_HEALTH_TEST_STEPS = ["smoke", "full_suite"] as const;
export const NIGHTLY_HEALTH_STEPS = [...NIGHTLY_HEALTH_SETUP_STEPS, ...NIGHTLY_HEALTH_TEST_STEPS] as const;

/** More than this share of the tests in error, with no assertion failure, reads as a broken environment. */
export const NIGHTLY_ENV_ERROR_SHARE = 0.2;

const Count = z.number().int().min(0).max(100_000_000);

export const NightlyHealthInputSchema = z
  .object({
    steps: z.array(z.object({ step: z.enum(NIGHTLY_HEALTH_STEPS), status: z.enum(["passed", "failed", "skipped"]) }).strict()).max(NIGHTLY_HEALTH_STEPS.length),
    /** One entry per check the run was to make. */
    checks: z
      .array(
        z
          .object({
            /** A check whose job is to run tests (kind `test`): the other kinds are never faulted for collecting none. */
            runsTests: z.boolean(),
            started: z.boolean(),
            /** The whole check hit its time limit. */
            timedOut: z.boolean(),
            /** The environment approves a report file for this check, and whether one was written. */
            reportApproved: z.boolean(),
            reportWritten: z.boolean(),
            testsCollected: Count,
          })
          .strict(),
      )
      .max(64),
    tests: z.object({ total: Count, passed: Count, failures: Count, errors: Count, skipped: Count }).strict(),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.steps.map((entry) => entry.step)).size !== input.steps.length) context.addIssue({ code: "custom", path: ["steps"], message: "a step appears once" });
    const { total, passed, failures, errors, skipped } = input.tests;
    if (total !== passed + failures + errors + skipped) context.addIssue({ code: "custom", path: ["tests", "total"], message: "total is passed, failures, errors and skipped together" });
  });
export type NightlyHealthInput = z.infer<typeof NightlyHealthInputSchema>;

export const NIGHTLY_ENVIRONMENT_CAUSES = [
  "pull_failed", "update_failed", "setup_failed", "build_failed", "boot_failed", "mocks_failed", "preprod_unreachable",
  "check_never_started", "check_timed_out", "no_tests_collected", "no_report_written", "collection_errors",
] as const;
export type NightlyEnvironmentCause = (typeof NIGHTLY_ENVIRONMENT_CAUSES)[number];
export const NIGHTLY_UNCLEAR_CAUSES = ["unreadable", "steps_disagree", "incomplete_run", "all_tests_failed", "few_errors", "other"] as const;
export type NightlyUnclearCause = (typeof NIGHTLY_UNCLEAR_CAUSES)[number];

export type NightlyHealth =
  | { class: "passed" }
  | { class: "environment"; cause: NightlyEnvironmentCause }
  /** `setupProved`: the run has the same evidence a passing night needs that the SETUP works (a check ran, the code was put in place, both test steps ran and were not skipped). Without it a night with failing tests says nothing about a repair state. */
  | { class: "tests"; setupProved: boolean }
  | { class: "unclear"; cause: NightlyUnclearCause };

const STEP_CAUSE: Readonly<Record<(typeof NIGHTLY_HEALTH_SETUP_STEPS)[number], NightlyEnvironmentCause>> = {
  pull: "pull_failed", update: "update_failed", setup: "setup_failed", build: "build_failed", boot: "boot_failed", mocks: "mocks_failed", preprod_probe: "preprod_unreachable",
};

/**
 * What one nightly run says about the project's health. `input` is parsed here, and anything that is not exactly the bounded shape is "unclear", never "passed".
 */
export function classifyNightlyHealth(input: unknown, context: { /** The broker's own approved environment for this night defines NO smoke check: a skipped `smoke` step is then all of its (no) checks passing. The worker's word is never used for this. */ noSmokeCheck?: boolean } = {}): NightlyHealth {
  const parsed = NightlyHealthInputSchema.safeParse(input);
  if (!parsed.success) return { class: "unclear", cause: "unreadable" };
  const { checks, tests } = parsed.data;
  // The worker reports `smoke` skipped when the environment has no smoke check (it says only what ran). That is fine for the verdict only if the BROKER's approved environment, at the night's revision, really defines none.
  const steps = context.noSmokeCheck === true
    ? [...parsed.data.steps.filter((entry) => entry.step !== "smoke"), { step: "smoke" as const, status: (parsed.data.steps.find((entry) => entry.step === "smoke")?.status ?? "skipped") === "failed" ? "failed" as const : "passed" as const }]
    : parsed.data.steps;

  // 1. a step before the tests failed (the earliest in the run's own order of steps)
  for (const step of NIGHTLY_HEALTH_SETUP_STEPS) {
    if (steps.some((entry) => entry.step === step && entry.status === "failed")) return { class: "environment", cause: STEP_CAUSE[step] };
  }

  // 2. a check that never gave tests a chance to run
  if (checks.some((check) => !check.started)) return { class: "environment", cause: "check_never_started" };
  if (checks.some((check) => check.timedOut)) return { class: "environment", cause: "check_timed_out" };
  if (checks.some((check) => check.runsTests && check.testsCollected === 0)) return { class: "environment", cause: "no_tests_collected" };
  if (checks.some((check) => check.reportApproved && !check.reportWritten)) return { class: "environment", cause: "no_report_written" };

  // 3. every failure is a collection or import error and it touches more than a fifth of the tests
  if (tests.errors > 0 && tests.failures === 0 && tests.errors > tests.total * NIGHTLY_ENV_ERROR_SHARE) return { class: "environment", cause: "collection_errors" };

  // The evidence that the setup works, shared by "passed" and by "tests": a check was made, the code was put in place by at least one of pull, update, setup, build, and both test steps ran.
  const codeInPlace = (["pull", "update", "setup", "build"] as const).some((step) => steps.some((entry) => entry.step === step && entry.status === "passed"));
  const testStepsRan = NIGHTLY_HEALTH_TEST_STEPS.every((step) => steps.some((entry) => entry.step === step && entry.status !== "skipped"));
  // A test step that failed while the counts show no failure cannot be read either way.
  const testStepFailed = steps.some((entry) => entry.status === "failed" && (NIGHTLY_HEALTH_TEST_STEPS as readonly string[]).includes(entry.step));
  if (tests.failures + tests.errors === 0) {
    if (testStepFailed) return { class: "unclear", cause: "steps_disagree" };
    // A run in which no test actually ran (nothing collected, or everything skipped) proves nothing: the environment is not healthy.
    if (tests.total - tests.skipped === 0) return { class: "environment", cause: "no_tests_collected" };
    // "Passed" needs the whole run on record: at least one check, a passing test, no setup step failed (checked above), and both test steps present and passed.
    const testStepsPassed = NIGHTLY_HEALTH_TEST_STEPS.every((step) => steps.some((entry) => entry.step === step && entry.status === "passed"));
    // Skipped setup steps are fine one by one, but at least one of the steps that put the code in place (pull, update, setup, build) must have passed (`codeInPlace`, above).
    return checks.length > 0 && tests.passed > 0 && testStepsPassed && codeInPlace ? { class: "passed" } : { class: "unclear", cause: "incomplete_run" };
  }

  // 4. real assertion failures next to tests that passed
  if (tests.failures > 0 && tests.passed > 0) return { class: "tests", setupProved: checks.length > 0 && codeInPlace && testStepsRan && tests.errors === 0 };

  // 5. anything else
  if (tests.failures > 0) return { class: "unclear", cause: "all_tests_failed" };
  if (tests.errors > 0) return { class: "unclear", cause: "few_errors" };
  return { class: "unclear", cause: "other" };
}

/** What the project page shows for a class (design 6.2): environment is the only one that sets "Setup needs repair". */
export function nightlyHealthShownAs(health: NightlyHealth): "healthy" | "needs_repair" | "tests_failing" | "not_sure" {
  switch (health.class) {
    case "passed": return "healthy";
    case "environment": return "needs_repair";
    case "tests": return "tests_failing";
    case "unclear": return "not_sure";
  }
}
