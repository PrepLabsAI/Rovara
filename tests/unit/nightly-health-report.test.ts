// Worker side: the nightly result's counts and its health block come from one tally, so the broker never reads them as disagreeing.
import { describe, expect, it } from "vitest";
import { NIGHTLY_STEP_WORDS, NightlyResultSchema } from "@rovara-code/contracts";
import { nightlyCountsAndHealth, type NightlyRunFacts } from "../../packages/worker/src/nightly-health-report.js";
import { nightlyHealthOf } from "../../packages/core/src/core/test-env/nightly.js";

const check = { runsTests: true, started: true, timedOut: false, reportApproved: true, reportWritten: true, testsCollected: 100 };
const allPassed = NIGHTLY_STEP_WORDS.map((step) => ({ step, status: "passed" as const }));
const facts = (over: Partial<NightlyRunFacts> = {}): NightlyRunFacts => ({ steps: allPassed, checks: [check], tally: { passed: 90, failures: 6, errors: 3, skipped: 1 }, ...over });
const HEAD = "a".repeat(40);
const resultOf = (built: ReturnType<typeof nightlyCountsAndHealth>) => NightlyResultSchema.parse({
  schemaVersion: 1, slotId: "b".repeat(64), envRevision: 1, branch: "main", headSha: HEAD, startedAt: "2026-11-05T06:00:00.000Z", finishedAt: "2026-11-05T06:40:00.000Z", durationMs: 2_400_000,
  tests: built.tests, failed: [], flaky: [], slowest: [], health: built.health,
});

describe("the nightly result's counts and health block", () => {
  it("come from one tally: failed is failures and errors together, and the total is every outcome", () => {
    const built = nightlyCountsAndHealth(facts());
    expect(built.tests).toEqual({ total: 100, passed: 90, failed: 9, skipped: 1 });
    expect(built.health.tests).toEqual({ total: 100, passed: 90, failures: 6, errors: 3, skipped: 1 });
  });

  it("is never read by the broker as disagreeing: the result parses and the class is the classifier's own", () => {
    expect(nightlyHealthOf(resultOf(nightlyCountsAndHealth(facts())))).toEqual({ class: "tests", setupProved: false, ranFrom: "fresh" });
    expect(nightlyHealthOf(resultOf(nightlyCountsAndHealth(facts({ tally: { passed: 100, failures: 0, errors: 0, skipped: 0 } }))))).toEqual({ class: "passed", ranFrom: "fresh" });
    expect(nightlyHealthOf(resultOf(nightlyCountsAndHealth(facts({ tally: { passed: 5, failures: 0, errors: 95, skipped: 0 } }))))).toEqual({ class: "environment", cause: "collection_errors", ranFrom: "fresh" });
    const setupFailed = allPassed.map((entry) => (entry.step === "setup" ? { ...entry, status: "failed" as const } : entry));
    expect(nightlyHealthOf(resultOf(nightlyCountsAndHealth(facts({ steps: setupFailed }))))).toEqual({ class: "environment", cause: "setup_failed", ranFrom: "fresh" });
  });

  it("says where the code came from only when the run says so", () => {
    expect(nightlyCountsAndHealth(facts()).health).not.toHaveProperty("ranFrom");
    expect(nightlyCountsAndHealth(facts({ ranFrom: "saved_image" })).health.ranFrom).toBe("saved_image");
    expect(nightlyHealthOf(resultOf(nightlyCountsAndHealth(facts({ ranFrom: "saved_image" }))))?.ranFrom).toBe("saved_image");
  });

  it("keeps one entry per step in the step words' order, and a failure is never hidden by a later pass", () => {
    const built = nightlyCountsAndHealth(facts({ steps: [{ step: "smoke", status: "passed" }, { step: "setup", status: "failed" }, { step: "setup", status: "passed" }, { step: "pull", status: "skipped" }] }));
    expect(built.health.steps).toEqual([{ step: "pull", status: "skipped" }, { step: "setup", status: "failed" }, { step: "smoke", status: "passed" }]);
  });

  it("refuses a tally or a check that is not a bounded count", () => {
    expect(() => nightlyCountsAndHealth(facts({ tally: { passed: -1, failures: 0, errors: 0, skipped: 0 } }))).toThrow();
    expect(() => nightlyCountsAndHealth(facts({ tally: { passed: 1.5, failures: 0, errors: 0, skipped: 0 } }))).toThrow();
    expect(() => nightlyCountsAndHealth(facts({ checks: Array.from({ length: 65 }, () => check) }))).toThrow();
  });
});
