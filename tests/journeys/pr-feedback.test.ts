// journey-gate: 11
// Journey 11: PR feedback. A reviewer comments on the draft pull request, Rovara reads it, a feedback review runs on the real worker and proposes fixes, and the owner decides on the web.
// On the real core and the real worker; see briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md. D1 deletes tests/integration/workflow-e2e/07-pr-feedback.test.ts, which this replaces in part.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { feedbackCriticReply, firstUserText } from "../support/faux-scripts.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { buildUntilPullRequest, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

/** A task with its draft pull request open and a teammate's review comment on it, read by merge tracking and reviewed by the real worker; returns what the owner sees. */
async function commentedPullRequest(w: JourneyWorld) {
  const taskId = await startTask(w);
  await planUntilCard(w, taskId);
  await w.approvePlan(taskId);
  const pullRequest = await buildUntilPullRequest(w, taskId);
  const model = w.harness.world.host.model;
  pullRequest.draft.draft = false;
  model.setAccount("priya", "write");
  model.addReviewComment(pullRequest.draft.id, "priya", "Please rename health.txt to status.txt.", "health.txt", 1);
  await w.runJobs();
  await w.runJobs(120);
  const reviewed = await w.runStep("FEEDBACK_REVIEW", [(context: Parameters<typeof firstUserText>[0]) => fauxAssistantMessage(feedbackCriticReply(firstUserText(context), { repositoryId: "demo", path: "health.txt", testPath: "health.test.ts" }))]);
  expect(reviewed.operation.status, String(reviewed.operation.error)).toBe("SUCCEEDED");
  const view = await w.maya("GET", `/v1/dev/tasks/${taskId}/workflow/feedback`);
  expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
  const review = (view.body as { review: { revision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings: Array<{ id: string; priority: string; rationale: string; commentIds: string[] }> } }).review;
  return { taskId, pullRequest, review };
}

describe("journey 11: PR feedback", () => {
  it("a review comment on the pull request is read, reviewed, and shown to the owner as a recommended fix; the owner dismisses it with a note and the task goes back to waiting for the merge", async () => {
    world = await createJourneyWorld();
    const { taskId, review } = await commentedPullRequest(world);
    expect(review.findings, "the owner sees one finding for the one comment").toHaveLength(1);
    expect(review.findings[0]).toMatchObject({ priority: "SHOULD_FIX" });
    const dismissed = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, { requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
      bundleDigests: review.bundleDigests, decision: "DISMISS", selectedFindingIds: [], ownerNote: "The file name is fine as it is." });
    expect(dismissed.status, JSON.stringify(dismissed.body).slice(0, 300)).toBe(200);
    const after = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; workflow: { stage: string; state: string } };
    expect({ stage: after.workflow.stage, state: after.workflow.state }, "back to waiting for the merge").toEqual({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const reread = (await world.maya("GET", `/v1/dev/tasks/${taskId}/workflow/feedback`)).body as { review?: { status: string; nextAction?: string } };
    expect({ status: reread.review?.status, next: reread.review?.nextAction }, "what the owner reads after dismissing").toEqual({ status: "DISMISSED", next: "No code changes will start from this proposal." });
    world.proof.assertAllCore();
  }, 180_000);

  it("the owner approves the recommended fix and the fix starts: its dispatch verifies the approval itself, the worker is given the fix's IMPLEMENT with the owner's approval, and the task does not fail", async () => {
    world = await createJourneyWorld();
    const { taskId, review } = await commentedPullRequest(world);
    const approved = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, { requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
      bundleDigests: review.bundleDigests, decision: "APPROVE", selectedFindingIds: [review.findings[0]!.id] });
    expect(approved.status, JSON.stringify(approved.body).slice(0, 300)).toBe(200);
    // Train 27e (707331b89, core/pr-feedback/fix-context.ts and core/task-flow/dispatch.ts): the approval re-check at dispatch no longer reads the task's spend while the fix's own run is open (it was the
    // "KNOWN GAP (pinned)" this journey held: the fix failed at dispatch with "The feedback approval changed or could not be verified"). Money stays checked at approval and at start.
    const dispatched = await world.dispatchOnly("IMPLEMENT");
    const payload = dispatched.invocation.payload as { workflowMode: string; workflowFix: { source: string }; workflowFeedbackApproval: { taskId: string; selectedFindingIds: string[]; selectedCommentIds: string[]; ownerId: string } };
    expect({ mode: payload.workflowMode, source: payload.workflowFix.source, task: payload.workflowFeedbackApproval.taskId, findings: payload.workflowFeedbackApproval.selectedFindingIds, comments: payload.workflowFeedbackApproval.selectedCommentIds },
      "the worker is told to fix exactly what the owner approved").toEqual({ mode: "IMPLEMENT", source: "feedback", task: taskId, findings: [review.findings[0]!.id], comments: review.findings[0]!.commentIds });
    expect(payload.workflowFeedbackApproval.ownerId, "the approval names its owner").not.toBe("");
    const failedOperation = world.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === "IMPLEMENT" && row.status === "FAILED");
    expect(failedOperation, "no fix operation failed at dispatch").toEqual([]);
    const after = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string };
    expect(after.status, "the task is not failed").not.toBe("FAILED");
    const view = await world.maya("GET", `/v1/dev/tasks/${taskId}/workflow/feedback`);
    expect((view.body as { review: { nextAction: string } }).review.nextAction).not.toBe("Review the failed operation before retrying.");
    world.proof.assertAllCore();
  }, 180_000);
});
