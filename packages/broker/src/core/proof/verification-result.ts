// Setup and test health SH5 (design setup-test-health.md, sections 4.1 and 4.2): the broker's classifier for the four results. PURE: it reads stored fields only (the workflow snapshot, the facts the
// auto-fix policy already takes, the evidence pack the broker built, the nightly already-failing set and the plan's planned facts) and returns a member of fixed lists. It never reads, returns or
// parses text a worker, a model or a check printed: the worker's own words ("all passed", a summary, a verdict) cannot set a result. Nothing is wired: `vx` ships off.
//
// Order of the rules (design 4.1):
//   1. Code failed wins. A fault of the code (4.2 "code" rows, a regression in the evidence pack, or an unclear fault whose original-code run passed) is "Code failed" even when environment faults are
//      mixed in; those are still listed as reasons.
//   2. An unclear fault is not decided here: the original-code run is requested or awaited first (existing policy), so the answer is "waiting".
//   3. Blocked by environment: a required check could not give a verdict for an environment reason, AFTER the one automatic retry (while the auto-fix policy still says RETRY the answer is "waiting").
//      A test that fails on the original code too is Blocked unless every such test is in the already-failing set; then it is only "Partially verified" (known failing).
//   4. Partially verified: nothing failed or was blocked, but something planned did not run or could not be read.
//   5. Verified: every required check ran on the current candidate, the evidence is for exactly this code, and nothing is missing.
// Anything that cannot be read is never Verified.
import {
  autoFixDecision, classifyBlockedWorkflow, E2E_PROJECT_CHECK_ID, SANDBOX_MODEL_HOSTS_ITEM_ID, isValidTestId,
  type AutoFixBudget, type AutoFixCode, type AutoFixFacts, type EvidencePack, type TestingBlockedReason, type TestingCodeReason, type TestingPartialReason, type TestingReason, type TestingResult,
  type WorkflowSnapshot,
} from "@agentx/contracts";

/** What a "waiting" answer is waiting for. A fixed list: the caller words it. */
export const RESULT_WAITING = ["not_checked_yet", "retry_pending", "original_code_pending", "cause_unknown", "needs_a_person"] as const;
export type ResultWaiting = (typeof RESULT_WAITING)[number];

/** A test the project knows is already failing: a bare name (the last nightly's failures; matches in any check) or a name marked for one check (matches only in that check). */
export type KnownFailingEntry = string | { name: string; checkId: string };

export type ResultOutcome =
  | { decided: true; result: TestingResult; reasons: TestingReason[] }
  | { decided: false; waiting: ResultWaiting };

/** The state of the follow-up full run, as the broker stores it (`rovara-code/full-suite-followup.ts` words it as a view): `pending` is queued or running, `not_run` is expired, not queued or never planned. */
export type FullSuiteState = "not_needed" | "pending" | "not_run";

export interface ResultInput {
  /** The task's workflow as stored. */
  workflow: WorkflowSnapshot;
  /** What the caller knows that the workflow does not store; the same facts the auto-fix policy takes. */
  facts: AutoFixFacts;
  /** The auto-fix budget and switch: they decide whether the one automatic retry is still coming. */
  budget: AutoFixBudget;
  /** The pack the BROKER built from the worker's raw parts. Ignored unless it is for exactly the current candidate. */
  evidence?: EvidencePack | undefined;
  /** The already-failing set (`alreadyFailingForResults`: the nightly baseline's failures and a maintainer's marks): empty when unknown or truncated, which excuses nothing. */
  alreadyFailing: readonly KnownFailingEntry[];
  /** What the plan said, from stored fields. */
  planned?: {
    fullSuite?: FullSuiteState | undefined;
    /** Names of the mocked services that a claim of the plan needs to be the real thing. */
    claimsNeedingRealService?: readonly string[] | undefined;
  } | undefined;
}

type Rule =
  | { kind: "code"; reason: TestingCodeReason }
  | { kind: "environment"; reason: TestingBlockedReason }
  /** A test fails on the original code too: Blocked unless every failing test is known failing. */
  | { kind: "original_fails" }
  /** The original-code run has not settled whose fault it is. */
  | { kind: "unclear" }
  /** About reviews or the pull request, not the tests: has its own place, never a test result. */
  | { kind: "review" }
  | { kind: "neutral" }
  /** Today's ask card, unchanged: a person must act and it is not about the test environment. */
  | { kind: "ask" };

const code = (reason: TestingCodeReason): Rule => ({ kind: "code", reason });
const env = (reason: TestingBlockedReason): Rule => ({ kind: "environment", reason });
const ASK: Rule = { kind: "ask" };

/**
 * Design 4.2 as a table, one entry for EVERY auto-fix code: a new code is a compile error here until it is placed. Codes the table does not list stay today's ask (`ask`, never an environment claim);
 * `executor-result-mismatch` is placed with `executor-failed` (the same machine fault) and is the one extension of the table.
 */
export const RESULT_RULES: Readonly<Record<AutoFixCode, Rule>> = {
  "build-failed": code("app_failed"), "app-exited": code("app_failed"), "app-unhealthy": code("app_failed"), "seed-failed": code("app_failed"),
  "e2e-assertion-failed": code("e2e_assertion_failed"), "check-failed": code("check_failed"), "new-failing-test": code("new_failing_test"), "regression-found": code("regression_found"), "round-refused": code("round_refused"),
  "review-findings": { kind: "review" },
  "deadline-exceeded": env("timed_out"), "executor-failed": env("executor_failed"), "executor-result-mismatch": env("executor_failed"), "mock-unavailable": env("mock_unavailable"),
  "check-runner-failed": env("check_runner_failed"), "check-not-started": env("check_could_not_start"), "provider-outage": env("provider_outage"), "runner-busy": env("runner_busy"),
  "setup-failed-in-task": env("setup_failed_in_task"), "host-blocked": env("host_blocked"), "build-host-offline": env("build_host_offline"),
  "runtime-renewed": env("test_machine_renewed"),
  "model-channel-unavailable": ASK, "cancelled": ASK, "evidence too large": ASK,
  "review-not-run": { kind: "review" }, "review-run-failed": { kind: "review" },
  "runtime-expired": env("test_machine_expired"), "runtime-unusable": env("test_machine_unusable"), "runtime-environment-drifted": env("test_machine_drifted"), "login-failed": env("login_failed"),
  "setup-changed-files": env("setup_changed_files"), "leftover-processes": env("leftover_processes"), "check-broken": env("check_command_broken"),
  "fails-on-original-code": { kind: "original_fails" },
  "model-environment-unsafe": ASK, "model-route-changed-reapprove": ASK, "agent-route-not-approved": ASK, "model-route-not-tested": ASK,
  "selection-changed": ASK, "accounts-changed": ASK, "plan-not-approvable": ASK, "history-rewritten": ASK, "cancelled-by-owner": ASK, "unknown-group-code": ASK, "unreadable": ASK,
  "review-unusable": { kind: "review" }, "rule-files-unverified": { kind: "review" },
  "pull-request-open": { kind: "neutral" },
  "dispatch-exhausted": ASK, "run-lost": ASK, "owner-stopped": ASK, "base-merged": ASK,
  "e2e-evidence-unknown": { kind: "unclear" }, "check-result-unknown": { kind: "unclear" }, "check-failed-cause-unknown": { kind: "unclear" },
};

/** At a blocked REVIEW the tests already passed: only these two codes are about the tests, every other signal is about the review or the pull request. */
const REVIEW_STAGE_TEST_CODES: ReadonlySet<AutoFixCode> = new Set<AutoFixCode>(["regression-found", "leftover-processes"]);

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** What an unclear E2E fault becomes once each UNKNOWN group's own original-code result is known. Mirrors the auto-fix policy: only a group that positively passed on the original code points at the candidate. */
function unclearE2e(facts: AutoFixFacts): "code" | "original_fails" | "original_code_pending" | "cause_unknown" {
  const groups = Object.values(facts.e2eUnknownGroups ?? {});
  if (groups.length === 0) return "original_code_pending";
  if (groups.some((result) => result === "failed" || result === "cannot-run")) return "original_fails";
  if (groups.some((result) => result === "skipped")) return "cause_unknown";
  if (groups.some((result) => result === "pending" || result === "not-run")) return "original_code_pending";
  return groups.every((result) => result === "passed") ? "code" : "cause_unknown";
}

/** The kind of a check by its id, from the task's own check list (required, optional and proposed checks). Undefined when the list does not name it: an unknown kind is never read as a test. */
export function workflowCheckKind(workflow: WorkflowSnapshot, checkId: string): string | undefined {
  const policy = workflow.checkPolicy;
  return [...(policy?.required ?? []), ...(policy?.optional ?? []), ...(policy?.proposed ?? [])].find((entry) => entry.id === checkId)?.kind;
}

/** A check that failed on the original code (by the original-code facts) that the evidence pack does not name at all (or there is no pack for this code) AND that is a test check by the task's check list: no per-test data, so nothing about its failures is confirmed (M2). A check of another or an unknown kind keeps the old rule. */
export function testCheckFailedBeforeWithoutData(workflow: WorkflowSnapshot, failedOnOriginal: readonly { checkId: string }[], pack: EvidencePack | undefined): boolean {
  return failedOnOriginal.some((result) => !(pack?.checks ?? []).some((check) => check.checkId === result.checkId) && workflowCheckKind(workflow, result.checkId) === "test");
}

/** A check with no per-test data to read at all: no test counts, or a count of zero failures while the check failed. */
export const hasNoTestData = (check: EvidencePack["checks"][number]): boolean => check.tests === undefined || check.tests.failed + check.tests.errored === 0;

/**
 * The failing tests of a check, when the pack gives usable per-test data for it: every failing test named once (distinct names) and as many names as the count says. Undefined when it does not (no test
 * counts, a count of zero while the check failed, fewer names than the count, or a name twice): the data cannot say which tests failed, so nothing about them can be confirmed.
 */
export function readableFailingTests(check: EvidencePack["checks"][number]): string[] | undefined {
  if (check.tests === undefined) return undefined;
  const declared = check.tests.failed + check.tests.errored;
  if (declared === 0) return undefined;
  const failingNames = check.tests.names.filter((test) => test.status === "failed" || test.status === "errored");
  const failed = failingNames.map((test) => test.name);
  if (failed.length !== declared || new Set(failed).size !== failed.length) return undefined;
  // A failing test whose id is not valid (hidden or look-alike characters, too long; contracts `test-id.ts`) cannot be in the nightly's failing set or a mark, so it is never confirmed as already failing: unreadable here.
  if (failingNames.some((test) => test.unlisted === true) || !failed.every(isValidTestId)) return undefined;
  return failed;
}

/**
 * Whether a check that failed on the original code too has a failing test that was NOT failing before (owner decision, Opus re-check M2): a failing test the already-failing set does not know (the last usable nightly's
 * failures and a maintainer's marks for this check; with no usable nightly, only the marks), a failing test the change itself added (`newTests`), or failing tests the pack does not name (or names twice).
 * A check of the `test` kind whose per-test data cannot be read (no test counts, a count of zero while it failed, because the pack dropped them as disagreeing with the check) is the same: unconfirmed. A check of
 * another kind (a lint, say) has no tests to judge. Such a check is a failure of the CODE ("Code failed", the code goes back), never "Blocked by environment": the old failure must not hide a new one.
 */
export function hasUnconfirmedFailingTest(check: EvidencePack["checks"][number], alreadyFailing: readonly KnownFailingEntry[]): boolean {
  const failed = readableFailingTests(check);
  if (failed === undefined) return hasNoTestData(check) ? check.kind === "test" : true;
  const anyCheck = new Set(alreadyFailing.filter((entry): entry is string => typeof entry === "string"));
  const perCheck = new Set(alreadyFailing.flatMap((entry) => (typeof entry === "string" ? [] : [`${entry.checkId}\u0000${entry.name}`])));
  const added = new Set(check.tests!.newTests);
  return failed.some((name) => added.has(name) || !(anyCheck.has(name) || perCheck.has(`${check.checkId}\u0000${name}`)));
}

/** The checks (by ID) that failed on the original code too but have a failing test that was not failing before (see `hasUnconfirmedFailingTest`): the broker's input to the auto-fix policy while the four results are on. */
export function newFailingCheckIds(evidence: EvidencePack | undefined, alreadyFailing: readonly KnownFailingEntry[]): string[] {
  return (evidence?.checks ?? []).filter((check) => check.after === "failed" && check.class === "already_failing" && hasUnconfirmedFailingTest(check, alreadyFailing)).map((check) => check.checkId);
}

/** Whether every failing check of the evidence failed on the original code too and every failing test of it is in the already-failing set. Anything short of that excuses nothing. */
function knownFailingExcused(failing: readonly EvidencePack["checks"][number][], alreadyFailing: readonly KnownFailingEntry[]): boolean {
  if (failing.length === 0 || alreadyFailing.length === 0) return false;
  const anyCheck = new Set(alreadyFailing.filter((entry): entry is string => typeof entry === "string"));
  const perCheck = new Set(alreadyFailing.flatMap((entry) => (typeof entry === "string" ? [] : [`${entry.checkId}\u0000${entry.name}`])));
  return failing.every((check) => {
    if (check.after !== "failed" || check.class !== "already_failing" || check.tests === undefined) return false;
    // A test the change itself added cannot have been failing before it: the worker's own list of new tests is never a reason to excuse one.
    const added = new Set(check.tests.newTests);
    // Every failure must be named once (the names are capped) and known (a nightly failure in any check, a mark for this check); a check that failed with no failing test named (it did not run its tests) is not excused.
    const failedTests = readableFailingTests(check);
    return failedTests !== undefined && failedTests.every((name) => !added.has(name) && (anyCheck.has(name) || perCheck.has(`${check.checkId}\u0000${name}`)));
  });
}

/**
 * The result of a task's tests, or what the answer is waiting for. Pure and fail closed: a missing, stale or unreadable input is never read as a pass.
 */
export function classifyTestingResult(input: ResultInput): ResultOutcome {
  const { workflow, facts, budget } = input;
  const current = workflow.candidate?.digest;
  if (current === undefined) return { decided: false, waiting: "not_checked_yet" };
  const evidence = input.evidence !== undefined && input.evidence.candidateDigest === current ? input.evidence : undefined;
  const verification = workflow.verification?.candidateDigest === current ? workflow.verification : undefined;

  // ---- the signals of a blocked VERIFY or REVIEW, through the existing classifier
  const blockedChecks = workflow.state === "BLOCKED" && (workflow.stage === "VERIFY" || workflow.stage === "REVIEW");
  const reviewStage = workflow.stage === "REVIEW";
  const signals = (blockedChecks ? classifyBlockedWorkflow(workflow, facts) : []).filter((signal) => !reviewStage || REVIEW_STAGE_TEST_CODES.has(signal.code));
  const rules = signals.map((signal) => RESULT_RULES[signal.code]);

  const codeReasons: TestingCodeReason[] = [];
  const blockedReasons: TestingBlockedReason[] = [];
  let originalFails = false;
  let ask = false;
  let unclearWaiting: ResultWaiting | undefined;
  for (const [index, rule] of rules.entries()) {
    if (rule.kind === "code") codeReasons.push(rule.reason);
    else if (rule.kind === "environment") blockedReasons.push(rule.reason);
    else if (rule.kind === "original_fails") originalFails = true;
    else if (rule.kind === "ask") ask = true;
    else if (rule.kind === "unclear") {
      // Only an unclear E2E round has an original-code round per group to settle it; any other unclear fault stays unclear.
      const settled = signals[index]?.code === "e2e-evidence-unknown" ? unclearE2e(facts) : "cause_unknown";
      if (settled === "code") codeReasons.push("e2e_assertion_failed");
      else if (settled === "original_fails") originalFails = true;
      else unclearWaiting = laterWaiting(unclearWaiting, settled === "cause_unknown" ? "cause_unknown" : "original_code_pending");
    }
  }

  // ---- what the broker's evidence pack says about each check (stored fields only)
  const evidenceChecks = evidence?.checks ?? [];
  const failingChecks = evidenceChecks.filter((check) => check.after === "failed");
  const originalFailingChecks: EvidencePack["checks"][number][] = [];
  for (const check of failingChecks) {
    if (check.class === "regression") codeReasons.push("check_failed");
    else if (check.class === "already_failing") originalFailingChecks.push(check);
    else unclearWaiting = "cause_unknown";
  }
  if (evidenceChecks.some((check) => check.after === "timed_out")) unclearWaiting = "cause_unknown";
  // A regression is already "Code failed"; what is left failing must all be an excused original-code failure.
  // Every check the policy saw fail on the original code must be one of the excused checks of the pack: a failing check the pack does not cover is never hidden behind a known failing one.
  const failedOnOriginal = (verification?.results ?? []).filter((result) => result.checkId !== E2E_PROJECT_CHECK_ID && result.status === "FAILED" && (facts.checkOriginal?.[result.checkId] === "failed" || facts.checkOriginal?.[result.checkId] === "cannot-run"));
  const excused = () => knownFailingExcusedAll(failingChecks.filter((check) => check.class !== "regression"), originalFailingChecks, input.alreadyFailing)
    && failedOnOriginal.every((result) => originalFailingChecks.some((check) => check.checkId === result.checkId));
  if (originalFailingChecks.length > 0) originalFails = true;
  // A check that failed before AND has a failing test that was not failing before is the code's fault (M2): the old failure does not hide the new one.
  if (originalFailingChecks.some((check) => hasUnconfirmedFailingTest(check, input.alreadyFailing))) codeReasons.push("new_failing_test");
  // A TEST check the policy saw fail on the original code that the pack does not name at all (or there is no pack for this code) has no per-test data at all: nothing about its failures is confirmed, so it is the same (M2). Another or an unknown kind keeps the old rule.
  if (testCheckFailedBeforeWithoutData(workflow, failedOnOriginal, evidence)) codeReasons.push("new_failing_test");

  // ---- 1. Code failed wins; environment faults are still listed
  if (codeReasons.length > 0) return { decided: true, result: "code_failed", reasons: unique([...codeReasons, ...blockedReasons, ...(originalFails && !excused() ? ["fails_on_original_code" as const] : [])]) };

  // ---- 2. an unclear fault waits for the original-code run (existing policy), it is not guessed
  const decision = autoFixDecision(workflow, facts, budget);
  const retryComing = decision.action === "RETRY";
  if (unclearWaiting !== undefined) return { decided: false, waiting: retryComing ? "retry_pending" : unclearWaiting };

  // ---- 3. a fault that is today's ask (the owner's stop, a changed selection, a rewritten history ...) is not renamed "Blocked by environment" because an environment code is beside it
  if (ask) return { decided: false, waiting: retryComing ? "retry_pending" : "needs_a_person" };

  // ---- 4. Blocked by environment, only after the one automatic retry
  let knownFailingOnly = false;
  if (originalFails) {
    if (excused()) knownFailingOnly = true;
    else blockedReasons.push("fails_on_original_code");
  }
  if (blockedReasons.length > 0) return retryComing ? { decided: false, waiting: "retry_pending" } : { decided: true, result: "blocked_by_environment", reasons: unique(blockedReasons) };

  // ---- 5. nothing failed or was blocked: was everything required checked on this exact code?
  if (verification === undefined) return { decided: false, waiting: "not_checked_yet" };
  // A check that failed on the original code too and is excused (known failing) is the one non-pass that does not stop the answer.
  const excusedIds = new Set(knownFailingOnly ? originalFailingChecks.map((check) => check.checkId) : []);
  if (verification.results.some((result) => result.checkId !== E2E_PROJECT_CHECK_ID && result.status !== "PASS" && !excusedIds.has(result.checkId))) return { decided: false, waiting: workflow.state === "BLOCKED" ? "needs_a_person" : "not_checked_yet" };
  if (workflow.e2e?.required === true && workflow.e2e.qualifiedRound?.candidateDigest !== current) return { decided: false, waiting: workflow.state === "BLOCKED" ? "needs_a_person" : "not_checked_yet" };

  const partial: TestingPartialReason[] = [];
  if (verification.reviewOnly === true || verification.results.length === 0) partial.push("no_checks_ran");
  if (evidence === undefined) partial.push("evidence_missing");
  const needReal = new Set(input.planned?.claimsNeedingRealService ?? []);
  for (const item of evidence?.notTested ?? []) {
    if (item.kind === "claim") partial.push("claim_not_tested");
    else if (item.kind === "scenario") partial.push("scenario_not_tested");
    else if (item.kind === "check") partial.push("check_not_run");
    // FIX-0518: the laptop's opt-out line ("model hosts allowed in the test sandbox by project setting") is a fixed note about where the tests ran, not a sign that details could not be read: it is shown, and the verdict stays.
    else if (item.kind === "environment") { if (item.id !== SANDBOX_MODEL_HOSTS_ITEM_ID) partial.push("evidence_unreadable"); }
    else if (item.kind === "mocked_service" && needReal.has(item.id)) partial.push("real_service_not_tested");
  }
  if (evidenceChecks.some((check) => check.after === "unknown" || check.after === "not_run")) partial.push("check_not_run");
  const fullSuite = input.planned?.fullSuite ?? "not_needed";
  if (fullSuite === "pending") partial.push("full_suite_pending");
  else if (fullSuite === "not_run") partial.push("full_suite_not_run");
  if (knownFailingOnly) partial.push("known_failing_only");
  return partial.length > 0 ? { decided: true, result: "partially_verified", reasons: unique(partial) } : { decided: true, result: "verified", reasons: [] };
}

/** The later of two answers a result can wait for: an unknown cause is stronger than a pending original-code run. */
function laterWaiting(current: ResultWaiting | undefined, next: ResultWaiting): ResultWaiting {
  return current === "cause_unknown" || next === "cause_unknown" ? "cause_unknown" : next;
}

/**
 * Whether the "fails on the original code" fault is excused. It is only when the evidence pack names the failing checks, each failed on the original code too, and every failing test is known failing.
 * A signal without evidence behind it (`fails-on-original-code` from a check result alone) excuses nothing, and a failing check of another kind is never hidden behind a known failing one.
 */
function knownFailingExcusedAll(failingChecks: readonly EvidencePack["checks"][number][], originalFailingChecks: readonly EvidencePack["checks"][number][], alreadyFailing: readonly KnownFailingEntry[]): boolean {
  return failingChecks.length === originalFailingChecks.length && knownFailingExcused(originalFailingChecks, alreadyFailing);
}
