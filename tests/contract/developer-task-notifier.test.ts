// tests/contract/developer-task-notifier.test.ts
// Spec 025 FR-032, FR-034, C7 to C9: the notifier, fed from the fake table's writes, posting to a
// fake Slack. The queue is an array; a failed notice stays in it with its attempt count.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { indexExpiresAt } from "@agentx/contracts";
import { SlackPostError, chatPostMessage } from "../../packages/broker/src/aws/slack-web.js";
import { cachedSlackPoster, createNotifierHandler, retryDelaySeconds } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });
function parseAction(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected Slack action object");
  return parsed as Record<string, unknown>;
}

type Post = (input: { channel: string; threadTs?: string; text: string }) => Promise<{ ts: string }>;

type Client = { send(command: unknown): Promise<unknown> };

async function notifierHarness(body: Record<string, unknown> = { shareToChannel: true }, options: {
  post?: Post;
  documentClient?: (db: FakeDynamoDb) => Client;
  readArtifact?: (key: string) => Promise<string>;
  update?: (input: { channel: string; ts: string; text: string; blocks: unknown[] }) => Promise<void>;
  createPlanCanvas?: (input: { channel: string; taskId: string; title: string; version: number; markdown: string }) => Promise<{ canvasId: string; permalink: string }>;
  closeTaskCanvases?: (taskId: string, expectedManifestDigest?: string) => Promise<{ status: "COMPLETE" | "ARCHIVE_PENDING"; reason?: string }>;
} = {}) {
  const harness = await createDeveloperTaskBroker();
  const postOverride = options.post;
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string; blocks?: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  let failing: string | undefined;
  let ts = 1_695_500_000_000_100;
  const deliveryFailed = vi.fn();
  const retryLater = vi.fn(async () => undefined);
  const handle = createNotifierHandler({
    documentClient: options.documentClient?.(harness.db) ?? harness.db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater,
    post: postOverride ?? (async (input) => {
      if (failing !== undefined) throw new SlackPostError(failing);
      posts.push(input);
      ts += 1;
      const text = String(ts);
      return { ts: `${text.slice(0, 10)}.${text.slice(10)}` };
    }),
    update: options.update ?? (async (input) => { updates.push(input); }),
    ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
    ...(options.createPlanCanvas === undefined ? {} : { createPlanCanvas: options.createPlanCanvas }),
    ...(options.closeTaskCanvases === undefined ? {} : { closeTaskCanvases: options.closeTaskCanvases }),
    now: () => clock, log: (entry) => logs.push(entry), deliveryFailed,
  });
  /** Stream to queue, then every queued notice once; failed ones stay queued. */
  const pump = async () => {
    await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = queue.splice(0, queue.length);
    const answer = await handle({ Records: batch.map((entry, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(entry.notice), attributes: { ApproximateReceiveCount: String(entry.attempt + 1) } })) });
    const failed = new Set(answer.batchItemFailures.map((failure) => failure.itemIdentifier));
    batch.forEach((entry, index) => { if (failed.has(`m${index}`)) queue.push({ notice: entry.notice, attempt: entry.attempt + 1 }); });
  };
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return {
    ...harness, stream, posts, updates, queue, logs, pump, handle, taskId, workspaceId, active, deliveryFailed, retryLater,
    advance: (ms: number) => { clock += ms; }, fail: (code: string | undefined) => { failing = code; }, now: () => clock,
  };
}

describe("the shared thread (FR-032, US3 scenario 1)", () => {
  it("reports a blocked independent review instead of forwarding a worker PASS summary, with an exact-candidate retry", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const operationId = h.active();
    const candidateDigest = "a".repeat(64);
    await h.finish(h.workspaceId, operationId, "SUCCEEDED", { result: { result: "Both reviews PASS" } });
    await h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow", ExpressionAttributeValues: { ":workflow": {
        revision: 9, stage: "REVIEW", state: "BLOCKED", artifacts: [], candidate: { digest: candidateDigest },
        verification: { candidateDigest, results: [{ checkId: "diff-check", status: "PASS" }] },
        reviews: [{ operationId, candidateDigest, role: "SECURITY", provider: "test", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: new Date().toISOString() }],
      } },
    }));
    await h.pump();
    const message = h.posts.at(-1)!;
    expect(message.text).toContain("security review: invalid json");
    expect(message.text).toContain("has not opened a pull request");
    expect(message.text).not.toContain("Both reviews PASS");
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({
      action_id: "agentx_workflow_retry_reviews", text: { type: "plain_text", text: "Retry reviews" },
      value: JSON.stringify({ taskId: h.taskId, revision: 9, candidateDigest }),
    })] }));
  });

  it("automatically retries terminal Canvas cleanup without requiring an owner re-drive", async () => {
    let attempt = 0;
    const closeTaskCanvases = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? { status: "ARCHIVE_PENDING" as const, reason: "canvas_not_found" } : { status: "COMPLETE" as const };
    });
    const h = await notifierHarness({ shareToChannel: false, workflow: true, workflowPath: "QUICK" }, { closeTaskCanvases });
    const terminalNotice: Notice = { id: `${h.taskId}:canvas_closeout:4`, kind: "canvas_closeout", taskId: h.taskId,
      at: new Date(h.now()).toISOString(), expectedWorkflowRevision: 4 };
    const deliver = async () => h.handle({ Records: [{ eventSource: "aws:sqs", messageId: "terminal-closeout", receiptHandle: "receipt",
      body: JSON.stringify(terminalNotice), attributes: { ApproximateReceiveCount: "1" } }] });

    const first = await deliver();
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "terminal-closeout" }]);
    expect(h.retryLater).toHaveBeenCalledWith("receipt", expect.any(Number));
    expect(closeTaskCanvases).toHaveBeenCalledTimes(1);
    const retried = await deliver();

    expect(retried.batchItemFailures).toEqual([]);
    expect(closeTaskCanvases).toHaveBeenCalledTimes(2);
  });

  it("retries owner re-drives against the supplied manifest digest until closeout completes", async () => {
    const manifestDigest = "a".repeat(64);
    let closeoutAttempt = 0;
    const closeoutCalls: Array<[string, string | undefined, number | undefined]> = [];
    const closeTaskCanvases = async (taskId: string, digest?: string, workflowRevision?: number) => {
      closeoutCalls.push([taskId, digest, workflowRevision]);
      closeoutAttempt += 1;
      return closeoutAttempt === 1 ? { status: "ARCHIVE_PENDING" as const, reason: "timeout" } : { status: "COMPLETE" as const };
    };
    const h = await notifierHarness({ shareToChannel: false, workflow: true, workflowPath: "QUICK" }, { closeTaskCanvases });
    const pendingNotice: Notice = { id: `${h.taskId}:canvas_closeout_retry:req`, kind: "canvas_closeout", taskId: h.taskId,
      at: new Date(h.now() - 2 * 60 * 60 * 1000).toISOString(), manifestDigest, expectedWorkflowRevision: 3 };
    const deliver = async () => h.handle({ Records: [{ eventSource: "aws:sqs", messageId: "closeout", receiptHandle: "receipt",
      body: JSON.stringify(pendingNotice), attributes: { ApproximateReceiveCount: "1" } }] });
    const first = await deliver();
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "closeout" }]);
    expect(h.retryLater).toHaveBeenCalledWith("receipt", expect.any(Number));
    const second = await deliver();
    expect(second.batchItemFailures).toEqual([]);
    expect(closeoutCalls).toEqual([[h.taskId, manifestDigest, 3], [h.taskId, manifestDigest, 3]]);
  });

  it("posts a short plan-ready note with a link to the saved Canvas details", async () => {
    const plan = "# Goal\nFix retry handling.\n\n## Checks\nRun the retry regression test.";
    const createPlanCanvas = vi.fn(async (_input, onCreated?: (canvasId: string) => Promise<void>) => {
      await onCreated?.("F12345678");
      return { canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" };
    });
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => plan,
      createPlanCanvas,
    });
    await h.pump();
    const preparation = h.active();
    await h.finish(h.workspaceId, preparation, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const message = h.posts.at(-1)!;
    expect(createPlanCanvas).toHaveBeenCalledWith(expect.objectContaining({ channel: SLACK_CHANNEL, taskId: h.taskId, title: "Fix the flaky retry test", version: 1, markdown: plan }), expect.any(Function));
    expect(message.text).toBe("The coding plan is ready. No code changes have started. <https://acme.slack.com/docs/T123/F12345678|Read and approve this step>.");
    expect(message.text).not.toContain("Fix retry handling");
    expect(message.blocks).toHaveLength(2);
    const actions = (message.blocks?.[1] as { elements: Array<{ action_id: string; value: string }> }).elements;
    expect(actions.map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes"]);
    const approvalValue = parseAction(actions[0]!.value);
    expect(approvalValue).toMatchObject({ taskId: h.taskId, revision: 2, decision: "APPROVE" });
    expect(typeof approvalValue.digest === "string" && /^[a-f0-9]{64}$/.test(approvalValue.digest)).toBe(true);
    const saved = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { artifacts: Array<{ id: string; objectKey: string; type: string }>; canvasLineage?: Array<Record<string, unknown>> } };
    const planArtifact = saved.workflow.artifacts?.find((artifact) => artifact.type === "plan");
    expect(planArtifact).toBeDefined();
    expect(saved.workflow.canvasLineage).toEqual([expect.objectContaining({
      key: `PLAN_REVIEW:2:${planArtifact!.id}`, workflowRevision: 2, artifactId: planArtifact!.id, artifactRef: planArtifact!.objectKey,
      artifactDigest: createHash("sha256").update(plan).digest("hex"), state: "CREATED", canvasId: "F12345678",
      permalink: "https://acme.slack.com/docs/T123/F12345678",
    })]);
  });

  it("updates the original approval card after an owner decision and removes its buttons", async () => {
    const plan = "# Plan\nAdd a retry regression test.";
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => plan,
      createPlanCanvas: async () => ({ canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" }),
    });
    const workflowRecord = h.db.get(`DEVTASK#${h.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    const requiredCheck = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
    h.db.set({ ...workflowRecord, workflow: { ...workflowRecord.workflow, checkPolicy: { required: [requiredCheck], optional: [], selectedOptionalIds: [] } } });

    await h.pump();
    const prepare = h.active();
    await h.finish(h.workspaceId, prepare, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const approvalCard = h.posts.at(-1)!;
    const originalActions = (approvalCard.blocks?.at(-1) as { elements: Array<{ action_id: string }> }).elements;
    expect(originalActions.map((action) => action.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes"]);
    const saved = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
    const planRevision = saved.workflow.revision;
    const planDigest = saved.workflow.artifacts.at(-1)?.sha256;
    const decision = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: saved.workflow.revision, decision: "APPROVE", reason: "Looks good.",
      artifactDigest: planDigest,
    });
    expect(decision.status).toBe(200);
    await h.pump();

    expect(h.updates).toHaveLength(1);
    const postedMarker = h.db.find((item) => item.pk === `DEVTASK#${h.taskId}` && item.postedWorkflowRevision === planRevision && item.postedArtifactDigest === planDigest)[0];
    expect(h.updates[0]?.channel).toBe(approvalCard.channel);
    expect(h.updates[0]?.ts).toBe(postedMarker?.postedTs);
    expect(h.updates[0]?.text).toBe(approvalCard.text);
    expect(h.updates[0]?.blocks.every((block) => (block as { type?: string }).type === "section")).toBe(true);
    expect(JSON.stringify(h.updates[0]?.blocks)).not.toContain("agentx_workflow_approve");
    expect(JSON.stringify(h.updates[0]?.blocks)).not.toContain("agentx_workflow_changes");
  });

  it("removes stale buttons without growing a long fallback approval message", async () => {
    const plan = "P".repeat(32_700);
    const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
    const originalText: { value?: string } = {};
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => plan,
      createPlanCanvas: async () => { throw new SlackPostError("free_teams_cannot_create_standalone_canvases"); },
      update: async (input) => {
        if (originalText.value !== undefined && input.text.length > originalText.value.length) throw new SlackPostError("msg_too_long");
        updates.push(input);
      },
    });
    const workflowRecord = h.db.get(`DEVTASK#${h.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    const requiredCheck = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
    h.db.set({ ...workflowRecord, workflow: { ...workflowRecord.workflow, checkPolicy: { required: [requiredCheck], optional: [], selectedOptionalIds: [] } } });
    await h.pump();
    const preparation = h.active();
    await h.finish(h.workspaceId, preparation, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const approvalCard = h.posts.at(-1)!;
    originalText.value = approvalCard.text;
    expect(approvalCard.text.length).toBeGreaterThan(32_768);
    const saved = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
    const decision = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: saved.workflow.revision, decision: "APPROVE", reason: "Looks good.",
      artifactDigest: saved.workflow.artifacts.at(-1)?.sha256,
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    await h.pump();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toBe(approvalCard.text);
    expect(JSON.stringify(updates[0]?.blocks)).not.toContain("agentx_workflow_approve");
    expect(JSON.stringify(updates[0]?.blocks)).not.toContain("agentx_workflow_changes");
  });

  it("shows the saved plan in Slack when this workspace cannot create Canvases", async () => {
    const plan = "# Goal\nFix retry handling.\n\n## Checks\nRun the retry regression test.";
    const createPlanCanvas = vi.fn(async () => { throw new SlackPostError("free_teams_cannot_create_standalone_canvases"); });
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => plan, createPlanCanvas });
    await h.pump();
    const preparation = h.active();
    await h.finish(h.workspaceId, preparation, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const message = h.posts.at(-1)!;
    expect(message.text).toContain("Canvas isn’t available in this Slack workspace");
    expect(message.text).toContain(plan);
    expect(message.text).toContain("No code changes have started.");
    const sections = (message.blocks ?? []).filter((block) => (block as { type?: string }).type === "section") as Array<{ text: { text: string } }>;
    expect(sections.map((section) => section.text.text).join("\n")).toContain(plan);
    const actions = (message.blocks?.at(-1) as { elements: Array<{ action_id: string }> }).elements;
    expect(actions.map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes"]);
  });

  it("shows the current requirements document in the Full path approval message", async () => {
    const requirements = "# Requirements\nAdd password reset.\n";
    const createPlanCanvas = vi.fn(async () => ({ canvasId: "F22345678", permalink: "https://acme.slack.com/docs/T123/F22345678" }));
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => requirements,
      createPlanCanvas,
    });
    await h.pump();
    const taskKey = `DEVTASK#${h.taskId}`;
    const task = h.db.get(taskKey, "META") as { workflow: Record<string, unknown> };
    h.db.set({ pk: taskKey, sk: "META", ...task, workflow: { ...task.workflow, path: "FULL", reviewPhase: "REQUIREMENTS" } });
    const preparation = h.active();
    await h.finish(h.workspaceId, preparation, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", requirements);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const message = h.posts.at(-1)!;
    expect(createPlanCanvas).toHaveBeenCalledWith(expect.objectContaining({ markdown: requirements }), expect.any(Function));
    expect(message.text).toBe("The requirements document is ready. No code changes have started. <https://acme.slack.com/docs/T123/F22345678|Read and approve this step>.");
    const actions = (message.blocks?.[1] as { elements: Array<{ text: { text: string } }> }).elements;
    expect(actions[0]?.text.text).toBe("Approve this step");
  });

  it("posts concise Slack updates as GitHub merges each required pull request", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    h.advance(10_000);
    const taskKey = `DEVTASK#${h.taskId}`;
    const saveWorkflow = async (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: taskKey, sk: "META" }, UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ExpressionAttributeValues: { ":workflow": workflow, ":now": new Date(h.now()).toISOString() },
    }));
    const first = {
      stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 1,
      artifacts: [],
      pullRequests: [
        { repositoryId: "api", number: 12, url: "https://github.com/example/api/pull/12", required: true, state: "UNKNOWN", candidateDigest: "a".repeat(64) },
        { repositoryId: "web", number: 13, url: "https://github.com/example/web/pull/13", required: true, state: "UNKNOWN", candidateDigest: "a".repeat(64) },
      ],
    };
    await saveWorkflow(first);
    await h.pump();
    await saveWorkflow({ ...first, revision: 2, pullRequests: first.pullRequests.map((pr, index) => ({ ...pr, state: index === 0 ? "MERGED" : "OPEN" })) });
    await h.pump();
    expect(h.posts.at(-1)!.text).toContain("GitHub update: 1 of 2 pull requests is merged.");
    expect(h.posts.at(-1)!.text).toContain("<https://github.com/example/web/pull/13|PR #13> is still open.");
    await saveWorkflow({ ...first, revision: 3, stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: first.pullRequests.map((pr) => ({ ...pr, state: "MERGED" })) });
    await h.pump();
    expect(h.posts.at(-1)!.text).toBe("GitHub confirms all 2 required pull requests are merged. The task is complete.");
  });

  it("keeps legacy PR feedback notices redacted and does not expose an unbound approval button", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    h.advance(10_000);
    const taskKey = `DEVTASK#${h.taskId}`;
    const candidateDigest = "a".repeat(64);
    const saveWorkflow = async (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: taskKey, sk: "META" }, UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ExpressionAttributeValues: { ":workflow": workflow, ":now": new Date(h.now()).toISOString() },
    }));
    await saveWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 1, artifacts: [], candidate: { digest: candidateDigest }, pullRequests: [
      { repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", required: true, state: "OPEN", candidateDigest },
    ] });
    await h.pump();
    const feedbackId = "f".repeat(64);
    await saveWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 2, artifacts: [], candidate: { digest: candidateDigest }, pullRequests: [
      { repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", required: true, state: "OPEN", candidateDigest },
    ], feedback: {
      feedbackId, status: "PENDING", repositoryId: "payments", number: 11, candidateDigest,
      comments: [{ id: "4321", url: "https://github.com/acme/payments/pull/11#discussion_r4321", author: "reviewer", body: "Handle this edge case" }],
      proposedPlan: "Review the comment in context, update code, and rerun checks and reviews.", planDigest: "b".repeat(64),
    } });
    await h.pump();
    const message = h.posts.at(-1)!;
    expect(message.text).toContain("PR #11 has reviewer feedback");
    expect(message.text).toContain("Open the GitHub comment");
    expect(message.text).not.toContain("Handle this edge case");
    expect(message.text).not.toContain("Review the comment in context");
    expect(message.blocks).toBeUndefined();
  });

  it("posts the start message in the channel and records the thread", async () => {
    const { db, posts, pump, taskId } = await notifierHarness({ shareToChannel: true, shareMode: "continue" });
    await pump();
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toHaveProperty("threadTs");
    expect(posts[0]!.channel).toBe(SLACK_CHANNEL);
    expect(posts[0]!.text).toContain(`<@${MAYA.slackUserId}> started a task from Claude Code: *Fix the flaky retry test*`);
    expect(posts[0]!.text).toContain("Status: STARTING");
    expect(posts[0]!.text).toContain("may mention AgentX in this thread");
    const task = db.get(`DEVTASK#${taskId}`, "META") as { share: { threadTs: string } };
    expect(task.share.threadTs).toMatch(/^\d{10}\.\d{6}$/);
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${task.share.threadTs}`, "META")).toMatchObject({ taskId, mode: "continue", ownerKey: expect.any(String) as string });
  });

  it("replies in the thread as the task runs, ends and opens a pull request, then closes; the summary is redacted", async () => {
    const h = await notifierHarness();
    await h.pump();
    const prepareId = h.active();
    await h.finish(h.workspaceId, prepareId, "SUCCEEDED");
    await h.pump();
    const taskOperation = h.active();
    await h.events(h.workspaceId, taskOperation, [say(`All green. Token was ${SECRET}.`)]);
    await h.finish(h.workspaceId, taskOperation, "SUCCEEDED");
    await h.pump();
    const opened = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix the flaky retry test" });
    const operationId = String(opened.body.operationId);
    const publish = h.db.find((item) => item.entityType === "OPERATION" && item.id === operationId)[0] as { publication: { headBranch: string } };
    const url = "https://github.com/example/demo/pull/7";
    await h.finish(h.workspaceId, operationId, "SUCCEEDED", { result: { repository: "demo", number: 7, url, headBranch: publish.publication.headBranch, baseBranch: "main", commit: "a".repeat(40), checks: [], reconciled: false } });
    await h.pump();
    const thread = h.posts[0]!;
    const replies = h.posts.slice(1);
    expect(replies.every((reply) => reply.threadTs !== undefined && reply.channel === thread.channel)).toBe(true);
    expect(replies.map((reply) => reply.text.split("\n")[0])).toEqual([
      "The workspace is ready, and the task is running.",
      "The task ended SUCCEEDED.",
      `Pull request opened: ${url}`,
    ]);
    expect(replies[1]!.text).toContain(">All green.");
    expect(JSON.stringify(h.posts)).not.toContain(SECRET);
  });

  it("says a failed pull request as the pull request, in the thread (final review M4)", async () => {
    const h = await notifierHarness();
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const opened = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix the flaky retry test" });
    await h.finish(h.workspaceId, String(opened.body.operationId), "FAILED", { error: "push rejected" });
    await h.pump();
    expect(h.posts.at(-1)!.text).toBe("The pull request could not be opened (FAILED, publication_failed): push rejected");
  });

  it("posts nothing for a private task (US3 scenario 3)", async () => {
    const h = await notifierHarness({});
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.queue).toEqual([]);
  });

  it("shares a running task with its current status, and leaves out what happened before (US3 scenario 9)", async () => {
    const h = await notifierHarness({});
    const prepareId = h.active();
    await h.finish(h.workspaceId, prepareId, "SUCCEEDED");
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID() });
    // Deterministic timing: the share is 5 seconds after the prepare ended (db.set emits no stream record).
    const readyAt = Date.parse(String((h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${prepareId}`) as { updatedAt: string }).updatedAt));
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> };
    h.db.set({ ...task, share: { ...task.share, sharedAt: new Date(readyAt + 5_000).toISOString() } });
    // Ruling F7: the earlier "workspace is ready" is dropped, not held for the thread.
    await h.pump();
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.text).toContain("Status: RUNNING");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "ready", noticeId: `${prepareId}:ready`, outcome: "before_share" }));
  });

  it("holds a reply until the start message has its thread, then posts it there", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.queue.map((entry) => entry.notice.kind).sort()).toEqual(["ready", "start"]);
    h.fail(undefined);
    await h.pump();
    await h.pump();
    expect(h.posts.map((post) => post.threadTs === undefined ? "start" : "reply")).toEqual(["start", "reply"]);
  });

  it("posts each notice once, however often it is delivered (C9)", async () => {
    const h = await notifierHarness();
    await h.pump();
    const [start] = h.posts;
    const again = { notice: { id: `${h.taskId}:start`, kind: "start" as const, taskId: h.taskId, at: new Date().toISOString() }, attempt: 0 };
    h.queue.push(again, again);
    await h.pump();
    expect(h.posts).toEqual([start]);
  });

  it("says a mode change, and skips a change that a later one replaced", async () => {
    const h = await notifierHarness();
    await h.pump();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "view" });
    await h.pump();
    expect(h.posts.slice(1).map((post) => post.text)).toEqual(["This thread is now view only: follow-ups happen in the developer's AI tool."]);
  });
});

describe("retries (C9, Review Focus 3)", () => {
  it("retries with a growing delay within the hour", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    await h.pump();
    expect(h.retryLater.mock.calls.map(([, seconds]) => seconds)).toEqual([30, 60]);
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 900, 900]);
    expect(h.deliveryFailed).not.toHaveBeenCalled();
  });

  it("gives up on the start message after an hour and drops the task's later replies", async () => {
    const h = await notifierHarness();
    h.fail("channel_not_found");
    await h.pump();
    h.advance(3_600_000 + 2_000);
    await h.pump();
    expect(h.deliveryFailed).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.delivery_failed", kind: "start", reason: "channel_not_found" }));
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> }).share).toHaveProperty("postFailedAt");
    h.fail(undefined);
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(h.posts).toEqual([]);
    expect(h.deliveryFailed).toHaveBeenCalledTimes(1);
    expect((await h.dev(MAYA, "GET", `/v1/dev/tasks/${h.taskId}`)).body.task).toMatchObject({ share: { postFailed: true } });
  });

  it("never logs the bot token or a post's text", async () => {
    // Ruling F6: the token flows into the real Slack call, which Slack refuses.
    const refused = vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" }));
    const h = await notifierHarness({ shareToChannel: true }, { post: (input) => chatPostMessage(BOT_TOKEN, input, refused) });
    await h.pump();
    expect(refused).toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", kind: "start", reason: "invalid_auth" }));
    expect(JSON.stringify(h.logs)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain("Fix the flaky retry test");
  });
});

describe("a closed task (C24, Q3)", () => {
  it("records the thread closed when the start message is posted after the close", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "npm ci exited 1" });
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/close`, { requestId: randomUUID() });
    h.fail(undefined);
    await h.pump();
    await h.pump();
    const threadTs = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { threadTs: string } }).share.threadTs;
    expect(h.db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, "META")).toMatchObject({ closedAt: expect.any(String) as string });
    expect(h.posts.map((post) => post.text.split("\n")[0])).toContain("The task is closed, and its workspace is released. This thread no longer drives it.");
  });

  it("posts nothing after the closed reply (Q3)", async () => {
    const h = await notifierHarness();
    await h.pump();
    const prepareId = h.active();
    await h.finish(h.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    await h.pump();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/close`, { requestId: randomUUID() });
    await h.pump();
    expect(h.posts.at(-1)!.text).toBe("The task is closed, and its workspace is released. This thread no longer drives it.");
    const posted = h.posts.length;
    h.queue.push({ notice: { id: `${randomUUID()}:setup_failed`, kind: "setup_failed", workspaceId: h.workspaceId, operationId: prepareId, at: new Date(Date.now() + 1_000).toISOString() }, attempt: 0 });
    await h.pump();
    expect(h.posts).toHaveLength(posted);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "setup_failed", outcome: "after_close" }));
  });

  it("posts nothing for an earlier change delivered after the closed reply (Q3)", async () => {
    const h = await notifierHarness();
    await h.pump();
    const prepareId = h.active();
    await h.finish(h.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    await h.pump();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/close`, { requestId: randomUUID() });
    await h.pump();
    const posted = h.posts.length;
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { sharedAt: string }; closedAt: string };
    expect(Date.parse(task.share.sharedAt)).toBeLessThan(Date.parse(task.closedAt));
    // Changed before the close (at the share's time), delivered after the closed reply.
    h.queue.push({ notice: { id: `${randomUUID()}:setup_failed`, kind: "setup_failed", workspaceId: h.workspaceId, operationId: prepareId, at: task.share.sharedAt }, attempt: 0 });
    await h.pump();
    expect(h.posts).toHaveLength(posted);
    expect(h.logs.filter((entry) => entry.outcome === "after_close")).toHaveLength(1);
  });

  it("drops an expired notice even when counting the failure throws", async () => {
    const h = await notifierHarness();
    h.fail("channel_not_found");
    await h.pump();
    h.deliveryFailed.mockImplementation(() => { throw Object.assign(new Error("namespace missing"), { name: "MetricError" }); });
    h.advance(3_600_000 + 2_000);
    await h.pump();
    expect(h.queue).toEqual([]);
    expect(h.logs).toContainEqual({ event: "developer_notifier.metric_failed", error: "MetricError" });
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> }).share).toHaveProperty("postFailedAt");
  });
});

describe("races with the start message (C1, C24)", () => {
  /** A table whose next TransactWriteCommand first runs `before`: another writer committing meanwhile. */
  function interleaved() {
    let before: (() => Promise<void>) | undefined;
    return {
      set: (run: () => Promise<void>) => { before = run; },
      documentClient: (db: FakeDynamoDb): Client => ({
        send: async (command: unknown) => {
          if (before !== undefined && command instanceof TransactWriteCommand) {
            const run = before;
            before = undefined;
            await run();
          }
          return db.send(command as Parameters<FakeDynamoDb["send"]>[0]);
        },
      }),
    };
  }

  it("records the thread closed when the task closes between the start post and its record (ruling F4)", async () => {
    const race = interleaved();
    const h = await notifierHarness({ shareToChannel: true }, { documentClient: race.documentClient });
    h.fail("ratelimited");
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "npm ci exited 1" });
    h.fail(undefined);
    race.set(async () => { await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/close`, { requestId: randomUUID() }); });
    await h.pump();
    await h.pump();
    const threadTs = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { threadTs: string } }).share.threadTs;
    expect(h.db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, "META")).toMatchObject({ closedAt: expect.any(String) as string });
    expect(h.posts.map((post) => post.text.split("\n")[0])).toContain("The task is closed, and its workspace is released. This thread no longer drives it.");
  });

  it("keeps a posted start message's ts when its record fails, and records that thread on the next delivery, without posting again", async () => {
    const race = interleaved();
    const h = await notifierHarness({ shareToChannel: true }, { documentClient: race.documentClient });
    race.set(async () => { throw Object.assign(new Error("the table is unavailable"), { name: "InternalServerError" }); });
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> }).share).not.toHaveProperty("threadTs");
    const { postedTs } = h.db.get(`DEVTASK#${h.taskId}`, `NOTICE#${h.taskId}:start`) as { postedTs: string };
    expect(postedTs).toMatch(/^\d{10}\.\d{6}$/);
    expect(h.queue).toHaveLength(1);
    await h.pump();
    expect(h.posts).toHaveLength(1);
    const threadTs = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { threadTs: string } }).share.threadTs;
    expect(threadTs).toBe(postedTs);
    expect(h.db.get(`DEVTASK#${h.taskId}`, `NOTICE#${h.taskId}:start`)).toMatchObject({ deliveredAt: expect.any(String) as string });
    expect(h.db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, "META")).toMatchObject({ taskId: h.taskId });
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "start", outcome: "recorded" }));
    // Later deliveries find it delivered.
    h.queue.push({ notice: { id: `${h.taskId}:start`, kind: "start", taskId: h.taskId, at: new Date().toISOString() }, attempt: 0 });
    await h.pump();
    expect(h.posts).toHaveLength(1);
  });

  it("posts the start message once when two deliveries of it run at the same time (final review M3)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const posted: string[] = [];
    const h = await notifierHarness({ shareToChannel: true }, { post: async (input) => { posted.push(input.channel); await gate; return { ts: "1695500000.000200" }; } });
    await h.handle({ Records: h.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const start = h.queue.find((entry) => entry.notice.kind === "start")!.notice;
    const delivery = (id: string) => h.handle({ Records: [{ eventSource: "aws:sqs", messageId: id, receiptHandle: id, body: JSON.stringify(start), attributes: { ApproximateReceiveCount: "1" } }] });
    const first = delivery("first");
    const second = delivery("second");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    release();
    const answers = await Promise.all([first, second]);
    expect(posted).toHaveLength(1);
    // The delivery that did not post waits for the other one, and is retried.
    expect(answers.flatMap((answer) => answer.batchItemFailures.map((failure) => failure.itemIdentifier))).toHaveLength(1);
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { threadTs: string } }).share.threadTs).toBe("1695500000.000200");
    expect(h.logs).not.toContainEqual(expect.objectContaining({ event: "developer_notifier.start_posted_twice" }));
    // Its retry finds the start delivered and posts nothing.
    expect((await delivery("again")).batchItemFailures).toEqual([]);
    expect(posted).toHaveLength(1);
  });

  it("lets a later delivery post the start message when an earlier one failed to post (final review M3)", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    expect(h.posts).toHaveLength(0);
    h.fail(undefined);
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect((h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: Record<string, unknown> }).share).toHaveProperty("threadTs");
  });
});

describe("chat.postMessage", () => {
  it("returns the message's ts, and reports Slack's error code without the token", async () => {
    const ok = vi.fn(async () => Response.json({ ok: true, ts: "1695500000.000200" }));
    expect(await chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, threadTs: "1695500000.000100", text: "hi" }, ok as unknown as typeof fetch)).toEqual({ ts: "1695500000.000200" });
    expect(JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit & { body: string }])[1].body) as unknown).toMatchObject({ channel: SLACK_CHANNEL, thread_ts: "1695500000.000100", unfurl_links: false });
    const refused = vi.fn(async () => Response.json({ ok: false, error: "not_in_channel" }));
    await expect(chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, text: "hi" }, refused as unknown as typeof fetch)).rejects.toMatchObject({ slackError: "not_in_channel" });
    const error = await chatPostMessage(BOT_TOKEN, { channel: SLACK_CHANNEL, text: "hi" }, refused as unknown as typeof fetch).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it("keeps the bot token cached, and loads it again after Slack refuses it", async () => {
    const loadToken = vi.fn(async () => BOT_TOKEN);
    let answer: Record<string, unknown> = { ok: true, ts: "1695500000.000200" };
    const fetcher = vi.fn(async () => Response.json(answer));
    const post = cachedSlackPoster(loadToken, () => 0, fetcher);
    await post({ channel: SLACK_CHANNEL, text: "hi" });
    await post({ channel: SLACK_CHANNEL, text: "hi" });
    expect(loadToken).toHaveBeenCalledTimes(1);
    for (const code of ["invalid_auth", "token_revoked"]) {
      answer = { ok: false, error: code };
      await expect(post({ channel: SLACK_CHANNEL, text: "hi" })).rejects.toMatchObject({ slackError: code });
    }
    answer = { ok: false, error: "ratelimited" };
    await expect(post({ channel: SLACK_CHANNEL, text: "hi" })).rejects.toMatchObject({ slackError: "ratelimited" });
    answer = { ok: true, ts: "1695500000.000300" };
    await post({ channel: SLACK_CHANNEL, text: "hi" });
    // Loaded once at first, and once after each refusal; a rate limit keeps the token.
    expect(loadToken).toHaveBeenCalledTimes(3);
  });
});

describe("notice markers expire after 30 days (25c note 2)", () => {
  const expiry = (h: { now(): number }) => indexExpiresAt(new Date(h.now()).toISOString());
  const notices = (db: FakeDynamoDb) => db.find((item) => item.entityType === "NOTICE");

  it("gives every delivered marker, the start's and each reply's, the TTL attribute", async () => {
    const h = await notifierHarness();
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const markers = notices(h.db);
    expect(markers.length).toBeGreaterThanOrEqual(3);
    for (const marker of markers) expect(marker).toMatchObject({ deliveredAt: expect.any(String) as string, indexExpiresAt: expiry(h) });
  });

  it("gives a start claim whose post failed the TTL attribute", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    const claim = h.db.get(`DEVTASK#${h.taskId}`, `NOTICE#${h.taskId}:start`);
    expect(claim).not.toHaveProperty("deliveredAt");
    expect(claim).toMatchObject({ indexExpiresAt: expiry(h) });
  });

  it("gives a kept start ts the TTL attribute", async () => {
    const h = await notifierHarness({ shareToChannel: true }, {
      documentClient: (db) => ({
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) throw Object.assign(new Error("the table is unavailable"), { name: "InternalServerError" });
          return db.send(command as Parameters<FakeDynamoDb["send"]>[0]);
        },
      }),
    });
    await h.pump();
    expect(h.db.get(`DEVTASK#${h.taskId}`, `NOTICE#${h.taskId}:start`)).toMatchObject({ postedTs: expect.any(String) as string, indexExpiresAt: expiry(h) });
  });
});

describe("an uncertain start post is logged (25c note 3)", () => {
  const uncertain = (logs: Array<Record<string, unknown>>) => logs.filter((entry) => entry.event === "developer_notifier.start_post_uncertain");

  /** The real poster, over a fake fetch: what the Lambda posts with. */
  const poster = (fetchImplementation: () => Promise<Response>, loadToken: () => Promise<string> = async () => BOT_TOKEN) =>
    cachedSlackPoster(loadToken, Date.now, fetchImplementation);

  it("logs a start post whose request failed before Slack answered, once, with the error's name only", async () => {
    let calls = 0;
    const h = await notifierHarness({ shareToChannel: true }, {
      post: poster(async () => { calls += 1; throw Object.assign(new Error(`the operation was aborted ${BOT_TOKEN}`), { name: "TimeoutError" }); }),
    });
    await h.pump();
    expect(calls).toBe(1);
    expect(uncertain(h.logs)).toEqual([{ event: "developer_notifier.start_post_uncertain", reason: "post_error", taskId: h.taskId, error: "TimeoutError" }]);
    expect(JSON.stringify(h.logs)).not.toContain(BOT_TOKEN);
  });

  it("logs a start post whose 2xx answer could not be read, since Slack may have posted it", async () => {
    const h = await notifierHarness({ shareToChannel: true }, {
      post: poster(async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error("body cut off"), { name: "AbortError" }); } }) as unknown as Response),
    });
    await h.pump();
    expect(uncertain(h.logs)).toEqual([{ event: "developer_notifier.start_post_uncertain", reason: "post_error", taskId: h.taskId, error: "SlackPostError" }]);
  });

  it("logs a start post that met a 5xx answer", async () => {
    const h = await notifierHarness({ shareToChannel: true }, {
      post: poster(async () => ({ ok: false, status: 503, json: async () => { throw new Error("not json"); } }) as unknown as Response),
    });
    await h.pump();
    expect(uncertain(h.logs)).toHaveLength(1);
  });

  it("does not log a start post that never left because the bot token could not be loaded", async () => {
    let fetched = 0;
    const h = await notifierHarness({ shareToChannel: true }, {
      post: poster(async () => { fetched += 1; throw new Error("unreachable"); }, async () => { throw Object.assign(new Error("throttled"), { name: "ThrottlingException" }); }),
    });
    await h.pump();
    expect(fetched).toBe(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", kind: "start", reason: "ThrottlingException" }));
    expect(uncertain(h.logs)).toEqual([]);
  });

  it("does not log a start post Slack refused with its own error code", async () => {
    const h = await notifierHarness({ shareToChannel: true }, {
      post: poster(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "channel_not_found" }) }) as unknown as Response),
    });
    await h.pump();
    expect(uncertain(h.logs)).toEqual([]);
  });

  it("does not log a post Slack refused", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    expect(uncertain(h.logs)).toEqual([]);
  });

  it("does not log a reply's failed post, only the start's", async () => {
    let failReplies = false;
    let ts = 1_695_500_000_000_300;
    const h = await notifierHarness({ shareToChannel: true }, {
      post: async (input) => {
        if (failReplies && input.threadTs !== undefined) throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
        ts += 1;
        const text = String(ts);
        return { ts: `${text.slice(0, 10)}.${text.slice(10)}` };
      },
    });
    await h.pump();
    failReplies = true;
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    expect(uncertain(h.logs)).toEqual([]);
  });

  it("logs a lapsed start claim with no posted ts, once, and posts again", async () => {
    const h = await notifierHarness();
    await h.handle({ Records: h.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    // A delivery claimed the post and then died before it recorded anything.
    h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: `NOTICE#${h.taskId}:start`, entityType: "NOTICE", postingUntil: h.now() - 1 });
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect(uncertain(h.logs)).toEqual([{ event: "developer_notifier.start_post_uncertain", reason: "claim_lapsed", taskId: h.taskId }]);
  });

  it("logs a lapsed claim once when two deliveries find it at the same time, from the one that wins the claim", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await notifierHarness({ shareToChannel: true }, { post: async () => { await gate; return { ts: "1695500000.000200" }; } });
    await h.handle({ Records: h.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const start = h.queue.find((entry) => entry.notice.kind === "start")!.notice;
    h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: `NOTICE#${h.taskId}:start`, entityType: "NOTICE", postingUntil: h.now() - 1 });
    const delivery = (id: string) => h.handle({ Records: [{ eventSource: "aws:sqs", messageId: id, receiptHandle: id, body: JSON.stringify(start), attributes: { ApproximateReceiveCount: "1" } }] });
    const both = Promise.all([delivery("first"), delivery("second")]);
    await vi.waitFor(() => expect(uncertain(h.logs)).toHaveLength(1));
    release();
    await both;
    expect(uncertain(h.logs)).toEqual([{ event: "developer_notifier.start_post_uncertain", reason: "claim_lapsed", taskId: h.taskId }]);
  });

  it("does not log a start claim given back after Slack refused the post", async () => {
    const h = await notifierHarness();
    h.fail("ratelimited");
    await h.pump();
    h.fail(undefined);
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect(uncertain(h.logs)).toEqual([]);
  });
});

describe("the PR feedback advisory summary", () => {
  it("posts a brief, redacted summary with a secure detail link and named actions", async () => {
    const { feedbackReviewSlackMessage } = await import("../../packages/broker/src/aws/developer-task-notifier.js");
    const message = feedbackReviewSlackMessage({
      taskId: "11111111-1111-4111-8111-111111111111", revision: 8,
      reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)],
      totalComments: 7, recommendedFindingIds: ["finding-1", "finding-2"], highestPriority: "MUST_FIX",
      detailUrl: "https://agentx.example/review/11111111-1111-4111-8111-111111111111",
    });
    expect(message.text).toContain("7 comments");
    expect(message.text).toContain("2 recommendations");
    expect(message.text).toContain("Highest priority: must fix");
    expect(message.text).toContain("https://agentx.example/review/");
    expect(message.text).not.toContain("hostile comment");
    expect(message.text).not.toContain("full fix plan");
    expect(message.text.length).toBeLessThan(500);
    const blocks = message.blocks as Array<{ elements?: Array<{ action_id: string; value: string }> }>;
    const actions = blocks.flatMap(block => block.elements ?? []);
    expect(actions.map(action => action.action_id)).toEqual([
      "agentx_feedback_review_recommended", "agentx_feedback_review_changes",
    ]);
    const feedbackActionValue = parseAction(actions[0]!.value);
    expect(feedbackActionValue).toMatchObject({
      selection: "RECOMMENDED", expectedRevision: 8, reviewDigest: "a".repeat(64),
      proposalDigest: "b".repeat(64),
    });
    expect(typeof feedbackActionValue.bundleSetDigest === "string" && /^[a-f0-9]{64}$/.test(feedbackActionValue.bundleSetDigest)).toBe(true);
    const maxPrMessage = feedbackReviewSlackMessage({ taskId: "11111111-1111-4111-8111-111111111111", revision: 8,
      reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: Array.from({ length: 32 }, (_, index) => String(index).padStart(2, "0").repeat(32)),
      totalComments: 128, recommendedFindingIds: ["finding"], highestPriority: "MUST_FIX", detailUrl: "https://agentx.example/review/11111111-1111-4111-8111-111111111111" });
    const maxPrActionValue = parseAction(((maxPrMessage.blocks[1] as { elements: Array<{ value: string }> }).elements[0]!).value);
    expect(typeof maxPrActionValue.bundleSetDigest === "string" && /^[a-f0-9]{64}$/.test(maxPrActionValue.bundleSetDigest)).toBe(true);
    expect(((maxPrMessage.blocks[1] as { elements: Array<{ value: string }> }).elements[0]!).value.length).toBeLessThan(2_000);
  });

  it("does not offer approval when there are no recommended fixes", async () => {
    const { feedbackReviewSlackMessage } = await import("../../packages/broker/src/aws/developer-task-notifier.js");
    const message = feedbackReviewSlackMessage({
      taskId: "11111111-1111-4111-8111-111111111111", revision: 8,
      reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)],
      totalComments: 0, recommendedFindingIds: [], highestPriority: undefined,
      detailUrl: "https://agentx.example/review/11111111-1111-4111-8111-111111111111",
    });
    expect(message.text).toContain("No fixes are recommended");
    const actions = (message.blocks as Array<{ elements?: Array<{ action_id: string; text: { text: string } }> }>).flatMap(block => block.elements ?? []);
    expect(actions.map(action => action.action_id)).toEqual(["agentx_feedback_review_changes"]);
    expect(actions[0]?.text.text).toBe("Request changes");
  });
});
