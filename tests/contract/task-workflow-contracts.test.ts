import * as workflowContracts from "../../packages/contracts/src/task-workflow.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WorkflowFeedbackBundleSchema, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackReviewReportSchema, WorkflowFeedbackReviewRefSchema, WorkflowFeedbackFindingSchema,
  WorkflowFeedbackNoteSchema,
  requestWorkflowFeedbackReview, decideWorkflowFeedbackFindings,
  completeWorkflowFeedbackReview,
  WorkflowTransitionError,
  createCandidateManifest,
  CandidateManifestSchema,
  createWorkflowSnapshot,
  decideWorkflow,
  recordWorkflowVerification,
  submitWorkflowReview,
  recordExpectedWorkflowPullRequests,
  registerWorkflowPullRequest,
  observeWorkflowPullRequest,
  requestWorkflowFeedback,
  decideWorkflowFeedback,
  dismissDeletedWorkflowFeedback,
  WorkflowSnapshotSchema,
  submitWorkflowArtifact,
  StartDeveloperTaskRequestSchema,
} from "@agentx/contracts";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const plan = {
  id: "plan-v1",
  type: "plan" as const,
  version: 1,
  sha256: "b".repeat(64),
  producer: "agentx-planner",
  objectKey: `tasks/${taskId}/plan-v1.md`,
  createdAt: "2026-10-05T12:00:00.000Z",
};

describe("native task workflow contracts", () => {
  it("requires an explicit Quick or Full choice when creating a workflow task", () => {
    const request = { requestId: "a1ec6b71-2494-4cbd-92a9-6eecab01676b", project: "payments", instructions: "Fix retry handling", workflow: true };
    expect(StartDeveloperTaskRequestSchema.safeParse(request).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ ...request, workflowPath: "QUICK" }).success).toBe(true);
  });

  it("stores exact task Canvas lineage and retryable closeout state while keeping legacy snapshots valid", () => {
    const workflow = { ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), artifacts: [plan] };
    expect(WorkflowSnapshotSchema.parse(workflow).canvasLineage).toBeUndefined();
    const tracked = WorkflowSnapshotSchema.parse({ ...workflow, canvasLineage: [{
      key: "PLAN:2:plan-v1", stage: "PLAN_REVIEW", workflowRevision: 2, artifactId: "plan-v1",
      artifactRef: plan.objectKey, artifactDigest: plan.sha256, state: "CREATED", canvasId: "F12345678",
      permalink: "https://acme.slack.com/docs/T123/F12345678", createdAt: "2026-10-05T12:01:00.000Z",
    }], canvasCloseout: { status: "ARCHIVE_PENDING", terminalState: "CLOSED", manifestDigest: "c".repeat(64),
      manifestRef: `private/task-closeouts/${taskId}/${"c".repeat(64)}.json`, preparedAt: "2026-10-05T12:02:00.000Z",
      canvases: [{ lineageKey: "PLAN:2:plan-v1", canvasId: "F12345678", status: "UNKNOWN", attempts: 1 }] } });
    expect(tracked.canvasLineage?.[0]?.canvasId).toBe("F12345678");
    expect(tracked.canvasCloseout?.canvases[0]?.status).toBe("UNKNOWN");
    expect(WorkflowSnapshotSchema.parse({ ...workflow, canvasCloseoutAttempt: {
      status: "ARCHIVE_PENDING", workflowRevision: 1, terminalState: "CLOSED", reason: "artifact_unavailable", attempts: 1,
      updatedAt: "2026-10-05T12:02:00.000Z",
    } }).canvasCloseoutAttempt).toMatchObject({ reason: "artifact_unavailable", workflowRevision: 1 });
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, canvasLineage: [{
      key: "PLAN:2:plan-v1", stage: "PLAN_REVIEW", workflowRevision: 2, artifactId: "plan-v1",
      artifactRef: plan.objectKey, artifactDigest: plan.sha256, state: "CREATED", canvasId: "F99999999",
      permalink: "https://acme.slack.com/docs/T123/F12345678", createdAt: "2026-10-05T12:01:00.000Z",
    }, { key: "PLAN:2:plan-v1", stage: "PLAN_REVIEW", workflowRevision: 2, artifactId: "plan-v1",
      artifactRef: plan.objectKey, artifactDigest: plan.sha256, state: "CREATED", canvasId: "F88888888",
      permalink: "https://acme.slack.com/docs/T123/F88888888", createdAt: "2026-10-05T12:01:00.000Z" }] }).success).toBe(false);
  });
  it("rejects worker-authored claims that its feedback review is independent or read-only evidence", () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const report = { schemaVersion: 1, taskId, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "c".repeat(64), taskRequirementsDigest: "d".repeat(64), candidateBindings: [{ repositoryId: "demo", number: 1,
        headSha: "a".repeat(40), candidateDigest: candidate.digest, commentSetDigest: "e".repeat(64), bundleDigest: "f".repeat(64) }],
      operationId: "11111111-1111-4111-8111-111111111111", provider: "scripted", version: "1", status: "COMPLETE",
      bundleDigests: ["f".repeat(64)], findingRefs: [], findings: [], recordedAt: "2026-10-05T12:00:00.000Z" };
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...report, reviewerId: "independent-reviewer", readOnly: true }).success).toBe(false);
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...report, qualification: "INDEPENDENT_EVIDENCE" }).success).toBe(false);
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...report, operationMode: "IMPLEMENT" }).success).toBe(false);
  });
  it("matches dispatch approval to the exact selected report findings, source comments, PR set, and heads", () => {
    const binding = { taskId, requestId: "11111111-1111-4111-8111-111111111111", ownerId,
      decisionWorkflowRevision: 4, activeWorkflowRevision: 6, reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64),
      bundleDigests: ["c".repeat(64)], candidateDigest: "d".repeat(64), selectedFindingIds: ["finding-1"], selectedCommentIds: ["comment-1"] };
    const review = { bundleRefs: [{ repositoryId: "demo", number: 42, headSha: "e".repeat(40), candidateDigest: binding.candidateDigest, sha256: binding.bundleDigests[0] }],
      reviewRef: { sha256: binding.reviewDigest, proposalDigest: binding.proposalDigest, bundleDigests: binding.bundleDigests,
        candidateBindings: [{ repositoryId: "demo", number: 42, headSha: "e".repeat(40), candidateDigest: binding.candidateDigest, bundleDigest: binding.bundleDigests[0] }],
        findingRefs: [{ id: "finding-1", bundleDigest: binding.bundleDigests[0], commentIds: ["comment-1"], priority: "MUST_FIX", assessment: "ACTIONABLE", recommended: true }] } };
    expect(workflowContracts.workflowFeedbackApprovalMatchesReview(binding as never, review as never)).toBe(true);
    expect(workflowContracts.workflowFeedbackApprovalMatchesReview({ ...binding, selectedCommentIds: ["comment-2"] }, review as never)).toBe(false);
    expect(workflowContracts.workflowFeedbackApprovalMatchesReview({ ...binding, selectedFindingIds: ["finding-1", "finding-2"] }, review as never)).toBe(false);
    expect(workflowContracts.workflowFeedbackApprovalMatchesReview({ ...binding, bundleDigests: ["f".repeat(64)] }, review as never)).toBe(false);
  });
  it("computes a stable candidate digest from sorted repository identities and exact commits", () => {
    const left = { repositoryId: "repo-b", commitSha: "b".repeat(40), treeSha: "2".repeat(40) };
    const right = { repositoryId: "repo-a", commitSha: "a".repeat(40), treeSha: "1".repeat(40) };

    const first = createCandidateManifest([left, right]);
    const reordered = createCandidateManifest([right, left]);
    const changed = createCandidateManifest([{ ...left, commitSha: "c".repeat(40) }, right]);

    expect(first).toEqual(reordered);
    expect(first.repositories.map((repo) => repo.repositoryId)).toEqual(["repo-a", "repo-b"]);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.digest).not.toBe(first.digest);
    expect(CandidateManifestSchema.safeParse({ ...first, digest: "f".repeat(64) }).success).toBe(false);
  });

  it("rejects duplicate repository identities and malformed candidate hashes", () => {
    const repo = { repositoryId: "repo-a", commitSha: "a".repeat(40), treeSha: "1".repeat(40) };

    expect(() => createCandidateManifest([repo, repo])).toThrow(WorkflowTransitionError);
    expect(() => createCandidateManifest([{ ...repo, commitSha: "bad" }])).toThrow(WorkflowTransitionError);
  });

  it("requires passing checks and both candidate-bound review roles before the PR stage", () => {
    const current = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "VERIFY" as const,
      state: "BLOCKED" as const,
    };
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const checks = {
      candidateDigest: candidate.digest,
      producer: "agentx-broker",
      environmentId: "ci-local",
      recordedAt: "2026-10-05T12:01:00.000Z",
      results: [{ checkId: "unit", status: "PASS" as const }],
    };

    const reviewed = recordWorkflowVerification(current, { candidate, checks, now: "2026-10-05T12:02:00.000Z" });
    expect(reviewed).toMatchObject({ stage: "REVIEW", state: "WAITING", candidate: { digest: candidate.digest } });
    expect(() => submitWorkflowReview(reviewed, {
      candidateDigest: "f".repeat(64), role: "CRITIC", provider: "scripted", version: "1",
      status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z",
    }, "2026-10-05T12:03:00.000Z")).toThrow(WorkflowTransitionError);

    const criticReviewed = submitWorkflowReview(reviewed, {
      operationId: "11111111-1111-4111-8111-111111111111",
      candidateDigest: candidate.digest, role: "CRITIC", provider: "scripted", version: "1",
      status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z",
    }, "2026-10-05T12:03:00.000Z");
    expect(criticReviewed).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    const ready = submitWorkflowReview(criticReviewed, {
      operationId: "11111111-1111-4111-8111-111111111111",
      candidateDigest: candidate.digest, role: "SECURITY", provider: "scripted", version: "1",
      status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:04:00.000Z",
    }, "2026-10-05T12:04:00.000Z");
    expect(ready).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  });

  it("keeps failed checks or non-passing reviews from reaching pull request readiness", () => {
    const current = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "VERIFY" as const,
      state: "BLOCKED" as const,
    };
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const blocked = recordWorkflowVerification(current, {
      candidate,
      checks: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci-local", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "FAILED" as const }] },
      now: "2026-10-05T12:02:00.000Z",
    });
    expect(blocked).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  });

  it("waits for every expected pull request to be observed merged by GitHub", () => {
    const candidate = createCandidateManifest([
      { repositoryId: "payments-api", commitSha: "a".repeat(40), treeSha: "1".repeat(40) },
      { repositoryId: "payments-ui", commitSha: "b".repeat(40), treeSha: "2".repeat(40) },
    ]);
    const candidateDigest = candidate.digest;
    const current = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "PULL_REQUEST" as const,
      state: "READY" as const,
      candidate,
      verification: { candidateDigest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: [
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest, role: "CRITIC" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" },
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest, role: "SECURITY" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:03:00.000Z" },
      ],
    };
    const waiting = recordExpectedWorkflowPullRequests(current, [
      { repositoryId: "payments-api", number: 11, url: "https://github.com/acme/api/pull/11", candidateDigest: current.candidate.digest, required: true },
      { repositoryId: "payments-ui", number: 12, url: "https://github.com/acme/ui/pull/12", candidateDigest: current.candidate.digest, required: true },
    ], "2026-10-05T12:04:00.000Z");
    const oneMerged = observeWorkflowPullRequest(waiting, {
      repositoryId: "payments-api", number: 11, candidateDigest: current.candidate.digest,
      state: "MERGED", source: "GITHUB_API", observedAt: "2026-10-05T12:05:00.000Z",
    }, "2026-10-05T12:05:00.000Z");
    expect(oneMerged).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const allMerged = observeWorkflowPullRequest(oneMerged, {
      repositoryId: "payments-ui", number: 12, candidateDigest: current.candidate.digest,
      state: "MERGED", source: "GITHUB_API", observedAt: "2026-10-05T12:06:00.000Z",
    }, "2026-10-05T12:06:00.000Z");
    expect(allMerged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    const reopened = observeWorkflowPullRequest(allMerged, {
      repositoryId: "payments-api", number: 11, candidateDigest: current.candidate.digest,
      state: "OPEN", source: "GITHUB_API", observedAt: "2026-10-05T12:07:00.000Z",
    }, "2026-10-05T12:07:00.000Z");
    expect(reopened).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(reopened).not.toHaveProperty("outcome");
  });

  it("requires owner approval for the exact PR feedback plan and candidate before coding", () => {
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const ready = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "PULL_REQUEST" as const,
      state: "READY" as const,
      candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: [
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "CRITIC" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" },
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "SECURITY" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:03:00.000Z" },
      ],
    };
    const waiting = recordExpectedWorkflowPullRequests(ready, [
      { repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", candidateDigest: candidate.digest, required: true },
    ], "2026-10-05T12:04:00.000Z");
    const feedback = requestWorkflowFeedback(waiting, {
      feedbackId: "f".repeat(64), repositoryId: "payments", number: 11, candidateDigest: candidate.digest,
      comments: [{ id: "4321", url: "https://github.com/acme/payments/pull/11#discussion_r4321", author: "reviewer", body: "Handle this edge case" }],
      proposedPlan: "Review the feedback in context, update the code, and rerun required checks and reviews.",
    }, "2026-10-05T12:05:00.000Z");

    expect(() => decideWorkflowFeedback(feedback, {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedRevision: feedback.revision,
      candidateDigest: "b".repeat(64), feedbackId: "f".repeat(64), decision: "APPROVE",
    }, { actorId: "c".repeat(64), role: "TASK_OWNER" }, "2026-10-05T12:06:00.000Z")).toThrow(WorkflowTransitionError);

    const approved = decideWorkflowFeedback(feedback, {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedRevision: feedback.revision,
      candidateDigest: candidate.digest, feedbackId: "f".repeat(64), decision: "APPROVE",
    }, { actorId: ownerId, role: "TASK_OWNER" }, "2026-10-05T12:06:00.000Z");
    expect(approved).toMatchObject({ stage: "IMPLEMENT", state: "READY", decisions: [{ actorRole: "TASK_OWNER", artifactDigest: feedback.feedback?.planDigest }] });
    expect(approved).not.toHaveProperty("verification");
    expect(approved).not.toHaveProperty("candidate");
    const deleted = dismissDeletedWorkflowFeedback(feedback, "4321", "2026-10-05T12:05:30.000Z");
    expect(deleted).toMatchObject({ revision: feedback.revision + 1, feedback: { status: "DISMISSED" } });
    expect(() => decideWorkflowFeedback(deleted, {
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", expectedRevision: deleted.revision,
      candidateDigest: candidate.digest, feedbackId: "f".repeat(64), decision: "APPROVE",
    }, { actorId: ownerId, role: "TASK_OWNER" }, "2026-10-05T12:06:00.000Z")).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflowFeedback(feedback, {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedRevision: feedback.revision - 1,
      candidateDigest: candidate.digest, feedbackId: "f".repeat(64), decision: "APPROVE",
    }, { actorId: ownerId, role: "TASK_OWNER" }, "2026-10-05T12:06:00.000Z")).toThrow(WorkflowTransitionError);
  });

  it("keeps a multi-repository workflow in PR creation until every candidate repository has a PR", () => {
    const candidate = createCandidateManifest([
      { repositoryId: "payments-api", commitSha: "a".repeat(40), treeSha: "1".repeat(40) },
      { repositoryId: "payments-ui", commitSha: "b".repeat(40), treeSha: "2".repeat(40) },
    ]);
    const current = {
      ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "PULL_REQUEST" as const,
      state: "READY" as const,
      candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: [
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "CRITIC" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:02:00.000Z" },
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "SECURITY" as const, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: "2026-10-05T12:03:00.000Z" },
      ],
    };
    const first = registerWorkflowPullRequest(current, {
      repositoryId: "payments-api", number: 11, url: "https://github.com/acme/api/pull/11", headSha: "d".repeat(40), candidateDigest: candidate.digest, required: true,
    }, "2026-10-05T12:04:00.000Z");
    expect(first).toMatchObject({ stage: "PULL_REQUEST", state: "READY", pullRequests: [{ repositoryId: "payments-api", state: "UNKNOWN" }] });
    const completeSet = registerWorkflowPullRequest(first, {
      repositoryId: "payments-ui", number: 12, url: "https://github.com/acme/ui/pull/12", headSha: "e".repeat(40), candidateDigest: candidate.digest, required: true,
    }, "2026-10-05T12:05:00.000Z");
    expect(completeSet).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "payments-api" }, { repositoryId: "payments-ui" }] });
    const oneMerged = observeWorkflowPullRequest(completeSet, { repositoryId: "payments-api", number: 11, candidateDigest: candidate.digest, state: "MERGED", source: "GITHUB_API", observedAt: "2026-10-05T12:06:00.000Z" }, "2026-10-05T12:06:00.000Z");
    expect(oneMerged).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const allMerged = observeWorkflowPullRequest(oneMerged, { repositoryId: "payments-ui", number: 12, candidateDigest: candidate.digest, state: "MERGED", source: "GITHUB_API", observedAt: "2026-10-05T12:07:00.000Z" }, "2026-10-05T12:07:00.000Z");
    expect(allMerged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
  });

  it("rejects persisted PR-ready or merged stages without their required evidence", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" });
    expect(WorkflowSnapshotSchema.safeParse({ ...initial, stage: "PULL_REQUEST", state: "READY" }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...initial, stage: "MERGED", state: "COMPLETE", outcome: "MERGED" }).success).toBe(false);
  });

  it("requires an attributable approval for the exact current plan before implementation", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" });
    const awaitingApproval = submitWorkflowArtifact(initial, {
      expectedRevision: initial.revision,
      artifact: plan,
      now: "2026-10-05T12:01:00.000Z",
    });

    expect(awaitingApproval.stage).toBe("PLAN_REVIEW");
    expect(awaitingApproval.state).toBe("WAITING");
    expect(() => decideWorkflow(awaitingApproval, {
      requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b",
      expectedRevision: awaitingApproval.revision,
      decision: "APPROVE",
      artifactDigest: "c".repeat(64),
      reason: "Reviewed",
    }, { actorId: ownerId, role: "TASK_OWNER" }, { now: "2026-10-05T12:02:00.000Z", allowedSkipStages: [] })).toThrow(WorkflowTransitionError);

    const approvalRequest = {
      requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b",
      expectedRevision: awaitingApproval.revision,
      decision: "APPROVE",
      artifactDigest: plan.sha256,
      reason: "Reviewed and approved",
    };
    const actor = { actorId: ownerId, role: "TASK_OWNER" as const };
    const options = { now: "2026-10-05T12:02:00.000Z", allowedSkipStages: [] };
    const approved = decideWorkflow(awaitingApproval, approvalRequest, actor, options);

    expect(approved.stage).toBe("IMPLEMENT");
    expect(approved.state).toBe("READY");
    expect(approved.decisions[0]).toMatchObject({ decision: "APPROVE", actorId: ownerId, artifactDigest: plan.sha256 });
    expect(decideWorkflow(approved, approvalRequest, actor, options)).toEqual(approved);
  });

  it("requires requirements, design, and implementation-plan approvals on the Full path", () => {
    let workflow = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z", path: "FULL" });
    const phases = [
      { type: "requirements" as const, content: "Goal: fix retries.\nScope: payments API." },
      { type: "design" as const, content: "Approach: bounded retry with backoff." },
      { type: "plan" as const, content: "1. Update retry helper.\n2. Add test." },
    ];
    for (const [index, phase] of phases.entries()) {
      if (index > 0) workflow = WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" });
      const artifact = {
        id: `full-phase-${index + 1}`, type: phase.type, version: 1,
        sha256: createHash("sha256").update(phase.content).digest("hex"), producer: "agentx-worker-untrusted",
        objectKey: `tasks/${taskId}/${phase.type}.md`, createdAt: `2026-10-05T12:0${index + 1}:00.000Z`,
      };
      workflow = submitWorkflowArtifact(workflow, { expectedRevision: workflow.revision, artifact, now: artifact.createdAt });
      expect(workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      const decision = decideWorkflow(workflow, {
        requestId: `d532a6e0-3de1-44e3-a6d2-e8c635d77f2${index}`,
        expectedRevision: workflow.revision,
        decision: "APPROVE",
        artifactDigest: artifact.sha256,
        reason: "Approved",
      }, { actorId: ownerId, role: "TASK_OWNER" }, { now: `2026-10-05T12:1${index}:00.000Z`, allowedSkipStages: [] });
      workflow = decision;
      if (index < 2) expect(workflow).toMatchObject({ path: "FULL", stage: "PLAN", state: "READY", reviewPhase: ["DESIGN", "IMPLEMENTATION_PLAN"][index] });
      else expect(workflow).toMatchObject({ path: "FULL", stage: "IMPLEMENT", state: "READY" });
    }
  });

  it("refuses stale revision, unauthorized actor and a skip the workflow policy did not allow", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" });
    const awaitingApproval = submitWorkflowArtifact(initial, {
      expectedRevision: initial.revision,
      artifact: plan,
      now: "2026-10-05T12:01:00.000Z",
    });
    const base = {
      requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b",
      expectedRevision: awaitingApproval.revision,
      decision: "APPROVE" as const,
      artifactDigest: plan.sha256,
      reason: "Reviewed",
    };

    expect(() => decideWorkflow(awaitingApproval, { ...base, expectedRevision: 0 }, { actorId: ownerId, role: "TASK_OWNER" }, { now: "2026-10-05T12:02:00.000Z", allowedSkipStages: [] })).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflow(awaitingApproval, base, { actorId: "c".repeat(64), role: "TASK_OWNER" }, { now: "2026-10-05T12:02:00.000Z", allowedSkipStages: [] })).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflow(awaitingApproval, {
      ...base,
      decision: "SKIP",
      artifactDigest: undefined,
    }, { actorId: ownerId, role: "TASK_OWNER" }, { now: "2026-10-05T12:02:00.000Z", allowedSkipStages: [] })).toThrow(WorkflowTransitionError);
  });
});

describe("Slack-attributed PR feedback notes", () => {
  it("records the verified Slack owner, workspace, thread and source message", () => {
    const note = WorkflowFeedbackNoteSchema.parse({
      schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111", actorId: ownerId,
      source: "THREAD_REPLY", sourceId: "Ev0000000001", text: "Please address the second recommendation.", at: "2026-10-05T12:00:00.000Z",
      slack: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001", userId: "U0123456789", messageTs: "1695500002.000007", eventId: "Ev0000000001" },
    });
    expect(note.slack).toMatchObject({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", userId: "U0123456789", messageTs: "1695500002.000007" });
  });
});


describe("immutable multi-PR feedback reviews", () => {
  const now = "2026-10-05T12:00:00.000Z";
  const uuid = "11111111-1111-4111-8111-111111111111";
  const hash = (letter: string) => letter.repeat(64);
  function fixture() {
    const candidate = createCandidateManifest([
      { repositoryId: "api", commitSha: "a".repeat(40), treeSha: "1".repeat(40) },
      { repositoryId: "ui", commitSha: "b".repeat(40), treeSha: "2".repeat(40) },
    ]);
    const bundleRefs = candidate.repositories.map((repo, index) => ({
      schemaVersion: 1 as const, taskId, repositoryId: repo.repositoryId, number: index + 1,
      headSha: "d".repeat(40), headTreeSha: repo.treeSha, candidateDigest: candidate.digest,
      commentSetDigest: hash(index === 0 ? "c" : "d"), sha256: hash(index === 0 ? "e" : "f"),
      objectKey: `tasks/${taskId}/feedback/${hash(index === 0 ? "e" : "f")}.json`,
      producer: "github-reconciler", version: "1", recordedAt: now,
      comments: [0, 1].map(i => ({ id: `${repo.repositoryId}-${i}`, threadId: `thread-${repo.repositoryId}`,
        kind: "REVIEW_COMMENT" as const, url: `https://github.com/acme/${repo.repositoryId}/pull/${index + 1}#comment-${i}`,
        author: "reviewer", updatedAt: now, bodyDigest: createHash("sha256").update("comment").digest("hex"), bodyBytes: 7 })),
    }));
    const findingRefs = bundleRefs.map((bundle, index) => ({ id: `finding-${index}`, bundleDigest: bundle.sha256,
      commentIds: bundle.comments.map(c => c.id), priority: "MUST_FIX" as const,
      assessment: "ACTIONABLE" as const, recommended: true }));
    const reviewRef = { schemaVersion: 1 as const, taskId, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const,
      qualification: "AI_GENERATED_ADVISORY" as const, sha256: hash("b"), objectKey: `tasks/${taskId}/reviews/${hash("b")}.json`,
      proposalDigest: hash("c"), taskRequirementsDigest: hash("a"),
      candidateBindings: bundleRefs.map(b => ({ repositoryId: b.repositoryId, number: b.number, headSha: b.headSha,
        candidateDigest: b.candidateDigest, commentSetDigest: b.commentSetDigest, bundleDigest: b.sha256 })),
      operationId: uuid, provider: "scripted", version: "1",
      status: "COMPLETE" as const, bundleDigests: bundleRefs.map(b => b.sha256), findingRefs, recordedAt: now };
    const current = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId, now }), candidate,
      stage: "WAIT_FOR_MERGE", state: "WAITING",
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: uuid, candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: bundleRefs.map(b => ({ repositoryId: b.repositoryId, number: b.number, headSha: b.headSha, candidateDigest: b.candidateDigest, required: true, state: "OPEN", url: `https://github.com/acme/${b.repositoryId}/pull/${b.number}` })),
    });
    const request = { requestId: uuid, expectedRevision: current.revision + 1, reviewDigest: reviewRef.sha256,
      proposalDigest: reviewRef.proposalDigest, bundleDigests: reviewRef.bundleDigests, selectedFindingIds: ["finding-0"], decision: "APPROVE" as const };
    return { current, bundleRefs, reviewRef, request };
  }
  it("persists collected bundles before a reviewer exists and fences old approvals", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    expect(workflowContracts.collectWorkflowFeedbackBundles).toBeTypeOf("function");
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    const collected = workflowContracts.collectWorkflowFeedbackBundles(reviewed, { bundleRefs, threadObservations: [] }, now);
    expect(collected.feedbackReview).toMatchObject({ status: "COLLECTING", bundleRefs });
    expect(collected.feedbackReview?.reviewRef).toBeUndefined();
    expect(collected.feedbackReviewHistory).toEqual([reviewRef]);
    expect(collected.stage).toBe("WAIT_FOR_MERGE");
    expect(() => decideWorkflowFeedbackFindings(collected, { ...request, expectedRevision: collected.revision }, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
    expect(() => workflowContracts.collectWorkflowFeedbackBundles(current, { bundleRefs: [bundleRefs[0]], threadObservations: [] }, now)).toThrow();
  });
  it("returns the exact active critic report to a waiting owner decision", () => {
    const { current, bundleRefs, reviewRef } = fixture();
    const collected = workflowContracts.collectWorkflowFeedbackBundles(current, { bundleRefs, threadObservations: [] }, now);
    const running = { ...collected, revision: collected.revision + 1, state: "RUNNING" as const };
    expect(running).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING", feedbackReview: { status: "COLLECTING", bundleRefs } });
    expect(WorkflowFeedbackReviewRefSchema.safeParse(reviewRef).success).toBe(true);
    const complete = completeWorkflowFeedbackReview(running, {
      expectedRevision: running.revision, taskId, candidateDigest: current.candidate!.digest,
      operationId: reviewRef.operationId, bundleRefs, reviewRef,
    }, now);
    expect(complete).toMatchObject({ revision: running.revision + 1, state: "WAITING", feedbackReview: { status: "PENDING", reviewRef } });
    expect(() => completeWorkflowFeedbackReview(running, {
      expectedRevision: running.revision, taskId, candidateDigest: current.candidate!.digest,
      operationId: "22222222-2222-4222-8222-222222222222", bundleRefs, reviewRef,
    }, now)).toThrow(WorkflowTransitionError);
  });
  it("serializes artifact bodies before hashing and validates storage envelopes after round-trip", () => {
    const { bundleRefs, reviewRef } = fixture();
    const { sha256: _bundleDigest, objectKey: _bundleKey, ...bundleMetadata } = bundleRefs[0]!;
    void _bundleDigest; void _bundleKey;
    const payloadComments = bundleMetadata.comments.map(c => ({ ...c, body: "comment" }));
    const payload = { ...bundleMetadata, comments: payloadComments,
      commentSetDigest: createHash("sha256").update(JSON.stringify(payloadComments), "utf8").digest("hex"), sourceDeliveryIds: ["delivery-1"] };
    const parsed = WorkflowFeedbackBundleSchema.parse(payload);
    const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored: unknown = JSON.parse(bytes.toString("utf8"));
    expect(WorkflowFeedbackBundleSchema.parse(stored)).toEqual(parsed);
    const bundleRef = WorkflowFeedbackBundleRefSchema.parse({ ...bundleMetadata, sha256, objectKey: `tasks/${taskId}/feedback/${sha256}.json` });
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundleRef.sha256);
    const parsedStored = WorkflowFeedbackBundleSchema.parse(stored);
    expect(WorkflowFeedbackBundleSchema.safeParse({ ...parsedStored, sha256, objectKey: bundleRef.objectKey }).success).toBe(false);
    const { sha256: _reviewDigest, objectKey: _reviewKey, ...reportMetadata } = reviewRef;
    void _reviewDigest; void _reviewKey;
    const findingRefs = [{ ...reviewRef.findingRefs[0]!, bundleDigest: sha256 }];
    const report = WorkflowFeedbackReviewReportSchema.parse({ ...reportMetadata, bundleDigests: [sha256],
      candidateBindings: [{ ...reportMetadata.candidateBindings[0]!, bundleDigest: sha256 }], findingRefs,
      findings: findingRefs.map(f => ({ ...f, evidence: [{ source: "code", reference: "api/file.ts:1" }], rationale: "Reproduced",
        confidence: { level: "HIGH", reason: "Observed candidate" }, proposedDisposition: "IMPLEMENT" })) });
    const reportBytes = Buffer.from(JSON.stringify(report), "utf8");
    const reportDigest = createHash("sha256").update(reportBytes).digest("hex");
    const decoded = WorkflowFeedbackReviewReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
    const reportRef = WorkflowFeedbackReviewRefSchema.parse({ ...reportMetadata, bundleDigests: [sha256],
      candidateBindings: [{ ...reportMetadata.candidateBindings[0]!, bundleDigest: sha256 }], findingRefs,
      sha256: reportDigest, objectKey: `tasks/${taskId}/reviews/${reportDigest}.json` });
    expect(decoded).toEqual(report);
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(reportRef.sha256);
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...decoded, sha256: reportDigest, objectKey: reportRef.objectKey }).success).toBe(false);
  });
  it("permits attributed changes or dismissal of incomplete reports while refusing approval and stale actors", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    for (const status of ["BLOCKED", "FAILED", "INTERRUPTED", "UNKNOWN"] as const) {
      const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef: { ...reviewRef, status, blockReason: "critic could not verify this report" } }, now);
      expect(() => decideWorkflowFeedbackFindings(reviewed, request, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
      for (const decision of ["REQUEST_CHANGES", "DISMISS"] as const) {
        const noteRequest = { ...request, decision, selectedFindingIds: [], ownerNote: "Review could not complete; revisit." };
        const result = decideWorkflowFeedbackFindings(reviewed, noteRequest, { actorId: ownerId, role: "TASK_OWNER" }, now);
        expect(result.stage).toBe("WAIT_FOR_MERGE");
        expect(result.feedbackNotes?.[0]).toMatchObject({ actorId: ownerId, source: decision, text: noteRequest.ownerNote });
        const { ownerNote: _ownerNote, ...withoutOwnerNote } = noteRequest;
        void _ownerNote;
        expect(() => decideWorkflowFeedbackFindings(reviewed, withoutOwnerNote, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
        expect(() => decideWorkflowFeedbackFindings(reviewed, { ...noteRequest, expectedRevision: 99 }, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
        expect(() => decideWorkflowFeedbackFindings(reviewed, { ...noteRequest, reviewDigest: hash("f") }, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
        expect(() => decideWorkflowFeedbackFindings(reviewed, noteRequest, { actorId: hash("f"), role: "TASK_OWNER" }, now)).toThrow();
      }
    }
  });
  it("rejects a complete review omitting any currently open linked PR", () => {
    const { current, bundleRefs, reviewRef } = fixture();
    expect(() => requestWorkflowFeedbackReview(current, { bundleRefs: [bundleRefs[0]],
      reviewRef: { ...reviewRef, bundleDigests: [bundleRefs[0]!.sha256], findingRefs: [reviewRef.findingRefs[0]!] } }, now)).toThrow();
  });
  it("refuses approval when a linked PR becomes open after complete review registration", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    const closed = { ...current, pullRequests: current.pullRequests!.map(pr => pr.repositoryId === "ui" ? { ...pr, state: "CLOSED" } : pr) };
    const onlyApiReview = { ...reviewRef, bundleDigests: [bundleRefs[0]!.sha256],
      candidateBindings: [reviewRef.candidateBindings[0]!], findingRefs: [reviewRef.findingRefs[0]!] };
    const reviewed = requestWorkflowFeedbackReview(closed, { bundleRefs: [bundleRefs[0]],
      reviewRef: onlyApiReview }, now);
    const reopened = { ...reviewed, revision: reviewed.revision + 1, pullRequests: current.pullRequests };
    expect(() => decideWorkflowFeedbackFindings(reopened, { ...request, expectedRevision: reopened.revision, bundleDigests: [bundleRefs[0]!.sha256] },
      { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
  });
  it("retains open PR bundles with zero eligible comments and rejects complete reviews omitting an open linked PR", () => {
    const { current, bundleRefs, reviewRef } = fixture();
    const bundles = [{ ...bundleRefs[0]!, comments: [] }, bundleRefs[1]!];
    const ref = { ...reviewRef, findingRefs: [reviewRef.findingRefs[1]!] };
    const result = requestWorkflowFeedbackReview(current, { bundleRefs: bundles, reviewRef: ref }, now);
    expect(result.feedbackReview?.bundleRefs[0]?.comments).toEqual([]);
    const { sha256: _digest, objectKey: _key, ...emptyPayload } = bundles[0]!;
    void _digest; void _key;
    expect(WorkflowFeedbackBundleSchema.safeParse({ ...emptyPayload, commentSetDigest: createHash("sha256").update("[]", "utf8").digest("hex"), sourceDeliveryIds: [] }).success).toBe(true);
    const omitted = { ...reviewRef, bundleDigests: [bundleRefs[0]!.sha256], candidateBindings: [reviewRef.candidateBindings[0]!],
      findingRefs: [reviewRef.findingRefs[0]!] };
    expect(() => requestWorkflowFeedbackReview(current, { bundleRefs: [bundleRefs[0]], reviewRef: omitted }, now)).toThrow();
    const emptyReview = requestWorkflowFeedbackReview(current, { bundleRefs: bundleRefs.map(b => ({ ...b, comments: [] })), reviewRef: { ...reviewRef, findingRefs: [] } }, now);
    expect(emptyReview.feedbackReview?.reviewRef?.findingRefs).toEqual([]);
    const closedCurrent = { ...current, pullRequests: current.pullRequests!.map(pr => pr.repositoryId === "ui" ? { ...pr, state: "CLOSED" } : pr) };
    expect(requestWorkflowFeedbackReview(closedCurrent, { bundleRefs: [bundleRefs[0]], reviewRef: omitted }, now).feedbackReview?.bundleRefs).toHaveLength(1);
  });
  it("retains two exact heads and grouped source IDs while excluding full bodies from snapshot references", () => {
    const { current, bundleRefs, reviewRef } = fixture();
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    expect(reviewed.feedbackReview?.bundleRefs.map(b => b.headSha)).toEqual(["d".repeat(40), "d".repeat(40)]);
    expect(reviewed.feedbackReview?.reviewRef?.findingRefs[0]?.commentIds).toEqual(["api-0", "api-1"]);
    expect(reviewed.feedbackReview?.bundleRefs[0]?.comments[0]?.threadId).toBe("thread-api");
    expect(JSON.stringify(reviewed)).not.toContain('"body":');
    expect(() => requestWorkflowFeedbackReview(current, { bundleRefs: [{ ...bundleRefs[0], comments: [{ ...bundleRefs[0]!.comments[0], body: "large comment" }] }, bundleRefs[1]], reviewRef }, now)).toThrow();
  });
  it("validates all priorities separately from all seven assessments and full artifact evidence", () => {
    const { bundleRefs, reviewRef } = fixture();
    const { sha256: _bundleSha, objectKey: _bundleKey, ...bundlePayload } = bundleRefs[0]!;
    const { sha256: _reviewSha, objectKey: _reviewKey, ...reviewPayload } = reviewRef;
    void _bundleSha; void _bundleKey; void _reviewSha; void _reviewKey;
    const finding = { ...reviewRef.findingRefs[0], evidence: [{ source: "code", reference: "api/file.ts:1" }], rationale: "Empty input causes failure.", confidence: { level: "HIGH", reason: "Reproduced in candidate code" }, proposedDisposition: "IMPLEMENT" };
    for (const priority of ["MUST_FIX", "SHOULD_FIX", "OPTIONAL"])
      for (const assessment of ["ACTIONABLE", "ALREADY_ADDRESSED", "STALE", "TECHNICALLY_INCORRECT", "OUT_OF_SCOPE", "CONFLICTING", "NEEDS_OWNER_DECISION"])
        expect(WorkflowFeedbackFindingSchema.safeParse({ ...finding, priority, assessment }).success).toBe(true);
    expect(WorkflowFeedbackFindingSchema.safeParse({ ...finding, priority: "ACTIONABLE" }).success).toBe(false);
    expect(WorkflowFeedbackFindingSchema.safeParse({ ...finding, commentIds: [] }).success).toBe(false);
    const commentsWithBodies = bundleRefs[0]!.comments.map(c => ({ ...c, body: "comment" }));
    expect(WorkflowFeedbackBundleSchema.safeParse({ ...bundlePayload, comments: commentsWithBodies,
      commentSetDigest: createHash("sha256").update(JSON.stringify(commentsWithBodies), "utf8").digest("hex"), sourceDeliveryIds: ["delivery-1"] }).success).toBe(true);
    expect(WorkflowFeedbackBundleSchema.safeParse({ ...bundlePayload, comments: bundleRefs[0]!.comments.map(c => ({ ...c, body: "edited" })), sourceDeliveryIds: ["delivery-1"] }).success).toBe(false);
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...reviewPayload, findings: [finding] }).success).toBe(false);
    expect(WorkflowFeedbackReviewReportSchema.safeParse({ ...reviewPayload, findings: [finding, { ...finding, ...reviewRef.findingRefs[1] }] }).success).toBe(true);
  });
  it("approves a strict subset with immutable decision bindings and keeps every unselected finding", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    const approved = decideWorkflowFeedbackFindings(reviewed, request, { actorId: ownerId, role: "TASK_OWNER" }, now);
    expect(approved).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
    expect(approved.feedbackDecisions?.[0]).toMatchObject({ selectedFindingIds: ["finding-0"], selectedCommentIds: ["api-0", "api-1"], reviewDigest: reviewRef.sha256, proposalDigest: reviewRef.proposalDigest, actorId: ownerId });
    expect(approved.feedbackDecisions?.[0]?.candidates).toEqual([{ repositoryId: "api", number: 1, headSha: "d".repeat(40), candidateDigest: current.candidate!.digest, commentSetDigest: hash("c"), bundleDigest: hash("e") }]);
    expect(approved.feedbackReview?.reviewRef?.findingRefs).toHaveLength(2);
    expect(approved.pullRequests).toEqual(current.pullRequests);
    expect(() => decideWorkflowFeedbackFindings(approved, request, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
  });
  it("rejects stale or invalid digests, unknown selections, incomplete reports and cross-candidate groups", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    for (const patch of [{ reviewDigest: hash("f") }, { proposalDigest: "invalid" }, { bundleDigests: [hash("a")] }, { expectedRevision: 99 }, { selectedFindingIds: [] }, { selectedFindingIds: ["unknown"] }, { selectedFindingIds: ["finding-0", "finding-0"] }])
      expect(() => decideWorkflowFeedbackFindings(reviewed, { ...request, ...patch }, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
    expect(() => decideWorkflowFeedbackFindings(reviewed, request, { actorId: hash("f"), role: "TASK_OWNER" }, now)).toThrow();
    expect(() => requestWorkflowFeedbackReview(current, { bundleRefs: [{ ...bundleRefs[0], headSha: "f".repeat(40) }, bundleRefs[1]], reviewRef }, now)).toThrow();
    expect(() => requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef: { ...reviewRef, findingRefs: [{ ...reviewRef.findingRefs[0], commentIds: ["ui-0"] }, reviewRef.findingRefs[1]] } }, now)).toThrow();
    const blocked = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef: { ...reviewRef, status: "BLOCKED", blockReason: "critic could not verify this report" } }, now);
    expect(() => decideWorkflowFeedbackFindings(blocked, request, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
  });
  it("records attributed change notes and dismissal reasons without resolving GitHub comments", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    for (const decision of ["REQUEST_CHANGES", "DISMISS"] as const) {
      expect(() => decideWorkflowFeedbackFindings(reviewed, { ...request, decision, selectedFindingIds: [] }, { actorId: ownerId, role: "TASK_OWNER" }, now)).toThrow();
      const decided = decideWorkflowFeedbackFindings(reviewed, { ...request, decision, selectedFindingIds: [], ownerNote: "Please explain the edge case." }, { actorId: ownerId, role: "TASK_OWNER" }, now);
      expect(decided.stage).toBe("WAIT_FOR_MERGE");
      expect(decided.feedbackNotes?.[0]).toMatchObject({ actorId: ownerId, text: "Please explain the edge case.", source: decision });
      expect(decided.pullRequests).toEqual(current.pullRequests);
    }
    expect(WorkflowSnapshotSchema.safeParse(createWorkflowSnapshot({ taskId, ownerId, now })).success).toBe(true);
  });
});
