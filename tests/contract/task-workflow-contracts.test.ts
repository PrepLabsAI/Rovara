import * as workflowContracts from "../../packages/contracts/src/task-workflow.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WorkflowFeedbackBundleSchema, WorkflowFeedbackBundleRefSchema, WorkflowFeedbackReviewReportSchema, WorkflowFeedbackReviewRefSchema, WorkflowFeedbackFindingSchema,
  WorkflowFeedbackNoteSchema,
  WorkflowTransitionError,
  createCandidateManifest,
  CandidateManifestSchema,
  createWorkflowSnapshot,
  decideWorkflow,
  recordWorkflowVerification,
  submitWorkflowReview,
  recordExpectedWorkflowPullRequests,
  registerWorkflowPullRequest,
  WorkflowSnapshotSchema,
  WorkflowReviewReportSchema,
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

  it("lets reviews pass with advisory pre-existing findings and blocks only introduced ones", () => {
    const current = { ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), stage: "VERIFY" as const, state: "BLOCKED" as const };
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const reviewing = recordWorkflowVerification(current, { candidate, now: "2026-10-05T12:02:00.000Z",
      checks: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] } });
    const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", findings: unknown[]) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z" });
    const advised = submitWorkflowReview(reviewing, report("CRITIC", "PASS", [{ text: "Legacy code logs tokens", origin: "PRE_EXISTING" }]), "2026-10-05T12:03:00.000Z");
    expect(advised).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    expect(() => WorkflowReviewReportSchema.parse(report("SECURITY", "PASS", [{ text: "New SQL injection", origin: "INTRODUCED" }]))).toThrow();
    expect(submitWorkflowReview(advised, report("SECURITY", "FINDINGS", [{ text: "New SQL injection", origin: "INTRODUCED", severity: "HIGH", file: "db.ts" }]), "2026-10-05T12:04:00.000Z"))
      .toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(WorkflowReviewReportSchema.parse(report("CRITIC", "FINDINGS", ["legacy string"])).findings).toEqual([{ text: "legacy string", origin: "INTRODUCED" }]);
  });

  it("pins the base commit on the first verified candidate and refuses a later candidate with another base", () => {
    const current = { ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), stage: "VERIFY" as const, state: "BLOCKED" as const };
    const base = "e".repeat(40);
    const checks = (digest: string) => ({ candidateDigest: digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "FAILED" as const }] });
    const first = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40), baseCommitSha: base }]);
    const pinned = recordWorkflowVerification(current, { candidate: first, checks: checks(first.digest), now: "2026-10-05T12:02:00.000Z" });
    expect(pinned.reviewBase).toEqual([{ repositoryId: "payments", baseCommitSha: base }]);
    const moved = createCandidateManifest([{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "f".repeat(40) }]);
    expect(() => recordWorkflowVerification(pinned, { candidate: moved, checks: checks(moved.digest), now: "2026-10-05T12:03:00.000Z" })).toThrow(/base/);
    // A later candidate on the same base is accepted, and one that drops its base is refused.
    const next = createCandidateManifest([{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "2".repeat(40), baseCommitSha: base }]);
    expect(recordWorkflowVerification(pinned, { candidate: next, checks: checks(next.digest), now: "2026-10-05T12:03:00.000Z" }).reviewBase).toEqual(pinned.reviewBase);
    const unbased = createCandidateManifest([{ repositoryId: "payments", commitSha: "b".repeat(40), treeSha: "2".repeat(40) }]);
    expect(() => recordWorkflowVerification(pinned, { candidate: unbased, checks: checks(unbased.digest), now: "2026-10-05T12:03:00.000Z" })).toThrow(/base/);
    // A candidate without a base pins nothing.
    expect(recordWorkflowVerification(current, { candidate: unbased, checks: checks(unbased.digest), now: "2026-10-05T12:02:00.000Z" }).reviewBase).toBeUndefined();
  });

  it("keeps a stored pre-structured review with many long string findings readable and blocking", () => {
    const stored = { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: "c".repeat(64), role: "SECURITY", provider: "scripted", version: "1",
      status: "FINDINGS", findings: Array.from({ length: 50 }, (_, index) => `${index} ${"x".repeat(990)}`), readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z" };
    const parsed = WorkflowReviewReportSchema.parse(stored);
    expect(parsed.findings).toHaveLength(20);
    expect(parsed.findings.every((finding) => finding.origin === "INTRODUCED" && finding.text.length === 600)).toBe(true);
    expect(() => WorkflowReviewReportSchema.parse({ ...stored, findings: Array.from({ length: 21 }, () => ({ text: "x", origin: "INTRODUCED" })) })).toThrow();
    expect(() => WorkflowReviewReportSchema.parse({ ...stored, findings: [...Array.from({ length: 20 }, () => "legacy"), { text: "x", origin: "INTRODUCED" }] })).toThrow();
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

  it("waits on GitHub for every expected pull request once all are recorded", () => {
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
    expect(waiting).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "payments-api", state: "UNKNOWN" }, { repositoryId: "payments-ui", state: "UNKNOWN" }] });
    expect(waiting).not.toHaveProperty("outcome");
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
  });

  it("rejects persisted PR-ready or merged stages without their required evidence", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }], optional: [], selectedOptionalIds: [] } });
    expect(WorkflowSnapshotSchema.safeParse({ ...initial, stage: "PULL_REQUEST", state: "READY" }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...initial, stage: "MERGED", state: "COMPLETE", outcome: "MERGED" }).success).toBe(false);
  });

  it("requires an attributable approval for the exact current plan before implementation", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }], optional: [], selectedOptionalIds: [] } });
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
    let workflow = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z", path: "FULL", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }], optional: [], selectedOptionalIds: [] } });
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
});

describe("sending blocked work back to coding (Task 16)", () => {
  const sendBack = { requestId: "22222222-2222-4222-8222-222222222222", actorId: ownerId, reason: "Fix the findings", now: "2026-10-05T12:05:00.000Z" };
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const checks = { required: [{ id: "unit", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] };
  const review = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", findings: unknown[]) => ({
    operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role, provider: "t", version: "1", status, findings, readOnly: true, recordedAt: "2026-10-05T12:01:00.000Z",
  });
  const ready = () => ({
    ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z", checkPolicy: checks }), revision: 7, stage: "PULL_REQUEST" as const, state: "READY" as const, candidate,
    verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] },
    reviews: [review("CRITIC", "PASS", []), review("SECURITY", "PASS", [])],
  });

  it("lets only the owner send a blocked change back to coding from implementation, checks or reviews", () => {
    const base = { ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), revision: 5, blockReason: "x" };
    for (const stage of ["IMPLEMENT", "VERIFY", "REVIEW"] as const) {
      const next = workflowContracts.returnWorkflowToImplementation({ ...base, stage, state: "BLOCKED" }, sendBack);
      expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 6, decisions: [{ decision: "REQUEST_CHANGES", source: "SEND_BACK", workflowRevision: 5 }] });
      expect(next.blockReason).toBeUndefined();
    }
    expect(() => workflowContracts.returnWorkflowToImplementation({ ...base, stage: "REVIEW", state: "BLOCKED" }, { ...sendBack, actorId: "c".repeat(64) })).toThrow(workflowContracts.WorkflowTransitionError);
    expect(() => workflowContracts.returnWorkflowToImplementation({ ...base, stage: "PLAN_REVIEW", state: "WAITING" }, sendBack)).toThrow(workflowContracts.WorkflowTransitionError);
    expect(() => workflowContracts.returnWorkflowToImplementation({ ...base, stage: "REVIEW", state: "RUNNING" }, sendBack)).toThrow(workflowContracts.WorkflowTransitionError);
  });

  it("sends a change that is ready to publish, or whose publication AgentX gave up on, back to coding, keeping its evidence until new code replaces it", () => {
    const fromReady = workflowContracts.returnWorkflowToImplementation(ready(), sendBack);
    expect(fromReady).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 8, candidate });
    expect(fromReady.verification?.candidateDigest).toBe(candidate.digest);
    expect(fromReady.reviews).toHaveLength(2);
    const gaveUp = { ...ready(), state: "BLOCKED" as const, blockReason: workflowContracts.WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE };
    expect(workflowContracts.returnWorkflowToImplementation(gaveUp, sendBack)).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 8 });
    // A pull request already opened for one repository would be left behind by new code: that is refused, not stranded silently.
    const partlyPublished = { ...ready(), pullRequests: [{ repositoryId: "demo", number: 4, url: "https://github.com/example/demo/pull/4", headSha: "d".repeat(40), candidateDigest: candidate.digest, required: true, state: "UNKNOWN" as const }] };
    expect(() => workflowContracts.returnWorkflowToImplementation(partlyPublished, sendBack)).toThrow(/pull request/);
    // A request ID already used for another decision is refused.
    expect(() => workflowContracts.returnWorkflowToImplementation({ ...fromReady, stage: "IMPLEMENT", state: "BLOCKED" }, sendBack)).toThrow(workflowContracts.WorkflowTransitionError);
  });

  it("lists the introduced review findings and the failed checks as the coder's problems to fix, never pre-existing ones", () => {
    const blocked = { ...ready(), stage: "REVIEW" as const, state: "BLOCKED" as const, blockReason: "the critic review did not pass", reviews: [
      review("CRITIC", "FINDINGS", [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }, { text: "No test covers empty input.", origin: "INTRODUCED" }]),
      review("SECURITY", "PASS", [{ text: "Old logger prints emails.", origin: "PRE_EXISTING", file: "src/log.ts" }]),
    ] };
    expect(workflowContracts.sendBackInstructions(WorkflowSnapshotSchema.parse(blocked))).toBe(
      "- [code review] The new parser drops the last line. (src/parse.ts:40)\n- [code review] No test covers empty input.");
    const failedChecks = { ...ready(), stage: "VERIFY" as const, state: "BLOCKED" as const, blockReason: "candidate checks failed or have unknown results", reviews: [],
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "FAILED" as const }] } };
    expect(workflowContracts.sendBackInstructions(WorkflowSnapshotSchema.parse(failedChecks))).toBe("- check npm test failed");
    expect(workflowContracts.sendBackInstructions(WorkflowSnapshotSchema.parse(ready()))).toBe("- No check or review problems were recorded; follow the owner note.");
  });

  it("counts only evidence about the current code: older checks and reviews neither offer a send-back nor reach the coder", () => {
    const older = "f".repeat(64);
    const staleChecks = WorkflowSnapshotSchema.parse({ ...ready(), stage: "VERIFY", state: "BLOCKED", blockReason: "AgentX could not read a valid check report.", reviews: [],
      verification: { candidateDigest: older, producer: "t", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "FAILED" }] } });
    expect(workflowContracts.workflowSendBackOffered(staleChecks)).toBe(false);
    expect(workflowContracts.sendBackProblems(staleChecks)).toEqual([]);
    const staleReview = WorkflowSnapshotSchema.parse({ ...ready(), stage: "REVIEW", state: "BLOCKED", blockReason: "x",
      reviews: [{ ...review("CRITIC", "FINDINGS", [{ text: "Gone code.", origin: "INTRODUCED" }]), candidateDigest: older }] });
    expect(workflowContracts.workflowSendBackOffered(staleReview)).toBe(false);
    expect(workflowContracts.sendBackProblems(staleReview)).toEqual([]);
    const current = WorkflowSnapshotSchema.parse({ ...staleReview, reviews: [review("CRITIC", "FINDINGS", [{ text: "Live code.", origin: "INTRODUCED" }])] });
    expect(workflowContracts.workflowSendBackOffered(current)).toBe(true);
    expect(workflowContracts.sendBackProblems(current)).toEqual([{ source: "code review", text: "Live code." }]);
  });
});
