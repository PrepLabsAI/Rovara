// I-3: what the Slack close form says closing does, for a task with several pull requests in different states.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, type WorkflowSnapshot } from "@agentx/contracts";
import { closeConfirmationText } from "../../packages/broker/src/aws/slack-interactivity.js";

const pr = (repositoryId: string, number: number, state: string, candidateDigest = "a".repeat(64)) => ({ repositoryId, number, state, required: true, candidateDigest, url: `https://github.com/example/${repositoryId}/pull/${number}` });
const workflow = (fields: Record<string, unknown>) => ({ stage: "WAIT_FOR_MERGE", state: "WAITING", candidate: { digest: "a".repeat(64), repositories: [] }, ...fields }) as unknown as WorkflowSnapshot;

describe("the close form with several pull requests", () => {
  it("names each state: two open, one closed and one merged", () => {
    expect(closeConfirmationText(workflow({ pullRequests: [pr("a", 3, "OPEN"), pr("b", 5, "OPEN"), pr("c", 7, "CLOSED"), pr("d", 9, "MERGED")] })))
      .toBe("Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded. PRs #3 and #5 stay open on GitHub. PR #7 stays closed on GitHub. PR #9 is already merged.");
  });

  it("names the open pull requests an approved fix isn't on yet", () => {
    expect(closeConfirmationText(workflow({ state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed,
      pullRequests: [pr("a", 3, "OPEN", "b".repeat(64)), pr("b", 5, "OPEN", "b".repeat(64)), pr("c", 7, "MERGED", "b".repeat(64))] })))
      .toBe("Closing stops this task and releases its workspace. The approved fix that isn't on PRs #3 and #5 yet is discarded. PRs #3 and #5 stay open on GitHub. PR #7 is already merged.");
  });
});
