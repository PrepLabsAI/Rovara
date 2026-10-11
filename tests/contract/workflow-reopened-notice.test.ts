// D3: a reopened pull request is named by its repository and number, so two repositories' pull requests that share a
// number are never confused.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, type WorkflowSnapshot } from "@agentx/contracts";
import { noticesOf } from "../../packages/broker/src/developer/notifications.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { visibleSlackText } from "../support/strict-slack.js";

const taskId = "11111111-2222-4333-8444-555555555555";
const pr = (repositoryId: string, state: string) => ({ repositoryId, number: 3, state, required: true, candidateDigest: "a".repeat(64), url: `https://github.com/example/${repositoryId}/pull/3` });

describe("a reopened pull request in a task with two repositories whose pull requests share a number", () => {
  it("the notice names the repository as well as the number, and the thread names only the one reopened", () => {
    const before = { stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestClosed, revision: 5, pullRequests: [pr("a", "OPEN"), pr("b", "CLOSED")] };
    const after = { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 6, pullRequests: [pr("a", "OPEN"), pr("b", "OPEN")] };
    const notices = noticesOf({ entityType: "DEVELOPER_TASK", taskId, workflow: before }, { entityType: "DEVELOPER_TASK", taskId, workflow: after }, "2026-10-11T12:00:00.000Z", "event-1");
    const notice = notices.find((entry) => entry.kind === "workflow")!;
    expect(notice).toMatchObject({ pullRequestReopened: true, reopenedPullRequests: [{ repositoryId: "b", number: 3 }] });
    const message = workflowMessage({ taskId, workflow: { ...after, path: "QUICK" } as unknown as WorkflowSnapshot, pullRequestReopened: notice.reopenedPullRequests });
    expect(visibleSlackText(message!.text)).toBe("PR #3 was reopened, so I'm following it again.");
    expect(message!.text).toContain("example/b/pull/3");
    expect(message!.text).not.toContain("example/a/pull/3");
  });
});
