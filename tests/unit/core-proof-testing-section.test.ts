// Setup and test health SH18: the Testing view (rows from the task's selected checks, the classifier's result) and the `## Testing` section of a pull request: fixed words, redacted and inert text, the shrink
// levels that never drop the result or a blocked, failed, not-run or already-failing row, and the description with the view absent being exactly what it was.
import { describe, expect, it } from "vitest";
import {
  EvidencePackSchema, TESTING_REASON_TEXT, TestingViewSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, wholeTaskSpendUsd,
  type AutoFixBudget, type TestingView, type WorkflowSnapshot,
} from "@agentx/contracts";
import { testingSectionLines, testingViewOf, type TestingViewInput } from "../../packages/broker/src/core/proof/testing-section.js";
import { rovaraStatusLines, type PullRequestBodyContext } from "../../packages/broker/src/core/proof/pull-request-body.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = "2026-11-02T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
type Over = Record<string, unknown>;
const budget: AutoFixBudget = { enabled: false, dayBudgetHasRoom: false, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: 15 } };
const command = (executable: string, args: string[]) => ({ cwd: "repo/app", executable, args, timeoutSeconds: 600 });
const policy = (...checks: Array<[string, string, string, string[]]>) => ({ required: checks.map(([id, label, executable, args]) => ({ id, label, command: command(executable, args) })), optional: [], selectedOptionalIds: [], proposed: [] });
const POLICY = policy(["unit", "Unit tests", "pytest", ["-q"]], ["lint", "Lint", "ruff", ["check", "."]]);
const check = (checkId: string, status: string, extra: Over = {}): Over => ({ checkId, status, ...extra });
const results = (...rows: Over[]): Over => ({ verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: rows } });
const workflow = (over: Over = {}, state: "READY" | "BLOCKED" = "READY", blockReason?: string): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW }), definitionVersion: "1.1.0", revision: 7, stage: "REVIEW", state, ...(blockReason === undefined ? {} : { blockReason }), candidate, checkPolicy: POLICY,
  ...results(check("unit", "PASS"), check("lint", "PASS")), ...over,
});
const pack = (checks: Over[] = [{}, { checkId: "lint", kind: "lint", label: "lint" }], over: Over = {}) => EvidencePackSchema.parse({
  schemaVersion: 1, candidateDigest: candidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
  checks: checks.map((entry) => ({ checkId: "unit", kind: "test", label: "unit", before: "passed", after: "passed", class: "passing", durationMs: 5, ...entry })),
  selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [], ...over,
});
const view = (input: Partial<TestingViewInput> = {}): TestingView => {
  const outcome = testingViewOf({ workflow: workflow(), facts: {}, budget, evidence: pack(), alreadyFailing: [], ...input });
  if (outcome.view === undefined) throw new Error(`no view: ${String(outcome.waiting)}`);
  return outcome.view;
};
const testsOf = (failed: string[]) => ({ total: 10, passed: 10 - failed.length, failed: failed.length, skipped: 0, errored: 0, newTests: [], names: failed.map((name) => ({ name, status: "failed" })) });
const STUCK = (): WorkflowSnapshot => workflow({ stage: "VERIFY", verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed);

describe("the Testing view: one row per selected check, in order", () => {
  it("is Verified with only passed rows, the command as approved and the passed count from the evidence", () => {
    const v = view({ evidence: pack([{ tests: { total: 37, passed: 37, failed: 0, skipped: 0, errored: 0, newTests: [], names: [] } }, { checkId: "lint", kind: "lint", label: "lint" }]) });
    expect(v).toMatchObject({ result: "verified", reasons: [] });
    expect(v.rows).toEqual([
      { label: "Unit tests", command: "pytest -q", status: "passed", passedTests: 37 },
      { label: "Lint", command: "ruff check .", status: "passed" },
    ]);
    expect(TestingViewSchema.safeParse(v).success).toBe(true);
  });

  it("is Partially verified when the planned full run is pending or was not run, as a last row with its fixed reason", () => {
    expect(view({ planned: { fullSuite: "pending" } })).toMatchObject({ result: "partially_verified", reasons: ["full_suite_pending"] });
    expect(view({ planned: { fullSuite: "pending" } }).rows.at(-1)).toEqual({ label: "Full test suite", command: "all tests", status: "pending", reason: "full_suite_pending" });
    expect(view({ planned: { fullSuite: "not_run" } }).rows.at(-1)).toMatchObject({ status: "not_run", reason: "full_suite_not_run" });
  });

  it("marks a row already failing only when the nightly or maintainers' set covers every failing test; otherwise the code failed", () => {
    const failing = workflow(results(check("unit", "FAILED"), check("lint", "PASS")));
    const evidence = pack([{ after: "failed", class: "already_failing", tests: testsOf(["t::a"]) }, { checkId: "lint", kind: "lint", label: "lint" }]);
    const covered = view({ workflow: failing, evidence, alreadyFailing: ["t::a"] });
    expect(covered).toMatchObject({ result: "partially_verified", reasons: ["known_failing_only"] });
    expect(covered.rows[0]).toEqual({ label: "Unit tests", command: "pytest -q", status: "known_failing", reason: "known_failing_only" });
    // Not on the list (no usable nightly, or a different test): the code's fault, the row says so (owner decision M2).
    const uncovered = view({ workflow: failing, evidence, alreadyFailing: [] });
    expect(uncovered).toMatchObject({ result: "code_failed", reasons: ["new_failing_test", "fails_on_original_code"] });
    expect(uncovered.rows[0]).toMatchObject({ status: "failed", reason: "new_failing_test" });
    // Y failed on the old code too, Z is newly failing: Code failed, not Blocked by environment.
    const yz = pack([{ after: "failed", class: "already_failing", tests: testsOf(["Y", "Z"]) }, { checkId: "lint", kind: "lint", label: "lint" }]);
    expect(view({ workflow: failing, evidence: yz, alreadyFailing: ["Y"] })).toMatchObject({ result: "code_failed" });
    expect(view({ workflow: failing, evidence: yz, alreadyFailing: ["Y", "Z"] })).toMatchObject({ result: "partially_verified" });
  });

  it("shows a regression as Code failed with a failed row, and a check that never started as blocked", () => {
    const regression = workflow(results(check("unit", "FAILED"), check("lint", "PASS")));
    const v = view({ workflow: regression, evidence: pack([{ after: "failed", class: "regression", tests: testsOf(["t::a"]) }, { checkId: "lint", kind: "lint", label: "lint" }]) });
    expect(v.result).toBe("code_failed");
    expect(v.rows[0]).toMatchObject({ status: "failed", reason: "check_failed" });
    const never = workflow({ stage: "VERIFY", ...results(check("unit", "PASS"), check("lint", "FAILED", { neverStarted: true })) }, "BLOCKED");
    expect(view({ workflow: never })).toMatchObject({ result: "blocked_by_environment" });
    expect(view({ workflow: never }).rows[1]).toMatchObject({ status: "blocked", reason: "check_could_not_start" });
  });

  it("a blocked task with no result for a check lists it as blocked by the result's environment reason, and is not decided while a retry is still coming", () => {
    const v = view({ workflow: STUCK(), evidence: undefined });
    expect(v.result).toBe("blocked_by_environment");
    expect(v.rows.map((row) => [row.status, row.reason])).toEqual([["blocked", "check_runner_failed"], ["blocked", "check_runner_failed"]]);
    const coming = testingViewOf({ workflow: STUCK(), facts: {}, budget: { ...budget, enabled: true, dayBudgetHasRoom: true }, evidence: undefined, alreadyFailing: [] });
    expect(coming).toEqual({ waiting: "retry_pending" });
  });

  it("is never a view the contract refuses: a verified result with no row to show returns nothing", () => {
    const none = workflow({ checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] } });
    expect(testingViewOf({ workflow: none, facts: {}, budget, evidence: pack(), alreadyFailing: [] })).toEqual({ waiting: "unreadable" });
  });

  it("redacts and cuts a command, strips hidden characters, and never stores the invisible marks inertness adds", () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const secret = workflow({ checkPolicy: policy(["unit", "Unit tests‮", "run", [`--token=${token}`, "x".repeat(300)]]), ...results(check("unit", "PASS")) });
    const v = view({ workflow: secret, evidence: pack([{}]) });
    expect(v.rows[0]!.command.includes(token)).toBe(false);
    expect(Array.from(v.rows[0]!.command).length).toBeLessThanOrEqual(120);
    expect(v.rows[0]!.label).toBe("Unit tests");
    expect(JSON.stringify(v)).not.toMatch(/[‍‮]/u);
  });

  it("a pack for other code changes the result (Partially verified: details missing), never a worker's word", () => {
    const other = { ...pack(), candidateDigest: "9".repeat(64) };
    expect(view({ evidence: other })).toMatchObject({ result: "partially_verified", reasons: ["evidence_missing"] });
  });
});

describe("the pull request's Testing section", () => {
  const many = (): TestingView => {
    const checks = Array.from({ length: 40 }, (_, n) => ({ id: `c${String(n)}`, label: `Check number ${String(n)} @team #123`, command: command("run-all-the-things", ["--flag", "x".repeat(100)]) }));
    const rows = checks.map((entry, n) => (n === 39 ? check(entry.id, "FAILED", { neverStarted: true }) : check(entry.id, "PASS")));
    return view({ workflow: workflow({ stage: "VERIFY", checkPolicy: { required: checks, optional: [], selectedOptionalIds: [], proposed: [] }, ...results(...rows) }, "BLOCKED"), evidence: pack([{ checkId: "c0" }]), planned: { fullSuite: "pending" } });
  };

  it("starts with the heading and the result line, then a table of every check with fixed words", () => {
    const lines = testingSectionLines(view({ planned: { fullSuite: "pending" } }), 0, ["- Tested on head commit 11111111"]);
    expect(lines[0]).toBe("## Testing — Partially verified");
    expect(lines[1]).toBe("Result: everything that ran passed; 1 check did not run yet.");
    expect(lines).toContain("| Check | Command | Result |");
    expect(lines.some((line) => line.includes("⏳ pending: the full suite has not finished yet"))).toBe(true);
    expect(lines).toContain("- Tested on head commit 11111111");
  });

  it("makes every label and command inert: no mention, cross-reference, link or table break", () => {
    const lines = testingSectionLines(many(), 0);
    const text = lines.join("\n");
    expect(text).not.toMatch(/@team/u);
    expect(text).toContain("@‍team");
    expect(text).not.toMatch(/#123/u);
    for (const row of lines.filter((line) => line.startsWith("| Check number"))) expect(row.split("|").length).toBe(5);
  });

  it("keeps the result and every blocked or not-run row at levels 0 to 4, and folds passed rows from level 2", () => {
    const v = many();
    for (let level = 0; level <= 4; level += 1) {
      const lines = testingSectionLines(v, level);
      expect(lines[0], `level ${String(level)}`).toBe("## Testing — Blocked by environment");
      expect(lines[1]).toMatch(/^Result: /u);
      expect(lines.some((line) => line.includes("Check number 39") && line.includes("⛔ blocked")), `blocked row at ${String(level)}`).toBe(true);
      expect(lines.some((line) => line.includes("Full test suite") && line.includes("pending")), `pending row at ${String(level)}`).toBe(true);
      const passedRows = lines.filter((line) => line.includes("✅")).length;
      if (level < 2) expect(passedRows).toBe(39);
      else {
        expect(passedRows).toBe(0);
        expect(lines.some((line) => /^39 more checks passed/u.test(line))).toBe(true);
      }
    }
  });

  it("is smaller at each level (the description can shrink to fit its byte cap)", () => {
    const sizes = [0, 1, 2, 3, 4, 5].map((level) => Buffer.byteLength(testingSectionLines(many(), level).join("\n")));
    for (let level = 1; level < sizes.length; level += 1) expect(sizes[level]!).toBeLessThanOrEqual(sizes[level - 1]!);
    expect(sizes[5]!).toBeLessThan(sizes[0]!);
    expect(sizes[4]!).toBeLessThan(sizes[3]!);
  });

  it("says each reason only in its fixed sentence", () => {
    const v = view({ workflow: STUCK(), evidence: undefined });
    expect(testingSectionLines(v, 0).join("\n")).toContain(TESTING_REASON_TEXT.check_runner_failed);
  });
});

describe("the whole description with the view", () => {
  const reviews = () => ["Reviews: code review passed; security review passed"];
  const body = (context: PullRequestBodyContext) => rovaraStatusLines(workflow(), context, reviews);

  // The block as the builder at the base of this lane (f759be005) wrote it for this workflow and these reviews, taken from that commit and pinned here: with `vx` off no view is built, and the block must be these lines.
  const TODAYS_BLOCK = [
    "## What changed", "Rovara couldn't list the changed files.", "",
    "## Tests", "- Tested on head commit 11111111", "- Passed: Unit tests; Lint", "- Tests added: Rovara couldn't list the changed files, so it can't say.", "",
    "## Reviews", "Reviews: code review passed; security review passed", "",
    "## Risk: Medium", "- Rovara couldn't list every changed file.",
  ];

  it("is exactly what the builder wrote before this lane while the view is absent (vx off): the same lines, and the same with the field set to undefined", () => {
    expect(body({})).toEqual(TODAYS_BLOCK);
    expect(body({ testing: undefined })).toEqual(TODAYS_BLOCK);
    expect(body({}).join("\n")).not.toContain("Testing");
  });

  // L1 (Opus re-check): 64 blocked rows with multibyte labels and commands must still fit, with the result line, however the budget is set.
  const multibyte = (): TestingView => TestingViewSchema.parse({
    schemaVersion: 1, result: "blocked_by_environment", reasons: ["check_runner_failed"],
    rows: Array.from({ length: 64 }, (_, n) => ({ label: `\u691C\u67FB${String(n)} `.repeat(14).trim(), command: `\u5B9F\u884C ${String(n)} `.repeat(14).trim().slice(0, 118), status: "blocked", reason: "check_runner_failed" })),
  });

  it("64 blocked multibyte rows fit the default budget and a tight one, with the heading and the result line, down to counts at the last resort", () => {
    const v = multibyte();
    expect(Buffer.byteLength(testingSectionLines(v, 0).join("\n"))).toBeGreaterThan(15_000);
    for (const budget of [22_000, 12_000, 9_000, 4_000]) {
      const lines = rovaraStatusLines(workflow(), { testing: v }, reviews, budget);
      expect(Buffer.byteLength(lines.join("\n")), `budget ${String(budget)}`).toBeLessThanOrEqual(budget);
      const text = lines.join("\n");
      expect(text).toContain("## Testing \u2014 Blocked by environment");
      expect(text).toContain("Result: 64 checks could not give a result because of the test environment.");
    }
    const tight = rovaraStatusLines(workflow(), { testing: v }, reviews, 4_000).join("\n");
    expect(tight).toContain("- 64 checks blocked: the check runner failed");
    expect(tight).toContain("Every check, with its command, is listed on the task page.");
    // At level 4 the labels are cut to about 40 characters.
    const level4 = testingSectionLines(v, 4).filter((line) => line.startsWith("| "))[2]!;
    expect(Array.from(level4.split("|")[1]!.trim()).length).toBeLessThanOrEqual(40);
  });

  it("with the view, replaces ## Tests by ## Testing and keeps the tested commit and tests-added lines", () => {
    const lines = body({ testing: view() });
    expect(lines).not.toContain("## Tests");
    expect(lines).toContain("## Testing — Verified");
    expect(lines.join("\n")).toContain("- Tested on head commit 11111111");
    expect(lines.join("\n")).toContain("- Tests added:");
    expect(lines.join("\n")).not.toContain("- Passed:");
  });

  it("fits a tiny budget by shrinking the table and never drops a blocked row or the result", () => {
    const checks = Array.from({ length: 40 }, (_, n) => ({ id: `c${String(n)}`, label: `Check number ${String(n)}`, command: command("run-all-the-things", ["--flag", "x".repeat(100)]) }));
    const rows = checks.map((entry, n) => (n === 39 ? check(entry.id, "FAILED", { neverStarted: true }) : check(entry.id, "PASS")));
    const flow = workflow({ stage: "VERIFY", checkPolicy: { required: checks, optional: [], selectedOptionalIds: [], proposed: [] }, ...results(...rows) }, "BLOCKED");
    const v = view({ workflow: flow, evidence: pack([{ checkId: "c0" }]) });
    const text = rovaraStatusLines(flow, { testing: v }, reviews, 3_000).join("\n");
    expect(text).toContain("## Testing — Blocked by environment");
    expect(text).toContain("Check number 39");
    expect(text).toContain("more checks passed");
  });

  it("the Proof section's first line is the same result when there is one", () => {
    // No plan with claims here, so the Proof section is absent: only the Testing section carries the result.
    expect(body({ testing: view() }).filter((line) => line.startsWith("Result: ")).length).toBe(1);
  });
});
