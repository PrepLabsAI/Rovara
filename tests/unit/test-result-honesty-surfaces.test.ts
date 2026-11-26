// TEST-RESULT-HONESTY: the words every summary of a check uses. A pass that skipped tests never reads "Checks passed"; a run in which every test was skipped is "not tested"; a failure that looks like a missing service says what it
// looks like it needs (a hint). The outputs are the runners' real final lines.
import { describe, expect, it } from "vitest";
import { AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, checkResultNote, checksReplyPrefix, checksSection, opensWithTestResult, type CheckEntry, type CheckReport } from "../../packages/contracts/src/index.js";
import { renderEvent } from "../../packages/broker/src/plugins/channel/slack/format.js";
import { testResultNotTested } from "../../packages/broker/src/core/proof/test-result-items.js";

const PYTEST_SOME = "tests/test_db.py ss\n========================= 3 passed, 4 skipped in 0.42s =========================\n";
const PYTEST_ALL = "tests/test_db.py sssss\n============================== 5 skipped in 0.11s ==============================\n";
const JEST_SOME = "Test Suites: 1 skipped, 2 passed, 2 of 3 total\nTests:       4 skipped, 6 passed, 10 total\n";
const VITEST_ALL = " Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n";
const GO_SOME = "--- PASS: TestUsers (0.00s)\n--- SKIP: TestDB (0.00s)\nPASS\nok  \texample.com/app\t0.003s\n";
const PG_REFUSED = 'psycopg2.OperationalError: could not connect to server: Connection refused\n\tIs the server running on host "localhost" (127.0.0.1) and accepting\n\tTCP/IP connections on port 5432?\n';
const TAIL = "\n\n*Agent's account:*\n";

const entry = (overrides: Partial<CheckEntry>): CheckEntry => ({ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "9 passed in 0.4s", durationMs: 10, ...overrides });
const report = (checks: CheckEntry[], overrides: Partial<CheckReport> = {}): CheckReport => ({
  status: "verified", source: "project", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(), checks, extraTry: "not_needed", agentClaim: "success", ...overrides,
});

describe("the reply to the person", () => {
  it("says Passed, N tests skipped, never Checks passed, for each runner", () => {
    expect(checksReplyPrefix([report([entry({ output: PYTEST_SOME })])])).toBe(`Passed, 4 tests skipped (1 project check).${TAIL}`);
    expect(checksReplyPrefix([report([entry({ output: JEST_SOME })])])).toBe(`Passed, 4 tests skipped (1 project check).${TAIL}`);
    expect(checksReplyPrefix([report([entry({ output: GO_SOME })])])).toBe(`Passed, 1 test skipped (1 project check).${TAIL}`);
    expect(checksReplyPrefix([report([entry({ output: PYTEST_SOME, source: "agent_commands" })], { source: "agent_commands" })]))
      .toBe(`Passed, 4 tests skipped (1 of the agent's own test commands, rerun by AgentX).${TAIL}`);
  });
  it("adds the skips of several checks", () => {
    const two = [entry({ output: PYTEST_SOME }), entry({ id: "readiness:1", label: "jest", output: JEST_SOME })];
    expect(checksReplyPrefix([report(two)])).toBe(`Passed, 8 tests skipped (2 project checks).${TAIL}`);
  });
  it("keeps the plain pass when nothing was skipped", () => {
    expect(checksReplyPrefix([report([entry({})])])).toBe(`Checks passed (1 project check).${TAIL}`);
  });
  it("a run in which every test was skipped is not tested", () => {
    expect(checksReplyPrefix([report([entry({ output: PYTEST_ALL })])])).toBe(`Not tested: every test was skipped (1 project check).${TAIL}`);
    expect(checksReplyPrefix([report([entry({ output: VITEST_ALL })])])).toContain("Not tested: every test was skipped");
    expect(checksReplyPrefix([report([entry({ output: PYTEST_ALL })])])).not.toContain("Checks passed");
  });
  it("one check that tested nothing among others is named, and the count excludes it", () => {
    const two = [entry({ output: PYTEST_ALL }), entry({ id: "readiness:1", label: "lint", output: "ok" })];
    expect(checksReplyPrefix([report(two)])).toBe(`Checks: 1 of 2 pass.\nNot tested: every test was skipped: pytest -q.${TAIL}`);
  });
  it("skips in a failing check are not reported as a pass, and a missing Postgres is a hint on the failure", () => {
    const failing = report([entry({ class: "failing_no_before", before: "unknown", after: "failed", output: PG_REFUSED })]);
    expect(checksReplyPrefix([failing])).toBe(`No regression found, but no check passes yet.\nFails now, with no earlier result: pytest -q.\npytest -q: looks like it needs Postgres: Rovara didn't start one.${TAIL}`);
    const regression = report([entry({ class: "regression", after: "failed", output: "Error: connect ECONNREFUSED 127.0.0.1:6379" })], { status: "regression" });
    expect(checksReplyPrefix([regression])).toBe(`Not done: pytest -q passed before and fails now.\npytest -q: looks like it needs Redis: Rovara didn't start one.${TAIL}`);
  });
  it("a plain failure says nothing about a service", () => {
    const failing = report([entry({ class: "failing_no_before", before: "unknown", after: "failed", output: "AssertionError: 3 != 4" })]);
    expect(checksReplyPrefix([failing])).not.toContain("needs");
  });
});

describe("the pull request's Checks section", () => {
  const section = (checks: CheckEntry[]) => checksSection([], report(checks));
  it("each line says what was skipped or that nothing was tested", () => {
    expect(section([entry({ output: PYTEST_SOME })])).toContain("- `pytest -q`: passed → passed, passing, 4 tests skipped");
    expect(section([entry({ output: PYTEST_ALL })])).toContain("- `pytest -q`: passed → passed, passing, not tested, every test was skipped");
    expect(section([entry({ output: GO_SOME })])).toContain("passing, 1 test skipped");
  });
  it("a failing check that looks like a missing service says so on its line", () => {
    const text = section([entry({ after: "failed", class: "regression", output: PG_REFUSED })]);
    expect(text).toContain("regression, looks like it needs Postgres: Rovara didn't start one");
  });
  it("a plain pass is unchanged", () => {
    expect(section([entry({})])).toContain("- `pytest -q`: passed → passed, passing");
    expect(section([entry({})])).not.toContain("skipped");
  });
});

describe("the Slack check report", () => {
  const event = (text: string, status: "passed" | "failed" | "unknown") => ({ type: "check_report", data: { text, status, checks: [] } }) as never;
  it("is not led by Checks passed when it opens with its own result", () => {
    expect(renderEvent(event("Passed, 4 tests skipped (1 project check).", "passed"), 4000)).toEqual({ text: "Passed, 4 tests skipped (1 project check)." });
    expect(renderEvent(event("Not tested: every test was skipped (1 project check).", "passed"), 4000)).toEqual({ text: "Not tested: every test was skipped (1 project check)." });
    expect(renderEvent(event("Checks passed (1 project check).", "passed"), 4000)).toEqual({ text: "Checks passed. Checks passed (1 project check)." });
    expect(opensWithTestResult("Checks: 1 of 2 pass.")).toBe(false);
  });
});

describe("the evidence pack's not-tested items", () => {
  it("lists a check that tested nothing as a check, skipped tests apart, and a missing service once", () => {
    const items = testResultNotTested([
      entry({ output: PYTEST_ALL }),
      entry({ id: "readiness:1", label: "jest", output: JEST_SOME }),
      entry({ id: "readiness:2", label: "api", after: "failed", class: "failing_no_before", output: PG_REFUSED }),
      entry({ id: "readiness:3", label: "db", after: "failed", class: "failing_no_before", output: PG_REFUSED }),
      entry({ id: "readiness:4", label: "plain", output: "ok" }),
    ]);
    expect(items).toEqual([
      { kind: "check", id: "skipped:readiness:0", text: "pytest -q: every test was skipped", reason: "not tested" },
      { kind: "not_selected", id: "skipped:readiness:1", text: "4 tests skipped in jest", reason: "skipped, not run" },
      { kind: "environment", id: "needs_postgres", text: "A check looks like it needs Postgres: Rovara didn't start one", reason: "service not available" },
    ]);
  });
  it("reads skips only from a check that passed, and a missing service only from one that failed", () => {
    const failed = entry({ after: "failed", class: "failing_no_before", output: `${PYTEST_SOME}${PG_REFUSED}` });
    expect(checkResultNote(failed).skipped).toBeUndefined();
    expect(checkResultNote(failed).needs).toEqual(["Postgres"]);
    expect(testResultNotTested([failed]).map((item) => item.id)).toEqual(["needs_postgres"]);
    const timedOut = entry({ after: "unknown", class: "not_rerun", output: PYTEST_ALL });
    expect(checkResultNote(timedOut)).toEqual({ needs: [] });
    const passed = entry({ output: `${PYTEST_SOME}${PG_REFUSED}` });
    expect(checkResultNote(passed)).toEqual({ skipped: { skipped: 4, all: false }, needs: [] });
  });
  it("flattens a label that holds control characters", () => {
    expect(testResultNotTested([entry({ label: "pytest‮\n-q", output: PYTEST_ALL })])[0]?.text).toBe("pytest -q: every test was skipped");
  });
});
