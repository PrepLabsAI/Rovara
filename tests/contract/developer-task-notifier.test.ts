// tests/contract/developer-task-notifier.test.ts
// Spec 025 FR-032, FR-034, C7 to C9: the notifier, fed from the fake table's writes, posting to a
// fake Slack. The queue is an array; a failed notice stays in it with its attempt count.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, indexExpiresAt } from "@agentx/contracts";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { SlackPostError, chatPostMessage } from "../../packages/broker/src/aws/slack-web.js";
import { cachedSlackPoster, createNotifierHandler, retryDelaySeconds } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { StrictSlackWeb, visibleSlackText } from "../support/strict-slack.js";
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
  reviewUrlBase?: string;
} = {}) {
  const harness = await createDeveloperTaskBroker();
  const postOverride = options.post;
  // Gap 12: every thread post stays brief (1,200 visible characters, blocks included).
  const strict = new StrictSlackWeb({ briefLimit: 1_200 });
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string; blocks?: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  let failing: string | undefined;
  const deliveryFailed = vi.fn();
  const retryLater = vi.fn(async () => undefined);
  const handle = createNotifierHandler({
    documentClient: options.documentClient?.(harness.db) ?? harness.db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater,
    post: postOverride ?? (async (input) => {
      if (failing !== undefined) throw new SlackPostError(failing);
      const posted = strict.post(input);
      posts.push(input);
      return { ts: posted.ts };
    }),
    update: options.update ?? (async (input) => { strict.update(input); updates.push(input); }),
    postEphemeral: async (input) => { strict.postEphemeral(input); },
    ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
    ...(options.createPlanCanvas === undefined ? {} : { createPlanCanvas: options.createPlanCanvas }),
    ...(options.reviewUrlBase === undefined ? {} : { reviewUrlBase: options.reviewUrlBase }),
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
    ...harness, strict, stream, posts, updates, queue, logs, pump, handle, taskId, workspaceId, active, deliveryFailed, retryLater,
    advance: (ms: number) => { clock += ms; }, fail: (code: string | undefined) => { failing = code; }, now: () => clock,
  };
}

describe("refused Slack presses (Task 19)", () => {
  it("tells the presser privately, in the task's thread, why the broker refused a press, once", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    const share = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { channelId: string; threadTs: string } }).share;
    const before = h.posts.length;
    // A teammate presses the owner's button in the thread.
    const answer = await h.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId: h.taskId, userId: "U0TEAMMATE1",
      thread: { teamId: SLACK_TEAM, channelId: share.channelId, threadTs: share.threadTs }, requestId: randomUUID(), expectedRevision: 99,
      artifactDigest: "a".repeat(64), decision: "APPROVE", reason: "Approved in Slack.", selectedOptionalCheckIds: [] });
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ refused: true });
    await h.pump();
    expect(h.strict.ephemerals).toEqual([{ channel: share.channelId, threadTs: share.threadTs, user: "U0TEAMMATE1", text: "Only the task owner can do that." }]);
    // Nobody else hears it, and a redelivered notice says it once.
    expect(h.posts.length).toBe(before);
    const delivered = h.logs.filter((entry) => entry.event === "developer_notifier.notice" && entry.kind === "workflow_refusal");
    expect(delivered).toEqual([expect.objectContaining({ outcome: "posted" })]);
    const notice = { id: String(delivered[0]!.noticeId), kind: "workflow_refusal", taskId: h.taskId, at: new Date(h.now()).toISOString() };
    await h.handle({ Records: [{ eventSource: "aws:sqs", messageId: "again", receiptHandle: "again", body: JSON.stringify(notice) }] });
    expect(h.strict.ephemerals).toHaveLength(1);
  });
});

describe("cards whose step is over lose their buttons (Task 19)", () => {
  const candidateDigest = "a".repeat(64);
  const now = () => new Date().toISOString();
  const review = (status: string, findings: unknown[] = []) => ({ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest, role: "SECURITY", provider: "test", version: "1",
    status, ...(status === "UNKNOWN" ? { failureReason: "INVALID_JSON" } : {}), findings, readOnly: true, recordedAt: now() });
  const passed = { candidateDigest, results: [{ checkId: "required-1", status: "PASS" }] };
  const kinds: Array<{ name: string; actionId: string; workflow: Record<string, unknown> }> = [
    { name: "Retry planning", actionId: "agentx_workflow_retry_plan", workflow: { stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended failed" } },
    { name: "Retry coding", actionId: "agentx_workflow_retry_implementation", workflow: { stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" } },
    { name: "Retry reviews", actionId: "agentx_workflow_retry_reviews", workflow: { stage: "REVIEW", state: "BLOCKED", candidate: { digest: candidateDigest }, verification: passed, reviews: [review("UNKNOWN")] } },
    { name: "Send back to coding", actionId: "agentx_workflow_send_back", workflow: { stage: "REVIEW", state: "BLOCKED", candidate: { digest: candidateDigest }, verification: passed,
      reviews: [review("FINDINGS", [{ text: "The parser drops the last line.", origin: "INTRODUCED" }])] } },
    { name: "Retry opening the pull request", actionId: "agentx_workflow_retry_publish", workflow: { stage: "PULL_REQUEST", state: "BLOCKED", blockReason: "GitHub refused the pull request",
      candidate: { digest: candidateDigest }, verification: passed, reviews: [review("PASS")] } },
  ];

  for (const kind of kinds) {
    it(`takes ${kind.name} (and Close task) off its card once the task moved on, and leaves them while it has not`, async () => {
      const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
      await h.pump();
      const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": now(), ":workflow": { artifacts: [], ...workflow } } }));
      await setWorkflow({ revision: 9, ...kind.workflow });
      await h.pump();
      const card = h.strict.lastPostWithAction(kind.actionId);
      expect(JSON.stringify(card.blocks)).toContain("agentx_workflow_close");
      // A press the broker refused moves nothing: the card keeps its buttons.
      await h.pump();
      expect(h.strict.updates.filter((update) => update.ts === card.ts)).toEqual([]);
      // The press took effect: the step moved on.
      await setWorkflow({ revision: 10, stage: "IMPLEMENT", state: "RUNNING" });
      await h.pump();
      const edits = h.strict.updates.filter((update) => update.ts === card.ts);
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe(card.text);
      expect(edits[0]!.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
      expect(edits[0]!.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "Done. This step moved on." }] });
      // Edited once: later steps leave it alone.
      await setWorkflow({ revision: 11, stage: "VERIFY", state: "RUNNING" });
      await h.pump();
      expect(h.strict.updates.filter((update) => update.ts === card.ts)).toHaveLength(1);
    });
  }

  it("says a card's task is closed when Close task took effect", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": now(), ":workflow": { artifacts: [], ...workflow } } }));
    await setWorkflow({ revision: 9, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" });
    await h.pump();
    const card = h.strict.lastPostWithAction("agentx_workflow_close");
    await setWorkflow({ revision: 10, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" });
    await h.pump();
    const edits = h.strict.updates.filter((update) => update.ts === card.ts);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    expect(edits[0]!.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "This task is closed." }] });
  });

  it("gives up on a card Slack will not edit, and retries one Slack could not edit just then", async () => {
    let failing: string | undefined;
    const updates: Array<{ ts: string; blocks: unknown[] }> = [];
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { update: async (input) => {
      if (failing !== undefined) throw new SlackPostError(failing);
      updates.push(input);
    } });
    await h.pump();
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": now(), ":workflow": { artifacts: [], ...workflow } } }));
    await setWorkflow({ revision: 9, stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended failed" });
    await h.pump();
    const card = h.strict.lastPostWithAction("agentx_workflow_retry_plan");
    failing = "ratelimited";
    await setWorkflow({ revision: 10, stage: "PLAN", state: "RUNNING" });
    await h.pump();
    expect(h.queue).toHaveLength(1);
    failing = undefined;
    await h.pump();
    expect(updates.filter((update) => update.ts === card.ts)).toHaveLength(1);
    // A card Slack refuses for good is given up on, and the step is still said.
    await setWorkflow({ revision: 11, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" });
    await h.pump();
    failing = "message_not_found";
    await setWorkflow({ revision: 12, stage: "IMPLEMENT", state: "RUNNING" });
    await h.pump();
    expect(h.queue).toEqual([]);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.button_card_update_failed", error: "message_not_found" }));
  });
});

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
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        revision: 9, stage: "REVIEW", state: "BLOCKED", artifacts: [], candidate: { digest: candidateDigest },
        verification: { candidateDigest, results: [{ checkId: "diff-check", status: "PASS" }] },
        reviews: [{ operationId, candidateDigest, role: "SECURITY", provider: "test", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: new Date().toISOString() }],
      } },
    }));
    await h.pump();
    const message = h.posts.at(-1)!;
    expect(message.text).toBe("A review couldn't finish (security review: its answer wasn't in the expected format). Nothing was sent to GitHub.");
    expect(h.posts.map((post) => post.text).join("\n")).not.toContain("Both reviews PASS");
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({
      action_id: "agentx_workflow_retry_reviews", text: { type: "plain_text", text: "Retry reviews" },
      value: JSON.stringify({ taskId: h.taskId, revision: 9, candidateDigest }),
    }), expect.objectContaining({ action_id: "agentx_workflow_close", text: { type: "plain_text", text: "Close task" } })] }));
  });

  it("offers Retry reviews in plain words when AgentX gave up starting the reviews on its own", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    const candidateDigest = "a".repeat(64);
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      // updatedAt dates the change, as the broker's writes do, so the notice is not taken for one from before the share.
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        artifacts: [], candidate: { digest: candidateDigest }, verification: { candidateDigest, results: [{ checkId: "required-1", status: "PASS" }] }, ...workflow,
      } } }));
    await setWorkflow({ revision: 8, stage: "REVIEW", state: "WAITING" });
    await h.pump();
    const before = h.posts.length;
    await setWorkflow({ revision: 9, stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE });
    await h.pump();
    expect(h.posts.length).toBe(before + 1);
    const message = h.posts.at(-1)!;
    expect(message.text).toContain(WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE);
    expect(message.text).not.toMatch(/candidate|revision|digest|operation|workflow/i);
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({
      action_id: "agentx_workflow_retry_reviews", text: { type: "plain_text", text: "Retry reviews" },
      value: JSON.stringify({ taskId: h.taskId, revision: 9, candidateDigest }),
    }), expect.objectContaining({ action_id: "agentx_workflow_close" })] }));
  });

  it("offers Retry opening the pull request in plain words when the draft did not open or AgentX gave up starting it", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "free the workspace" });
    await h.pump();
    const candidateDigest = "a".repeat(64);
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        artifacts: [], candidate: { digest: candidateDigest, repositories: [{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "b".repeat(40) }] },
        checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] }, ...workflow,
      } } }));
    await setWorkflow({ revision: 8, stage: "PULL_REQUEST", state: "READY" });
    await h.pump();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as Parameters<typeof developerTaskIdentity>[0];
    const accepted = await h.actions.acceptPullRequest(developerTaskIdentity(task), h.workspaceId, { requestId: randomUUID(), repository: "demo", title: "AgentX: fix", draft: true },
      () => [], { workflowCandidate: { repositoryId: "demo", treeSha: "b".repeat(40), candidateDigest } });
    await h.finish(h.workspaceId, accepted.operation.id, "FAILED", { error: "GitHub refused the push" });
    await h.pump();
    const failed = h.posts.at(-1)!;
    expect(failed.text).toBe("Checks and reviews passed, but I couldn't open the draft pull request (GitHub didn't accept it). The checked code is kept.");
    expect(failed.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({
      action_id: "agentx_workflow_retry_publish", text: { type: "plain_text", text: "Retry opening the pull request" },
      value: JSON.stringify({ taskId: h.taskId, revision: 8 }),
    }), expect.objectContaining({ action_id: "agentx_workflow_close" })] }));
    // The workspace no longer holds the checked code: said in plain words, with no retry that would fail the same way.
    const changed = await h.actions.acceptPullRequest(developerTaskIdentity(task), h.workspaceId, { requestId: randomUUID(), repository: "demo", title: "AgentX: fix", draft: true },
      () => [], { workflowCandidate: { repositoryId: "demo", treeSha: "b".repeat(40), candidateDigest } });
    await h.finish(h.workspaceId, changed.operation.id, "FAILED", { error: "CONFIG_INVALID: the code changed after its checks and reviews; AgentX did not publish it" });
    await h.pump();
    const changedPost = h.posts.at(-1)!;
    expect(changedPost.text).toBe("The code changed after its checks and reviews passed, so I didn't open the pull request. Send it back to coding, or run the checks again on the current code.");
    expect(changedPost.text).not.toMatch(/candidate|revision|digest|operation|workflow/i);
    expect(JSON.stringify(changedPost.blocks ?? [])).not.toContain("agentx_workflow_retry_publish");
    // Task 16: the way out is sending it back to coding, or running the checks again on the current code.
    expect(changedPost.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [
      expect.objectContaining({ action_id: "agentx_workflow_send_back", style: "primary", text: { type: "plain_text", text: "Send back to coding" }, value: JSON.stringify({ taskId: h.taskId, revision: 8 }) }),
      expect.objectContaining({ action_id: "agentx_workflow_retry_checks", text: { type: "plain_text", text: "Run checks again" }, value: JSON.stringify({ taskId: h.taskId, revision: 8 }) }),
      expect.objectContaining({ action_id: "agentx_workflow_close", text: { type: "plain_text", text: "Close task" } }),
    ] }));
    const before = h.posts.length;
    await setWorkflow({ revision: 9, stage: "PULL_REQUEST", state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE });
    await h.pump();
    expect(h.posts.length).toBe(before + 1);
    const gaveUp = h.posts.at(-1)!;
    expect(gaveUp.text).toContain(WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE);
    expect(gaveUp.text).not.toMatch(/candidate|revision|digest|operation|workflow/i);
    expect(gaveUp.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: [expect.objectContaining({
      action_id: "agentx_workflow_retry_publish", value: JSON.stringify({ taskId: h.taskId, revision: 9 }),
    }), expect.objectContaining({ action_id: "agentx_workflow_close" })] }));
  });

  it("posts one retry when two Lambdas deliver the refused publication's block and the worker's failure at the same time", async () => {
    // Slack answers slowly, so both deliveries are past their checks before either post returns.
    const said: Array<{ text: string; blocks?: unknown[] }> = [];
    const slow = new StrictSlackWeb({ briefLimit: 1_200 });
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      post: async (input) => { await new Promise((resolve) => setTimeout(resolve, 5)); const posted = slow.post(input); said.push(input); return { ts: posted.ts }; },
    });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "free the workspace" });
    await h.pump();
    const candidateDigest = "a".repeat(64);
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        artifacts: [], candidate: { digest: candidateDigest, repositories: [{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "b".repeat(40) }] }, ...workflow,
      } } }));
    await setWorkflow({ revision: 8, stage: "PULL_REQUEST", state: "READY" });
    await h.pump();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as Parameters<typeof developerTaskIdentity>[0];
    const accepted = await h.actions.acceptPullRequest(developerTaskIdentity(task), h.workspaceId, { requestId: randomUUID(), repository: "demo", title: "AgentX: fix", draft: true },
      () => [], { workflowCandidate: { repositoryId: "demo", treeSha: "b".repeat(40), candidateDigest } });
    await setWorkflow({ revision: 9, stage: "PULL_REQUEST", state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE });
    await h.finish(h.workspaceId, accepted.operation.id, "FAILED", { error: "the pull request is not the checked code" });
    await h.handle({ Records: h.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = h.queue.splice(0, h.queue.length);
    expect(batch.map((entry) => entry.notice.kind).sort()).toEqual(["ended", "workflow"]);
    const deliver = (entry: { notice: Notice }, index: number) => h.handle({ Records: [{ eventSource: "aws:sqs", messageId: `c${index}`, receiptHandle: `rc${index}`,
      body: JSON.stringify(entry.notice), attributes: { ApproximateReceiveCount: "1" } }] });
    // Each notice in its own Lambda, at the same time.
    const answers = await Promise.all(batch.map(deliver));
    const retries = () => said.filter((post) => JSON.stringify(post.blocks ?? []).includes("agentx_workflow_retry_publish"));
    expect(retries()).toHaveLength(1);
    // The one that found the other's claim was retried; on its retry it finds the words said and posts nothing.
    expect(answers.flatMap((answer) => answer.batchItemFailures)).toHaveLength(1);
    await Promise.all(batch.map(deliver));
    expect(retries()).toHaveLength(1);
  });

  it("posts one retry when a refused publication blocks the task and the worker then reports the same publication failed", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "free the workspace" });
    await h.pump();
    const candidateDigest = "a".repeat(64);
    const setWorkflow = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        artifacts: [], candidate: { digest: candidateDigest, repositories: [{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "b".repeat(40) }] }, ...workflow,
      } } }));
    await setWorkflow({ revision: 8, stage: "PULL_REQUEST", state: "READY" });
    await h.pump();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as Parameters<typeof developerTaskIdentity>[0];
    const accepted = await h.actions.acceptPullRequest(developerTaskIdentity(task), h.workspaceId, { requestId: randomUUID(), repository: "demo", title: "AgentX: fix", draft: true },
      () => [], { workflowCandidate: { repositoryId: "demo", treeSha: "b".repeat(40), candidateDigest } });
    const before = h.posts.length;
    // The broker refused the publication's callback and blocked the task; then the worker's own failure arrived.
    await setWorkflow({ revision: 9, stage: "PULL_REQUEST", state: "BLOCKED", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE });
    await h.finish(h.workspaceId, accepted.operation.id, "FAILED", { error: "the pull request is not the checked code" });
    await h.pump();
    await h.pump();
    const retries = h.posts.slice(before).filter((post) => JSON.stringify(post.blocks ?? []).includes("agentx_workflow_retry_publish"));
    expect(retries).toHaveLength(1);
    expect(h.posts.slice(before)).toHaveLength(1);
    expect(h.queue).toEqual([]);
  });

  it("shows the problems the reviews found briefly, escaped, with Send back to coding, Retry reviews and Close task", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const operationId = h.active();
    const candidateDigest = "a".repeat(64);
    await h.finish(h.workspaceId, operationId, "SUCCEEDED", { result: { result: "Reviews done" } });
    const finding = (text: string, extra: Record<string, unknown> = {}) => ({ text, origin: "INTRODUCED", ...extra });
    await h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": {
        revision: 11, stage: "REVIEW", state: "BLOCKED", blockReason: "the critic review did not pass", artifacts: [], candidate: { digest: candidateDigest },
        verification: { candidateDigest, results: [{ checkId: "required-1", status: "PASS" }] },
        reviews: [
          { operationId, candidateDigest, role: "CRITIC", provider: "test", version: "1", status: "FINDINGS", readOnly: true, recordedAt: new Date().toISOString(), findings: [
            finding("The new parser drops the last line.", { file: "src/parse.ts", line: 40 }), finding("<!channel> sees *this* & that"),
            finding("x".repeat(600)), finding("A fourth problem."),
          ] },
          { operationId, candidateDigest, role: "SECURITY", provider: "test", version: "1", status: "PASS", readOnly: true, recordedAt: new Date().toISOString(), findings: [{ text: "Old logger prints emails.", origin: "PRE_EXISTING" }] },
        ],
      } },
    }));
    await h.pump();
    const message = h.posts.at(-1)!;
    expect(message.text).toContain("The new parser drops the last line. (src/parse.ts:40)");
    expect(message.text).toContain("&lt;!channel&gt;");
    expect(message.text).not.toContain("<!channel>");
    expect(message.text).toContain("1 more");
    expect(message.text).not.toContain("Old logger prints emails.");
    expect(message.text).not.toMatch(/candidate|revision|digest|operation|workflow|FAILED|SUCCEEDED/i);
    expect(visibleSlackText(message.text).length).toBeLessThanOrEqual(1_200);
    const actions = (message.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string; style?: string }> }>).find((block) => block.type === "actions")!;
    expect(actions.elements!.map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    expect(actions.elements![0]).toMatchObject({ style: "primary", value: JSON.stringify({ taskId: h.taskId, revision: 11 }) });
    expect(actions.elements!.filter((button) => button.style === "primary")).toHaveLength(1);
  });

  it("offers Retry planning and Close task when planning stops", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "the model stopped" });
    await h.pump();
    const workflow = (h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { stage: string; state: string; revision: number } }).workflow;
    expect(workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    const actions = (h.posts.at(-1)!.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string; text: { text: string } }> }>).find((block) => block.type === "actions")!;
    expect(actions.elements!.map((button) => [button.action_id, button.text.text])).toEqual([["agentx_workflow_retry_plan", "Retry planning"], ["agentx_workflow_close", "Close task"]]);
    expect(parseAction(actions.elements![0]!.value)).toEqual({ taskId: h.taskId, revision: workflow.revision });
  });

  it("offers Retry coding and Close task when coding stops", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const operationId = h.active();
    await h.finish(h.workspaceId, operationId, "FAILED", { error: "the model stopped" });
    await h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" },
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString(), ":workflow": { revision: 7, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed", artifacts: [] } } }));
    await h.pump();
    const actions = (h.posts.at(-1)!.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find((block) => block.type === "actions")!;
    expect(actions.elements!.map((button) => button.action_id)).toEqual(["agentx_workflow_retry_implementation", "agentx_workflow_close"]);
    expect(parseAction(actions.elements![0]!.value)).toEqual({ taskId: h.taskId, revision: 7 });
    expect(h.posts.at(-1)!.text).toBe("Coding stopped before it finished. The run stopped unexpectedly.");
  });

  it("posts one message per workflow step and never repeats a blocked review for a stale notice", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    h.advance(10_000);
    const save = (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" }, UpdateExpression: "SET workflow = :w, updatedAt = :now", ExpressionAttributeValues: { ":w": workflow, ":now": new Date(h.now()).toISOString() } }));
    const record = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: Record<string, unknown> };
    const blocked = { ...record.workflow, revision: 20, stage: "REVIEW", state: "BLOCKED", candidate: { digest: "a".repeat(64) }, verification: { candidateDigest: "a".repeat(64), results: [{ checkId: "required-1", status: "PASS" }] },
      reviews: [{ operationId: "o", candidateDigest: "a".repeat(64), role: "SECURITY", provider: "t", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: new Date().toISOString() }] };
    await save(blocked);
    await save({ ...blocked, revision: 21, state: "RUNNING" });
    await h.pump();
    const texts = h.posts.filter((post) => post.threadTs !== undefined).map((post) => post.text);
    expect(texts.filter((text) => text.startsWith("A review couldn't finish"))).toHaveLength(0); // revision 20's notice is stale by delivery
    expect(texts.filter((text) => text.includes("reviews are running"))).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "workflow", noticeId: `${h.taskId}:workflow:20`, outcome: "stale" }));
  });

  it("logs a step posted again after a post that may have landed, and gives back a claim whose post never left", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    h.advance(10_000);
    const save = (revision: number) => h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${h.taskId}`, sk: "META" }, UpdateExpression: "SET workflow = :w, updatedAt = :now",
      ExpressionAttributeValues: { ":w": { revision, stage: "VERIFY", state: "RUNNING", artifacts: [] }, ":now": new Date(h.now()).toISOString() } }));
    // Slack refused with its own code: nothing was posted, so the claim is given back and nothing is logged.
    await save(2);
    h.fail("ratelimited");
    await h.pump();
    expect(h.db.get(`DEVTASK#${h.taskId}`, `NOTICE#${h.taskId}:said:revision:2`)).not.toHaveProperty("claimedBy");
    // A 5xx answer may have posted it: the claim is kept, and the retry that posts again says so.
    h.fail("http_500");
    await h.pump();
    h.fail(undefined);
    await h.pump();
    expect(h.posts.filter((post) => post.text.startsWith("Running the selected checks again"))).toHaveLength(1);
    expect(h.logs.filter((entry) => entry.event === "developer_notifier.said_post_uncertain")).toEqual([
      expect.objectContaining({ reason: "claim_retaken", noticeId: `${h.taskId}:workflow:2` }),
    ]);
  });

  it("never posts 'The task ended' or raw model output for workflow tasks", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    await h.events(h.workspaceId, h.active(), [say(`The plan is done ${SECRET}`)]);
    await h.finish(h.workspaceId, h.active(), "FAILED", { error: "worker stopped" });
    await h.pump();
    const texts = h.posts.map((post) => post.text).join("\n");
    expect(texts).not.toMatch(/The task ended|SUCCEEDED|FAILED/);
    expect(texts).not.toContain("The plan is done");
    expect(texts).not.toContain(SECRET);
    expect(texts).toContain("I couldn't finish the coding plan.");
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
    expect(message.text.startsWith("*Coding plan v1 is ready for your approval.* No code has changed yet.")).toBe(true);
    expect(message.text).toContain("> Fix retry handling.");
    expect(message.text).toContain("<https://acme.slack.com/docs/T123/F12345678|Read the full coding plan>");
    expect(message.blocks).toHaveLength(2);
    const actions = (message.blocks?.[1] as { elements: Array<{ action_id: string; value: string; text: { text: string } }> }).elements;
    expect(actions.map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
    expect(actions[0]!.text.text).toBe("Approve coding plan");
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
    expect(originalActions.map((action) => action.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
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
    // The text is kept as it was; a short status line replaces the buttons.
    expect(h.updates[0]?.text).toBe(approvalCard.text);
    expect(h.updates[0]?.blocks.map((block) => (block as { type?: string }).type)).toEqual(["section", "context"]);
    expect(h.updates[0]?.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: `Approved by <@${MAYA.slackUserId}>.` }] });
    expect(JSON.stringify(h.updates[0]?.blocks)).not.toContain("agentx_workflow_");
    expect(h.posts.at(-1)!.text).toBe(`Coding plan approved by <@${MAYA.slackUserId}>. Writing the code now; then I'll run 1 check.`);
  });

  it("still posts the next step when editing the previous approval card fails", async () => {
    const plan = "# Plan\nAdd a retry regression test.";
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => plan,
      createPlanCanvas: async () => ({ canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" }),
    });
    const workflowRecord = h.db.get(`DEVTASK#${h.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    const requiredCheck = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
    h.db.set({ ...workflowRecord, workflow: { ...workflowRecord.workflow, checkPolicy: { required: [requiredCheck], optional: [], selectedOptionalIds: [] } } });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();
    const saved = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
    // Slack lost the card (it was deleted): editing it fails with Slack's own error, which no retry would fix.
    h.strict.failNext("chat.update", "message_not_found");
    const decision = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: saved.workflow.revision, decision: "APPROVE", reason: "Looks good.", artifactDigest: saved.workflow.artifacts.at(-1)?.sha256,
    });
    expect(decision.status).toBe(200);
    await h.pump();
    expect(h.posts.at(-1)!.text.startsWith("Coding plan approved by")).toBe(true);
    expect(h.queue).toEqual([]);
    expect(h.updates).toHaveLength(0);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.workflow_card_update_failed", taskId: h.taskId, error: "message_not_found" }));
  });

  it("retries the step when editing the approval card meets a passing Slack problem", async () => {
    const plan = "# Plan\nAdd a retry regression test.";
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, {
      readArtifact: async () => plan,
      createPlanCanvas: async () => ({ canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" }),
    });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();
    const saved = h.db.get(`DEVTASK#${h.taskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
    h.strict.failNext("chat.update", "ratelimited");
    const decision = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: saved.workflow.revision, decision: "REQUEST_CHANGES", reason: "Add a test for empty input.", artifactDigest: saved.workflow.artifacts.at(-1)?.sha256,
    });
    expect(decision.status).toBe(200);
    await h.pump();
    // The next step is posted before the card is edited, so the card's trouble never holds it up.
    expect(h.posts.at(-1)!.text).toBe("Got it. Revising the coding plan with your changes.");
    expect(h.queue).toHaveLength(1);
    await h.pump();
    expect(h.queue).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: `Changes requested by <@${MAYA.slackUserId}>.` }] });
    // The retry finished the edit without posting the step again.
    expect(h.posts.filter((post) => post.text === "Got it. Revising the coding plan with your changes.")).toHaveLength(1);
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
    // A long document is never pasted into the thread: the card stays brief, with its first line as the summary.
    expect(visibleSlackText(approvalCard.text).length).toBeLessThanOrEqual(1_200);
    expect(approvalCard.text).toContain(`> ${"P".repeat(157)}...`);
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
    expect(h.logs.map((entry) => entry.event)).not.toContain("developer_notifier.workflow_card_update_failed");
  });

  it("links the task page with a short summary when this workspace cannot create Canvases", async () => {
    const plan = "# Goal\nFix retry handling.\n\n## Checks\nRun the retry regression test.";
    const createPlanCanvas = vi.fn(async () => { throw new SlackPostError("free_teams_cannot_create_standalone_canvases"); });
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => plan, createPlanCanvas, reviewUrlBase: "https://agentx.example.test" });
    await h.pump();
    const preparation = h.active();
    await h.finish(h.workspaceId, preparation, "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();

    const message = h.posts.at(-1)!;
    expect(message.text).toBe(`*Coding plan v1 is ready for your approval.* No code has changed yet.\n> Fix retry handling.\n> Run the retry regression test.\n<https://agentx.example.test/review/${h.taskId}/task|Read the full coding plan>`);
    const actions = (message.blocks?.at(-1) as { elements: Array<{ action_id: string }> }).elements;
    expect(actions.map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
  });

  it("posts a three-line summary and a link to the AgentX task page when Canvas is unavailable", async () => {
    const plan = `# Plan\n\nGoal: fix retry handling.\n\n1. Fix it\n2. Test it\n3. Ship it\n${"P".repeat(32_000)}`;
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => plan, createPlanCanvas: async () => { throw new SlackPostError("free_teams_cannot_create_standalone_canvases"); }, reviewUrlBase: "https://agentx.example.test" });
    h.strict.briefLimit = 1_200;
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();
    const message = h.posts.at(-1)!;
    expect(message.text).toContain(`<https://agentx.example.test/review/${h.taskId}/task|Read the full coding plan>`);
    expect(message.text).toContain("> Goal: fix retry handling.");
    expect(message.text).not.toContain("PPPP");
    expect(message.text.split("\n").filter((line) => line.startsWith("> "))).toHaveLength(3);
    expect(visibleSlackText(message.text).length).toBeLessThanOrEqual(1_200);

    // The link's page shows the owner the whole plan, read back from what the planner saved.
    const sessionId = randomUUID();
    h.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: "slack",
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    const page = await h.handler({
      version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${h.taskId}/task`, rawQueryString: "",
      headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("3. Ship it");
    expect(page.body).toContain("P".repeat(32_000));
  });

  it("says when the full document could not be linked, and still offers the decision", async () => {
    const plan = "# Goal\nFix retry handling.";
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => plan,
      createPlanCanvas: async () => { throw new SlackPostError("free_teams_cannot_create_standalone_canvases"); } });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();
    expect(h.posts.at(-1)!.text).toBe("*Coding plan v1 is ready for your approval.* No code has changed yet.\n> Fix retry handling.\nI couldn't link the full coding plan; ask an AgentX admin to check the task page.");
    expect(JSON.stringify(h.posts.at(-1)!.blocks)).toContain("agentx_workflow_approve");
  });

  it("counts the thread replies saved since the last step on the approval card", async () => {
    const plan = "# Goal\nFix retry handling.";
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => plan,
      createPlanCanvas: async () => ({ canvasId: "F12345678", permalink: "https://acme.slack.com/docs/T123/F12345678" }) });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { teamId: string; channelId: string; threadTs: string } };
    for (const messageTs of ["1695500001.000001", "1695500002.000001"]) {
      h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: `NOTE#${messageTs}`, entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: h.taskId, slackUserId: "U0TEAMMATE1", isOwner: false,
        teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs, messageTs, eventId: `Ev${messageTs}`, text: "Please also handle empty names.",
        truncated: false, receivedAt: new Date(h.now()).toISOString(), workflowRevision: 1 });
    }
    const planning = h.active();
    await h.artifact(h.workspaceId, planning, "plan.md", plan);
    await h.finish(h.workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    await h.pump();
    expect(h.posts.at(-1)!.text).toContain("\n2 thread replies since the last step will be included.\n");
  });

  it("says on a blocked step's post that thread replies came in that no step has taken yet", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" }, { readArtifact: async () => "# Goal\nFix." });
    await h.pump();
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.pump();
    const task = h.db.get(`DEVTASK#${h.taskId}`, "META") as { share: { teamId: string; channelId: string; threadTs: string } };
    for (const messageTs of ["1695500001.000001", "1695500002.000001"]) {
      h.db.set({ pk: `DEVTASK#${h.taskId}`, sk: `NOTE#${messageTs}`, entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: h.taskId, slackUserId: "U0TEAMMATE1", isOwner: false,
        teamId: task.share.teamId, channelId: task.share.channelId, threadTs: task.share.threadTs, messageTs, eventId: `Ev${messageTs}`, text: "Please also handle empty names.",
        truncated: false, receivedAt: new Date(h.now()).toISOString(), workflowRevision: 1 });
    }
    await h.finish(h.workspaceId, h.active(), "INTERRUPTED", { error: "worker stopped" });
    await h.pump();
    expect(h.posts.at(-1)!.text).toMatch(/\n2 thread replies came in after the plan; see the task page\.$/);
    expect(JSON.stringify(h.posts.at(-1)!.blocks)).toContain("agentx_workflow_retry_plan");
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
    expect(message.text).toBe("*Requirements v1 is ready for your approval.* No code has changed yet.\n> Add password reset.\n<https://acme.slack.com/docs/T123/F22345678|Read the full requirements>");
    const actions = (message.blocks?.[1] as { elements: Array<{ text: { text: string } }> }).elements;
    expect(actions[0]?.text.text).toBe("Approve requirements");
  });

  it("posts the draft pull request links once, with a way to close the task after merging on GitHub", async () => {
    const h = await notifierHarness({ shareToChannel: true, workflow: true, workflowPath: "QUICK" });
    await h.pump();
    h.advance(10_000);
    const taskKey = `DEVTASK#${h.taskId}`;
    const saveWorkflow = async (workflow: Record<string, unknown>) => h.db.send(new UpdateCommand({
      TableName: "state", Key: { pk: taskKey, sk: "META" }, UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ExpressionAttributeValues: { ":workflow": workflow, ":now": new Date(h.now()).toISOString() },
    }));
    const first = {
      stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 2,
      artifacts: [],
      pullRequests: [
        { repositoryId: "api", number: 12, url: "https://github.com/example/api/pull/12", required: true, state: "UNKNOWN", candidateDigest: "a".repeat(64) },
        { repositoryId: "web", number: 13, url: "https://github.com/example/web/pull/13", required: true, state: "UNKNOWN", candidateDigest: "a".repeat(64) },
      ],
    };
    await saveWorkflow(first);
    await h.pump();
    expect(h.posts.at(-1)!.text).toBe("Draft pull requests opened: <https://github.com/example/api/pull/12|PR #12>, <https://github.com/example/web/pull/13|PR #13>. Review them and merge them on GitHub, then close this task here.");
    expect(JSON.stringify(h.posts.at(-1)!.blocks)).toContain("agentx_workflow_close");
    // A later step that changes nothing about the pull requests says nothing again.
    const before = h.posts.length;
    await saveWorkflow({ ...first, revision: 3 });
    await h.pump();
    expect(h.posts).toHaveLength(before);
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
