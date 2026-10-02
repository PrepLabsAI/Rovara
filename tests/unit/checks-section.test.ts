// Spec 051 Task 5 (FR-008): the pull request's checks section is deterministic text, and only a regression is a draft.
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE_VERSION,
  agentxPreambleSha256,
  checkOutputTail,
  checksForSection,
  checksMakeDraft,
  checksSection,
  type CheckEntry,
  type CheckReport,
} from "@agentx/contracts";

const entry = (overrides: Partial<CheckEntry>): CheckEntry => ({
  id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing",
  output: "ok", durationMs: 10, ...overrides,
});
const report = (overrides: Partial<CheckReport>): CheckReport => ({
  status: "verified", source: "project", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
  checks: [], extraTry: "not_needed", agentClaim: "success", ...overrides,
});

describe("checksSection (FR-008)", () => {
  it("is empty with no report and every publish check passing (Review Focus 5)", () => {
    expect(checksSection(undefined, undefined)).toBe("");
    expect(checksSection([], undefined)).toBe("");
    expect(checksSection([entry({}), entry({ id: "readiness:1", before: "failed", class: "fixed" })], undefined)).toBe("");
  });

  it("lists passing checks after a verified task", () => {
    const latest = report({ source: "agent_commands", checks: [entry({ id: "agent:0", label: "pytest -k x", source: "agent_commands", before: "unknown" })] });
    expect(checksSection([entry({})], latest)).toBe([
      "## Checks",
      "",
      "No check that passed before this change fails now.",
      "",
      "After the last task, AgentX reran the agent's own test commands:",
      "- `pytest -k x`: unknown → passed, passing",
      "",
      "At publish, AgentX reran the project's checks:",
      "- `npm test`: passed → passed, passing",
    ].join("\n"));
  });

  it("marks a regression as a draft and shows the failing output", () => {
    const failing = entry({ after: "failed", class: "regression", output: "FAIL test_a\n1 failed\n" });
    expect(checksSection([failing], report({ status: "regression", checks: [failing], extraTry: "given" }))).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check that passed before this change fails now.**",
      "",
      "After the last task, AgentX reran the project's checks:",
      "- `npm test`: passed → failed, regression",
      "",
      "At publish, AgentX reran the project's checks:",
      "- `npm test`: passed → failed, regression",
      "",
      "### Output: `npm test` (after the last task)",
      "",
      "```text",
      "FAIL test_a\n1 failed",
      "```",
      "",
      "### Output: `npm test` (at publish)",
      "",
      "```text",
      "FAIL test_a\n1 failed",
      "```",
    ].join("\n"));
  });

  it("notes an already-failing check without making a draft", () => {
    const already = entry({ label: "make lint", before: "failed", after: "failed", class: "already_failing", output: "" });
    expect(checksSection([already], undefined)).toBe([
      "## Checks",
      "",
      "No check that passed before this change fails now.",
      "",
      "At publish, AgentX reran the project's checks:",
      "- `make lint`: failed → failed, already failing before this change",
      "",
      "### Output: `make lint` (at publish)",
      "",
      "```text",
      "(no output)",
      "```",
    ].join("\n"));
    expect(checksMakeDraft([already], undefined)).toBe(false);
  });

  it("lists mixed checks, with a check that has no earlier result (Ruling C) and a timeout", () => {
    const checks = [
      entry({}),
      entry({ id: "readiness:1", label: "npm run lint", before: "unknown", after: "failed", class: "failing_no_before", output: "lint error" }),
      entry({ id: "readiness:2", label: "npm run e2e", before: "failed", after: "passed", class: "fixed" }),
      entry({ id: "readiness:3", label: "npm run slow", before: "passed", after: "timed_out", class: "regression", output: "readiness command 3 timed out after 600s" }),
      entry({ id: "readiness:4", label: "npm run big", before: "passed", after: "not_run", class: "not_rerun" }),
    ];
    expect(checksSection(undefined, report({ status: "regression", checks }))).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check that passed before this change fails now.**",
      "",
      "After the last task, AgentX reran the project's checks:",
      "- `npm test`: passed → passed, passing",
      "- `npm run lint`: unknown → failed, fails now, with no earlier result",
      "- `npm run e2e`: failed → passed, fixed",
      "- `npm run slow`: passed → timed out, regression",
      "- `npm run big`: passed → not run, not rerun",
      "",
      "### Output: `npm run lint` (after the last task)",
      "",
      "```text",
      "lint error",
      "```",
      "",
      "### Output: `npm run slow` (after the last task)",
      "",
      "```text",
      "readiness command 3 timed out after 600s",
      "```",
    ].join("\n"));
  });

  it("says when the last task was not checked", () => {
    expect(checksSection(undefined, report({ status: "not_verified", notVerifiedReason: "no_checks", source: "none" }))).toBe(
      "## Checks\n\nNo check that passed before this change fails now.\n\nAfter the last task, no checks ran.",
    );
    expect(checksSection(undefined, report({ status: "not_verified", notVerifiedReason: "stopped", source: "none" }))).toBe(
      "## Checks\n\nNo check that passed before this change fails now.\n\n"
        + "After the last task, AgentX could not check the work: the task stopped before AgentX could check it.",
    );
  });

  it("makes a draft only for a regression (Ruling C)", () => {
    expect(checksMakeDraft(undefined, undefined)).toBe(false);
    expect(checksMakeDraft([entry({ before: "unknown", after: "failed", class: "failing_no_before" })], undefined)).toBe(false);
    expect(checksMakeDraft([entry({ after: "failed", class: "regression" })], undefined)).toBe(true);
    expect(checksMakeDraft(undefined, report({ status: "regression" }))).toBe(true);
    expect(checksMakeDraft(undefined, report({ status: "verified" }))).toBe(false);
  });

  it("shows the last 40 lines of output, within a fence its backticks cannot close", () => {
    const output = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(checkOutputTail(output).split("\n")).toEqual(Array.from({ length: 40 }, (_, index) => `line ${index + 11}`));
    const section = checksSection([entry({ label: "a `b` c", after: "failed", class: "regression", output: "```\nboom" })], undefined);
    expect(section).toContain("- ``a `b` c``: passed → failed, regression");
    expect(section).toContain("````text\n```\nboom\n````");
  });

  it("puts a label on one line, cut to 200 characters", () => {
    const section = checksSection([entry({ label: `npm test\n${"x".repeat(300)}`, after: "failed", class: "regression" })], undefined);
    const line = section.split("\n").find((text) => text.startsWith("- "))!;
    expect(line).toBe(`- \`npm test ${"x".repeat(190)}…\`: passed → failed, regression`);
  });

  it("stays within its limit: outputs are left out first, then lines, each with a note", () => {
    const checks = Array.from({ length: 64 }, (_, index) => entry({
      id: `readiness:${index}`, label: `check ${index} ${"y".repeat(150)}`, after: "failed", class: "regression", output: "z".repeat(5_000),
    }));
    const full = checksSection(checks, undefined, 1_000_000);
    expect(full.length).toBeGreaterThan(65_536);
    const capped = checksSection(checks, undefined, 30_000);
    expect(capped.length).toBeLessThanOrEqual(30_000);
    expect(capped).toMatch(/_AgentX left out \d+ check outputs to keep this description within GitHub's limit\._$/);
    expect(capped.split("\n").filter((text) => text.startsWith("- "))).toHaveLength(64);
    const tight = checksSection(checks, undefined, 2_000);
    expect(tight.length).toBeLessThanOrEqual(2_000);
    expect(tight).toContain("more checks to keep this description within GitHub's limit._");
    expect(tight).not.toContain("### Output");
    expect(checksSection(checks, undefined)).toBe(checksSection(checks, undefined));
  });

  it("stores a report with outputs cut to the section's tail", () => {
    const stored = checksForSection(report({ checks: [entry({ output: "q".repeat(10_000) })] }));
    expect(stored.checks[0]!.output).toBe("q".repeat(4_000));
  });
});
