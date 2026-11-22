import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, IMPLICIT_COMPANY_ID, WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { authorizeLinkedGithubWebhook, handleGithubWebhook, reconcileTaskPullRequestFeedback, type ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";
import { engineStampKey, stampItem, type Engine } from "../../packages/broker/src/core-host/engine-stamp.js";
import { mergeReadiness } from "../../packages/broker/src/core/merge/merge.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-21T12:00:00.000Z";
const HEAD = "a".repeat(40), TREE = "b".repeat(40);
const URL = "https://github.com/example/demo/pull/7";
const DELIVERY = "550e8400-e29b-41d4-a716-446655440030";
const SECRET = "fixture-only";

function ready(workflow: WorkflowSnapshot) {
  return mergeReadiness({ workflow,
    pullRequests: [{ repositoryId: "demo", number: 7, headSha: HEAD, state: "open", draft: false, baseBranch: "main", ci: "passing", branch: "up_to_date", behindRequired: false }],
    approvals: new Map([["demo#7", { approved: true, by: { hostUserId: "reviewer", login: "reviewer" }, commitId: HEAD, approvers: [{ hostUserId: "reviewer", login: "reviewer" }] }]]),
    recordedBases: new Map([["demo#7", "main"]]), presser: { hostUserId: "owner" }, allowSelfApproval: true, requesterName: "Owner" });
}

function setup(engine?: Engine) {
  const db = new FakeDynamoDb({ consistency: "eventual" });
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: HEAD, treeSha: TREE }]);
  const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: TASK, ownerId: "d".repeat(64), now: NOW }),
    stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: TASK, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests: [{ repositoryId: "demo", number: 7, url: URL, headSha: HEAD, headTreeSha: TREE, candidateDigest: candidate.digest, required: true, state: "OPEN" }] });
  const key = taskKey(TASK);
  db.set({ ...key, project: "demo", startingRevision: 1, workflow });
  if (engine !== undefined) db.set(stampItem(IMPLICIT_COMPANY_ID, TASK, { engine, areas: { flow: engine, build: engine, merge: engine }, flags: "fixture", stampedAt: NOW }).item);
  db.set({ ...githubWorkflowPullRequestKey("example/demo", 7), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 7,
    url: URL, taskId: TASK, workspaceId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest });
  const current = () => db.get(key.pk, key.sk)!.workflow as WorkflowSnapshot;
  const bundles: string[] = [];
  const input: ReconcileTaskPullRequestFeedbackInput = {
    documentClient: db, tableName: "state", repositoryFullName: "example/demo", number: 7, deliveryId: DELIVERY, now: NOW,
    loadTask: async () => ({ project: "demo", startingRevision: 1, workflow: current() }),
    repositoryUrl: async () => "https://github.com/example/demo.git",
    getCurrentFeedback: async () => ({ pullRequest: { number: 7, url: URL, state: "open", headBranch: "task", baseBranch: "main", headCommit: HEAD, headTreeSha: TREE, title: "Fixture", body: "" },
      comments: [{ id: "101", threadId: "thread-1", kind: "REVIEW_COMMENT", url: `${URL}#discussion_r101`, author: "reviewer", updatedAt: NOW, body: "Please add a test.", path: "src/a.ts", line: 1 }],
      threads: [{ id: "thread-1", resolved: false, commentIds: ["101"] }] }),
    persistBundle: async (_bundle, bytes, digest) => { bundles.push(bytes); return `tasks/${TASK}/feedback/${digest}.json`; },
    saveWorkflow: async (_taskId, _revision, next) => { db.set({ ...db.get(key.pk, key.sk)!, workflow: next }); },
  };
  const authorize = () => authorizeLinkedGithubWebhook({ ...input, scope: { installationId: 77, repositoryId: 42, fullName: "example/demo", pullRequestNumber: 7 }, verifyRepository: async () => true });
  const deliver = () => {
    const rawBody = JSON.stringify({ action: "created", installation: { id: 77 }, repository: { id: 42, full_name: "example/demo" }, pull_request: { number: 7 },
      comment: { id: 101, body: "Please add a test.", html_url: `${URL}#discussion_r101`, updated_at: NOW, user: { login: "reviewer" }, path: "src/a.ts", line: 1 } });
    return handleGithubWebhook({ documentClient: db, tableName: "state", rawBody, secret: SECRET, now: () => NOW,
      headers: { "x-github-delivery": DELIVERY, "x-github-event": "pull_request_review_comment", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}` },
      authorizeRepository: authorize, process: async () => { await reconcileTaskPullRequestFeedback(input); } });
  };
  return { db, input, current, bundles, authorize, deliver };
}

function unreadable(f: ReturnType<typeof setup>, kind: "read failure" | "malformed stamp") {
  if (kind === "read failure") f.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk === engineStampKey(TASK).pk, error: { name: "ProvisionedThroughputExceededException", message: "stamp unavailable" } });
  else f.db.set({ ...engineStampKey(TASK), coreEngine: { engine: "core" } });
}

describe("the legacy GitHub feedback engine boundary", () => {
  it("a core task with a matching legacy index stays merge-ready after a signed review-comment webhook", async () => {
    const f = setup("core");
    const before = f.current();
    expect(ready(before).ready).toBe(true);
    await expect(f.deliver()).rejects.toThrow(/outside the registered installation and repository scope/);
    expect(f.current()).toEqual(before);
    expect(f.current().feedbackReview).toBeUndefined();
    expect(ready(f.current()).ready).toBe(true);
    expect(f.bundles).toHaveLength(0);
    expect(f.db.get(`GITHUB_DELIVERY#${DELIVERY}`, "META")).toBeUndefined();
  });

  it("direct reconciliation cannot collect or update a core task during recovery", async () => {
    const f = setup("core");
    const before = f.current();
    await expect(reconcileTaskPullRequestFeedback(f.input)).resolves.toBe(false);
    expect(f.current()).toEqual(before);
    expect(f.bundles).toHaveLength(0);
    expect(ready(f.current()).ready).toBe(true);
  });

  it.each([undefined, "workflow"] as const)("a legacy task (stamp=%s) still collects a signed review comment", async (engine) => {
    const f = setup(engine);
    await expect(f.deliver()).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(f.current().feedbackReview).toMatchObject({ status: "COLLECTING" });
    expect(f.current().feedbackReview?.bundleRefs[0]?.comments).toMatchObject([{ id: "101" }]);
    expect(f.bundles).toHaveLength(1);
    expect(f.db.get(`GITHUB_DELIVERY#${DELIVERY}`, "META")).toMatchObject({ status: "COMPLETED" });
  });

  it.each(["read failure", "malformed stamp"] as const)("authorization fails safe on %s", async (kind) => {
    const f = setup("core");
    unreadable(f, kind);
    await expect(f.deliver()).rejects.toThrow();
    expect(f.current().feedbackReview).toBeUndefined();
    expect(f.bundles).toHaveLength(0);
    expect(f.db.get(`GITHUB_DELIVERY#${DELIVERY}`, "META")).toBeUndefined();
  });

  it.each(["read failure", "malformed stamp"] as const)("direct reconciliation fails safe on %s", async (kind) => {
    const f = setup("core");
    const before = f.current();
    unreadable(f, kind);
    await expect(reconcileTaskPullRequestFeedback(f.input)).rejects.toThrow();
    expect(f.current()).toEqual(before);
    expect(f.bundles).toHaveLength(0);
  });
});


it("flow ownership skips legacy feedback even when the top-level engine differs, with fixed aggregate log words", async () => {
  const f = setup("workflow");
  const stamp = f.db.get(engineStampKey(TASK).pk, engineStampKey(TASK).sk)!;
  f.db.set({ ...stamp, coreEngine: { ...(stamp.coreEngine as object), areas: { flow: "core", build: "workflow", merge: "workflow" } } });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    expect(await f.authorize()).toBe(false);
    expect(log.mock.calls).toEqual([[JSON.stringify({ component: "broker", event: "github_webhook.core_task_skipped" })]]);
    expect(f.bundles).toEqual([]);
  } finally { log.mockRestore(); }
});

it("a false reconciliation never releases or starts a critic for a core task", async () => {
  const f = setup("core");
  const { loadSlackBroker } = await import("../support/slack-broker.js");
  const { processGithubWorkflowEvent, reconcileWorkflowMergeRecoveryTask } = await loadSlackBroker() as unknown as typeof BrokerModule;
  const before = f.db.find(() => true);
  const load = vi.spyOn(f.db, "send");
  await processGithubWorkflowEvent({ documentClient: f.db, tableName: "state", githubPullRequests: { getPullRequestFeedback: vi.fn() } } as never,
    { fullName: "example/demo", number: 7 } as never, DELIVERY);
  expect(await reconcileWorkflowMergeRecoveryTask({ documentClient: f.db, tableName: "state" } as never, TASK, { beforeRequest: vi.fn(), signal: new AbortController().signal })).toMatchObject({ kind: "RETRY" });
  expect(f.db.find(() => true)).toEqual(before);
  // No task/workspace read after the engine refusal; in particular no release and no critic acceptance.
  expect(load.mock.calls.filter(([command]) => ((command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk ?? "").startsWith("DEVTASK#"))).toHaveLength(0);
});

it.each(["feedback", "merge"])("missing %s reader refuses before any legacy reconciliation", async kind => {
  const f = setup("core");
  const { loadSlackBroker } = await import("../support/slack-broker.js");
  const { processGithubWorkflowEvent } = await loadSlackBroker() as unknown as typeof BrokerModule;
  const send = vi.spyOn(f.db, "send");
  await expect(processGithubWorkflowEvent({ documentClient: f.db, tableName: "state", githubPullRequests: {} } as never,
    { fullName: "example/demo", number: 7 } as never, DELIVERY, kind === "feedback" ? undefined : {
      observationMode: "merge", budget: { beforeRequest: vi.fn(), signal: new AbortController().signal }, release: "queue",
    })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
});

it.each(["invalid-url", "wrong-number"])("merge recovery defers a %s link without using it", async kind => {
  const f = setup("workflow");
  const workflow = f.current();
  if (kind === "invalid-url") workflow.pullRequests![0]!.url = "https://example.com/unrelated";
  else workflow.pullRequests![0]!.number = 8;
  f.db.set({ ...f.db.get(taskKey(TASK).pk, taskKey(TASK).sk)!, workflow });
  const { loadSlackBroker } = await import("../support/slack-broker.js");
  const { reconcileWorkflowMergeRecoveryTask } = await loadSlackBroker() as unknown as typeof BrokerModule;
  await expect(reconcileWorkflowMergeRecoveryTask({ documentClient: f.db, tableName: "state" } as never, TASK,
    { beforeRequest: vi.fn(), signal: new AbortController().signal })).resolves.toMatchObject({ kind: "RETRY" });
});
