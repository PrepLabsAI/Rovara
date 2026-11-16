// General fakes slice 2 (DEC 234; review M1): every place that says a recorded check "passed" says so with the Made by Rovara words when a Rovara-made fake answered it. The Proof section already did; these are
// the Tests section's "Passed:" line, both "Checks:" status lines, the task page's proof row, and the chat message. Unlabelled results read exactly as before (golden).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { GENERAL_FAKE_MADE_NOTE } from "../../packages/contracts/src/general-fakes.js";
import { verificationReport } from "../../packages/broker/src/core/proof/verification-report.js";
import { workflowPullRequestStatusLines } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { workflowPullRequestStatusLines as awsStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";
import { proofReportOf } from "../../packages/broker/src/local/app/proof-report.js";
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
});
