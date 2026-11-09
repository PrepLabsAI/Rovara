// Setup and test health SH1: the four results, their fixed reasons and the Testing rows.
import { describe, expect, it } from "vitest";
import {
  TESTING_BLOCKED_REASONS, TESTING_CODE_REASONS, TESTING_COMMAND_MAX, TESTING_PARTIAL_REASONS, TESTING_REASONS, TESTING_REASON_TEXT, TESTING_RESULTS, TESTING_RESULT_LABELS, TESTING_ROWS_MAX,
  TestingRowSchema, TestingViewSchema, testingSummary,
} from "@agentx/contracts";

const row = (over: Record<string, unknown> = {}) => ({ label: "unit", command: "pytest -q", status: "passed", ...over });
const view = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, result: "verified", reasons: [], rows: [row()], ...over });

describe("testing result words", () => {
  it("has exactly the four results in their fixed words", () => {
    expect(TESTING_RESULTS).toEqual(["verified", "code_failed", "partially_verified", "blocked_by_environment"]);
    expect(Object.values(TESTING_RESULT_LABELS)).toEqual(["Verified", "Code failed", "Partially verified", "Blocked by environment"]);
  });

  it("gives every reason one sentence, and the three kinds of reason do not overlap", () => {
    expect(Object.keys(TESTING_REASON_TEXT).sort()).toEqual([...TESTING_REASONS].sort());
    expect(new Set(TESTING_REASONS).size).toBe(TESTING_REASONS.length);
    for (const text of Object.values(TESTING_REASON_TEXT)) expect(text).toMatch(/^[^\p{Cc}\p{Cf}]+$/u);
  });

  it("names the three codes the design adds as environment reasons", () => {
    for (const reason of ["setup_failed_in_task", "host_blocked", "build_host_offline"]) expect(TESTING_BLOCKED_REASONS).toContain(reason);
  });
});

describe("TestingRowSchema", () => {
  it("accepts a row per status with its own kind of reason", () => {
    expect(TestingRowSchema.safeParse(row({ passedTests: 37 })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "failed" })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "failed", reason: "regression_found" })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "blocked", reason: "host_blocked" })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "not_run", reason: "check_not_run" })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "pending", reason: "full_suite_pending" })).success).toBe(true);
  });

  it("refuses a reason of the wrong kind or a missing one", () => {
    expect(TestingRowSchema.safeParse(row({ reason: "check_failed" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "failed", reason: "host_blocked" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "blocked" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "blocked", reason: "check_not_run" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "not_run" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "not_run", reason: "host_blocked" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "failed", passedTests: 1 })).success).toBe(false);
  });

  it("is strict and bounded: unknown fields, long or hidden text, and free-text reasons are refused", () => {
    expect(TestingRowSchema.safeParse(row({ extra: 1 })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ command: "x".repeat(TESTING_COMMAND_MAX) })).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ command: "x".repeat(TESTING_COMMAND_MAX + 1) })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ command: "pytest\nrm -rf /" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ label: "a‮b" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ command: "" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "blocked", reason: "the pre-prod endpoint was down" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(row({ status: "fine" })).success).toBe(false);
  });
});

describe("TestingViewSchema", () => {
  it("accepts a consistent view of each result", () => {
    expect(TestingViewSchema.safeParse(view()).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["check_failed"], rows: [row({ status: "failed" })] })).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["check_failed", "host_blocked"], rows: [row({ status: "failed" }), row({ status: "blocked", reason: "host_blocked" })] })).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: ["host_blocked"], rows: [row(), row({ status: "blocked", reason: "host_blocked" })] })).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: ["full_suite_pending"], rows: [row(), row({ status: "pending", reason: "full_suite_pending" })] })).success).toBe(true);
  });

  it("does not let Verified list a reason, an empty table or a row that did not pass", () => {
    expect(TestingViewSchema.safeParse(view({ reasons: ["check_not_run"] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ rows: [] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ rows: [row(), row({ status: "not_run", reason: "check_not_run" })] })).success).toBe(false);
  });

  it("keeps a result from carrying reasons or rows of another kind", () => {
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["host_blocked"], rows: [row({ status: "failed" })] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["check_failed", "full_suite_pending"], rows: [] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: ["host_blocked"], rows: [row({ status: "failed" }), row({ status: "blocked", reason: "host_blocked" })] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: ["check_failed", "host_blocked"], rows: [] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: [], rows: [] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: [], rows: [row()] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: ["host_blocked"], rows: [row()] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: ["check_not_run"], rows: [row({ status: "blocked", reason: "host_blocked" })] })).success).toBe(false);
  });

  it("bounds rows and reasons, and refuses a repeated reason, an unknown result or an unknown field", () => {
    expect(TestingViewSchema.safeParse(view({ rows: Array.from({ length: TESTING_ROWS_MAX }, () => row()) })).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ rows: Array.from({ length: TESTING_ROWS_MAX + 1 }, () => row()) })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["check_failed", "check_failed"] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "mostly_fine" })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ extra: true })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ schemaVersion: 2 })).success).toBe(false);
  });

  it("holds every code, environment and partial reason in a view of its own result", () => {
    for (const reason of TESTING_CODE_REASONS) expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: [reason], rows: [] })).success).toBe(true);
    for (const reason of TESTING_BLOCKED_REASONS) expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: [reason], rows: [] })).success).toBe(true);
    for (const reason of TESTING_PARTIAL_REASONS) expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: [reason], rows: [] })).success).toBe(true);
  });
});

describe("known_failing rows (review fix 5)", () => {
  const known = (over: Record<string, unknown> = {}) => row({ status: "known_failing", reason: "known_failing_only", ...over });
  it("is a row status that names known_failing_only and nothing else", () => {
    expect(TestingRowSchema.safeParse(known()).success).toBe(true);
    expect(TestingRowSchema.safeParse(row({ status: "known_failing" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(known({ reason: "check_not_run" })).success).toBe(false);
    expect(TestingRowSchema.safeParse(known({ passedTests: 1 })).success).toBe(false);
  });

  it("is allowed only in a Partially verified view that says known_failing_only", () => {
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: ["known_failing_only"], rows: [row(), known()] })).success).toBe(true);
    expect(TestingViewSchema.safeParse(view({ result: "partially_verified", reasons: ["check_not_run"], rows: [row(), known()] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ rows: [row(), known()] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "code_failed", reasons: ["check_failed"], rows: [row({ status: "failed" }), known()] })).success).toBe(false);
    expect(TestingViewSchema.safeParse(view({ result: "blocked_by_environment", reasons: ["host_blocked"], rows: [row({ status: "blocked", reason: "host_blocked" }), known()] })).success).toBe(false);
  });
});

describe("testingSummary", () => {
  it("says each result in fixed words with counts from the rows", () => {
    const blocked = row({ status: "blocked", reason: "host_blocked" });
    expect(testingSummary({ result: "verified", rows: [] })).toBe("Result: every check ran on this code and passed.");
    expect(testingSummary({ result: "code_failed", rows: [] })).toBe("Result: at least one check fails on this change.");
    expect(testingSummary({ result: "code_failed", rows: [blocked as never] })).toBe("Result: at least one check fails on this change; 1 check also could not give a result.");
    expect(testingSummary({ result: "blocked_by_environment", rows: [blocked as never, blocked as never] })).toBe("Result: 2 checks could not give a result because of the test environment.");
    expect(testingSummary({ result: "blocked_by_environment", rows: [] })).toBe("Result: a check could not give a result because of the test environment.");
    expect(testingSummary({ result: "partially_verified", rows: [row({ status: "pending", reason: "full_suite_pending" }) as never] })).toBe("Result: everything that ran passed; 1 check did not run yet.");
    expect(testingSummary({ result: "partially_verified", rows: [] })).toBe("Result: everything that ran passed; some things were not tested.");
  });
});
