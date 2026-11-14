// Rovara Code (Plan 6 Task 12): what a version 2 task says about its checks and reviews. `verificationReport` turns the worker's recorded check results (untrusted
// output: the labels of the checks a model proposed, the paths in a diff) into the four lists the person reads: what passed, what failed, what could not be checked
// and which tests were added. Every string in it is redacted, on one line and cut to its limit, and the whole report is parsed by `VerificationReportSchema` before
// it leaves this module. It is plain text for every reader: the task page, Slack and the PR body escape it for their own markup, and nothing here builds HTML.
import {
  VerificationReportSchema, redactText, workflowCheckResultBroken, workflowIsReviewOnly, workflowSelectedChecks,
  type VerificationReport, type WorkflowSnapshot,
} from "@agentx/contracts";

/** The build rule of a version 2 task, exact: it ends every build prompt (the plan's text). */
export const IMPLEMENT_TEST_RULE = "Add or update tests for every behaviour you change. If a change can't be tested, say why in your final message.";

/** A build prompt of a version 2 task ends with the test rule; a version 1 prompt is returned as it is. */
export function withTestRule(prompt: string, workflow: Pick<WorkflowSnapshot, "definitionVersion">): string {
  return workflow.definitionVersion === "1.1.0" ? `${prompt}\n\n${IMPLEMENT_TEST_RULE}` : prompt;
}

/** The paths that count as tests: a test folder, a `.test` or `.spec` file, a Go or Python `_test` file and a Python `test_` file. Matched on whole path segments. */
export const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|tests?|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py)$/,
  /(^|\/)test_[^/]+\.py$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

const LABEL_MAX = 200;
const REASON_MAX = 200;
const SUMMARY_MAX = 300;
const PATH_MAX = 500;
const LIST_MAX = 100;
const TESTS_ADDED_MAX = 50;

const E2E_LABEL = "Browser and API checks";
const AUTOMATED_CHECKS_LABEL = "Automated checks";

/** One redacted line of at most `max` characters (counted in code points): no control or format characters, runs of white space made one space. */
function oneLine(text: string, max: number, fallback: string): string {
  // Normalised before it is redacted: a format character (a zero-width space) inside a token would otherwise stop the match and leave the pieces readable.
  const flat = text.replace(/\p{Cf}+/gu, "").replace(/[\p{Cc}\s]+/gu, " ");
  const cleaned = redactText(flat).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (cleaned === "") return fallback;
  const points = Array.from(cleaned);
  return points.length <= max ? cleaned : `${points.slice(0, max - 1).join("")}\u2026`;
}

/** What the project knows that the workflow does not: how its pull request's CI is judged (Task 14 fills it from the tracked pull request). */
export interface VerificationProject {
  ciBasis?: "required" | "all_checks" | undefined;
}

/** A changed file as the task view lists it; `added` and `removed` are the diff's line counts when known (absent: the diff gave none, which is not 0). `renamedFrom` is the old name of a renamed file. */
export interface ChangedFileEntry {
  repository: string;
  path: string;
  renamedFrom?: string | undefined;
  added?: number | undefined;
  removed?: number | undefined;
  /** A test file the change deletes, or only takes lines out of (Plan 6 Task 16): what a fix that hides a failure by removing its test looks like. */
  testsRemoved?: true | undefined;
  /** A test file in which a line the change adds skips a test (`.skip(`, `xit(`, `@Disabled`, `t.Skip(`, `pytest.mark.skip`, ...). */
  testsSkipped?: true | undefined;
  /** package.json: a line of the `test` scripts was added or removed (Plan 6 Task 16): what a fix looks like that makes the tests not run. */
  testCommandChanged?: true | undefined;
  /** TE-B3: package.json: a line of another script CI runs (`pretest`, `posttest`, `ci`, `coverage`, `verify`, `check`) was added or removed. */
  ciScriptChanged?: true | undefined;
  /** TE-B3: a line the change adds takes tests or coverage out of a run (an ignore, deselect or exclude option in a test or coverage configuration, a `pragma: no cover` or an istanbul, c8 or v8 ignore comment). */
  testsExcluded?: true | undefined;
  /** TE-B3: the file is a test runner's or coverage tool's configuration, a Makefile or a `conftest.py` (under either name, for a rename). */
  testConfigChanged?: true | undefined;
  /** TE-B3: the file is a snapshot or golden file (under either name). */
  snapshotChanged?: true | undefined;
  /** TE-B3: the file is a fixture, mock or recorded-answer file (under either name). */
  fixtureChanged?: true | undefined;
  /** The diff changes a route declaration or response model, or a schema, serializer, OpenAPI or protobuf file: the public API or the shape of a response may be different for existing callers. */
  apiShapeChanged?: true | undefined;
}

/**
 * The report for the workflow's current code. Results recorded for other code are not this code's results, so the checks they named read as not checked. A check
 * that failed because its program or command couldn't run, never started or gave no answer is "not checked": the code isn't at fault, and nothing says it passed.
 * A review-only change is not checked, with the plan's reason. Required browser and API checks that no round qualified or failed for this code were not admitted.
 */
export function verificationReport(workflow: WorkflowSnapshot, changedFiles: readonly ChangedFileEntry[], project: VerificationProject): VerificationReport {
  const currentDigest = workflow.candidate?.digest;
  const recorded = workflow.verification !== undefined && currentDigest !== undefined && workflow.verification.candidateDigest === currentDigest ? workflow.verification : undefined;
  const reviewOnly = recorded?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const passed: VerificationReport["passed"] = [];
  const failed: VerificationReport["failed"] = [];
  const notChecked: VerificationReport["notChecked"] = [];
  const labelOf = (label: string) => oneLine(label, LABEL_MAX, "A check");
  const missing = (label: string, reason: string) => notChecked.push({ label: labelOf(label), reason: oneLine(reason, REASON_MAX, "It was not checked.") });

  if (reviewOnly) {
    missing(AUTOMATED_CHECKS_LABEL, workflow.checkPolicy?.noneReason ?? "No automated check applied to this change.");
  } else {
    const results = new Map((recorded?.results ?? []).map((result) => [result.checkId, result]));
    const selected = workflowSelectedChecks(workflow.checkPolicy);
    for (const check of selected) {
      const result = results.get(check.id);
      if (result === undefined) missing(check.label, "No result was recorded for it.");
      else if (result.neverStarted === true) missing(check.label, "It never started.");
      else if (workflowCheckResultBroken(result)) {
        missing(check.label, result.programNotFound === true ? "Its program isn't installed on Rovara's machine, so it did not run." : "Its command couldn't run, so it did not check the code.");
      } else if (result.status === "PASS") passed.push({ label: labelOf(check.label) });
      else if (result.status === "FAILED") failed.push({ label: labelOf(check.label), summary: oneLine("It failed on the latest code.", SUMMARY_MAX, "It failed.") });
      else missing(check.label, "Rovara couldn't tell whether it passed.");
      results.delete(check.id);
    }
    // A result for a check the policy no longer lists (the policy changed after the run) is shown by its id, never dropped silently.
    for (const [checkId, result] of results) {
      if (result.status === "PASS") passed.push({ label: labelOf(checkId) });
      else if (result.status === "FAILED" && !workflowCheckResultBroken(result) && result.neverStarted !== true) failed.push({ label: labelOf(checkId), summary: "It failed on the latest code." });
      else missing(checkId, "It was not checked.");
    }
  }

  if (workflow.e2e?.required === true) {
    if (workflow.e2e.qualifiedRound?.candidateDigest === currentDigest && currentDigest !== undefined) passed.push({ label: E2E_LABEL });
    else if (workflow.e2e.failedRound?.candidateDigest === currentDigest && currentDigest !== undefined) failed.push({ label: E2E_LABEL, summary: "They failed on the latest code." });
    else missing(E2E_LABEL, workflow.e2e.currentRoundId === undefined ? "They were not admitted to run on the latest code." : "They have not finished on the latest code.");
  }

  const testsAdded: VerificationReport["testsAdded"] = [];
  const seen = new Set<string>();
  for (const file of changedFiles) {
    if (testsAdded.length >= TESTS_ADDED_MAX) break;
    // A file the change only trimmed or deleted added no test. When the line counts are not known the file counts.
    if (!isTestPath(file.path) || (file.added !== undefined && file.added <= 0)) continue;
    const entry = { repository: oneLine(file.repository, LABEL_MAX, "repository"), path: oneLine(file.path, PATH_MAX, "path") };
    const key = `${entry.repository}\u0000${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    testsAdded.push(entry);
  }

  return VerificationReportSchema.parse({
    reviewOnly,
    ...(project.ciBasis === undefined ? {} : { ciBasis: project.ciBasis }),
    passed: passed.slice(0, LIST_MAX),
    failed: failed.slice(0, LIST_MAX),
    notChecked: notChecked.slice(0, LIST_MAX),
    testsAdded,
  });
}

/** The review round whose findings are being fixed: shown to a version 2 client in the task view and said in the thread. */
export interface ReviewRound {
  round: number;
  max: number;
  message: string;
}

/**
 * The review round being fixed, for a version 2 task that follows a program: while coding runs again after a review round found problems (the engine sends them
 * back on its own, up to the review step's `maxRounds`). The engine's counter (`programRounds`) counts every finished review, a clean one included, and is never
 * reset, so it alone would call an owner's send-back or a CI fix after a clean review "a round that found problems". A round is being fixed only when the review
 * step's reports for the code being rewritten still hold findings (they stay until the next candidate replaces them). Absent before the first review, while checks
 * or a review run, once the pull request is next, while the step is blocked, for a fix made for CI, a conflict or comments (`fixSource`), and always on a version 1
 * task (m20: it shows no round counter).
 */
export function workflowReviewRound(workflow: WorkflowSnapshot): ReviewRound | undefined {
  const program = workflow.program;
  if (workflow.definitionVersion !== "1.1.0" || program === undefined || workflow.programStepId === undefined) return undefined;
  if (workflow.stage !== "IMPLEMENT" || workflow.state === "BLOCKED" || workflow.fixSource !== undefined) return undefined;
  const current = program.steps.findIndex((step) => step.id === workflow.programStepId);
  const currentCode = workflow.candidate?.digest;
  const unresolved = currentCode !== undefined && (workflow.reviews ?? []).some((review) => review.status === "FINDINGS" && review.candidateDigest === currentCode);
  if (!unresolved) return undefined;
  for (const [index, step] of program.steps.entries()) {
    if (step.kind !== "review" || step.onFindings === undefined) continue;
    const backTo = program.steps.findIndex((candidate) => candidate.id === step.onFindings?.backTo);
    const round = workflow.programRounds?.[step.id];
    if (round === undefined || current < backTo || current >= index) continue;
    const max = step.onFindings.maxRounds;
    return { round, max, message: `Review round ${round} of ${max} found problems; I'm fixing them.` };
  }
  return undefined;
}
