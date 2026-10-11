import { describe, expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/index.js";
import { noticesOf } from "../../packages/broker/src/developer/notifications.js";

describe("the unreachable single-comment PR feedback path is gone", () => {
  it("exports no legacy feedback transitions or request schema", () => {
    for (const name of ["requestWorkflowFeedback", "decideWorkflowFeedback", "dismissDeletedWorkflowFeedback", "WorkflowFeedbackDecisionRequestSchema"]) {
      expect(Object.keys(contracts)).not.toContain(name);
    }
  });
  it("drops a stored legacy feedback field instead of validating it", () => {
    const snapshot = contracts.createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-07T12:00:00.000Z" });
    expect(contracts.WorkflowSnapshotSchema.parse({ ...snapshot, feedback: { feedbackId: "b".repeat(64) } })).not.toHaveProperty("feedback");
  });
  it("emits no legacy github_feedback notice for a feedback field", () => {
    const before = { entityType: "DEVELOPER_TASK", taskId: "t", workflow: { revision: 1, stage: "WAIT_FOR_MERGE", state: "WAITING" } };
    const after = { ...before, workflow: { ...before.workflow, feedback: { status: "PENDING", feedbackId: "f".repeat(64) } } };
    expect(noticesOf(before, after, "2026-10-07T12:00:00.000Z", "event-1").filter((notice) => notice.kind === "github_feedback")).toEqual([]);
  });
});
