// tests/integration/slack-start-notice.test.ts
// Spec 014 FR-026: when the Slack service says it has started, next to the ingress's own acknowledgement.
import { describe, expect, it, vi } from "vitest";
import {
  SLACK_QUEUED_BEHIND_ATTRIBUTE, queuedBehindAttributes, queuedBehindOf, type SlackRequestMessage, type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { processGroup, type QueueClient, type QueueMessage } from "../../packages/slack-service/src/consumer.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "what's open?", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspace(overrides: Record<string, unknown> = {}): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides };
}

function harness(result: SlackThreadWorkspaceResult, preparation = "SUCCEEDED") {
  const posts: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation: async () => ({ status: preparation }),
      createConversation: async () => "33333333-3333-4333-8333-333333333333",
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async () => undefined,
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async () => "2 issues are open.",
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts };
}

function queueEntry(extra: Partial<QueueMessage> = {}): QueueMessage {
  return { body: JSON.stringify(message()), receiptHandle: "receipt-1", groupId: "thread-a", receiveCount: 1, ...extra };
}

const queue: QueueClient = { receive: async () => [], delete: async () => undefined, extendVisibility: async () => undefined };
const groupOptions = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };

/** Issue 173: the heartbeat hook every message gets, whatever function it is. */
const anyHook: unknown = expect.any(Function);

describe("the start notice today (characterization)", () => {
  it.each(["READY", "UNPREPARED"] as const)("posts it before the reply in a %s thread when the request carries no queue count", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "2 issues are open."]);
  });

  it("posts it after an up-front setup wait", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: true }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SETTING_UP, WORKING, "2 issues are open."]);
  });

  it("hands a queue message with no count to the processor with the final-attempt flag alone", async () => {
    const contexts: unknown[] = [];
    await processGroup(queue, async (_message, context) => {
      contexts.push(context);
    }, [queueEntry()], groupOptions, () => undefined);
    // Issue 173: every message also gets the heartbeat hook.
    expect(contexts).toEqual([{ finalAttempt: false, onHeartbeat: anyHook }]);
  });
});

describe("the start notice only when the member was told to wait", () => {
  it.each(["READY", "UNPREPARED"] as const)("is not posted in a %s thread when nothing was queued ahead", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual(["2 issues are open."]);
  });

  it("is posted when the request waited behind earlier requests in the thread", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 2 });
    expect(h.posts).toEqual([WORKING, "2 issues are open."]);
  });

  it("is posted when nothing was queued ahead but SQS redelivered the request", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0, redelivered: true });
    expect(h.posts).toEqual([WORKING, "2 issues are open."]);
  });

  it("is not posted when nothing was queued ahead and the request was not redelivered", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0, redelivered: false });
    expect(h.posts).toEqual(["2 issues are open."]);
  });

  it.each([
    [true, SETTING_UP],
    [false, STILL],
  ])("is posted after an up-front setup wait even when nothing was queued ahead (created: %s)", async (created, notice) => {
    const h = harness(workspace({ status: "PREPARING", operationId, created }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual([notice, WORKING, "2 issues are open."]);
  });

  it("is not posted when setup fails, as today", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: true }), "FAILED");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual([SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Mention me again in this thread to start fresh."]);
  });

  it("hands the queue count to the processor", async () => {
    const contexts: unknown[] = [];
    await processGroup(queue, async (_message, context) => {
      contexts.push(context);
    }, [queueEntry({ queuedBehind: 0 }), queueEntry({ receiptHandle: "receipt-2", queuedBehind: 3, receiveCount: 5 })], groupOptions, () => undefined);
    expect(contexts).toEqual([
      { finalAttempt: false, queuedBehind: 0, onHeartbeat: anyHook },
      { finalAttempt: true, queuedBehind: 3, redelivered: true, onHeartbeat: anyHook },
    ]);
  });

  it("marks a message redelivered from its receive count, so a retry can still announce it started", async () => {
    const contexts: unknown[] = [];
    await processGroup(queue, async (_message, context) => {
      contexts.push(context);
    }, [
      queueEntry({ queuedBehind: 0, receiveCount: 1 }),
      queueEntry({ receiptHandle: "receipt-2", queuedBehind: 0, receiveCount: 2 }),
    ], groupOptions, () => undefined);
    expect(contexts).toEqual([
      { finalAttempt: false, queuedBehind: 0, onHeartbeat: anyHook },
      { finalAttempt: false, queuedBehind: 0, redelivered: true, onHeartbeat: anyHook },
    ]);
  });
});

describe("the queue count attribute", () => {
  it("round-trips through the queue attributes the ingress sends", () => {
    expect(queuedBehindAttributes(3)).toEqual({ [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { DataType: "Number", StringValue: "3" } });
    expect(queuedBehindOf(queuedBehindAttributes(0))).toBe(0);
    expect(queuedBehindOf(queuedBehindAttributes(3))).toBe(3);
  });

  it.each([
    ["no attributes", undefined],
    ["another attribute only", { other: { StringValue: "1" } }],
    ["a negative count", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "-1" } }],
    ["a fraction", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "1.5" } }],
    ["text", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "two" } }],
    ["no value", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: {} }],
  ])("reads %s as no count, so the processor keeps today's notice", (_name, attributes) => {
    expect(queuedBehindOf(attributes)).toBeUndefined();
  });
});
