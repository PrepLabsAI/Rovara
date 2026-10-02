// Spec 051 Task 5 (FR-008): the pull request's checks section is deterministic text, and only a regression is a draft.
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE_VERSION,
  agentxPreambleSha256,
  checkOutputTail,
  checksForSection,
  checksMakeDraft,
  checksSection,
  nextStandingFailures,
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
      "- `npm test`: passed → failed, regression (passed at preparation, fails now)",
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

  // Ruling Y (C-1): AgentX cannot tell that a check the agent's own task found failing was not the agent's doing, so it
  // is a draft; a project check that publish reran and found passing is left out (publish judges those itself).
  it("notes a check the task found already failing, and makes a draft", () => {
    const already = entry({ label: "make lint", before: "failed", after: "failed", class: "already_failing", output: "" });
    const latest = report({ checks: [already] });
    expect(checksSection(undefined, latest)).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check still fails.**",
      "",
      "After the last task, AgentX reran the project's checks:",
      "- `make lint`: failed → failed, already failing before this change",
      "",
      "### Output: `make lint` (after the last task)",
      "",
      "```text",
      "(no output)",
      "```",
    ].join("\n"));
    expect(checksMakeDraft(undefined, latest)).toBe(true);
    expect(checksMakeDraft([entry({ label: "make lint" })], latest)).toBe(false);
  });

  // Ruling S: the pull request is the whole change since preparation, so any failing check at publish is a draft.
  it("makes any check failing at publish a draft, and words one with no earlier result as such", () => {
    const unprepared = entry({ label: "make lint", before: "unknown", after: "failed", class: "failing_no_before", output: "lint error" });
    expect(checksSection([unprepared], undefined)).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check fails at publish.**",
      "",
      "At publish, AgentX reran the project's checks:",
      "- `make lint`: unknown → failed, fails now, with no earlier result",
      "",
      "### Output: `make lint` (at publish)",
      "",
      "```text",
      "lint error",
      "```",
    ].join("\n"));
    expect(checksMakeDraft([unprepared], undefined)).toBe(true);
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

  it("says when the last task was not verified", () => {
    const head = "## Checks\n\nNo check that passed before this change fails now.\n\n";
    expect(checksSection(undefined, report({ status: "not_verified", notVerifiedReason: "no_checks", source: "none" })))
      .toBe(`${head}After the last task: Not verified (no checks ran).`);
    expect(checksSection(undefined, report({ status: "not_verified", notVerifiedReason: "stopped", source: "none" })))
      .toBe(`${head}After the last task: Not verified (the task stopped before AgentX could check it).`);
    expect(checksSection(undefined, report({ status: "not_verified", checks: [entry({ after: "not_run", class: "not_rerun" })] })))
      .toBe(`${head}After the last task: Not verified. AgentX could not rerun the project's checks:\n- \`npm test\`: passed → not run, not rerun`);
  });

  // Ruling T: a task that ended without a report leaves a marker, never an older report.
  it.each([
    ["failed", "the task failed"],
  ] as const)("says Not verified for a task that %s", (reason, text) => {
    const marker = { status: "not_verified", reason } as const;
    expect(checksSection([entry({})], marker)).toBe([
      "## Checks",
      "",
      "No check that passed before this change fails now.",
      "",
      `After the last task: Not verified (${text}).`,
      "",
      "At publish, AgentX reran the project's checks:",
      "- `npm test`: passed → passed, passing",
    ].join("\n"));
    expect(checksMakeDraft([entry({})], marker)).toBe(false);
  });

  // Ruling AA (amends T): a latest cancelled or interrupted task makes a draft until a later report replaces it.
  it.each([["cancelled"], ["interrupted"]] as const)("makes a draft with a Not verified line when the last task was %s (Ruling AA)", (reason) => {
    const marker = { status: "not_verified", reason } as const;
    expect(checksMakeDraft(undefined, marker)).toBe(true);
    expect(checksSection([entry({})], marker)).toBe([
      "## Checks",
      "",
      `**This pull request is a draft: Not verified: the last task was ${reason}.**`,
      "",
      `After the last task: Not verified (the task was ${reason}).`,
      "",
      "At publish, AgentX reran the project's checks:",
      "- `npm test`: passed → passed, passing",
    ].join("\n"));
    // A later task's report replaces the marker and clears the draft.
    expect(checksMakeDraft(undefined, report({ status: "verified" }))).toBe(false);
    expect(checksSection([entry({})], report({ checks: [entry({})] }))).toContain("No check that passed before this change fails now.");
  });

  it("does not make a draft for failed or no_report alone (Ruling AA)", () => {
    expect(checksMakeDraft(undefined, { status: "not_verified", reason: "failed" })).toBe(false);
    expect(checksMakeDraft(undefined, { status: "not_verified", reason: "no_report" })).toBe(false);
    expect(checksSection(undefined, { status: "not_verified", reason: "no_report" })).toBe("");
  });

  it("words a project regression that publish reran and found passing as such, and keeps the draft (R-3)", () => {
    const standing = [{ label: "npm test", source: "project" as const, class: "regression" as const }];
    const marker = { status: "not_verified", reason: "failed" } as const;
    expect(checksMakeDraft([entry({})], marker, standing)).toBe(true);
    expect(checksSection([entry({})], marker, undefined, standing)).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check regressed in the last task and passes at publish.**",
      "",
      "After the last task: Not verified (the task failed).",
      "",
      "Still failing from earlier tasks:",
      "- `npm test`: regressed in the last task, passes at publish",
      "",
      "At publish, AgentX reran the project's checks:",
      "- `npm test`: passed → passed, passing",
    ].join("\n"));
  });

  it("keeps the description as before for a worker that sends no report, unless a check fails", () => {
    const marker = { status: "not_verified", reason: "no_report" } as const;
    expect(checksSection([entry({})], marker)).toBe("");
    expect(checksSection([entry({ after: "failed", class: "regression" })], marker))
      .toContain("After the last task: Not verified (the worker sent no check report).");
  });

  it("makes a draft for a failing publish check or a regression report (Rulings C, S)", () => {
    expect(checksMakeDraft(undefined, undefined)).toBe(false);
    expect(checksMakeDraft(undefined, report({ checks: [entry({ before: "unknown", after: "failed", class: "failing_no_before" })] }))).toBe(true);
    expect(checksMakeDraft([entry({ after: "failed", class: "regression" })], undefined)).toBe(true);
    expect(checksMakeDraft(undefined, report({ status: "regression" }))).toBe(true);
    expect(checksMakeDraft(undefined, report({ status: "verified" }))).toBe(false);
  });

  it("makes a draft for a standing failure, whatever the latest report is, and lists it (Ruling Y)", () => {
    const standing = [{ label: "pytest -k a", source: "agent_commands" as const, class: "regression" as const }];
    const none = report({ status: "not_verified", notVerifiedReason: "no_checks", source: "none" });
    expect(checksMakeDraft(undefined, none)).toBe(false);
    expect(checksMakeDraft(undefined, none, standing)).toBe(true);
    expect(checksMakeDraft(undefined, { status: "not_verified", reason: "failed" }, standing)).toBe(true);
    expect(checksSection(undefined, none, undefined, standing)).toBe([
      "## Checks",
      "",
      "**This pull request is a draft: a check that passed before this change fails now.**",
      "",
      "After the last task: Not verified (no checks ran).",
      "",
      "Still failing from earlier tasks:",
      "- `pytest -k a`: still fails, regression",
    ].join("\n"));
    // A failure the latest report also shows is listed once, there (its line and its output).
    const shown = report({ source: "agent_commands", checks: [entry({ label: "pytest -k a", source: "agent_commands", before: "failed", after: "failed", class: "already_failing" })] });
    expect(checksSection(undefined, shown, undefined, standing).match(/pytest -k a/g)).toHaveLength(2);
    expect(checksSection(undefined, shown, undefined, standing)).not.toContain("Still failing from earlier tasks");
  });

  it("tracks standing failures: a report clears what passes, adds what fails, and a marker keeps them (Ruling Y)", () => {
    const failing = (label: string, checkClass: CheckEntry["class"]) => entry({ label, source: "agent_commands", after: "failed", class: checkClass });
    const first = nextStandingFailures([], report({ source: "agent_commands", checks: [failing("a", "regression"), failing("b", "failing_no_before"), entry({ label: "c", source: "agent_commands" })] }));
    expect(first).toEqual([
      { label: "a", source: "agent_commands", class: "regression" },
      { label: "b", source: "agent_commands", class: "failing_no_before" },
    ]);
    expect(nextStandingFailures(first, { status: "not_verified", reason: "cancelled" })).toEqual(first);
    // "a" now reads as already failing, and stays a regression; "b" passes and clears.
    const second = nextStandingFailures(first, report({ source: "agent_commands", checks: [failing("a", "already_failing"), entry({ label: "b", source: "agent_commands", before: "failed", class: "fixed" })] }));
    expect(second).toEqual([{ label: "a", source: "agent_commands", class: "regression" }]);
    expect(nextStandingFailures(second, report({ source: "agent_commands", checks: [entry({ label: "a", source: "agent_commands", before: "failed", class: "fixed" })] }))).toEqual([]);
  });

  it("shows the last 40 lines of output, within a fence its backticks cannot close", () => {
    const output = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(checkOutputTail(output).split("\n")).toEqual(Array.from({ length: 40 }, (_, index) => `line ${index + 11}`));
    const section = checksSection([entry({ label: "a `b` c", after: "failed", class: "regression", output: "```\nboom" })], undefined);
    expect(section).toContain("- ``a `b` c``: passed → failed, regression (passed at preparation, fails now)");
    expect(section).toContain("````text\n```\nboom\n````");
  });

  it("puts a label on one line, cut to 200 characters", () => {
    const section = checksSection([entry({ label: `npm test\n${"x".repeat(300)}`, after: "failed", class: "regression" })], undefined);
    const line = section.split("\n").find((text) => text.startsWith("- "))!;
    expect(line).toBe(`- \`npm test ${"x".repeat(190)}…\`: passed → failed, regression (passed at preparation, fails now)`);
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

  it("stores a report with outputs cut to the section's tail, 48,000 characters in all", () => {
    const one = checksForSection(report({ checks: [entry({ output: "q".repeat(10_000) })] }));
    expect("checks" in one && one.checks[0]!.output).toBe("q".repeat(4_000));
    const many = checksForSection(report({ checks: Array.from({ length: 64 }, (_, index) => entry({ id: `readiness:${index}`, output: "q".repeat(10_000) })) }));
    expect("checks" in many && many.checks[0]!.output).toBe("q".repeat(750));
    expect(checksForSection({ status: "not_verified", reason: "failed" })).toEqual({ status: "not_verified", reason: "failed" });
  });
});
