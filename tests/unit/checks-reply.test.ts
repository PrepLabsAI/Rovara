// Spec 051 Task 6 (FR-009): the exact text that leads a Slack reply.
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, checksReplyPrefix, type CheckEntry, type CheckReport,
} from "@agentx/contracts";

const entry = (overrides: Partial<CheckEntry>): CheckEntry => ({
  id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing",
  output: "ok", durationMs: 10, ...overrides,
});
const report = (overrides: Partial<CheckReport>): CheckReport => ({
  status: "verified", source: "project", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
  checks: [], extraTry: "not_needed", agentClaim: "success", ...overrides,
});
const TAIL = "\n\n*Agent's account:*\n";

describe("checksReplyPrefix (FR-009)", () => {
  it("is empty with no report", () => {
    expect(checksReplyPrefix([])).toBe("");
  });

  it("names each regression", () => {
    const r = report({ status: "regression", checks: [
      entry({ label: "npm test", class: "regression", after: "failed" }),
      entry({ id: "readiness:1", label: "npm run lint", class: "regression", after: "failed" }),
    ] });
    const sentences = "Not done: npm test passed before and fails now.\nNot done: npm run lint passed before and fails now.";
    expect(checksReplyPrefix([r])).toBe(`${sentences}${TAIL}`);
  });

  it("counts project checks and the agent's own commands when verified", () => {
    const two = [entry({}), entry({ id: "readiness:1", label: "lint" })];
    expect(checksReplyPrefix([report({ checks: two })])).toBe(`Checks passed (2 project checks).${TAIL}`);
    expect(checksReplyPrefix([report({ checks: [entry({})] })])).toBe(`Checks passed (1 project check).${TAIL}`);
    expect(checksReplyPrefix([report({ source: "agent_commands", checks: [entry({ source: "agent_commands" })] })]))
      .toBe(`Checks passed (1 of the agent's own test commands, rerun by AgentX).${TAIL}`);
  });

  it("says why nothing was verified", () => {
    expect(checksReplyPrefix([report({ status: "not_verified", notVerifiedReason: "no_checks", source: "none" })]))
      .toBe(`Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.${TAIL}`);
    for (const reason of ["stopped", "error"] as const) {
      expect(checksReplyPrefix([report({ status: "not_verified", notVerifiedReason: reason })]))
        .toBe(`Not verified: the task stopped before AgentX could check it.${TAIL}`);
    }
  });

  it("adds already-failing and failing-with-no-earlier-result checks, and a verified report still leads with Checks passed", () => {
    const r = report({ checks: [
      entry({}),
      entry({ id: "readiness:1", label: "e2e", before: "failed", after: "failed", class: "already_failing" }),
      entry({ id: "readiness:2", label: "types", before: "unknown", after: "failed", class: "failing_no_before" }),
    ] });
    expect(checksReplyPrefix([r])).toBe(
      `Checks passed (1 project check).\nAlready failing before this change: e2e.\nFails now, with no earlier result: types.${TAIL}`,
    );
  });

  it("counts only passing and fixed checks as passed", () => {
    const r = report({ checks: [entry({ class: "fixed", before: "failed" }), entry({ id: "readiness:1", label: "types", before: "unknown", after: "failed", class: "failing_no_before" })] });
    expect(checksReplyPrefix([r])).toBe(`Checks passed (1 project check).\nFails now, with no earlier result: types.${TAIL}`);
    expect(checksReplyPrefix([report({ checks: [entry({ label: "types", before: "unknown", after: "failed", class: "failing_no_before" })] })]))
      .toBe(`No regression found, but no check passes yet.\nFails now, with no earlier result: types.${TAIL}`);
  });

  it("uses only the last report of a turn, so a stale verdict never leads", () => {
    const stale = report({ status: "regression", checks: [entry({ class: "regression", after: "failed" })] });
    const latest = report({ checks: [entry({})] });
    expect(checksReplyPrefix([stale, latest])).toBe(`Checks passed (1 project check).${TAIL}`);
    expect(checksReplyPrefix([latest, stale])).toBe(`Not done: npm test passed before and fails now.${TAIL}`);
  });
});
