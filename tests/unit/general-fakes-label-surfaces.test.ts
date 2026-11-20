// General fakes slice 2 (DEC 234; review M1): every place that says a recorded check "passed" says so with the Made by Rovara words when a Rovara-made fake answered it. The Proof section already did; these are
// the Tests section's "Passed:" line, both "Checks:" status lines, the task page's proof row, and the chat message. Unlabelled results read exactly as before (golden).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { GENERAL_FAKE_MADE_NOTE } from "../../packages/contracts/src/general-fakes.js";
import { verificationReport } from "../../packages/broker/src/core/proof/verification-report.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { workflowPullRequestStatusLines as awsStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";
import { proofReportOf } from "../../packages/broker/src/local/app/proof-report.js";
import { testingSectionLines } from "../../packages/broker/src/core/proof/testing-section.js";
import { checksReplyPrefix, AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, type CheckEntry } from "../../packages/contracts/src/index.js";
import { withStatusLines } from "../../packages/broker/src/developer/pull-request-feedback-section.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";

const now = "2026-11-16T12:00:00.000Z";
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const command = { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 };
function workflow(results: object[], over: Record<string, unknown> = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: randomUUID(), ownerId: "a".repeat(64), now, definitionVersion: "1.0.0" }),
    stage: "REVIEW", state: "WAITING", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command }, { id: "lint", label: "Lint", command }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results }, ...over,
  });
}
const made = workflow([{ checkId: "unit", status: "PASS", madeByRovara: true }, { checkId: "lint", status: "PASS" }]);
const plain = workflow([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }]);

describe("the label wherever a check is said to have passed", () => {
  it("the Tests section's lists carry it on the labelled check only", () => {
    expect(verificationReport(made, [], {}).passed).toEqual([{ label: `Unit tests (${GENERAL_FAKE_MADE_NOTE})` }, { label: "Lint" }]);
    expect(verificationReport(plain, [], {}).passed).toEqual([{ label: "Unit tests" }, { label: "Lint" }]);
    const failing = workflow([{ checkId: "unit", status: "FAILED", madeByRovara: true }, { checkId: "lint", status: "PASS" }]);
    expect(verificationReport(failing, [], {}).failed[0]!.label).toBe(`Unit tests (${GENERAL_FAKE_MADE_NOTE})`);
  });

  it("both Checks status lines (the PR body rewrite and the older copy) carry it", () => {
    for (const lines of [workflowPullRequestStatusLines(made, {}), awsStatusLines(made)]) {
      expect(lines.find((line) => line.startsWith("Checks:"))).toBe(`Checks: Unit tests passed (${GENERAL_FAKE_MADE_NOTE}), Lint passed`);
    }
    for (const lines of [workflowPullRequestStatusLines(plain, {}), awsStatusLines(plain)]) {
      expect(lines.find((line) => line.startsWith("Checks:"))).toBe("Checks: Unit tests passed, Lint passed");
    }
  });

  it("the task page's proof row says it", () => {
    const rows = proofReportOf({} as never, made, undefined).rows;
    expect(rows.find((row) => row.claim === "Unit tests")).toMatchObject({ status: "passed", detail: GENERAL_FAKE_MADE_NOTE });
    expect(rows.find((row) => row.claim === "Lint")).not.toHaveProperty("detail");
  });

  it("the chat message does not say plain 'All checks passed' when a fake answered one", () => {
    expect(workflowMessage({ taskId: "t", workflow: made })!.text).toContain(GENERAL_FAKE_MADE_NOTE);
    expect(workflowMessage({ taskId: "t", workflow: plain })!.text).not.toContain("Made by Rovara");
    expect(workflowMessage({ taskId: "t", workflow: plain })!.text).toBe("All 2 checks passed. Starting the code and security reviews.");
  });

  it("the other chat lines that say the checks passed carry it too", () => {
    const blockedReviews = (w: WorkflowSnapshot) => ({ ...w, state: "BLOCKED" as const, blockReason: "x" });
    expect(workflowMessage({ taskId: "t", workflow: blockedReviews(made) })!.text).toContain(`The checks passed (${GENERAL_FAKE_MADE_NOTE}`);
    expect(workflowMessage({ taskId: "t", workflow: blockedReviews(plain) })!.text).toMatch(/^The checks passed, but the reviews couldn't finish\./u);
    const publishing = (w: WorkflowSnapshot) => workflowMessage({ taskId: "t", workflow: { ...w, stage: "PULL_REQUEST" as const }, publishFailure: { category: "unknown" } })!.text;
    expect(publishing(made)).toContain(`Checks and reviews passed (${GENERAL_FAKE_MADE_NOTE}`);
    expect(publishing(plain)).toMatch(/^Checks and reviews passed, but I couldn't open/u);
  });

  it("the Testing section says it on the row, and never folds a labelled row into a plain count", () => {
    const row = (label: string, madeByRovara?: true) => ({ label, command: "npm test", status: "passed" as const, ...(madeByRovara === true ? { madeByRovara } : {}) });
    const view = { result: "verified" as const, rows: [row("unit", true), row("lint")] } as never;
    for (const level of [0, 1, 2, 3, 4]) {
      const text = testingSectionLines(view, level).join("\n");
      expect(text, `level ${String(level)}`).toContain(`passed (${GENERAL_FAKE_MADE_NOTE})`);
    }
    const minimal = testingSectionLines(view, 5).join("\n");
    expect(minimal).toContain("- 1 check passed");
    expect(minimal).toContain(`- 1 check passed (${GENERAL_FAKE_MADE_NOTE})`);
    // No label: exactly the old folded line.
    expect(testingSectionLines({ result: "verified", rows: [row("unit"), row("lint")] } as never, 2).join("\n")).toContain("2 more checks passed");
  });

  it("the Slack reply's headline counts labelled checks apart, in fixed words", () => {
    const entry = (id: string, extra: Partial<CheckEntry> = {}): CheckEntry => ({ id, label: id, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 1, ...extra });
    const report = (checks: CheckEntry[]) => ({ status: "verified" as const, source: "project" as const, preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(), checks, extraTry: "not_needed" as const, agentClaim: "success" as const });
    expect(checksReplyPrefix([report([entry("a", { madeByRovara: true }), entry("b")])])).toContain(`Checks passed (2 project checks; 1 ${GENERAL_FAKE_MADE_NOTE}).`);
    expect(checksReplyPrefix([report([entry("a", { madeByRovara: true }), entry("b"), entry("c", { class: "already_failing", after: "failed" })])])).toContain(`Checks: 2 of 3 pass (1 ${GENERAL_FAKE_MADE_NOTE}).`);
    expect(checksReplyPrefix([report([entry("a"), entry("b")])])).toBe("Checks passed (2 project checks).\n\n*Agent's account:*\n");
  });

  it("the pull request footer says it, and a labelled Checks line is still refreshed after a pushed fix", () => {
    for (const body of [workflowPullRequestBodyFooter(made), workflowPullRequestBodyFooter(plain)]) expect(typeof body).toBe("string");
    expect(workflowPullRequestBodyFooter(made)).toContain(`checks and reviews passed (${GENERAL_FAKE_MADE_NOTE}). Merge it on GitHub.`);
    expect(workflowPullRequestBodyFooter(plain)).toContain("checks and reviews passed. Merge it on GitHub.");
    const old = ["Checks: Lint passed, Unit tests passed (Made by Rovara, never change proof)", "Reviews: code review passed; security review passed"].join("\n");
    const next = withStatusLines(`Intro\n\n${old}\n\nOpened by me`, ["Checks: Unit tests passed, Lint passed", "Reviews: code review passed; security review passed"]);
    expect(next).toContain("Checks: Unit tests passed, Lint passed");
    expect(next).not.toContain("never change proof");
  });
});

const workflowPullRequestBodyFooter = (w: WorkflowSnapshot): string => workflowPullRequestBody({ title: "T" }, {
  ...w, reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
}, "# Plan\n", "https://rovara.example/review/x/task", {});
