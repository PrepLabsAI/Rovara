// tests/contract/shared-task-flow.test.ts
// Spec 025 US3 and SC-012: a shared task through the MCP tools, the notifier and the Slack
// service's processor, against the broker in process. Fake Slack, fake worker, the fake table.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLOSED_SHARED_NOTICE, VIEW_ONLY_NOTICE, parseSlackThreadSubject, turnRecordKeys, type ChannelInfoRequest, type ChannelInfoResponse, type SlackRequestMessage, type TurnRecord } from "../../packages/contracts/src/index.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { STUCK_SETUP_MESSAGE, sweepStuckSetups } from "../../packages/broker/src/aws/stuck-setup.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { MAYA, bindChannel, createDeveloperTaskBroker, recordStream, registerRevision, teammate } from "../support/developer-task-broker.js";
import { signedInClient } from "../support/mcp-broker-client.js";
import { SLACK_TEAM, call, issuer } from "../support/slack-broker.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
interface SharedTask { workspaceId: string; share: { threadTs: string; teamId: string; channelId: string; mode: string; sharedReason: string; modeReason?: string } }

const ADMIN = { subject: "admin-subject", admin: true };
const PRIYA = "U0PRIYA001";
const LEO = "U0LEO00001";
const SAM = "U0SAM00001";
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });
const taskRecord = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as SharedTask & { closedAt?: string };
/** The workspace's running operation; the broker removes the field when nothing runs. */
const activeOperation = (harness: Harness, workspaceId: string) => (harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId?: string }).activeOperationId;
const subjectOf = (task: SharedTask) => `${task.share.teamId}/${task.share.channelId}/${task.share.threadTs}`;
const sharedRecord = (harness: Harness, subject: string) => harness.db.get(`SHARED_TASK#${subject}`, "META") as { mode: string; closedAt?: string } | undefined;

/** The notifier over the harness's table, with Slack faked; pump() delivers everything pending. */
function notifier(harness: Harness) {
  const stream = recordStream(harness.db);
  const posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
  const queue: Notice[] = [];
  let ts = 1_695_500_000_000_100;
  const handle = createNotifierHandler({
    documentClient: harness.db, tableName: "state",
    enqueue: async (notices) => { queue.push(...notices); },
    retryLater: async () => undefined,
    post: async (input) => { posts.push(input); ts += 1; const text = String(ts); return { ts: `${text.slice(0, 10)}.${text.slice(10)}` }; },
    now: Date.now, log: () => undefined, deliveryFailed: () => undefined,
  });
  const pump = async () => {
    for (let round = 0; round < 3; round += 1) {
      await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
      const batch = queue.splice(0, queue.length);
      await handle({ Records: batch.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } })) });
    }
  };
  return { posts, pump };
}

/**
 * The Slack service's processor for one shared thread, on the real thread client against the broker.
 * `ran` lists the events whose turn reached the orchestrator.
 */
function slackService(harness: Harness, subject: string, runTurn: ProcessorDependencies["runTurn"] = async () => "ran") {
  const posts: string[] = [];
  const records: TurnRecord[] = [];
  const ran: string[] = [];
  const dependencies = (userId: string): ProcessorDependencies => ({
    api: () => createThreadApi({
      controlPlaneUrl: "https://agentx.example.test", pollIntervalMilliseconds: 1,
      signedFetch: createSignedServiceFetch({ region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, thread: parseSlackThreadSubject(subject), userId, baseFetch: brokerFetch(harness.handler) }),
    }),
    threads: {
      load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined,
      close: async () => undefined, finish: async () => undefined, claimSharedNotice: async () => true,
    },
    runTurn: async (input: TurnInput) => { ran.push(input.message.eventId); return runTurn(input); },
    post: async (_thread, text) => { posts.push(text); },
    userName: async (id) => ({ [PRIYA]: "Priya", [LEO]: "Leo", [SAM]: "Sam" } as Record<string, string>)[id],
    turnRecords: { write: async (record) => { records.push(record); harness.db.set({ ...turnRecordKeys(record), ...record }); return "written"; } },
  });
  let sequence = 0;
  const mention = (userId: string, text: string): SlackRequestMessage => {
    sequence += 1;
    return { version: 1, eventId: `Ev${String(sequence).padStart(10, "0")}`, thread: parseSlackThreadSubject(subject), userId, text, receivedAt: new Date(Date.now() + sequence).toISOString() };
  };
  const handle = (message: SlackRequestMessage, queuedBehind = 0) => processSlackRequest(message, dependencies(message.userId), { finalAttempt: true, queuedBehind });
  return { posts, records, ran, mention, handle };
}

/** A teammate's turn that runs one task operation through the broker, which the worker then ends. */
function channelTurn(harness: Harness, subject: string, reply: string) {
  return async (input: TurnInput) => {
    const accepted = await teammate(harness.handler, subject, input.message.userId, "POST", `/v1/service/workspaces/${input.workspaceId}/tasks`, { requestId: randomUUID(), conversationId: input.conversationId, prompt: input.message.text });
    await harness.finish(input.workspaceId, String((accepted.body.operation as { id: string }).id), "SUCCEEDED");
    return reply;
  };
}

/** Starts a shared task through the MCP tool and posts its start message; the workspace is still preparing. */
async function startShared(harness: Harness, slack: ReturnType<typeof notifier>, tool: Awaited<ReturnType<typeof signedInClient>>["tool"], shareMode: "view" | "continue") {
  const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test", share_to_channel: true, share_mode: shareMode });
  const taskId = String(started.value.task_id);
  await slack.pump();
  const task = taskRecord(harness, taskId);
  return { taskId, task, subject: subjectOf(task), workspaceId: task.workspaceId };
}

describe("a shared task through its life (US3)", () => {
  it("shares in continue mode, steers from the thread, switches to view only and closes", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool, expectNoTokenLeaked } = await signedInClient(harness, MAYA);

    // US3 scenario 1: the start message within the start, then a reply at each change.
    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test", share_to_channel: true, share_mode: "continue" });
    expect(started.value).toMatchObject({ shared: true, share_mode: "continue", share_posting: true });
    const taskId = String(started.value.task_id);
    await slack.pump();
    expect(slack.posts[0]!.text).toContain("started a task from Claude Code");
    const read = await tool("agentx_get_task", { task_id: taskId });
    const threadUrl = String(read.value.thread_url);
    expect(threadUrl).toMatch(/^https:\/\/slack\.com\/archives\//);
    const task = taskRecord(harness, taskId);
    const subject = subjectOf(task);
    // The start message is the thread: the task and the shared thread record both name it.
    expect(threadUrl).toBe(`https://slack.com/archives/${task.share.channelId}/p${task.share.threadTs.replace(".", "")}`);
    expect(sharedRecord(harness, subject)).toMatchObject({ mode: "continue", taskId });

    const workspaceId = task.workspaceId;
    const active = () => activeOperation(harness, workspaceId);
    await harness.finish(workspaceId, String(active()), "SUCCEEDED");
    const first = String(active());
    await harness.events(workspaceId, first, [say("Fixed the retry test.")]);
    await harness.finish(workspaceId, first, "SUCCEEDED");
    await slack.pump();
    expect(slack.posts.slice(1).map((post) => post.text.split("\n")[0])).toEqual(["The workspace is ready, and the task is running.", "The task ended SUCCEEDED."]);
    expect(slack.posts.slice(1).every((post) => post.threadTs === task.share.threadTs)).toBe(true);

    // US3 scenario 5: a teammate steers the task from the thread, as themselves.
    const service = slackService(harness, subject, channelTurn(harness, subject, "Ran the linter."));
    await service.handle(service.mention(PRIYA, "also run the linter"));
    expect(service.posts.at(-1)).toBe(`<@${PRIYA}> Ran the linter.`);
    const [channelOperation] = harness.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("CHANNEL_OPERATION#"));
    expect(channelOperation).toMatchObject({ slackUserId: PRIYA });
    expect(service.records).toEqual([expect.objectContaining({ taskId, disposition: "answered", requestedBy: expect.objectContaining({ userId: PRIYA }) as unknown })]);
    // The notifier does not post a teammate's operation: the Slack service already replied.
    await slack.pump();
    expect(slack.posts).toHaveLength(3);

    // US3 scenario 7: the developer sees the channel's turn, and can still switch to view only.
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ channel_turns: [{ author: "Priya", slack_user: PRIYA, request: "also run the linter", outcome: "answered" }] });
    expect((await tool("agentx_share_task", { task_id: taskId, share_mode: "view" })).value).toMatchObject({ share_mode: "view" });
    expect(taskRecord(harness, taskId).share).toMatchObject({ mode: "view" });
    expect(sharedRecord(harness, subject)).toMatchObject({ mode: "view" });
    await slack.pump();
    expect(slack.posts.at(-1)!.text).toBe("This thread is now view only: follow-ups happen in the developer's AI tool.");
    await service.handle(service.mention(LEO, "one more thing"));
    expect(service.posts.at(-1)).toBe(VIEW_ONLY_NOTICE);
    expect(service.ran).toHaveLength(1);

    // FR-032 and Q3: the close posts "closed", and the thread then drives nothing.
    await tool("agentx_close_task", { task_id: taskId });
    await harness.finish(workspaceId, String(active()), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    await slack.pump();
    expect(slack.posts.at(-1)!.text).toBe("The task is closed, and its workspace is released. This thread no longer drives it.");
    expect(taskRecord(harness, taskId).closedAt).toBeDefined();
    expect(sharedRecord(harness, subject)?.closedAt).toBeDefined();
    const workspaces = harness.db.find((item) => item.entityType === "WORKSPACE").length;
    const postsAtClose = slack.posts.length;
    await service.handle(service.mention(SAM, "reopen it please"));
    expect(service.posts.at(-1)).toBe(CLOSED_SHARED_NOTICE);
    expect(service.ran).toHaveLength(1);
    expect(harness.db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(workspaces);
    await slack.pump();
    expect(slack.posts).toHaveLength(postsAtClose);
    expectNoTokenLeaked();
  });

  it("shares view only when the project requires sharing and allows no continue, and says why (US3 scenarios 2 and 8)", async () => {
    const harness = await createDeveloperTaskBroker();
    await registerRevision(harness.handler, 2, { share: "required", shareMode: { default: "view", allowContinue: false } });
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix it", share_to_channel: false, share_mode: "continue" });
    expect(started.value).toMatchObject({ shared: true, share_mode: "view", share_reason: "required by project", share_mode_reason: "continue not allowed by project" });
    const taskId = String(started.value.task_id);
    expect(taskRecord(harness, taskId).share).toMatchObject({ mode: "view", sharedReason: "required" });
    await slack.pump();
    expect(slack.posts).toHaveLength(1);
    const subject = subjectOf(taskRecord(harness, taskId));
    expect(sharedRecord(harness, subject)).toMatchObject({ mode: "view" });
    // A teammate's mention gets the view-only notice, and nothing runs.
    const service = slackService(harness, subject);
    await service.handle(service.mention(PRIYA, "can you also fix the docs"));
    expect(service.posts).toEqual([VIEW_ONLY_NOTICE]);
    expect(service.ran).toEqual([]);
  });

  it("shares a private task later with its current status (US3 scenario 9)", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "Fix it" })).value.task_id);
    await slack.pump();
    expect(slack.posts).toEqual([]);
    expect(taskRecord(harness, taskId).share).toBeUndefined();
    await tool("agentx_share_task", { task_id: taskId });
    await slack.pump();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toContain("Status: STARTING");
    const task = taskRecord(harness, taskId);
    expect(task.share).toMatchObject({ mode: "view", sharedReason: "requested", threadTs: expect.any(String) as unknown });
    expect(sharedRecord(harness, subjectOf(task))).toMatchObject({ taskId, mode: "view" });
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ thread_url: `https://slack.com/archives/${task.share.channelId}/p${task.share.threadTs.replace(".", "")}` });
  });
});

describe("the owner's answers, end to end", () => {
  it("lets an admin open a view-only thread to the channel, and the channel then steers the task (Q2)", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const { taskId, subject, workspaceId } = await startShared(harness, slack, tool, "view");
    await harness.finish(workspaceId, String(activeOperation(harness, workspaceId)), "SUCCEEDED");
    await harness.finish(workspaceId, String(activeOperation(harness, workspaceId)), "SUCCEEDED");
    await slack.pump();

    const switched = await call(harness.handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/share-mode`, user: ADMIN, body: { requestId: randomUUID(), shareMode: "continue" } });
    expect(switched.status).toBe(200);
    expect(sharedRecord(harness, subject)).toMatchObject({ mode: "continue" });
    expect(harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "share")).toEqual([expect.objectContaining({ admin: { issuer, subject: ADMIN.subject } })]);
    await slack.pump();
    expect(slack.posts.at(-1)!.text).toBe("This thread is now open to the channel: members of this channel may mention AgentX here to steer the task.");

    const service = slackService(harness, subject, channelTurn(harness, subject, "Added the test."));
    await service.handle(service.mention(PRIYA, "add a test for the timeout"));
    expect(service.posts.at(-1)).toBe(`<@${PRIYA}> Added the test.`);
    expect(service.records).toEqual([expect.objectContaining({ taskId, disposition: "answered" })]);
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ share_mode: "continue", channel_turns: [{ slack_user: PRIYA, outcome: "answered" }] });
  });

  it("lets a teammate's stop in a continue thread cancel the developer's own run (Q8)", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const { taskId, subject, workspaceId } = await startShared(harness, slack, tool, "continue");
    await harness.finish(workspaceId, String(activeOperation(harness, workspaceId)), "SUCCEEDED");
    const developerRun = String(activeOperation(harness, workspaceId));
    await slack.pump();

    const stop = await harness.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: parseSlackThreadSubject(subject), userId: PRIYA });
    expect(JSON.parse(stop.body)).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(harness.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel" && item.workspaceId === workspaceId)).toEqual([expect.objectContaining({ requestedBy: { teamId: SLACK_TEAM, userId: PRIYA } })]);
    // The worker stops the developer's run.
    await harness.finish(workspaceId, developerRun, "CANCELLED");
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${developerRun}`)).toMatchObject({ status: "CANCELLED" });
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ status: "CANCELLED" });
    await slack.pump();
    expect(slack.posts.at(-1)).toMatchObject({ threadTs: taskRecord(harness, taskId).share.threadTs, text: "The task ended CANCELLED." });
  });

  it("refuses to share into a private channel the developer has not joined, and posts nothing (Q10)", async () => {
    const PRIVATE = "G0PRIVATE01";
    const channelInfo = async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({ ok: true, channels: request.channelIds.map((channelId) => ({ channelId, name: channelId === PRIVATE ? "payments-secret" : "payments-dev", isPrivate: channelId === PRIVATE })) });
    const harness = await createDeveloperTaskBroker({ channelInfo });
    await bindChannel(harness.handler, PRIVATE);
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const refused = await tool("agentx_start_task", { project: "payments", instructions: "Fix it", share_to_channel: true, channel: PRIVATE });
    expect(refused).toMatchObject({ isError: true, error: { code: "CHANNEL_REQUIRED", message: "you are not a member of that private channel; join it first, or share to one of the project's public channels" } });
    expect(harness.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
    await slack.pump();
    expect(slack.posts).toEqual([]);
  });

  it("fails a shared task's setup after 50 minutes, says so in the thread, and the developer reads setup_failed", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const { taskId, workspaceId } = await startShared(harness, slack, tool, "view");
    const prepare = String(activeOperation(harness, workspaceId));

    expect(await sweepStuckSetups(harness.db, "state", new Date(Date.now() + 49 * 60_000))).toMatchObject({ failed: [] });
    await slack.pump();
    expect(slack.posts).toHaveLength(1);

    expect(await sweepStuckSetups(harness.db, "state", new Date(Date.now() + 51 * 60_000))).toMatchObject({ failed: [workspaceId] });
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepare}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    await slack.pump();
    expect(slack.posts.map((post) => post.text).slice(1)).toEqual([`The workspace could not be set up, so the task did not run: ${STUCK_SETUP_MESSAGE}`]);
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ status: "FAILED", failure: { category: "setup_failed", message: STUCK_SETUP_MESSAGE } });
  });
});

describe("SC-012: 20 mentions from 3 teammates in a burst", () => {
  it("runs them one at a time, in delivery order, each attributed to its author", async () => {
    const harness = await createDeveloperTaskBroker();
    const slack = notifier(harness);
    const { tool } = await signedInClient(harness, MAYA);
    const { taskId, subject, workspaceId } = await startShared(harness, slack, tool, "continue");
    const active = () => activeOperation(harness, workspaceId);
    await harness.finish(workspaceId, String(active()), "SUCCEEDED");
    // The developer's own first run is still going when the burst arrives (Review Focus 1).
    const developerRun = String(active());

    // The first turn waits out the developer's run, which the broker does not name, in 15-second
    // pauses; fake timers let that wait pass without the test waiting for it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setTimeout(() => { void harness.finish(workspaceId, developerRun, "SUCCEEDED"); }, 20);
      const started: string[] = [];
      const overlaps: string[] = [];
      const service = slackService(harness, subject, async (input) => {
        if (active() !== undefined) overlaps.push(input.message.eventId);
        started.push(input.message.eventId);
        const accepted = await teammate(harness.handler, subject, input.message.userId, "POST", `/v1/service/workspaces/${input.workspaceId}/tasks`, { requestId: randomUUID(), conversationId: input.conversationId, prompt: input.message.text });
        const operationId = String((accepted.body.operation as { id: string }).id);
        // The worker ends the operation after the turn has answered; the next turn must wait for it.
        setTimeout(() => { void harness.finish(input.workspaceId, operationId, "SUCCEEDED"); }, 5);
        return `ok ${input.message.eventId}`;
      });
      const authors = [PRIYA, LEO, SAM];
      const burst = Array.from({ length: 20 }, (_, index) => service.mention(authors[index % 3]!, `request ${index}`));
      // The FIFO queue delivers a thread's messages one at a time, in order (processGroup).
      let done = false;
      const delivered = (async () => {
        for (const [index, message] of burst.entries()) await service.handle(message, index);
      })().finally(() => { done = true; });
      while (!done) await vi.advanceTimersByTimeAsync(50);
      await delivered;

      expect(overlaps).toEqual([]);
      expect(started).toEqual(burst.map((message) => message.eventId));
      expect(service.records.map((record) => [record.eventId, record.requestedBy.userId, record.taskId, record.disposition])).toEqual(burst.map((message) => [message.eventId, message.userId, taskId, "answered"]));
      expect(service.posts.filter((text) => text.startsWith("<@"))).toEqual(burst.map((message) => `<@${message.userId}> ok ${message.eventId}`));
      const channelOperations = harness.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("CHANNEL_OPERATION#"));
      expect(channelOperations.map((item) => item.slackUserId).sort()).toEqual(burst.map((message) => message.userId).sort());
      // Every channel operation ran and ended; nothing is left running.
      const taskOperations = harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task");
      expect(taskOperations).toHaveLength(21);
      expect(taskOperations.every((operation) => operation.status === "SUCCEEDED")).toBe(true);
      expect(active()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
