// TEST-RESULT-HONESTY: the words every surface that summarises a check uses for what the check's own output said about skipped tests and a missing test service (the Slack reply, the pull request's Checks section, the
// evidence pack's "not tested" list). One table, so the same fact reads the same everywhere. Plain words (DEC 540): a check is never "passed" without saying what it skipped, and one that ran no test at all is "not tested".
import type { CheckEntry } from "./checks.js";
import { missingServicesOf, skippedTestsOf, type SkippedTests, type TestService } from "./test-output-signals.js";

const tests = (count: number): string => `${count} ${count === 1 ? "test" : "tests"} skipped`;
const named = (services: readonly TestService[]): string => (services.length < 3 ? services.join(" and ") : `${services.slice(0, -1).join(", ")} and ${services.at(-1)}`);

export const TEST_RESULT_WORDS = {
  /** "3 tests skipped" */
  skipped: tests,
  /** The lead of a passing result that skipped tests; it replaces "Checks passed". */
  passedWithSkips: (count: number): string => `Passed, ${tests(count)}`,
  /** The result of a check in which no test ran. */
  allSkipped: "Not tested: every test was skipped",
  /** The same, as a fragment of a line about one check. */
  allSkippedShort: "not tested, every test was skipped",
  /** A failure that looks like a missing service: a hint, never a fact. */
  needs: (services: readonly TestService[]): string => `Looks like it needs ${named(services)}: Rovara didn't start ${services.length === 1 ? "one" : "them"}`,
  needsShort: (services: readonly TestService[]): string => `looks like it needs ${named(services)}: Rovara didn't start ${services.length === 1 ? "one" : "them"}`,
} as const;

export interface CheckResultNote {
  /** A passing check's skipped tests, when its output says some were. */
  skipped?: SkippedTests;
  /** A failing check's missing services, when its output says it could not reach any. */
  needs: TestService[];
}

/** What a check's output adds to its result: skips only on a check that passed, a missing service only on one that failed (a timed out or not-run check says nothing about either). */
export function checkResultNote(check: Pick<CheckEntry, "after" | "output">): CheckResultNote {
  const skipped = check.after === "passed" ? skippedTestsOf(check.output) : undefined;
  return { ...(skipped === undefined ? {} : { skipped }), needs: check.after === "failed" ? missingServicesOf(check.output) : [] };
}

/** Whether a check report's text already opens with a test-result verdict ("Passed, 3 tests skipped ...", "Not tested: ..."): a surface that adds its own "Checks passed." lead leaves it off, so the two never disagree. */
export const opensWithTestResult = (text: string): boolean => text.startsWith("Passed, ") || text.startsWith(TEST_RESULT_WORDS.allSkipped);

const CHECK_REPORT_LEADS = { passed: "Checks passed.", failed: "Checks failed.", unknown: "Checks have not finished." } as const;

/** A check report as a chat message: its status as a lead, unless the text opens with its own result (the two would disagree). */
export const checkReportWords = (report: { status: keyof typeof CHECK_REPORT_LEADS; text: string }): string => (opensWithTestResult(report.text) ? report.text : `${CHECK_REPORT_LEADS[report.status]} ${report.text}`);
