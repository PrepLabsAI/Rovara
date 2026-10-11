import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, WorkerInvocationSchema } from "@agentx/contracts";

const base = {
  protocolVersion: 1,
  kind: "task",
  operationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  fence: 1,
  projectRevision: 1,
  callbackCapability: "c".repeat(32),
  payload: {
    conversationId: "33333333-3333-4333-8333-333333333333",
    prompt: "Plan the requested change.",
  },
};

describe("workflow-mode worker invocation", () => {
  it("accepts the broker-selected read-only planning mode and the post-approval coding mode", () => {
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "PLAN" } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "IMPLEMENT" } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "REVIEW" } }).success).toBe(true);
  });

  it("keeps legacy task payloads valid and rejects unknown modes", () => {
    expect(WorkerInvocationSchema.parse(base)).not.toHaveProperty("payload.workflowMode");
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "ADMIN" } }).success).toBe(false);
  });

  it("requires a task, revision, and candidate binding for the separate feedback critic operation", () => {
    const binding = { taskId: "44444444-4444-4444-8444-444444444444", workflowRevision: 8, candidateDigest: "a".repeat(64) };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "FEEDBACK_REVIEW", workflowFeedbackReview: binding } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "FEEDBACK_REVIEW" } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "REVIEW", workflowFeedbackReview: binding } }).success).toBe(false);
  });

  it("carries the checks that ran, or review only with the plan's reason, only on a review operation", () => {
    const review = (workflowReviewChecks: unknown, workflowMode = "REVIEW") => WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode, workflowReviewChecks } }).success;
    expect(review({ reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] })).toBe(true);
    expect(review({ reviewOnly: true, checks: [], noneReason: "Docs only." })).toBe(true);
    expect(review({ reviewOnly: true, checks: [] })).toBe(true);
    expect(review({ reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] }, "IMPLEMENT")).toBe(false);
    expect(review({ reviewOnly: true, checks: [{ label: "Unit tests", command: "npm test" }] })).toBe(false);
    expect(review({ reviewOnly: false, checks: [], noneReason: "Docs only." })).toBe(false);
    expect(review({ reviewOnly: false, checks: [{ label: "x".repeat(81), command: "npm test" }] })).toBe(false);
    expect(review({ reviewOnly: false, checks: [{ label: "Unit tests", command: "x".repeat(1025) }] })).toBe(false);
  });

  it("carries the approved plan for the reviewers, with its digest, only on a review operation and within 32,768 bytes", () => {
    const sha256 = "a".repeat(64);
    const plan = (workflowReviewPlan: unknown, workflowMode = "REVIEW") => WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode, workflowReviewPlan } }).success;
    expect(plan({ markdown: "# Plan\n\nDo the thing.", sha256 })).toBe(true);
    expect(plan({ markdown: "x".repeat(32_768), sha256 })).toBe(true);
    expect(plan({ markdown: "é".repeat(16_385), sha256 })).toBe(false);
    expect(plan({ markdown: "x".repeat(32_769), sha256 })).toBe(false);
    expect(plan({ markdown: "", sha256 })).toBe(false);
    expect(plan({ markdown: "# Plan", sha256: "nope" })).toBe(false);
    expect(plan({ markdown: "# Plan", sha256, extra: 1 })).toBe(false);
    expect(plan({ markdown: "# Plan", sha256 }, "IMPLEMENT")).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowReviewPlan");
  });

  it("carries the reviewed tree for a pull request update, only as 40 hex on a maintain append", () => {
    const maintain = {
      ...base,
      kind: "maintain",
      payload: {
        action: "append",
        project: {
          name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate coding work.",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        },
        repository: "demo",
        pullRequestNumber: 7,
        headBranch: "agentx/55555555-5555-4555-8555-555555555555",
        baseBranch: "main",
        expectedHeadCommit: "b".repeat(40),
        repositoryGrant: "push-grant",
      },
    };
    const parse = (extra: Record<string, unknown>, action = "append") => WorkerInvocationSchema.safeParse({ ...maintain, payload: { ...maintain.payload, action, ...extra } }).success;
    expect(parse({})).toBe(true);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40) })).toBe(true);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40), workflowBaseCommit: "c".repeat(40) })).toBe(true);
    expect(parse({ workflowCandidateTreeSha: "A".repeat(40) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(39) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(64) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "g".repeat(40) })).toBe(false);
    expect(parse({ workflowBaseCommit: "c".repeat(40) })).toBe(false);
    expect(parse({ workflowBaseCommit: "c".repeat(41), workflowCandidateTreeSha: "a".repeat(40) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40) }, "sync")).toBe(false);
    expect(parse({ somethingElse: true })).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowPullRequestUpdate");
  });
});
