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

});

describe("row 2: a check that never gave the tests a chance is the environment", () => {
  it("covers never started, timed out as a whole, no tests collected, and no report where one is approved", () => {
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, started: false }] }))).toEqual({ class: "environment", cause: "check_never_started" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, timedOut: true }] }))).toEqual({ class: "environment", cause: "check_timed_out" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, testsCollected: 0 }], tests: counts(0, 0, 0) }))).toEqual({ class: "environment", cause: "no_tests_collected" });
    expect(classifyNightlyHealth(run({ checks: [{ ...okCheck, reportWritten: false }] }))).toEqual({ class: "environment", cause: "no_report_written" });
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

describe("row 5: anything else is unclear", () => {

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
