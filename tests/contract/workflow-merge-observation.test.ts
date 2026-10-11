import { createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, type WorkflowFeedbackBundle, type WorkflowSnapshot } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { reconcileTaskPullRequestFeedback, type ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";
import type { GitHubPullRequestFeedback } from "../../packages/broker/src/github-app.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = "2026-10-11T12:00:00.000Z";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440012";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

function fixture(options: { partial?: boolean; feedbackReview?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const candidate = createCandidateManifest(["api", "ui"].map(repositoryId => ({ repositoryId, commitSha: HEAD, treeSha: TREE })));
  const pullRequests = ["api", "ui"].slice(0, options.partial ? 1 : 2).map((repositoryId, index) => ({
    repositoryId, number: index + 1, url: `https://github.com/acme/${repositoryId}/pull/${index + 1}`,
    headSha: HEAD, headTreeSha: TREE, candidateDigest: candidate.digest, required: true as const, state: "OPEN" as const,
  }));
  let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "c".repeat(64), now: NOW }), candidate,
    stage: options.partial ? "PULL_REQUEST" : "WAIT_FOR_MERGE", state: options.partial ? "READY" : "WAITING",
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW,
      results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: TASK_ID, candidateDigest: candidate.digest,
      role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests,
    ...(options.feedbackReview ? {
      feedbackReview: {
        status: "COLLECTING",
        bundleRefs: [{ schemaVersion: 1, taskId: TASK_ID, repositoryId: "api", number: 1, headSha: HEAD,
          headTreeSha: TREE, candidateDigest: candidate.digest, commentSetDigest: "d".repeat(64), producer: "fixture",
          version: "1", recordedAt: NOW, comments: [{ id: "discussion:1", kind: "DISCUSSION",
            url: "https://github.com/acme/api/pull/1#issuecomment-1", author: "reviewer", updatedAt: NOW,
            bodyDigest: "e".repeat(64), bodyBytes: 16 }], sha256: "f".repeat(64),
          objectKey: `tasks/${TASK_ID}/feedback/${"f".repeat(64)}.json` }],
        threadObservations: [],
      },
    } : {}),
  });
  for (const pr of pullRequests) db.set({
    pk: `GITHUB_PR#acme/${pr.repositoryId}`, sk: `PR#${String(pr.number).padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR",
    repositoryFullName: `acme/${pr.repositoryId}`, repositoryId: pr.repositoryId, number: pr.number, url: pr.url,
    taskId: TASK_ID, workspaceId: "workspace", candidateDigest: candidate.digest,
  });
  const remote = new Map<string, { state: "open" | "closed" | "merged"; headCommit: string; headTreeSha: string }>(pullRequests.map(pr => [pr.repositoryId, {
    state: "open", headCommit: HEAD, headTreeSha: TREE,
  }]));
  let conflict = false;
  const reads: string[] = [];
  const saves: WorkflowSnapshot[] = [];
  const persistBundle = vi.fn(async (_bundle: WorkflowFeedbackBundle, _bytes: string, sha256: string) => `tasks/${TASK_ID}/feedback/${sha256}.json`);
  const reviewedComments = vi.fn(async () => []);
  const saveLandedPushes = vi.fn(async () => {});
  const commitParents = vi.fn(async () => [HEAD]);
  const input: ReconcileTaskPullRequestFeedbackInput = {
    observationMode: "merge",
    documentClient: db, tableName: "state", repositoryFullName: "acme/api", number: 1, deliveryId: "merge-recovery",
    loadTask: async () => ({ project: "fixture", startingRevision: 1, workflow }),
    repositoryUrl: async (_project, _revision, repositoryId) => `https://github.com/acme/${repositoryId}.git`,
    getCurrentFeedback: async (_url, number): Promise<GitHubPullRequestFeedback> => {
      const repositoryId = number === 1 ? "api" : "ui";
      const pr = pullRequests.find(value => value.repositoryId === repositoryId)!;
      const observation = remote.get(repositoryId)!;
      reads.push(repositoryId);
      return { pullRequest: { number, url: pr.url, state: observation.state, headBranch: "feature", baseBranch: "main",
        headCommit: observation.headCommit, headTreeSha: observation.headTreeSha, title: "fixture", body: "" }, comments: [], threads: [] };
    },
    persistBundle,
    reviewedComments,
    saveLandedPushes,
    commitParents,
    saveWorkflow: async (_taskId, revision, next) => {
      if (conflict) { conflict = false; workflow = WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1 }); throw Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" }); }
      if (revision !== workflow.revision) throw Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" });
      workflow = next; saves.push(next);
    },
    now: NOW,
  };
  return {
    input, reads, saves, persistBundle, reviewedComments, saveLandedPushes, commitParents,
    workflow: () => workflow,
    setRemote(repositoryId: string, value: Partial<{ state: "open" | "closed" | "merged"; headCommit: string; headTreeSha: string }>) {
      remote.set(repositoryId, { ...remote.get(repositoryId)!, ...value });
    },
    conflict: () => { conflict = true; },
  };
}

describe("merge-only task pull request reconciliation", () => {
  it("keeps omitted observation mode on the existing feedback collection path", async () => {
    const f = fixture();
    const getCurrentFeedback = (url: string, number: number) => f.input.getCurrentFeedback(url, number);
    const { observationMode: _mode, ...feedbackInput } = f.input;
    void _mode;
    expect(await reconcileTaskPullRequestFeedback({ ...feedbackInput,
      getCurrentFeedback: async (url, number) => {
        const feedback = await getCurrentFeedback(url, number);
        return { ...feedback, comments: [{ id: `discussion:${number}`, kind: "DISCUSSION" as const,
          url: `${feedback.pullRequest.url}#issuecomment-${number}`, author: "reviewer", updatedAt: NOW, body: "feedback" }] };
      },
    })).toBe(true);
    expect(f.persistBundle).toHaveBeenCalledTimes(2);
    expect(f.workflow().feedbackReview?.status).toBe("COLLECTING");
  });

  it("waits for both exact required PRs and completes only after both merge", async () => {
    const f = fixture();
    f.setRemote("api", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    f.setRemote("ui", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
  });

  it.each([
    ["foreign head", { state: "merged" as const, headCommit: "c".repeat(40), headTreeSha: TREE }],
    ["wrong tree", { state: "merged" as const, headCommit: HEAD, headTreeSha: "c".repeat(40) }],
    ["missing tree", { state: "merged" as const, headCommit: HEAD, headTreeSha: undefined }],
    ["malformed head", { state: "merged" as const, headCommit: "bad", headTreeSha: TREE }],
  ])("does not promote a merged PR with %s identity", async (_label, observation) => {
    const f = fixture();
    f.setRemote("api", observation as Partial<{ state: "merged"; headCommit: string; headTreeSha: string }>);
    f.setRemote("ui", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(f.workflow().pullRequests?.find(pr => pr.repositoryId === "api")?.state).toBe("OPEN");
  });

  it("blocks on closed-unmerged and returns to waiting when the exact PR reopens", async () => {
    const f = fixture();
    f.setRemote("api", { state: "closed" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    f.setRemote("api", { state: "open" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  });

  it("does not complete a partially published multi-repository candidate", async () => {
    const f = fixture({ partial: true });
    f.setRemote("api", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(false);
    expect(f.workflow()).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
  });

  it("recollects every linked PR after a CAS conflict", async () => {
    const f = fixture();
    f.setRemote("api", { state: "merged" });
    f.conflict();
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(f.reads).toEqual(["api", "ui", "api", "ui"]);
  });

  it("preserves pending feedback bytes and never runs feedback or ancestry helpers", async () => {
    const f = fixture({ feedbackReview: true });
    const before = JSON.stringify(f.workflow().feedbackReview);
    f.setRemote("api", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    expect(JSON.stringify(f.workflow().feedbackReview)).toBe(before);
    expect(f.persistBundle).not.toHaveBeenCalled();
    expect(f.reviewedComments).not.toHaveBeenCalled();
    expect(f.saveLandedPushes).not.toHaveBeenCalled();
    expect(f.commitParents).not.toHaveBeenCalled();
  });

  it("does not infer a lost fix push from a matching tree under a foreign head", async () => {
    const f = fixture();
    f.setRemote("api", { state: "open", headCommit: "c".repeat(40), headTreeSha: TREE });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(false);
    expect(f.workflow().pullRequests?.[0]?.headSha).toBe(HEAD);
    expect(f.commitParents).not.toHaveBeenCalled();
  });

  it("does not save or increment revision for a duplicate matching merge snapshot", async () => {
    const f = fixture();
    f.setRemote("api", { state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(true);
    const revision = f.workflow().revision;
    const saves = f.saves.length;
    expect(await reconcileTaskPullRequestFeedback(f.input)).toBe(false);
    expect(f.workflow().revision).toBe(revision);
    expect(f.saves).toHaveLength(saves);
  });
});
