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

  it("accepts only a broker-assigned immutable E2E admission reference on a CHECKS operation", () => {
    const workflowE2EAdmission = { schemaVersion: 1, taskId: "44444444-4444-4444-8444-444444444444",
      workflowRevision: 8, candidateDigest: "a".repeat(64), roundId: "55555555-5555-4555-8555-555555555555", groupRunIds: ["66666666-6666-4666-8666-666666666666"],
      admissionRef: { key: `workflow-e2e-admissions/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength: 4096 } };
    const parse = (extra: Record<string, unknown>, workflowMode = "CHECKS") => WorkerInvocationSchema.safeParse({
      ...base, payload: { ...base.payload, workflowMode, ...extra },
    }).success;
    expect(parse({ workflowE2EAdmission })).toBe(true);
    expect(parse({ workflowE2EAdmission }, "IMPLEMENT")).toBe(false);
    expect(parse({ workflowE2EAdmission: { ...workflowE2EAdmission, admissionRef: { ...workflowE2EAdmission.admissionRef,
      key: "workflow-e2e-admissions/other.json" } } })).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowE2EAdmission");
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

  it("carries the owner's approved PR feedback for the reviewers only on a review operation, bounded (0.2.12)", () => {
    const feedback = (workflowReviewFeedback: unknown, workflowMode = "REVIEW") => WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode, workflowReviewFeedback } }).success;
    const entry = { summary: "Use the shorter sentence.", fileChanges: [{ repositoryId: "demo", path: "README.md", change: "Shorten it." }], ownerNote: "Keep it short." };
    expect(feedback([entry])).toBe(true);
    expect(feedback([{ summary: "Use the shorter sentence.", fileChanges: [] }])).toBe(true);
    expect(feedback([])).toBe(false);
    expect(feedback([{ ...entry, extra: 1 }])).toBe(false);
    expect(feedback([{ ...entry, summary: "" }])).toBe(false);
    expect(feedback(Array.from({ length: 21 }, () => entry))).toBe(false);
    expect(feedback(Array.from({ length: 20 }, () => ({ ...entry, summary: "x".repeat(2_000) })))).toBe(false);
    expect(feedback([entry], "IMPLEMENT")).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowReviewFeedback");
  });

  it("carries the exact review retry note only on review operations and bounds it to the owner-note limit", () => {
    const reviewNote = (workflowReviewNote: unknown, workflowMode = "REVIEW") => WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode, workflowReviewNote } }).success;
    expect(reviewNote("Check the changed timeout path." )).toBe(true);
    expect(reviewNote("x".repeat(65_536))).toBe(true);
    expect(reviewNote("é".repeat(32_769))).toBe(false);
    expect(reviewNote("x".repeat(65_537))).toBe(false);
    expect(reviewNote("")).toBe(false);
    expect(reviewNote("Check the changed timeout path.", "IMPLEMENT")).toBe(false);
    expect(WorkerInvocationSchema.parse(base).payload).not.toHaveProperty("workflowReviewNote");
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowReviewNote");
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
    const pinned = { workflowBaseCommit: "c".repeat(40) };
    // The reviewed tree always comes with the task's base, so the worker always checks base ancestry.
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40), ...pinned })).toBe(true);
    expect(parse({ workflowCandidateTreeSha: "A".repeat(40), ...pinned })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(39), ...pinned })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(64), ...pinned })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "g".repeat(40), ...pinned })).toBe(false);
    expect(parse(pinned)).toBe(false);
    expect(parse({ workflowBaseCommit: "c".repeat(41), workflowCandidateTreeSha: "a".repeat(40) })).toBe(false);
    expect(parse({ workflowCandidateTreeSha: "a".repeat(40), ...pinned }, "sync")).toBe(false);
    expect(parse({ somethingElse: true })).toBe(false);
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowPullRequestUpdate");
  });
});
