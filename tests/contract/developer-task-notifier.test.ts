// tests/contract/developer-task-notifier.test.ts
// Spec 025 FR-032, FR-034, C7 to C9: the notifier, fed from the fake table's writes, posting to a
// fake Slack. The queue is an array; a failed notice stays in it with its attempt count.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SlackPostError, chatPostMessage } from "../../packages/broker/src/aws/slack-web.js";
import { createNotifierHandler, retryDelaySeconds } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

type Post = (input: { channel: string; threadTs?: string; text: string }) => Promise<{ ts: string }>;

async function notifierHarness(body: Record<string, unknown> = { shareToChannel: true }, postOverride?: Post) {
  const harness = await createDeveloperTaskBroker();
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
  const queue: Array<{ notice: Notice; attempt: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  let failing: string | undefined;
  let ts = 1_695_500_000_000_100;
  const deliveryFailed = vi.fn();
  const retryLater = vi.fn(async () => undefined);
  const handle = createNotifierHandler({
    documentClient: harness.db, tableName: "state",
    enqueue: async (notices) => { for (const notice of notices) queue.push({ notice, attempt: 0 }); },
    retryLater,
    post: postOverride ?? (async (input) => {
      if (failing !== undefined) throw new SlackPostError(failing);
      posts.push(input);
      ts += 1;
      const text = String(ts);
      return { ts: `${text.slice(0, 10)}.${text.slice(10)}` };
    }),
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
    ...harness, stream, posts, queue, logs, pump, taskId, workspaceId, active, deliveryFailed, retryLater,
    advance: (ms: number) => { clock += ms; }, fail: (code: string | undefined) => { failing = code; },
  };
}

describe("the shared thread (FR-032, US3 scenario 1)", () => {
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
    await h.finish(h.workspaceId, h.active(), "SUCCEEDED");
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID() });
    // Ruling F7: the earlier "workspace is ready" is dropped, not held for the thread.
    await h.pump();
    await h.pump();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.text).toContain("Status: RUNNING");
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
    const h = await notifierHarness({ shareToChannel: true }, (input) => chatPostMessage(BOT_TOKEN, input, refused));
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
});
