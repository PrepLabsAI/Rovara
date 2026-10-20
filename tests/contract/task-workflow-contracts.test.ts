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
  WorkflowSnapshotSchema,
  WorkflowReviewReportSchema,
  submitWorkflowArtifact,
  StartDeveloperTaskRequestSchema,
  WorkflowDecisionRequestSchema,
  WorkflowDecisionSchema,
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
  it("advances required E2E to review only with a candidate and current-round-bound trusted aggregate", () => {
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "b".repeat(40) }]);
    const roundId = "11111111-1111-4111-8111-111111111111";
    const groupRunIds = ["22222222-2222-4222-8222-222222222222"];
    const e2e = { contractDigest: "c".repeat(64), policyDigest: "d".repeat(64), bundleDigest: "e".repeat(64),
      executionPlanDigest: "f".repeat(64), required: true, currentRoundId: roundId, currentGroupRunIds: groupRunIds, resultRefs: [] };
    const current = workflowContracts.WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }),
      stage: "VERIFY", state: "BLOCKED", e2e });
    const checks = { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z",
      results: [{ checkId: "unit", status: "PASS" as const }] };
    const qualification = { candidateDigest: candidate.digest, contractDigest: e2e.contractDigest, policyDigest: e2e.policyDigest,
      bundleDigest: e2e.bundleDigest, executionPlanDigest: e2e.executionPlanDigest, roundId, groupRunIds,
      admissionSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) };

    const ordinaryOnly = workflowContracts.recordWorkflowVerification(current, { candidate, checks, now: "2026-10-05T12:02:00.000Z" });
    expect(ordinaryOnly).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    expect(ordinaryOnly.e2e?.qualifiedRound).toBeUndefined();

    const qualified = workflowContracts.recordWorkflowVerification(current, { candidate, checks, now: "2026-10-05T12:02:00.000Z", e2eQualification: qualification });
    expect(qualified).toMatchObject({ stage: "REVIEW", state: "WAITING", e2e: { qualifiedRound: qualification } });
    expect(() => workflowContracts.WorkflowSnapshotSchema.parse({ ...qualified, e2e: { ...qualified.e2e!, qualifiedRound: { ...qualification, roundId: "33333333-3333-4333-8333-333333333333" } } })).toThrow(/current candidate, contract, plan, and round/);
  });

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

  it("never blocks on an advisory finding, and still blocks on a non-advisory one", () => {
    const current = { ...createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" }), stage: "VERIFY" as const, state: "BLOCKED" as const };
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const reviewing = recordWorkflowVerification(current, { candidate, now: "2026-10-05T12:02:00.000Z",
      checks: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] } });
    const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", findings: unknown[]) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: "2026-10-05T12:03:00.000Z" });
    const advisory = { text: "The plan asks for a long timeout, which looks unwise.", origin: "INTRODUCED" as const, advisory: true as const };
    // An advisory introduced finding lets a review pass, and counts for nothing that blocks.
    expect(WorkflowReviewReportSchema.parse(report("CRITIC", "PASS", [advisory])).findings).toEqual([advisory]);
    expect(workflowContracts.blockingFindings(WorkflowReviewReportSchema.parse(report("CRITIC", "PASS", [advisory])))).toEqual([]);
    // A review whose only introduced finding is advisory cannot claim FINDINGS; one real finding still can.
    expect(() => WorkflowReviewReportSchema.parse(report("CRITIC", "FINDINGS", [advisory]))).toThrow();
    const real = { text: "New parser drops the last line.", origin: "INTRODUCED" as const };
    expect(workflowContracts.blockingFindings(WorkflowReviewReportSchema.parse(report("CRITIC", "FINDINGS", [advisory, real])))).toEqual([real]);
    expect(() => WorkflowReviewReportSchema.parse(report("CRITIC", "PASS", [advisory, real]))).toThrow();
    // advisory: false is the same as not saying so.
    expect(() => WorkflowReviewReportSchema.parse(report("CRITIC", "PASS", [{ ...real, advisory: false }]))).toThrow();
    expect(() => WorkflowReviewReportSchema.parse(report("CRITIC", "PASS", [{ ...real, advisory: "yes" }]))).toThrow();
    // The flag is never honoured on a SECURITY finding: only the owner's accept waives one. It blocks, is sent back, and a passing security review cannot carry it.
    const securityNote = { text: "Token is logged.", origin: "INTRODUCED" as const, advisory: true as const };
    expect(() => WorkflowReviewReportSchema.parse(report("SECURITY", "PASS", [securityNote]))).toThrow();
    expect(workflowContracts.blockingFindings(WorkflowReviewReportSchema.parse(report("SECURITY", "FINDINGS", [securityNote])))).toEqual([securityNote]);
    const withSecurity = WorkflowSnapshotSchema.parse({ ...reviewing, stage: "REVIEW", state: "BLOCKED", blockReason: "the security review did not pass",
      reviews: [report("CRITIC", "PASS", [advisory]), report("SECURITY", "FINDINGS", [securityNote])] });
    expect(workflowContracts.workflowSendBackOffered(withSecurity)).toBe(true);
    expect(workflowContracts.sendBackProblems(withSecurity)).toEqual([{ source: "security review", text: "Token is logged." }]);
    // Both reviews passing, the code review with an advisory note, reaches PR readiness.
    const withAdvisory = submitWorkflowReview(reviewing, report("SECURITY", "PASS", [{ text: "Old logger prints emails", origin: "PRE_EXISTING" }]), "2026-10-05T12:03:00.000Z");
    expect(withAdvisory).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    const ready = submitWorkflowReview(withAdvisory, report("CRITIC", "PASS", [advisory]), "2026-10-05T12:04:00.000Z");
    expect(ready).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(workflowContracts.sendBackProblems(ready)).toEqual([]);
    // Send back is offered and sent for the real finding only.
    const blocked = WorkflowSnapshotSchema.parse({ ...ready, stage: "REVIEW", state: "BLOCKED", blockReason: "the critic review did not pass",
      reviews: [report("CRITIC", "FINDINGS", [advisory, real]), report("SECURITY", "PASS", [])] });
    expect(workflowContracts.workflowSendBackOffered(blocked)).toBe(true);
    expect(workflowContracts.sendBackProblems(blocked)).toEqual([{ source: "code review", text: "New parser drops the last line." }]);
    // Where every introduced finding is an advisory code-review note, nothing is sent back.
    const onlyAdvisory = WorkflowSnapshotSchema.parse({ ...blocked, reviews: [report("CRITIC", "PASS", [advisory]), report("SECURITY", "PASS", [])] });
    expect(workflowContracts.workflowSendBackOffered(onlyAdvisory)).toBe(false);
    expect(workflowContracts.sendBackProblems(onlyAdvisory)).toEqual([]);
    // A report stored before the flag existed behaves as before.
    expect(workflowContracts.blockingFindings(WorkflowReviewReportSchema.parse(report("CRITIC", "FINDINGS", ["legacy string", { text: "x", origin: "INTRODUCED" }])))).toHaveLength(2);
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

  it("the decision request and record carry the owner's answers and included comments within their limits", () => {
    const base = { requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f2b", expectedRevision: 2, decision: "APPROVE", artifactDigest: plan.sha256, reason: "Approved." };
    const commentId = "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11";
    expect(WorkflowDecisionRequestSchema.safeParse({ ...base, answers: [{ decisionId: "d1", optionId: "above", opened: true }], includedCommentIds: [commentId] }).success).toBe(true);
    expect(WorkflowDecisionRequestSchema.safeParse({ ...base, answers: [{ decisionId: "d1", optionId: "above", opened: true }, { decisionId: "d1", optionId: "below", opened: true }] }).success).toBe(false);
    expect(WorkflowDecisionRequestSchema.safeParse({ ...base, answers: [{ decisionId: "d1", optionId: "above" }] }).success).toBe(false);
    expect(WorkflowDecisionRequestSchema.safeParse({ ...base, includedCommentIds: [commentId, commentId] }).success).toBe(false);
    expect(WorkflowDecisionRequestSchema.safeParse({ ...base, includedCommentIds: ["c1"] }).success).toBe(false);
    const recorded = { requestId: base.requestId, workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "Approved.", at: "2026-10-05T12:02:00.000Z" };
    expect(WorkflowDecisionSchema.safeParse({ ...recorded, answerOverrides: [{ decisionId: "d1", optionId: "above" }], commentsIncluded: 2, via: "PAGE" }).success).toBe(true);
    expect(WorkflowDecisionSchema.safeParse({ ...recorded, commentsIncluded: 26 }).success).toBe(false);
    expect(WorkflowDecisionSchema.safeParse({ ...recorded, via: "SLACK" }).success).toBe(false);
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

describe("what each pull request holds, for a fix that may have changed nothing", () => {
  it("uses every pull request's recorded tree whatever its state, and the candidate only for a repository with no pull request", () => {
    const tree = (c: string) => c.repeat(40);
    const workflow = { candidate: { digest: "f".repeat(64), repositories: [{ repositoryId: "a", treeSha: tree("1") }, { repositoryId: "b", treeSha: tree("2") }, { repositoryId: "c", treeSha: tree("3") }] },
      pullRequests: [
        { repositoryId: "a", number: 1, state: "OPEN", headTreeSha: tree("a"), candidateDigest: "e".repeat(64) },
        { repositoryId: "b", number: 2, state: "MERGED", headTreeSha: tree("b"), candidateDigest: "e".repeat(64) },
      ] } as unknown as Parameters<typeof workflowContracts.workflowPullRequestTrees>[0];
    expect(workflowContracts.workflowPullRequestTrees(workflow)).toEqual(new Map([["a", tree("a")], ["b", tree("b")], ["c", tree("3")]]));
    const unknownOpen = { ...workflow, pullRequests: [{ repositoryId: "a", number: 1, state: "OPEN", candidateDigest: "e".repeat(64) }] } as typeof workflow;
    expect(workflowContracts.workflowPullRequestTrees(unknownOpen)).toBeUndefined();
  });
});

describe("the task snapshot's storage budget", () => {
  it("counts the review threads remembered between rounds (feedbackThreadObservations)", () => {
    const taskId = "11111111-2222-4333-8444-555555555555";
    const ownerId = "a".repeat(64);
    const workflow = createWorkflowSnapshot({ taskId, ownerId, now: "2026-10-05T12:00:00.000Z" });
    const observation = (index: number) => ({ repositoryId: "demo", number: 1, threadId: `thread-${index}`, resolved: true,
      comments: Array.from({ length: 128 }, (_, comment) => ({ id: `review_comment:${index}-${comment}`, updatedAt: "2026-10-05T12:00:00.000Z", bodyDigest: "b".repeat(64) })),
      eligibleCommentIds: [] });
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, feedbackThreadObservations: [observation(1)] }).success).toBe(true);
    const tooMany = WorkflowSnapshotSchema.safeParse({ ...workflow, feedbackThreadObservations: Array.from({ length: 30 }, (_, index) => observation(index)) });
    expect(tooMany.success).toBe(false);
    expect(JSON.stringify(tooMany.error?.issues)).toContain("workflow metadata exceeds the task snapshot storage budget");
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
  describe("a failed review and its retry", () => {
    const failedRun = (status: "FAILED" | "BLOCKED" | "INTERRUPTED" = "FAILED", blockReason = "reviewer output: not valid JSON") => {
      const { current, bundleRefs, reviewRef } = fixture();
      const collected = workflowContracts.collectWorkflowFeedbackBundles(current, { bundleRefs, threadObservations: [] }, now);
      const running = { ...collected, revision: collected.revision + 1, state: "RUNNING" as const };
      const failedRef = { ...reviewRef, status, blockReason, findingRefs: [] };
      const failed = completeWorkflowFeedbackReview(running, { expectedRevision: running.revision, taskId, candidateDigest: current.candidate!.digest,
        operationId: reviewRef.operationId, bundleRefs, reviewRef: failedRef }, now);
      return { failed, failedRef, bundleRefs, reviewRef, current };
    };
    const owner = { actorId: ownerId, role: "TASK_OWNER" as const };

    it("keeps the task waiting for merge with the failed report pending", () => {
      const { failed, failedRef } = failedRun();
      expect(failed).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: failedRef } });
    });

    it("moves a failed review back to collecting on the same comments, one revision on", () => {
      const { failed, failedRef, bundleRefs } = failedRun();
      const retried = workflowContracts.retryWorkflowFeedbackReview(failed, { reviewDigest: failedRef.sha256, actor: owner, now });
      expect(retried).toMatchObject({ revision: failed.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING",
        feedbackReview: { status: "COLLECTING", bundleRefs, threadObservations: [] } });
      expect(retried.feedbackReview?.reviewRef).toBeUndefined();
      expect(retried.feedbackReviewHistory).toContainEqual(failedRef);
    });

    it("retries a review that timed out or was interrupted the same way", () => {
      for (const [status, reason] of [["BLOCKED", "review timed out"], ["INTERRUPTED", "review was cancelled"]] as const) {
        const { failed, failedRef } = failedRun(status, reason);
        expect(workflowContracts.retryWorkflowFeedbackReview(failed, { reviewDigest: failedRef.sha256, actor: owner, now }).feedbackReview, status)
          .toMatchObject({ status: "COLLECTING" });
      }
    });

    it("refuses a retry of a complete report, of another report, by someone else, or once the task moved", () => {
      const { failed, failedRef, current, bundleRefs, reviewRef } = failedRun();
      const retry = (snapshot: unknown, digest = failedRef.sha256, actor: { actorId: string; role: "TASK_OWNER" | "PROJECT_ADMIN" } = owner) =>
        () => workflowContracts.retryWorkflowFeedbackReview(snapshot, { reviewDigest: digest, actor, now });
      const complete = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
      expect(retry(complete, reviewRef.sha256)).toThrow(workflowContracts.WorkflowTransitionError);
      expect(retry(failed, "9".repeat(64))).toThrow(workflowContracts.WorkflowTransitionError);
      expect(retry(failed, failedRef.sha256, { actorId: "f".repeat(64), role: "TASK_OWNER" })).toThrow(workflowContracts.WorkflowTransitionError);
      expect(retry(failed, failedRef.sha256, { actorId: ownerId, role: "PROJECT_ADMIN" })).toThrow(workflowContracts.WorkflowTransitionError);
      expect(retry({ ...failed, state: "RUNNING" })).toThrow(workflowContracts.WorkflowTransitionError);
      const retried = workflowContracts.retryWorkflowFeedbackReview(failed, { reviewDigest: failedRef.sha256, actor: owner, now });
      expect(retry(retried)).toThrow(workflowContracts.WorkflowTransitionError);
    });
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
  it("keeps the reviewed tree of a pull request recorded without one when the owner approves a fix", () => {
    const { current, bundleRefs, reviewRef, request } = fixture();
    expect(current.pullRequests?.every(pr => pr.headTreeSha === undefined)).toBe(true);
    const reviewed = requestWorkflowFeedbackReview(current, { bundleRefs, reviewRef }, now);
    const approved = decideWorkflowFeedbackFindings(reviewed, request, { actorId: ownerId, role: "TASK_OWNER" }, now);
    expect(approved).toMatchObject({ stage: "IMPLEMENT", pullRequests: [{ repositoryId: "api", headTreeSha: "1".repeat(40) }, { repositoryId: "ui", headTreeSha: "2".repeat(40) }] });
    // Another decision changes no pull request.
    const dismissed = decideWorkflowFeedbackFindings(reviewed, { ...request, decision: "DISMISS", selectedFindingIds: [], ownerNote: "Not now." }, { actorId: ownerId, role: "TASK_OWNER" }, now);
    expect(dismissed.pullRequests?.every(pr => pr.headTreeSha === undefined)).toBe(true);
  });
  it("records a pull request's head tree without a new revision, only for its recorded head and reviewed code", () => {
    const { current } = fixture();
    const recorded = workflowContracts.recordWorkflowPullRequestHeadTrees(current, [{ repositoryId: "api", number: 1, headSha: "d".repeat(40), headTreeSha: "1".repeat(40) }], now);
    expect(recorded.revision).toBe(current.revision);
    expect(recorded.pullRequests?.map(pr => pr.headTreeSha)).toEqual(["1".repeat(40), undefined]);
    for (const wrong of [{ headSha: "e".repeat(40) }, { headTreeSha: "2".repeat(40) }, { number: 9 }]) {
      expect(() => workflowContracts.recordWorkflowPullRequestHeadTrees(current, [{ repositoryId: "api", number: 1, headSha: "d".repeat(40), headTreeSha: "1".repeat(40), ...wrong }], now))
        .toThrow(workflowContracts.WorkflowTransitionError);
    }
    // A tree already recorded is never replaced.
    expect(() => workflowContracts.recordWorkflowPullRequestHeadTrees(recorded, [{ repositoryId: "api", number: 1, headSha: "d".repeat(40), headTreeSha: "1".repeat(40) }], now))
      .toThrow(workflowContracts.WorkflowTransitionError);
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
    // The same pull requests, which now keep the reviewed tree they were opened with.
    expect(approved.pullRequests).toEqual(current.pullRequests!.map(pr => ({ ...pr, headTreeSha: current.candidate!.repositories.find(repo => repo.repositoryId === pr.repositoryId)!.treeSha })));
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

  it("lists the tests a review-only rerun found regressed as problems, with what to do about them, until new results replace them", () => {
    const regressed = workflowContracts.blockWorkflow({ ...ready(), stage: "VERIFY", state: "RUNNING", reviews: [], verification: undefined },
      workflowContracts.WORKFLOW_BLOCK_REASONS.regressionFound, "2026-10-05T12:02:00.000Z", { regressedChecks: ["npm test -- retry"] });
    expect(regressed.regressedChecks).toEqual(["npm test -- retry"]);
    expect(workflowContracts.sendBackProblems(regressed)).toEqual([{ source: "check", text: "npm test -- retry passed before this change and fails now", regressed: true }]);
    expect(workflowContracts.sendBackInstructions(regressed)).toBe(
      `- check npm test -- retry passed before this change and fails now\n${workflowContracts.WORKFLOW_REGRESSION_INSTRUCTION}`);
    expect(workflowContracts.WORKFLOW_REGRESSION_INSTRUCTION).toBe("These tests passed before this change and fail now. If the task intentionally changes this behaviour, update the tests to match it; otherwise fix the code.");
    // Sent back, the coding step still knows what regressed; the next block or verification replaces it.
    const sent = workflowContracts.returnWorkflowToImplementation(regressed, sendBack);
    expect(workflowContracts.sendBackProblems(sent)).toHaveLength(1);
    expect(workflowContracts.blockWorkflow(sent, "implementation operation ended failed", "2026-10-05T12:03:00.000Z").regressedChecks).toBeUndefined();
    expect(() => workflowContracts.blockWorkflow(regressed, "x", "2026-10-05T12:03:00.000Z", { regressedChecks: Array.from({ length: 9 }, (_, index) => `t${index}`) })).toThrow();
  });

  it("never sends a broken check to the coder, and offers Send back only for a real failure", () => {
    const verification = (results: Array<Record<string, unknown>>) => WorkflowSnapshotSchema.parse({ ...ready(), stage: "VERIFY", state: "BLOCKED", blockReason: "x", reviews: [],
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z", results } });
    const allBroken = verification([{ checkId: "unit", status: "FAILED", broken: true }, { checkId: "lint", status: "FAILED", programNotFound: true }]);
    expect(workflowContracts.workflowSendBackOffered(allBroken)).toBe(false);
    expect(workflowContracts.sendBackProblems(allBroken)).toEqual([]);
    const mixed = verification([{ checkId: "unit", status: "FAILED", broken: true }, { checkId: "lint", status: "FAILED" }]);
    expect(workflowContracts.workflowSendBackOffered(mixed)).toBe(true);
    expect(workflowContracts.sendBackProblems(mixed)).toEqual([{ source: "check", text: "lint failed" }]);
    expect(workflowContracts.WORKFLOW_BLOCK_REASONS.checksBroken).toBe("the checks couldn't run");
  });

  it("offers Send Back from a refused application round, and tells the coder why, but not from a changed selection (which approving the plan again fixes)", () => {
    const base = { ...ready(), stage: "VERIFY" as const, state: "BLOCKED" as const, reviews: [],
      e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] },
      verification: { candidateDigest: candidate.digest, producer: "agentx-worker-checks", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z", results: [{ checkId: "unit", status: "PASS" as const }] } };
    const refused = WorkflowSnapshotSchema.parse({ ...base, blockReason: `${workflowContracts.WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}a source file is over the per-file limit. Send the task back to coding, or close it.` });
    expect(workflowContracts.workflowSendBackOffered(refused)).toBe(true);
    expect(workflowContracts.sendBackProblems(refused)).toEqual([{ source: "check", text: "the browser and API checks could not be started: a source file is over the per-file limit." }]);
    const changed = WorkflowSnapshotSchema.parse({ ...base, blockReason: `${workflowContracts.WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}the web runtime was replaced` });
    expect(workflowContracts.workflowSendBackOffered(changed)).toBe(false);
    expect(workflowContracts.sendBackProblems(changed)).toEqual([]);
    // Only a task whose E2E round is required is offered it.
    const notRequired = WorkflowSnapshotSchema.parse({ ...base, e2e: { ...base.e2e, required: false }, blockReason: refused.blockReason });
    expect(workflowContracts.workflowSendBackOffered(notRequired)).toBe(false);
  });

  it("never offers Send Back for a block that only a runtime change or approving the plan again can fix, even for a task with no checks (Fix round 1, I2)", () => {
    const base = { ...ready(), stage: "VERIFY" as const, state: "BLOCKED" as const, reviews: [],
      e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } };
    for (const prefix of [workflowContracts.WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, workflowContracts.WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX]) {
      const withChecks = WorkflowSnapshotSchema.parse({ ...base, blockReason: `${prefix}the web runtime expires first` });
      expect(workflowContracts.workflowSendBackOffered(withChecks)).toBe(false);
      // A task with no check at all is "review only", for which coding again is otherwise always offered; these blocks are the exception.
      const reviewOnly = WorkflowSnapshotSchema.parse({ ...base, checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] }, blockReason: `${prefix}the web runtime expires first` });
      expect(workflowContracts.workflowSendBackOffered(reviewOnly)).toBe(false);
      expect(workflowContracts.sendBackProblems(reviewOnly)).toEqual([]);
    }
    // The administrator's remedy is stated before the reason, so it survives the workflow's 500 character block reason.
    expect(workflowContracts.WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX).toMatch(/administrator must qualify the runtime again.*retry the checks/i);
    expect(workflowContracts.WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX).not.toMatch(/send the task back/i);
    expect(workflowContracts.WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX).toMatch(/request changes/i);
  });

  it("offers Send Back from a broker-bound current E2E failure even when ordinary checks passed", () => {
    const roundId = "11111111-1111-4111-8111-111111111111";
    const runId = "22222222-2222-4222-8222-222222222222";
    const failed = WorkflowSnapshotSchema.parse({ ...ready(), stage: "VERIFY", state: "BLOCKED", blockReason: "opaque diagnostic text", reviews: [],
      e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true,
        currentRoundId: roundId, currentGroupRunIds: [runId], resultRefs: [], failedRound: { status: "FAILED", candidateDigest: candidate.digest,
          roundId, groupRunIds: [runId], admissionSha256: "e".repeat(64), evidenceSha256: "f".repeat(64) } },
      verification: { candidateDigest: candidate.digest, producer: "agentx-worker-checks", environmentId: "w", recordedAt: "2026-10-05T12:01:00.000Z",
        results: [{ checkId: "unit", status: "PASS" }] } });
    expect(workflowContracts.workflowSendBackOffered(failed)).toBe(true);
    expect(workflowContracts.sendBackProblems(failed)).toEqual([{ source: "check", text: `required E2E verification failed for the current round (${runId})` }]);
    const stale = WorkflowSnapshotSchema.parse({ ...failed, e2e: { ...failed.e2e!, currentRoundId: "33333333-3333-4333-8333-333333333333" } });
    expect(workflowContracts.workflowSendBackOffered(stale)).toBe(false);
    expect(workflowContracts.sendBackProblems(stale)).toEqual([]);
    const proseOnly = WorkflowSnapshotSchema.parse({ ...failed, e2e: { ...failed.e2e!, failedRound: undefined } });
    expect(workflowContracts.workflowSendBackOffered(proseOnly)).toBe(false);
    expect(workflowContracts.sendBackProblems(proseOnly)).toEqual([]);
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

describe("proposed checks and review-only verification", () => {
  const now = "2026-10-05T12:00:00.000Z";
  const command = { cwd: "workspace/payments", executable: "npx", args: ["vitest", "run"], timeoutSeconds: 600 };
  const proposal = { proposed: [{ id: "proposed-1", label: "Retry tests", command }], noneReason: "Only docs change otherwise." };
  const empty = { required: [], optional: [], selectedOptionalIds: [] };
  const actor = { actorId: ownerId, role: "TASK_OWNER" as const };
  const decide = (workflow: unknown, decision: "APPROVE" | "REQUEST_CHANGES", digest: string, requestId: string) => decideWorkflow(workflow, {
    requestId, expectedRevision: (workflow as { revision: number }).revision, decision, artifactDigest: digest, reason: "Owner decision",
  }, actor, { now, allowedSkipStages: [] });
  const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const reviewOnly = { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci-local", recordedAt: now, results: [], reviewOnly: true };
  const verifying = (checkPolicy: unknown) => ({ ...createWorkflowSnapshot({ taskId, ownerId, now }), checkPolicy, stage: "VERIFY" as const, state: "WAITING" as const });

  it("keeps a stored check policy without proposed checks readable, as an empty proposal", () => {
    const legacy = { ...createWorkflowSnapshot({ taskId, ownerId, now }), checkPolicy: empty };
    expect(WorkflowSnapshotSchema.parse(legacy).checkPolicy).toEqual({ ...empty, proposed: [] });
    expect(WorkflowSnapshotSchema.parse(legacy).checkPolicy).not.toHaveProperty("proposalNote");
  });

  it("refuses duplicate ids across project and proposed checks, and a proposal over the limits", () => {
    const required = [{ id: "proposed-1", label: "npm test", command }];
    expect(workflowContracts.WorkflowCheckPolicySchema.safeParse({ ...empty, required, proposed: proposal.proposed }).success).toBe(false);
    expect(workflowContracts.WorkflowCheckPolicySchema.safeParse({ ...empty, proposed: Array.from({ length: 9 }, (_, index) => ({ id: `proposed-${index + 1}`, label: "x", command })) }).success).toBe(false);
    expect(workflowContracts.WorkflowCheckPolicySchema.safeParse({ ...empty, proposed: [], noneReason: "x".repeat(301) }).success).toBe(false);
    expect(workflowContracts.WorkflowCheckPolicySchema.safeParse({ ...empty, proposed: [], proposalNote: "x".repeat(201) }).success).toBe(false);
  });

  it("stores a coding plan's proposal and clears it, with the optional choice, when a new plan version arrives", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now, checkPolicy: { ...empty, optional: [{ id: "lint", label: "Lint", command }] } });
    const waiting = submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: plan, now, proposal });
    expect(waiting.checkPolicy).toMatchObject({ proposed: proposal.proposed, noneReason: proposal.noneReason });
    const changes = decide(waiting, "REQUEST_CHANGES", plan.sha256, "d532a6e0-3de1-44e3-a6d2-e8c635d77f20");
    const plan2 = { ...plan, id: "plan-v2", version: 2, sha256: "c".repeat(64), objectKey: `tasks/${taskId}/plan-v2.md` };
    const revised = submitWorkflowArtifact({ ...changes, stage: "PLAN", state: "RUNNING", checkPolicy: { ...changes.checkPolicy, selectedOptionalIds: ["lint"], selectedProposedIds: [] } },
      { expectedRevision: changes.revision, artifact: plan2, now });
    expect(revised.checkPolicy).toEqual({ required: [], optional: [{ id: "lint", label: "Lint", command }], selectedOptionalIds: [], proposed: [] });
    const unreadable = submitWorkflowArtifact({ ...changes, stage: "PLAN", state: "RUNNING" },
      { expectedRevision: changes.revision, artifact: plan2, now, proposal: { proposed: [], proposalNote: "AgentX could not read the proposed checks" } });
    expect(unreadable.checkPolicy).toMatchObject({ proposed: [], proposalNote: "AgentX could not read the proposed checks" });
    expect(unreadable.checkPolicy).not.toHaveProperty("noneReason");
  });

  it("takes a proposal only with a coding plan", () => {
    const full = createWorkflowSnapshot({ taskId, ownerId, now, path: "FULL", checkPolicy: empty });
    const requirements = { ...plan, id: "requirements-v1", type: "requirements" as const, objectKey: `tasks/${taskId}/requirements-v1.md` };
    expect(() => submitWorkflowArtifact(full, { expectedRevision: full.revision, artifact: requirements, now, proposal })).toThrow(WorkflowTransitionError);
    expect(submitWorkflowArtifact(full, { expectedRevision: full.revision, artifact: requirements, now }).checkPolicy).toMatchObject({ proposed: [] });
  });

  it("ignores a proposal for a task stored without a check policy, which keeps running the project's checks", () => {
    const bare = createWorkflowSnapshot({ taskId, ownerId, now });
    expect(submitWorkflowArtifact(bare, { expectedRevision: bare.revision, artifact: plan, now, proposal }).checkPolicy).toBeUndefined();
  });

  it("approves a coding plan with no checks to run, and still refuses a stale approval", () => {
    const initial = createWorkflowSnapshot({ taskId, ownerId, now, checkPolicy: empty });
    const waiting = submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: plan, now });
    expect(() => decideWorkflow(waiting, { requestId: "d532a6e0-3de1-44e3-a6d2-e8c635d77f21", expectedRevision: waiting.revision - 1, decision: "APPROVE",
      artifactDigest: plan.sha256, reason: "Old press" }, actor, { now, allowedSkipStages: [] })).toThrow(/stale/);
    expect(decide(waiting, "APPROVE", plan.sha256, "d532a6e0-3de1-44e3-a6d2-e8c635d77f22")).toMatchObject({ stage: "IMPLEMENT", state: "READY", outcome: "PASSED" });
    // A legacy task with no check policy at all approves the same way.
    const bare = createWorkflowSnapshot({ taskId, ownerId, now });
    const bareWaiting = submitWorkflowArtifact(bare, { expectedRevision: bare.revision, artifact: plan, now });
    expect(decide(bareWaiting, "APPROVE", plan.sha256, "d532a6e0-3de1-44e3-a6d2-e8c635d77f23")).toMatchObject({ stage: "IMPLEMENT" });
  });

  it("records a review-only verification only when no check was selected, and only with no results", () => {
    expect(recordWorkflowVerification(verifying(empty), { candidate, checks: reviewOnly, now })).toMatchObject({ stage: "REVIEW", state: "WAITING", verification: { reviewOnly: true, results: [] } });
    // A task stored without a check policy runs the project's checks, so it is never review only.
    expect(() => recordWorkflowVerification(verifying(undefined), { candidate, checks: reviewOnly, now })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowVerification(verifying({ ...empty, proposed: proposal.proposed }), { candidate, checks: reviewOnly, now })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowVerification(verifying({ ...empty, required: [{ id: "required-1", label: "npm test", command }] }), { candidate, checks: reviewOnly, now })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowVerification(verifying({ ...empty, optional: [{ id: "lint", label: "Lint", command }], selectedOptionalIds: ["lint"] }), { candidate, checks: reviewOnly, now })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowVerification(verifying(empty), { candidate, checks: { ...reviewOnly, reviewOnly: undefined }, now })).toThrow(WorkflowTransitionError);
    expect(() => recordWorkflowVerification(verifying(empty), { candidate, checks: { ...reviewOnly, results: [{ checkId: "x", status: "PASS" as const }] }, now })).toThrow(WorkflowTransitionError);
    // The candidate is still validated exactly as with checks.
    expect(() => recordWorkflowVerification(verifying(empty), { candidate, checks: { ...reviewOnly, candidateDigest: "f".repeat(64) }, now })).toThrow(WorkflowTransitionError);
    const pinned = { ...verifying(empty), reviewBase: [{ repositoryId: "payments", baseCommitSha: "d".repeat(40) }] };
    expect(() => recordWorkflowVerification(pinned, { candidate, checks: reviewOnly, now })).toThrow(/base/);
  });

  it("lets a review-only change reach pull request readiness only when no check was selected", () => {
    const review = (role: "CRITIC" | "SECURITY") => ({ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role,
      provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
    const ready = (checkPolicy: unknown, verification: unknown) => ({ ...createWorkflowSnapshot({ taskId, ownerId, now }), checkPolicy, revision: 7,
      stage: "PULL_REQUEST", state: "READY", candidate, verification, reviews: [review("CRITIC"), review("SECURITY")] });
    expect(WorkflowSnapshotSchema.safeParse(ready(empty, reviewOnly)).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse(ready(undefined, reviewOnly)).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse(ready({ ...empty, proposed: proposal.proposed }, reviewOnly)).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse(ready(empty, { ...reviewOnly, reviewOnly: undefined })).success).toBe(false);
    const passed = { ...reviewOnly, reviewOnly: undefined, results: [{ checkId: "proposed-1", status: "PASS" }] };
    expect(WorkflowSnapshotSchema.safeParse(ready({ ...empty, proposed: proposal.proposed }, passed)).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse(ready({ ...empty, proposed: proposal.proposed }, { ...passed, results: [{ checkId: "proposed-1", status: "FAILED" }] })).success).toBe(false);
  });

  describe("pushing an approved PR feedback fix to the existing pull request", () => {
    const at = (minute: number) => `2026-10-05T12:${String(minute).padStart(2, "0")}:00.000Z`;
    const first = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const fix = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const passed = (candidate: typeof fix) => ({
      candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: at(1), results: [{ checkId: "unit", status: "PASS" as const }] },
      reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: at(2) })),
    });
    /** The fix passed its checks and reviews; the pull request still holds the first reviewed code. */
    const ready = () => WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId, now: at(0) }), revision: 9, stage: "PULL_REQUEST", state: "READY", ...passed(fix),
      pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headSha: "d".repeat(40), headTreeSha: "1".repeat(40), candidateDigest: first.digest, required: true, state: "OPEN" }],
    });

    it("records a pushed fix on the existing pull request and returns to waiting for merge", () => {
      expect(workflowContracts.workflowPullRequestUpdateDue(ready())).toBe(true);
      const running = workflowContracts.startWorkflowPullRequestUpdate(ready(), at(3));
      expect(running).toMatchObject({ stage: "PULL_REQUEST", state: "RUNNING", revision: 10 });
      const waiting = workflowContracts.recordWorkflowPullRequestUpdate(running, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40) }], now: at(4) });
      expect(waiting).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 11, pullRequestUpdatedAt: at(4),
        pullRequests: [{ number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40), candidateDigest: fix.digest, state: "OPEN" }] });
      expect(workflowContracts.workflowPullRequestUpdateDue(waiting)).toBe(false);
      // A second update of the same push is refused: the task is no longer pushing.
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(waiting, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40) }], now: at(5) })).toThrow(workflowContracts.WorkflowTransitionError);
      // Nothing to push when the pull request already holds the current code.
      expect(() => workflowContracts.startWorkflowPullRequestUpdate({ ...waiting, stage: "PULL_REQUEST", state: "READY" }, at(5))).toThrow(workflowContracts.WorkflowTransitionError);
      // A pull request may hold earlier code only while its fix is pushed or after its push failed.
      expect(WorkflowSnapshotSchema.safeParse({ ...ready(), stage: "WAIT_FOR_MERGE", state: "WAITING" }).success).toBe(false);
      const failed = workflowContracts.blockWorkflowPullRequestUpdate(running, { numbers: [42], cause: "HEAD_MOVED", now: at(4) });
      expect(failed).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: workflowContracts.WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed,
        pullRequestUpdateFailure: { numbers: [42], cause: "HEAD_MOVED" }, pullRequests: [{ headSha: "d".repeat(40), candidateDigest: first.digest }] });
      expect(WorkflowSnapshotSchema.safeParse({ ...failed, blockReason: workflowContracts.WORKFLOW_BLOCK_REASONS.feedbackReviewFailed }).success).toBe(false);
    });

    it("records a fix whose push was taken for failed but landed, from the blocked task, back to waiting for merge", () => {
      const running = workflowContracts.startWorkflowPullRequestUpdate(ready(), at(3));
      const failed = workflowContracts.blockWorkflowPullRequestUpdate(running, { numbers: [42], cause: "PUSH_REFUSED", now: at(4) });
      const waiting = workflowContracts.recordWorkflowPullRequestUpdate(failed, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40) }], now: at(5) });
      expect(waiting).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: failed.revision + 1, pullRequestUpdatedAt: at(5),
        pullRequests: [{ number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40), candidateDigest: fix.digest, state: "OPEN" }] });
      expect(waiting.blockReason).toBeUndefined();
      expect(waiting.pullRequestUpdateFailure).toBeUndefined();
      // Only on the reviewed tree, and only for a task blocked because its push failed.
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(failed, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "1".repeat(40) }], now: at(5) })).toThrow(workflowContracts.WorkflowTransitionError);
      const otherBlock = WorkflowSnapshotSchema.parse({ ...ready(), revision: 12, stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: workflowContracts.WORKFLOW_BLOCK_REASONS.pullRequestChanged,
        ...passed(first), pullRequests: ready().pullRequests });
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(otherBlock, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "1".repeat(40) }], now: at(5) })).toThrow(workflowContracts.WorkflowTransitionError);
    });

    it("refuses a pull request update whose tree is not the reviewed tree", () => {
      const running = workflowContracts.startWorkflowPullRequestUpdate(ready(), at(3));
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(running, { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "1".repeat(40) }], now: at(4) })).toThrow(workflowContracts.WorkflowTransitionError);
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(running, { updates: [{ repositoryId: "demo", number: 43, headSha: "f".repeat(40), headTreeSha: "2".repeat(40) }], now: at(4) })).toThrow(workflowContracts.WorkflowTransitionError);
      expect(() => workflowContracts.recordWorkflowPullRequestUpdate(ready(), { updates: [{ repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40) }], now: at(4) })).toThrow(workflowContracts.WorkflowTransitionError);
    });

    it("observes a merge while a fix is being pushed", () => {
      const running = workflowContracts.startWorkflowPullRequestUpdate(ready(), at(3));
      const open = workflowContracts.observeWorkflowPullRequest(running, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "OPEN", source: "GITHUB_API", observedAt: at(4) }, at(4));
      // Still pushing: an open pull request changes nothing about the push.
      expect(open).toMatchObject({ stage: "PULL_REQUEST", state: "RUNNING" });
      const merged = workflowContracts.observeWorkflowPullRequest(open, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "MERGED", source: "GITHUB_API", observedAt: at(5) }, at(5));
      expect(merged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: [{ state: "MERGED", headSha: "d".repeat(40) }] });
      // And after the push failed.
      const failed = workflowContracts.blockWorkflowPullRequestUpdate(running, { numbers: [42], cause: "PUSH_REFUSED", now: at(4) });
      expect(workflowContracts.observeWorkflowPullRequest(failed, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "OPEN", source: "GITHUB_API", observedAt: at(5) }, at(5)))
        .toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
      expect(workflowContracts.observeWorkflowPullRequest(failed, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "MERGED", source: "GITHUB_API", observedAt: at(5) }, at(5)))
        .toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    });

    it("observes a merge while the fix is still being coded or reviewed, with the pull request's earlier reviewed code", () => {
      // The fix is in review: its candidate has no reviews yet, and the pull request holds the first reviewed code.
      const reviewing = WorkflowSnapshotSchema.parse({ ...ready(), stage: "REVIEW", state: "RUNNING", reviews: [] });
      const merged = workflowContracts.observeWorkflowPullRequest(reviewing, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "MERGED", source: "GITHUB_API", observedAt: at(4) }, at(4));
      expect(merged).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: [{ candidateDigest: first.digest, state: "MERGED" }] });
      // Only a merge moves it: an open pull request leaves the fix where it is, and nothing is observed for a closed task.
      expect(workflowContracts.observeWorkflowPullRequest(reviewing, { repositoryId: "demo", number: 42, candidateDigest: first.digest, state: "OPEN", source: "GITHUB_API", observedAt: at(4) }, at(4)))
        .toMatchObject({ stage: "REVIEW", state: "RUNNING" });
      // A merged stage with the fix's own code still needs the fix's checks and reviews.
      expect(WorkflowSnapshotSchema.safeParse({ ...merged, pullRequests: merged.pullRequests!.map((pullRequest) => ({ ...pullRequest, candidateDigest: fix.digest })) }).success).toBe(false);
    });

    it("records a merge of the pushed fix before the push was recorded, only on the fix's reviewed tree", () => {
      const running = workflowContracts.startWorkflowPullRequestUpdate(ready(), at(3));
      expect(workflowContracts.observeWorkflowPullRequestMergedWithFix(running, { repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40), observedAt: at(4) }, at(4)))
        .toMatchObject({ stage: "MERGED", state: "COMPLETE", pullRequests: [{ headSha: "f".repeat(40), headTreeSha: "2".repeat(40), candidateDigest: fix.digest, state: "MERGED" }] });
      expect(() => workflowContracts.observeWorkflowPullRequestMergedWithFix(running, { repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "1".repeat(40), observedAt: at(4) }, at(4)))
        .toThrow(workflowContracts.WorkflowTransitionError);
      // A fix still in review was never pushed.
      const reviewing = WorkflowSnapshotSchema.parse({ ...ready(), stage: "REVIEW", state: "RUNNING", reviews: [] });
      expect(() => workflowContracts.observeWorkflowPullRequestMergedWithFix(reviewing, { repositoryId: "demo", number: 42, headSha: "f".repeat(40), headTreeSha: "2".repeat(40), observedAt: at(4) }, at(4)))
        .toThrow(workflowContracts.WorkflowTransitionError);
    });
  });
});
