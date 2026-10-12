import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_BLOCK_REASONS,
  WorkflowSnapshotSchema,
  WorkflowTransitionError,
  createCandidateManifest,
  createWorkflowSnapshot,
  decideWorkflow,
  decideWorkflowFeedbackFindings,
  keepWorkflowPullRequests,
  requestWorkflowFeedbackReview,
  resolveWorkflowReviewFindings,
  retryWorkflowFeedbackReview,
  returnWorkflowToImplementation,
  submitWorkflowArtifact,
  workflowFindingFingerprint,
  type WorkflowOwnerAuthority,
  type WorkflowSnapshot,
} from "../../packages/contracts/src/task-workflow.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const creator = "a".repeat(64);
const secondOwner = "b".repeat(64);
const outsider = "c".repeat(64);
const now = "2026-10-11T20:00:00.000Z";
const later = "2026-10-11T20:01:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const candidate = createCandidateManifest([{ repositoryId: "api", commitSha: "1".repeat(40), treeSha: "2".repeat(40) }]);
const ownerAuthority = (actorId = secondOwner, ownerIds: readonly string[] = [creator, secondOwner]): WorkflowOwnerAuthority => ({ actorId, ownerIds });

const evidence = {
  candidate,
  verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: now, results: [{ checkId: "unit", status: "PASS" as const }] },
  reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({
    operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest,
    role, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true, recordedAt: now,
  })),
};

const feedbackFixture = () => {
  const commentSetDigest = hash("comments");
  const bundleDigest = hash("bundle");
  const bundle = {
    schemaVersion: 1 as const, taskId, repositoryId: "api", number: 7, headSha: "3".repeat(40), headTreeSha: "2".repeat(40),
    candidateDigest: candidate.digest, commentSetDigest, sha256: bundleDigest,
    objectKey: `tasks/${taskId}/feedback/${bundleDigest}.json`, producer: "github-reconciler", version: "1", recordedAt: now,
    comments: [{ id: "comment-1", threadId: "thread-1", kind: "REVIEW_COMMENT" as const,
      url: "https://github.com/example/api/pull/7#comment-1", author: "reviewer", updatedAt: now, bodyDigest: hash("comment"), bodyBytes: 7 }],
  };
  const findingId = "finding-1";
  const reviewDigest = hash("review");
  const reviewRef = {
    schemaVersion: 1 as const, taskId, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const,
    qualification: "AI_GENERATED_ADVISORY" as const, sha256: reviewDigest,
    objectKey: `tasks/${taskId}/reviews/${reviewDigest}.json`, proposalDigest: hash("proposal"), taskRequirementsDigest: hash("requirements"),
    candidateBindings: [{ repositoryId: "api", number: 7, headSha: bundle.headSha, candidateDigest: candidate.digest, commentSetDigest, bundleDigest }],
    operationId: "22222222-2222-4222-8222-222222222222", provider: "scripted", version: "1", status: "COMPLETE" as const,
    bundleDigests: [bundleDigest], findingRefs: [{ id: findingId, bundleDigest, commentIds: ["comment-1"], priority: "MUST_FIX" as const,
      assessment: "ACTIONABLE" as const, recommended: true }], recordedAt: now,
  };
  const base = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: creator, now }), ...evidence, stage: "WAIT_FOR_MERGE", state: "WAITING",
    pullRequests: [{ repositoryId: "api", number: 7, headSha: bundle.headSha, candidateDigest: candidate.digest,
      required: true, state: "OPEN", url: "https://github.com/example/api/pull/7" }],
  });
  const reviewed = requestWorkflowFeedbackReview(base, { bundleRefs: [bundle], reviewRef }, later);
  const request = {
    requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: reviewed.revision,
    reviewDigest, proposalDigest: reviewRef.proposalDigest, bundleDigests: [bundleDigest], selectedFindingIds: [findingId], decision: "APPROVE" as const,
  };
  const failedRef = { ...reviewRef, sha256: hash("failed-review"), objectKey: `tasks/${taskId}/reviews/${hash("failed-review")}.json`,
    status: "FAILED" as const, blockReason: "review failed", findingRefs: [] };
  const failed = requestWorkflowFeedbackReview(base, { bundleRefs: [bundle], reviewRef: failedRef }, later);
  return { reviewed, request, failed, failedRef };
};

const findingFixture = () => {
  const finding = { text: "The parser drops the last line.", origin: "INTRODUCED" as const, file: "src/parser.ts", line: 12 };
  const workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: creator, now }), ...evidence, revision: 6,
    stage: "REVIEW", state: "BLOCKED", blockReason: "the code review did not pass",
    reviews: [
      { ...evidence.reviews[0]!, status: "FINDINGS", findings: [finding] },
      evidence.reviews[1]!,
    ],
  });
  return {
    workflow,
    input: { requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: workflow.revision, candidateDigest: candidate.digest,
      resolutions: [{ findingId: workflowFindingFingerprint("CRITIC", finding), action: "FIX" as const, note: "Keep the final line." }] },
  };
};

interface OwnerCase {
  name: string;
  run(actorId: string, authority?: WorkflowOwnerAuthority): WorkflowSnapshot;
  recordedActor(result: WorkflowSnapshot): string | undefined;
}

function ownerCases(): OwnerCase[] {
  const initial = createWorkflowSnapshot({ taskId, ownerId: creator, now });
  const artifact = { id: "plan-v1", type: "plan" as const, version: 1, sha256: hash("plan"), producer: "planner",
    objectKey: `tasks/${taskId}/plan.md`, createdAt: now };
  const waiting = submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact, now: later });
  const feedback = feedbackFixture();
  const approvedFeedback = decideWorkflowFeedbackFindings(feedback.reviewed, feedback.request, { actorId: creator, role: "TASK_OWNER" }, later);
  const keepable = WorkflowSnapshotSchema.parse({ ...approvedFeedback, state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.fixChangedNothing });
  const findings = findingFixture();
  const blocked = { ...createWorkflowSnapshot({ taskId, ownerId: creator, now }), revision: 4, stage: "IMPLEMENT" as const, state: "BLOCKED" as const, blockReason: "implementation stopped" };
  return [
    {
      name: "decideWorkflow",
      run: (actorId, authority) => decideWorkflow(waiting, {
        requestId: "55555555-5555-4555-8555-555555555555", expectedRevision: waiting.revision, decision: "APPROVE",
        artifactDigest: artifact.sha256, reason: "Approved",
      }, { actorId, role: "TASK_OWNER" }, { now: later, allowedSkipStages: [], ...(authority === undefined ? {} : { authority }) }),
      recordedActor: (result) => result.decisions.at(-1)?.actorId,
    },
    {
      name: "retryWorkflowFeedbackReview",
      run: (actorId, authority) => retryWorkflowFeedbackReview(feedback.failed, {
        reviewDigest: feedback.failedRef.sha256, actor: { actorId, role: "TASK_OWNER" }, now: later,
      }, authority),
      recordedActor: () => undefined,
    },
    {
      name: "decideWorkflowFeedbackFindings",
      run: (actorId, authority) => decideWorkflowFeedbackFindings(feedback.reviewed, feedback.request, { actorId, role: "TASK_OWNER" }, later, authority),
      recordedActor: (result) => result.feedbackDecisions?.at(-1)?.actorId,
    },
    {
      name: "returnWorkflowToImplementation",
      run: (actorId, authority) => returnWorkflowToImplementation(blocked, {
        requestId: "66666666-6666-4666-8666-666666666666", actorId, reason: "Please revise.", now: later,
      }, authority),
      recordedActor: (result) => result.decisions.at(-1)?.actorId,
    },
    {
      name: "keepWorkflowPullRequests",
      run: (actorId, authority) => keepWorkflowPullRequests(keepable, {
        requestId: "77777777-7777-4777-8777-777777777777", actorId, now: later,
      }, authority),
      recordedActor: (result) => result.feedbackDecisions?.at(-1)?.actorId,
    },
    {
      name: "resolveWorkflowReviewFindings",
      run: (actorId, authority) => resolveWorkflowReviewFindings(findings.workflow, findings.input, { actorId }, { now: later }, authority),
      recordedActor: (result) => result.decisions.at(-1)?.actorId,
    },
  ];
}

describe.each(ownerCases())("workflow owner parity: $name", (action) => {
  it("lets a broker-authorized second owner perform the transition as the actual actor", () => {
      const result = action.run(secondOwner, ownerAuthority());
      expect(result.ownerId).toBe(creator);
      const recorded = action.recordedActor(result);
      if (recorded !== undefined) expect(recorded).toBe(secondOwner);
  });

  it("refuses a non-owner and any authority whose actor does not match the helper actor", () => {
      expect(() => action.run(outsider, ownerAuthority(outsider))).toThrow(WorkflowTransitionError);
      expect(() => action.run(secondOwner, ownerAuthority(creator))).toThrow(WorkflowTransitionError);
      expect(() => action.run(secondOwner, ownerAuthority(secondOwner, [creator]))).toThrow(WorkflowTransitionError);
  });

  it("keeps legacy creator authority unchanged when broker authority is absent", () => {
      expect(action.run(creator).ownerId).toBe(creator);
      expect(() => action.run(secondOwner)).toThrow(WorkflowTransitionError);
  });
});
