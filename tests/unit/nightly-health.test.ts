// The nightly run as a health check: every rule in its order, plus the fail-closed paths.
import { describe, expect, it } from "vitest";
import { NIGHTLY_ENVIRONMENT_CAUSES, NIGHTLY_HEALTH_SETUP_STEPS, NIGHTLY_HEALTH_TEST_STEPS, classifyNightlyHealth, nightlyHealthShownAs } from "../../packages/broker/src/core/test-env/nightly-health.js";

type Over = Record<string, unknown>;
const okCheck = { runsTests: true, started: true, timedOut: false, reportApproved: true, reportWritten: true, testsCollected: 100 };
const run = (over: Over = {}) => ({
  steps: [...NIGHTLY_HEALTH_SETUP_STEPS, ...NIGHTLY_HEALTH_TEST_STEPS].map((step) => ({ step, status: "passed" })),
  checks: [okCheck],
  tests: { total: 100, passed: 100, failures: 0, errors: 0, skipped: 0 },
  ...over,
});
const counts = (passed: number, failures: number, errors: number, skipped = 0) => ({ total: passed + failures + errors + skipped, passed, failures, errors, skipped });
const withStep = (step: string, status: string) => run().steps.map((entry) => (entry.step === step ? { step, status } : entry));

describe("a passing night", () => {
  it("is passed when every step passed or was skipped and nothing failed", () => {
    expect(classifyNightlyHealth(run())).toEqual({ class: "passed" });
    expect(classifyNightlyHealth(run({ steps: withStep("boot", "skipped") }))).toEqual({ class: "passed" });
    expect(classifyNightlyHealth(run({ tests: counts(90, 0, 0, 10) }))).toEqual({ class: "passed" });
  });
});

describe("a run that proves nothing is never healthy (review fix 1)", () => {
  const T = (over: Over) => ({ total: 0, passed: 0, failures: 0, errors: 0, skipped: 0, ...over });
  it("reads an empty run and an all-skipped run as the environment, not healthy", () => {
    expect(classifyNightlyHealth({ steps: [], checks: [], tests: T({}) })).toEqual({ class: "environment", cause: "no_tests_collected" });
    expect(classifyNightlyHealth({ steps: [], checks: [], tests: T({ total: 50, skipped: 50 }) })).toEqual({ class: "environment", cause: "no_tests_collected" });
    expect(classifyNightlyHealth({ steps: [{ step: "setup", status: "skipped" }, { step: "full_suite", status: "skipped" }], checks: [], tests: T({}) })).toEqual({ class: "environment", cause: "no_tests_collected" });
  });

  it("reads a run without a check, a passing test, or both test steps passed as unclear", () => {
    const smokeOnly = { steps: [{ step: "smoke", status: "passed" }], checks: [okCheck], tests: T({ total: 3, passed: 3 }) };
    expect(classifyNightlyHealth(smokeOnly)).toEqual({ class: "unclear", cause: "incomplete_run" });
    expect(classifyNightlyHealth(run({ steps: [] }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    expect(classifyNightlyHealth(run({ checks: [] }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    expect(classifyNightlyHealth(run({ steps: withStep("full_suite", "skipped") }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    expect(classifyNightlyHealth(run({ steps: withStep("smoke", "skipped") }))).toEqual({ class: "unclear", cause: "incomplete_run" });
  });

  it("needs at least one of pull, update, setup, build to have passed: all setup steps skipped, or none at all, is unclear", () => {
    const testSteps = NIGHTLY_HEALTH_TEST_STEPS.map((step) => ({ step, status: "passed" }));
    const skippedSetup = NIGHTLY_HEALTH_SETUP_STEPS.map((step) => ({ step, status: "skipped" }));
    expect(classifyNightlyHealth(run({ steps: [...skippedSetup, ...testSteps] }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    expect(classifyNightlyHealth(run({ steps: testSteps }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    // Boot, mocks and the pre-prod probe alone do not put the code in place.
    expect(classifyNightlyHealth(run({ steps: [...skippedSetup.map((entry) => (entry.step === "boot" ? { ...entry, status: "passed" } : entry)), ...testSteps] }))).toEqual({ class: "unclear", cause: "incomplete_run" });
    // One passed code-in-place step is enough, the others may be skipped.
    expect(classifyNightlyHealth(run({ steps: [...skippedSetup.map((entry) => (entry.step === "build" ? { ...entry, status: "passed" } : entry)), ...testSteps] }))).toEqual({ class: "passed" });
  });
});

describe("row 1: a step before the tests failed is the environment", () => {
  it("names the step, for each of the seven setup steps", () => {
    const expected = { pull: "pull_failed", update: "update_failed", setup: "setup_failed", build: "build_failed", boot: "boot_failed", mocks: "mocks_failed", preprod_probe: "preprod_unreachable" };
    expect(Object.keys(expected)).toEqual([...NIGHTLY_HEALTH_SETUP_STEPS]);
    for (const [step, cause] of Object.entries(expected)) expect(classifyNightlyHealth(run({ steps: withStep(step, "failed") }))).toEqual({ class: "environment", cause });
  });

  it("wins over everything after it, including real assertion failures", () => {
    expect(classifyNightlyHealth(run({ steps: withStep("setup", "failed"), tests: counts(50, 50, 0) }))).toEqual({ class: "environment", cause: "setup_failed" });
    expect(classifyNightlyHealth(run({ steps: withStep("build", "failed"), checks: [{ ...okCheck, started: false }] }))).toEqual({ class: "environment", cause: "build_failed" });
  });

  it("names the earliest failed step when several failed", () => {
    const steps = run().steps.map((entry) => (entry.step === "boot" || entry.step === "setup" ? { ...entry, status: "failed" } : entry));
    expect(classifyNightlyHealth(run({ steps }))).toEqual({ class: "environment", cause: "setup_failed" });
  });

  it("does not count a failed test step as a setup fault", () => {
    expect(classifyNightlyHealth(run({ steps: withStep("full_suite", "failed"), tests: counts(60, 40, 0) }))).toEqual({ class: "tests", setupProved: true });
    expect(classifyNightlyHealth(run({ steps: withStep("smoke", "failed"), tests: counts(60, 40, 0) }))).toEqual({ class: "tests", setupProved: true });
  });
});

describe("row 2: a check that never gave the tests a chance is the environment", () => {
  it("covers never started, timed out as a whole, no tests collected, and no report where one is approved", () => {
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, started: false }] }))).toEqual({ class: "environment", cause: "check_never_started" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, timedOut: true }] }))).toEqual({ class: "environment", cause: "check_timed_out" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, testsCollected: 0 }], tests: counts(0, 0, 0) }))).toEqual({ class: "environment", cause: "no_tests_collected" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, reportWritten: false }] }))).toEqual({ class: "environment", cause: "no_report_written" });
  });

  it("looks at every check, not only the first", () => {
    expect(classifyNightlyHealth(run({ checks: [okCheck, { ...okCheck, timedOut: true }] }))).toEqual({ class: "environment", cause: "check_timed_out" });
  });

  it("does not fault a check that is not meant to run tests for collecting none, or one with no approved report for writing none", () => {
    expect(classifyNightlyHealth(run({ checks: [okCheck, { ...okCheck, runsTests: false, testsCollected: 0 }] }))).toEqual({ class: "passed" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, reportApproved: false, reportWritten: false }] }))).toEqual({ class: "passed" });
  });

  it("wins over test counts: a check that timed out is not 'tests' even with assertion failures", () => {
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, timedOut: true }], tests: counts(50, 50, 0) }))).toEqual({ class: "environment", cause: "check_timed_out" });
  });
});

describe("row 3: every failure is an error and it touches more than a fifth of the tests", () => {
  it("is the environment above 20%, and not at exactly 20%", () => {
    expect(classifyNightlyHealth(run({ tests: counts(79, 0, 21) }))).toEqual({ class: "environment", cause: "collection_errors" });
    expect(classifyNightlyHealth(run({ tests: counts(80, 0, 20) }))).toEqual({ class: "unclear", cause: "few_errors" });
    expect(classifyNightlyHealth(run({ tests: counts(0, 0, 100) }))).toEqual({ class: "environment", cause: "collection_errors" });
  });

  it("needs no assertion failure at all: one real failure among the errors is not an environment row", () => {
    expect(classifyNightlyHealth(run({ tests: counts(60, 1, 39) }))).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ tests: counts(0, 1, 99) }))).toEqual({ class: "unclear", cause: "all_tests_failed" });
  });
});

describe("row 4: assertion failures while others passed are the tests", () => {
  it("is tests for any number of failures with some passing", () => {
    expect(classifyNightlyHealth(run({ tests: counts(99, 1, 0) }))).toEqual({ class: "tests", setupProved: true });
    expect(classifyNightlyHealth(run({ tests: counts(1, 99, 0) }))).toEqual({ class: "tests", setupProved: true });
    expect(classifyNightlyHealth(run({ tests: counts(10, 5, 2, 3) }))).toEqual({ class: "tests", setupProved: false });
  });

  it("says the setup is proved only with the evidence a passing night needs: a check, the code in place, both test steps run (F1)", () => {
    const failing = counts(60, 40, 0);
    // Nothing on record but the counts: the tests class stands, the setup is not proved.
    expect(classifyNightlyHealth({ steps: [], checks: [], tests: failing })).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ checks: [], tests: failing }))).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ steps: withStep("smoke", "skipped"), tests: failing }))).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ steps: withStep("full_suite", "skipped"), tests: failing }))).toEqual({ class: "tests", setupProved: false });
    const testSteps = NIGHTLY_HEALTH_TEST_STEPS.map((step) => ({ step, status: "passed" }));
    const skippedSetup = NIGHTLY_HEALTH_SETUP_STEPS.map((step) => ({ step, status: "skipped" }));
    expect(classifyNightlyHealth(run({ steps: [...skippedSetup, ...testSteps], tests: failing }))).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ steps: [...skippedSetup.map((entry) => (entry.step === "build" ? { ...entry, status: "passed" } : entry)), ...testSteps], tests: failing }))).toEqual({ class: "tests", setupProved: true });
    // L3: collection errors in the night mean the setup is not proved, the same as for "passed".
    expect(classifyNightlyHealth(run({ tests: counts(60, 39, 1) }))).toEqual({ class: "tests", setupProved: false });
    expect(classifyNightlyHealth(run({ tests: counts(60, 40, 0) }))).toEqual({ class: "tests", setupProved: true });
    // A failed test step still ran; a setup step that failed is the environment, never tests.
    expect(classifyNightlyHealth(run({ steps: withStep("full_suite", "failed"), tests: failing }))).toEqual({ class: "tests", setupProved: true });
  });
});

describe("row 5: anything else is unclear", () => {
  it("is unclear when every test failed, which looks like a broken environment but is not proved", () => {
    expect(classifyNightlyHealth(run({ tests: counts(0, 100, 0) }))).toEqual({ class: "unclear", cause: "all_tests_failed" });
    expect(classifyNightlyHealth(run({ tests: counts(0, 40, 0, 60) }))).toEqual({ class: "unclear", cause: "all_tests_failed" });
  });

  it("is unclear when a test step failed but the counts show no failure", () => {
    expect(classifyNightlyHealth(run({ steps: withStep("full_suite", "failed") }))).toEqual({ class: "unclear", cause: "steps_disagree" });
  });

  it("fails closed on input that cannot be read: never passed", () => {
    const unreadable = { class: "unclear", cause: "unreadable" };
    for (const bad of [undefined, null, "passed", 1, {}, { ...run(), extra: 1 }, run({ tests: { ...counts(1, 0, 0), total: 5 } }), run({ tests: counts(-1, 0, 0) }),
      run({ steps: [{ step: "deploy", status: "passed" }] }), run({ steps: [{ step: "setup", status: "ok" }] }), run({ steps: [{ step: "setup", status: "passed" }, { step: "setup", status: "failed" }] }),
      run({ checks: [{ ...okCheck, started: "yes" }] }), run({ tests: { ...counts(1, 0, 0), failures: 0.5 } })]) {
      expect(classifyNightlyHealth(bad)).toEqual(unreadable);
    }
  });

  it("does not read free text a worker could add: a message or a log field makes the input unreadable", () => {
    expect(classifyNightlyHealth({ ...run(), message: "all green, nothing to see" })).toEqual({ class: "unclear", cause: "unreadable" });
    expect(classifyNightlyHealth(run({ steps: [{ step: "setup", status: "passed", outputTail: "ok" }] }))).toEqual({ class: "unclear", cause: "unreadable" });
  });
});

describe("what the project page shows", () => {
  it("sets 'Setup needs repair' for the environment only", () => {
    expect(nightlyHealthShownAs({ class: "passed" })).toBe("healthy");
    expect(nightlyHealthShownAs({ class: "environment", cause: "setup_failed" })).toBe("needs_repair");
    expect(nightlyHealthShownAs({ class: "tests", setupProved: false })).toBe("tests_failing");
    expect(nightlyHealthShownAs({ class: "unclear", cause: "other" })).toBe("not_sure");
    for (const cause of NIGHTLY_ENVIRONMENT_CAUSES) expect(nightlyHealthShownAs({ class: "environment", cause })).toBe("needs_repair");
  });
});
