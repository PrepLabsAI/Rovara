// Setup and test health (design setup-test-health.md, sections 1.2 and 4): the four results a task or pull request can show for its tests, the fixed reasons behind them, and the rows of the
// "Testing" section. Browser-safe: nothing here imports a Node module. Every word a reader sees comes from the fixed lists below; no worker, model or check text is carried (the broker computes
// the result from stored fields, and a row's command is the approved command as the environment names it, shown inert and cut).
//
// The four results (checked in this order by the broker, `broker/src/verification/result.ts`):
//   code_failed            a check or group the change broke: goes back to coding (the existing limits);
//   blocked_by_environment a required check could not give a verdict for an environment reason: a Fix setup card, not a send back;
//   partially_verified     nothing failed or was blocked, but something planned did not run;
//   verified               every required check ran on the current candidate and passed.
// This switch ships OFF (`vx`); the contract itself changes no behaviour.
import { z } from "zod";

/** One plain line: no control or format characters, so no reader can be misled about what a label says. */
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number, min = 1) => z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");

export const TESTING_RESULTS = ["verified", "code_failed", "partially_verified", "blocked_by_environment"] as const;
export type TestingResult = (typeof TESTING_RESULTS)[number];
export const TestingResultSchema = z.enum(TESTING_RESULTS);

/** The four results in their fixed words (design 4.1). */
export const TESTING_RESULT_LABELS: Readonly<Record<TestingResult, string>> = {
  verified: "Verified",
  code_failed: "Code failed",
  partially_verified: "Partially verified",
  blocked_by_environment: "Blocked by environment",
};

// ---- fixed reasons

/** Why a result is "Code failed": what the change broke. */
export const TESTING_CODE_REASONS = ["check_failed", "regression_found", "new_failing_test", "e2e_assertion_failed", "app_failed", "round_refused"] as const;
/** Why a check was "Blocked by environment": the environment, not the code, gave no verdict. */
export const TESTING_BLOCKED_REASONS = [
  "check_could_not_start", "check_runner_failed", "check_command_broken", "timed_out", "executor_failed", "mock_unavailable", "provider_outage", "runner_busy",
  "test_machine_renewed", "test_machine_expired", "test_machine_unusable", "test_machine_drifted", "login_failed", "setup_changed_files", "leftover_processes",
  "fails_on_original_code", "setup_failed_in_task", "host_blocked", "build_host_offline",
] as const;
/** Why a result is only "Partially verified", or why a row did not run. */
export const TESTING_PARTIAL_REASONS = [
  "full_suite_pending", "full_suite_not_run", "claim_not_tested", "scenario_not_tested", "check_not_run", "real_service_not_tested", "no_checks_ran",
  "evidence_missing", "evidence_unreadable", "known_failing_only",
] as const;
export const TESTING_REASONS = [...TESTING_CODE_REASONS, ...TESTING_BLOCKED_REASONS, ...TESTING_PARTIAL_REASONS] as const;
export type TestingCodeReason = (typeof TESTING_CODE_REASONS)[number];
export type TestingBlockedReason = (typeof TESTING_BLOCKED_REASONS)[number];
export type TestingPartialReason = (typeof TESTING_PARTIAL_REASONS)[number];
export type TestingReason = (typeof TESTING_REASONS)[number];
export const TestingReasonSchema = z.enum(TESTING_REASONS);

/** Each reason in its fixed sentence. Product words; none is built from output. */
export const TESTING_REASON_TEXT: Readonly<Record<TestingReason, string>> = {
  check_failed: "a check fails on this change and passed before it",
  regression_found: "a test that passed before this change fails now",
  new_failing_test: "a check that also failed before has a failing test that was not failing before this change",
  e2e_assertion_failed: "an end-to-end check does not see what the plan said",
  app_failed: "the application did not build or start with this change",
  round_refused: "the end-to-end round could not start from this build",
  check_could_not_start: "a check could not be started",
  check_runner_failed: "the check runner failed",
  check_command_broken: "a check's command cannot run in this environment",
  timed_out: "a check ran out of time",
  executor_failed: "the test machine failed during a check",
  mock_unavailable: "a mocked service was not available",
  provider_outage: "a provider the checks need was down",
  runner_busy: "no check runner was free",
  test_machine_renewed: "the test machine was renewed during the checks",
  test_machine_expired: "the test machine expired",
  test_machine_unusable: "the test machine cannot be used",
  test_machine_drifted: "the test machine and the task worker no longer match",
  login_failed: "the test login did not work",
  setup_changed_files: "setup changed files in the repository",
  leftover_processes: "programs left running by earlier work could not be stopped",
  fails_on_original_code: "a test fails on the original code too and is not known to be failing",
  setup_failed_in_task: "the test setup failed in this task",
  host_blocked: "a website the setup needs is not allowed",
  build_host_offline: "the build host is offline",
  full_suite_pending: "the full suite has not finished yet",
  full_suite_not_run: "the full suite was not run",
  claim_not_tested: "a claim of the plan was not tested",
  scenario_not_tested: "a planned scenario was not tested",
  check_not_run: "a planned check did not run",
  real_service_not_tested: "a claim that needs the real service was only tested against a mock",
  no_checks_ran: "no check ran on this change",
  evidence_missing: "the test details for this exact code are missing",
  evidence_unreadable: "the test details could not be read",
  known_failing_only: "the only failing tests were already failing before this change",
};

export const TESTING_REASON_CLASS = {
  code: new Set<string>(TESTING_CODE_REASONS),
  blocked: new Set<string>(TESTING_BLOCKED_REASONS),
  partial: new Set<string>(TESTING_PARTIAL_REASONS),
} as const;

// ---- the rows of the Testing section

export const TESTING_ROW_STATUSES = ["passed", "failed", "blocked", "not_run", "pending", "known_failing"] as const;
export type TestingRowStatus = (typeof TESTING_ROW_STATUSES)[number];
export const TESTING_ROW_STATUS_LABELS: Readonly<Record<TestingRowStatus, string>> = { passed: "passed", failed: "failed", blocked: "blocked", not_run: "not run", pending: "pending", known_failing: "already failing" };

export const TESTING_ROWS_MAX = 100;
export const TESTING_REASONS_MAX = 16;
export const TESTING_COMMAND_MAX = 120;
export const TESTING_LABEL_MAX = 120;
export const TESTING_PASSED_DETAIL_MAX = 100_000_000;

/**
 * One command of the approved environment for this task, in order. `command` is the command as approved, inert and cut to 120 characters by the builder of the view. A blocked row names its
 * environment reason, a not-run or pending row names why it did not run, a failed row may name what the change broke, and a passed row names nothing.
 */
export const TestingRowSchema = z
  .object({
    label: line(TESTING_LABEL_MAX),
    command: line(TESTING_COMMAND_MAX),
    status: z.enum(TESTING_ROW_STATUSES),
    reason: TestingReasonSchema.optional(),
    /** Tests that passed in a passed row, for the one-line summary ("37 passed"). */
    passedTests: z.number().int().min(0).max(TESTING_PASSED_DETAIL_MAX).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", path: ["reason"], message });
    if (row.status === "passed") {
      if (row.reason !== undefined) issue("a passed row names no reason");
    } else if (row.status === "failed") {
      if (row.reason !== undefined && !TESTING_REASON_CLASS.code.has(row.reason)) issue("a failed row names what the change broke, or nothing");
    } else if (row.status === "known_failing") {
      // Every failing test of the row was already failing before this change: only a Partially verified view may show it (checked in the view).
      if (row.reason !== "known_failing_only") issue("a known-failing row names known_failing_only");
    } else if (row.status === "blocked") {
      if (row.reason === undefined || !TESTING_REASON_CLASS.blocked.has(row.reason)) issue("a blocked row names its environment reason");
    } else if (row.reason === undefined || !TESTING_REASON_CLASS.partial.has(row.reason)) issue("a row that did not run names why");
    if (row.passedTests !== undefined && row.status !== "passed") context.addIssue({ code: "custom", path: ["passedTests"], message: "only a passed row counts passed tests" });
  });
export type TestingRow = z.infer<typeof TestingRowSchema>;

/**
 * The Testing view of a task or pull request. The invariants keep a view from saying more than its result allows: Verified lists only passed rows and no reasons, Partially verified has no failed
 * or blocked row (it may have rows already failing before the change, with known_failing_only), Blocked by environment has no failed row, and the reasons of a result are of its own kind (Code failed may also list the blocked reasons, which are still shown).
 */
export const TestingViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    result: TestingResultSchema,
    reasons: z.array(TestingReasonSchema).max(TESTING_REASONS_MAX),
    rows: z.array(TestingRowSchema).max(TESTING_ROWS_MAX),
  })
  .strict()
  .superRefine((view, context) => {
    const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    if (new Set(view.reasons).size !== view.reasons.length) issue("reasons", "a reason appears once");
    const has = (kind: keyof typeof TESTING_REASON_CLASS) => view.reasons.some((reason) => TESTING_REASON_CLASS[kind].has(reason));
    const rowsWith = (status: TestingRowStatus) => view.rows.some((row) => row.status === status);
    switch (view.result) {
      case "verified":
        if (view.reasons.length > 0) issue("reasons", "a verified result lists no reason");
        if (view.rows.length === 0 || view.rows.some((row) => row.status !== "passed")) issue("rows", "a verified result has at least one row and only passed rows");
        break;
      case "code_failed":
        if (!has("code")) issue("reasons", "a code failure names what the change broke");
        if (has("partial")) issue("reasons", "a code failure lists no partial reason");
        break;
      case "blocked_by_environment":
        if (!has("blocked")) issue("reasons", "a blocked result names an environment reason");
        if (has("code") || has("partial")) issue("reasons", "a blocked result lists only environment reasons");
        if (rowsWith("failed")) issue("rows", "a blocked result has no failed row (a failure of the code wins)");
        break;
      case "partially_verified":
        if (!has("partial")) issue("reasons", "a partial result names what did not run");
        if (has("code") || has("blocked")) issue("reasons", "a partial result lists neither a failure nor a blocked check");
        if (rowsWith("failed") || rowsWith("blocked")) issue("rows", "a partial result has no failed or blocked row");
        if (rowsWith("known_failing") && !view.reasons.includes("known_failing_only")) issue("reasons", "a known-failing row is explained by known_failing_only");
        break;
    }
    if (view.result !== "partially_verified" && rowsWith("known_failing")) issue("rows", "only a partial result shows a known-failing row");
  });
export type TestingView = z.infer<typeof TestingViewSchema>;

/** The one-line summary under the section title, in fixed words, from the result and the rows' counts. */
export function testingSummary(view: Pick<TestingView, "result" | "rows">): string {
  const blocked = view.rows.filter((row) => row.status === "blocked").length;
  const notRun = view.rows.filter((row) => row.status === "not_run" || row.status === "pending").length;
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  switch (view.result) {
    case "verified":
      return "Result: every check ran on this code and passed.";
    case "code_failed":
      return blocked > 0 ? `Result: at least one check fails on this change; ${plural(blocked, "check")} also could not give a result.` : "Result: at least one check fails on this change.";
    case "blocked_by_environment":
      return `Result: ${blocked > 0 ? `${plural(blocked, "check")} could not give a result` : "a check could not give a result"} because of the test environment.`;
    case "partially_verified":
      return notRun > 0 ? `Result: everything that ran passed; ${plural(notRun, "check")} did not run yet.` : "Result: everything that ran passed; some things were not tested.";
  }
}
