import { describe, expect, it } from "vitest";
import {
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
      repositoryId: "payments-api", number: 11, url: "https://github.com/acme/api/pull/11", candidateDigest: candidate.digest, required: true,
    }, "2026-10-05T12:04:00.000Z");
    expect(first).toMatchObject({ stage: "PULL_REQUEST", state: "READY", pullRequests: [{ repositoryId: "payments-api", state: "UNKNOWN" }] });
    const completeSet = registerWorkflowPullRequest(first, {
      repositoryId: "payments-ui", number: 12, url: "https://github.com/acme/ui/pull/12", candidateDigest: candidate.digest, required: true,
    }, "2026-10-05T12:05:00.000Z");
    expect(completeSet).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "payments-api" }, { repositoryId: "payments-ui" }] });
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
