// Setup and test health SH18 (design setup-test-health.md, sections 1.2 and 4.4): the Testing view of a task, and the `## Testing - <result>` section of a Rovara Code (version 2) pull request or change request.
// Replaces: the `## Tests` lists of passed, failed and not-checked checks, when `vx` is on (the lines about the tested commit, the tests added and the test proof stay under the new heading).
//
// PURE. `testingViewOf` takes stored fields only (the workflow, the facts and budget the auto-fix policy already reads, the broker's evidence pack, the already-failing set and the plan's planned facts) and returns
// either a valid `TestingView` or the reason there is none yet. The result itself is `classifyTestingResult` (SH5); this module adds the rows: one per command of the task's selected checks, in order, then the
// follow-up full run when one is planned. A row's words are fixed (status, reason); the label and the command are the approved check's own, redacted, on one line and cut. Nothing the worker, a model or a
// check printed is read. A view that breaks the contract's invariants is never shown (fail closed: the description and the task page are what they were).
//
// The section's shrink order (`testingSectionLines(view, level)`, level 0..4): 0 every row in full; 1 commands cut to 60 characters; 2 and above the passed rows fold into one count line; 3 and above the other
// commands are cut to 40. NEVER dropped at any level: the result line, and every blocked, failed, not-run, pending and already-failing row with its fixed reason.
import {
  E2E_PROJECT_CHECK_ID, TESTING_REASON_CLASS, TESTING_REASON_TEXT, TESTING_RESULT_LABELS, TESTING_ROW_STATUS_LABELS, TESTING_ROWS_MAX, TESTING_COMMAND_MAX, TESTING_LABEL_MAX, TestingViewSchema, redactText, testingSummary,
  workflowCheckResultBroken, workflowSelectedChecks,
  type AutoFixBudget, type AutoFixFacts, type EvidencePack, type TestingBlockedReason, type TestingReason, type TestingRow, type TestingView, type WorkflowSnapshot,
} from "@agentx/contracts";
import { classifyTestingResult, hasUnconfirmedFailingTest, type FullSuiteState, type KnownFailingEntry, type ResultWaiting } from "./verification-result.js";
import { inertLine } from "./inert-text.js";

export interface TestingViewInput {
  workflow: WorkflowSnapshot;
  facts: AutoFixFacts;
  budget: AutoFixBudget;
  /** The broker's pack for the task (ignored unless it is for exactly the current code). */
  evidence?: EvidencePack | undefined;
  /** `alreadyFailingForResults`: the nightly baseline's failures and a maintainer's marks. */
  alreadyFailing: readonly KnownFailingEntry[];
  planned?: { fullSuite?: FullSuiteState | undefined; claimsNeedingRealService?: readonly string[] | undefined } | undefined;
}

export type TestingViewOutcome = { view: TestingView } | { view?: undefined; waiting: ResultWaiting | "unreadable" };

/** One line of plain text for a stored row: redacted, no control or format character, one space between words, cut. NOT made inert here (the contract forbids the invisible characters inertness adds); the pull request layout does that when it prints. */
function plainText(text: string, max: number): string {
  const plain = redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const points = Array.from(plain);
  return points.length <= max ? plain : `${points.slice(0, max - 1).join("")}…`;
}

const commandOf = (command: { executable: string; args: readonly string[] }): string => plainText([command.executable, ...command.args].join(" "), TESTING_COMMAND_MAX) || "command";

function rowsOf(input: TestingViewInput, outcome: { result: TestingView["result"]; reasons: readonly TestingReason[] }, evidence: EvidencePack | undefined): TestingRow[] {
  const { workflow } = input;
  const digest = workflow.candidate?.digest;
  const verification = digest !== undefined && workflow.verification?.candidateDigest === digest ? workflow.verification : undefined;
  const firstBlocked = outcome.reasons.find((reason): reason is TestingBlockedReason => TESTING_REASON_CLASS.blocked.has(reason));
  const rows: TestingRow[] = [];
  for (const check of workflowSelectedChecks(workflow.checkPolicy)) {
    if (check.id === E2E_PROJECT_CHECK_ID) continue;
    const label = plainText(check.label, TESTING_LABEL_MAX) || check.id;
    const command = commandOf(check.command);
    const result = verification?.results.find((entry) => entry.checkId === check.id);
    const proof = evidence?.checks.find((entry) => entry.checkId === check.id);
    if (result === undefined) {
      rows.push(outcome.result === "blocked_by_environment" && firstBlocked !== undefined ? { label, command, status: "blocked", reason: firstBlocked } : { label, command, status: "not_run", reason: "check_not_run" });
    } else if (result.status === "PASS") {
      const passed = proof?.tests?.passed;
      rows.push({ label, command, status: "passed", ...(passed === undefined ? {} : { passedTests: passed }) });
    } else if (workflowCheckResultBroken(result) || result.neverStarted === true) {
      rows.push({ label, command, status: "blocked", reason: result.neverStarted === true ? "check_could_not_start" : "check_command_broken" });
    } else if (proof?.after === "timed_out") {
      rows.push({ label, command, status: "blocked", reason: "timed_out" });
    } else if (proof?.after === "failed" && proof.class === "already_failing" && hasUnconfirmedFailingTest(proof, input.alreadyFailing)) {
      // Failed before, but with a failing test that was not failing before (or one the change added): the code's fault, however the old failure looks.
      rows.push({ label, command, status: "failed", reason: "new_failing_test" });
    } else if (proof?.after === "failed" && proof.class === "already_failing") {
      rows.push(outcome.result === "partially_verified" ? { label, command, status: "known_failing", reason: "known_failing_only" } : { label, command, status: "blocked", reason: "fails_on_original_code" });
    } else if (outcome.result === "blocked_by_environment") {
      rows.push({ label, command, status: "blocked", reason: firstBlocked ?? "check_runner_failed" });
    } else {
      rows.push({ label, command, status: "failed", ...(proof?.class === "regression" ? { reason: "check_failed" as const } : {}) });
    }
  }
  const fullSuite = input.planned?.fullSuite;
  if ((fullSuite === "pending" || fullSuite === "not_run") && rows.length < TESTING_ROWS_MAX) {
    rows.push({ label: "Full test suite", command: "all tests", status: fullSuite === "pending" ? "pending" : "not_run", reason: fullSuite === "pending" ? "full_suite_pending" : "full_suite_not_run" });
  }
  return rows;
}

/**
 * The Testing view of a task, or why there is none (yet). `waiting` is the classifier's own word (the result is not decided: the original-code run, the one automatic retry or a person is still to come) or
 * `unreadable` (the rows and the result did not fit together; nothing is shown). A follow-up full run that failed is not an input: the caller passes no `fullSuite` for it and shows no view (see the loader).
 */
export function testingViewOf(input: TestingViewInput): TestingViewOutcome {
  const decided = classifyTestingResult({ workflow: input.workflow, facts: input.facts, budget: input.budget, evidence: input.evidence, alreadyFailing: input.alreadyFailing, planned: input.planned });
  if (!decided.decided) return { waiting: decided.waiting };
  const evidence = input.evidence !== undefined && input.evidence.candidateDigest === input.workflow.candidate?.digest ? input.evidence : undefined;
  const candidate = { schemaVersion: 1 as const, result: decided.result, reasons: decided.reasons, rows: rowsOf(input, decided, evidence) };
  const parsed = TestingViewSchema.safeParse(candidate);
  return parsed.success ? { view: parsed.data } : { waiting: "unreadable" };
}

// ---- the pull request section

const ROW_MARK: Readonly<Record<TestingRow["status"], string>> = { passed: "✅", failed: "❌", blocked: "⛔", not_run: "⚠", pending: "⏳", known_failing: "⚠" };
const cell = (text: string): string => text.replaceAll("|", "¦").replaceAll("`", "'");

function rowResult(row: TestingRow): string {
  if (row.status === "passed") return `${ROW_MARK.passed} ${row.passedTests === undefined ? "passed" : `${String(row.passedTests)} passed`}`;
  const word = TESTING_ROW_STATUS_LABELS[row.status];
  return `${ROW_MARK[row.status]} ${word}${row.reason === undefined ? "" : `: ${TESTING_REASON_TEXT[row.reason]}`}`;
}

/** The heading's result in its fixed words. */
export const testingHeading = (view: Pick<TestingView, "result">): string => `## Testing — ${TESTING_RESULT_LABELS[view.result]}`;

/**
 * The section's lines (heading, summary, the reasons that matter, the table), at a shrink level 0..5. `extra` are the lines that stay from the old Tests section (the tested commit, tests added, test proof);
 * they are already inert. The result line is at every level. Levels 0 to 4 list every row that is not a plain pass (labels are cut to 40 characters and commands to 30 at level 4). Level 5, the last resort
 * that always fits (a view has at most 100 rows, so its size is bounded by the fixed reasons, not by the rows), lists the rows as counts per status and fixed reason and points to the task page, where each
 * check is listed in full.
 */
export function testingSectionLines(view: TestingView, level: number, extra: readonly string[] = []): string[] {
  if (level >= 5) return testingMinimalLines(view, extra);
  const foldPassed = level >= 2;
  const passed = view.rows.filter((row) => row.status === "passed");
  const shown = foldPassed ? view.rows.filter((row) => row.status !== "passed") : view.rows;
  const commandMax = level >= 4 ? 30 : level === 3 ? 40 : level === 1 || level === 2 ? 60 : TESTING_COMMAND_MAX;
  const labelMax = level >= 4 ? 40 : level === 3 ? 60 : 80;
  const lines = [testingHeading(view), testingSummary(view)];
  if (shown.length > 0) {
    lines.push("", "| Check | Command | Result |", "| --- | --- | --- |",
      ...shown.map((row) => `| ${cell(inertLine(row.label, labelMax))} | \`${cell(inertLine(row.command, commandMax))}\` | ${rowResult(row)} |`));
  }
  if (foldPassed && passed.length > 0) {
    const tests = passed.reduce((sum, row) => sum + (row.passedTests ?? 0), 0);
    lines.push("", `${String(passed.length)} more check${passed.length === 1 ? "" : "s"} passed${tests > 0 ? ` (${String(tests)} tests)` : ""}; their rows are left out to keep this description short.`);
  }
  if (extra.length > 0) lines.push("", ...extra);
  return lines;
}

/** The last resort: the heading, the result line, one line per (status, fixed reason) with how many checks, and where the rest is. Bounded by the fixed lists, whatever the rows hold. */
function testingMinimalLines(view: TestingView, extra: readonly string[]): string[] {
  const groups = new Map<string, number>();
  for (const row of view.rows) {
    if (row.status === "passed") continue;
    const key = `${TESTING_ROW_STATUS_LABELS[row.status]}${row.reason === undefined ? "" : `: ${TESTING_REASON_TEXT[row.reason]}`}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const passed = view.rows.filter((row) => row.status === "passed").length;
  const lines = [testingHeading(view), testingSummary(view)];
  if (groups.size > 0 || passed > 0) {
    lines.push("", ...[...groups].map(([what, count]) => `- ${String(count)} check${count === 1 ? "" : "s"} ${what}`));
    if (passed > 0) lines.push(`- ${String(passed)} check${passed === 1 ? "" : "s"} passed`);
    lines.push("", "Every check, with its command, is listed on the task page.");
  }
  if (extra.length > 0) lines.push("", ...extra);
  return lines;
}
