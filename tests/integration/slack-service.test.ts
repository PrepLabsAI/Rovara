import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  SlackRequestMessage,
  SlackThreadWorkspaceResult,
  SlackWorkspaceCloseStartResult,
} from "../../packages/contracts/src/index.js";
import { processGroup, runConsumer, type QueueClient, type QueueMessage } from "../../packages/slack-service/src/consumer.js";
import { deterministicUuid, requestIdSequence } from "../../packages/slack-service/src/ids.js";
import {
  processSlackRequest,
  type ProcessorDependencies,
  type ThreadState,
  type TurnInput,
} from "../../packages/slack-service/src/processor.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prepareOperationId = "22222222-2222-4222-8222-222222222222";

function slackMessage(overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return {
    version: 1,
    eventId: "Ev0000000001",
    thread,
    userId: "U0123456789",
    text: "fix the navigation bug",
    receivedAt: "2026-09-23T21:00:00.000Z",
    ...overrides,
  };
}

function workspaceResult(overrides: Partial<Extract<SlackThreadWorkspaceResult, { outcome: "WORKSPACE" }>> = {}): SlackThreadWorkspaceResult {
  return {
    outcome: "WORKSPACE",
    workspaceId,
    status: "READY",
    operationId: null,
    created: false,
    orchestratorInstructions: "Delegate work.",
    ...overrides,
  };
}

function processorHarness(options: {
  workspace?: SlackThreadWorkspaceResult;
  preparation?: string;
  state?: ThreadState;
  turn?: (input: TurnInput) => Promise<string>;
  ensureError?: Error;
  closeStart?: SlackWorkspaceCloseStartResult;
  closeOperation?: { status: string; error?: string; result?: unknown };
} = {}) {
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const saved: Array<{ workspaceId: string; conversationId: string }> = [];
  const savedRevisions: number[] = [];
  const closed: Array<{ workspaceId: string; closedAt: string }> = [];
  const finished: string[] = [];
  const createConversation = vi.fn(async () => "33333333-3333-4333-8333-333333333333");
  const ensureWorkspace = vi.fn(async () => {
    if (options.ensureError) throw options.ensureError;
    return options.workspace ?? workspaceResult();
  });
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace,
      startClose: async () => options.closeStart ?? { outcome: "NOT_FOUND" },
      completeClose: async (_requestId, operationId) => ({
        outcome: "CLOSED",
        workspaceId,
        operationId,
        closedAt: "2026-09-24T08:00:00.000Z",
        storageReleased: true,
      }),
      waitForOperation: async () => options.closeOperation ?? { status: options.preparation ?? "SUCCEEDED" },
      createConversation,
    }),
    threads: {
      load: async () => options.state ?? {},
      saveConversation: async (_subject, state) => {
        saved.push(state);
      },
      saveSettingsRevision: async (_subject, revision) => {
        savedRevisions.push(revision);
      },
      close: async (_subject, state) => {
        closed.push(state);
      },
      finish: async (subject) => {
        finished.push(subject);
      },
    },
    runTurn: async (input) => {
      turns.push(input);
      return options.turn ? options.turn(input) : "Fixed the navigation bug.";
    },
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts, turns, saved, savedRevisions, closed, finished, createConversation, ensureWorkspace };
}

describe("deterministic request IDs", () => {
  it("reproduces the same valid UUIDs for a redelivered Slack event", () => {
    expect(deterministicUuid("Ev1:workspace")).toBe(deterministicUuid("Ev1:workspace"));
    expect(deterministicUuid("Ev1:workspace")).not.toBe(deterministicUuid("Ev2:workspace"));
    expect(z.string().uuid().safeParse(deterministicUuid("Ev1:workspace")).success).toBe(true);
    const first = requestIdSequence("Ev1");
    const second = requestIdSequence("Ev1");
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });
});

describe("signed control-plane service requests", () => {
  it("routes /v1 requests to /v1/service, drops the bearer token, and signs with SigV4 and the thread headers", async () => {
    const baseFetch = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const signedFetch = createSignedServiceFetch({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      thread,
      userId: "U0123456789",
      baseFetch,
    });
    await signedFetch(`https://api.example.test/v1/workspaces/${workspaceId}/tasks?limit=5`, {
      method: "POST",
      headers: { authorization: "Bearer slack-service", "content-type": "application/json" },
      body: "{\"prompt\":\"hi\"}",
    });
    const [url, init] = baseFetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.example.test/v1/service/workspaces/${workspaceId}/tasks?limit=5`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=.*x-agentx-slack-thread;x-agentx-slack-user/);
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["x-agentx-slack-thread"]).toBe("T0BSHLLUGBD/C0123456789/1695500000.000001");
    expect(headers["x-agentx-slack-user"]).toBe("U0123456789");
    expect(headers.host).toBeUndefined();
    expect(init?.body).toBe("{\"prompt\":\"hi\"}");
    await expect(signedFetch("https://api.example.test/health")).rejects.toThrow(/\/v1 routes/);
  });
});

describe("Slack request processing", () => {
  it("closes a clean workspace before ensuring one or running a model turn", async () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    const harness = processorHarness({
      closeStart: { outcome: "PREFLIGHT", workspaceId, operationId, status: "ACCEPTED" },
      closeOperation: { status: "SUCCEEDED", result: { safeToClose: true, repositories: [] } },
    });
    await processSlackRequest(slackMessage({ text: "<@UAGENTX> Close this workspace." }), harness.dependencies, { finalAttempt: false });
    expect(harness.ensureWorkspace).not.toHaveBeenCalled();
    expect(harness.turns).toHaveLength(0);
    expect(harness.posts).toEqual([
      "Checking this workspace for unpublished work before closing it.",
      "Workspace closed. Its runtime session and persistent workspace storage have been released.",
    ]);
    expect(harness.closed).toEqual([{ workspaceId, closedAt: "2026-09-24T08:00:00.000Z" }]);
  });

  it("does not create a workspace for a close request in an empty thread", async () => {
    const harness = processorHarness({ closeStart: { outcome: "NOT_FOUND" } });
    await processSlackRequest(slackMessage({ text: "close workspace" }), harness.dependencies, { finalAttempt: false });
    expect(harness.ensureWorkspace).not.toHaveBeenCalled();
    expect(harness.posts).toEqual(["This thread does not have a workspace to close."]);
  });

  it("keeps unpublished work and identifies affected repositories", async () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    const harness = processorHarness({
      closeStart: { outcome: "PREFLIGHT", workspaceId, operationId, status: "RUNNING" },
      closeOperation: {
        status: "SUCCEEDED",
        result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["untracked_files", "unpushed_head"] }] },
      },
    });
    await processSlackRequest(slackMessage({ text: "close this workspace" }), harness.dependencies, { finalAttempt: false });
    expect(harness.posts.at(-1)).toContain("demo: untracked files, an unpushed current commit");
    expect(harness.closed).toHaveLength(0);
  });

  it("escapes Slack control characters in the preflight failure notice (M5)", async () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    const harness = processorHarness({
      closeStart: { outcome: "PREFLIGHT", workspaceId, operationId, status: "RUNNING" },
      closeOperation: { status: "FAILED", error: "<!here> repo check failed" },
    });
    await processSlackRequest(slackMessage({ text: "close this workspace" }), harness.dependencies, { finalAttempt: false });
    expect(harness.posts.at(-1)).toBe("I couldn't close this workspace because its safety check failed: &lt;!here&gt; repo check failed");
  });

  it("does not run a model turn for a later message in a closed thread", async () => {
    const harness = processorHarness({
      workspace: { outcome: "CLOSED", workspaceId, closedAt: "2026-09-24T08:00:00.000Z" },
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.turns).toHaveLength(0);
    expect(harness.posts).toEqual(["This thread's workspace is closed. Start a new Slack thread to create a fresh workspace."]);
  });

  it("sets up a new thread's workspace, then runs the request with the project instructions", async () => {
    const harness = processorHarness({
      workspace: workspaceResult({ status: "PREPARING", operationId: prepareOperationId, created: true }),
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.posts).toEqual([
      "Setting up a new workspace for this thread. The first request takes a few minutes.",
      "Working on it now. I'll post the result in this thread when it's done.",
      "Fixed the navigation bug.",
    ]);
    expect(harness.saved).toEqual([{ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }]);
    expect(harness.turns[0]).toMatchObject({
      workspaceId,
      conversationId: "33333333-3333-4333-8333-333333333333",
      orchestratorInstructions: "Delegate work.",
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
    });
    expect(harness.ensureWorkspace).toHaveBeenCalledWith(deterministicUuid("Ev0000000001:workspace"));
    expect(harness.finished).toHaveLength(1);
  });

  it("continues a follow-up in the thread's existing workspace and conversation", async () => {
    const harness = processorHarness({
      state: { workspaceId, conversationId: "44444444-4444-4444-8444-444444444444" },
    });
    await processSlackRequest(slackMessage({ eventId: "Ev0000000002", userId: "U0456789012" }), harness.dependencies, { finalAttempt: false });
    expect(harness.createConversation).not.toHaveBeenCalled();
    expect(harness.turns[0]?.conversationId).toBe("44444444-4444-4444-8444-444444444444");
    expect(harness.posts[0]).toBe("Working on it now. I'll post the result in this thread when it's done.");
  });

  it("announces a settings revision change once, and records it silently the first time", async () => {
    const first = processorHarness({
      workspace: workspaceResult({ settingsRevision: 4 }),
      state: { workspaceId, conversationId: "44444444-4444-4444-8444-444444444444" },
    });
    await processSlackRequest(slackMessage(), first.dependencies, { finalAttempt: false });
    // A thread that has never been told a revision is not announced to; it is only recorded.
    expect(first.posts).not.toContain("Settings updated to revision 4.");
    expect(first.savedRevisions).toEqual([4]);

    const moved = processorHarness({
      workspace: workspaceResult({ settingsRevision: 5 }),
      state: { workspaceId, conversationId: "44444444-4444-4444-8444-444444444444", settingsRevision: 4 },
    });
    await processSlackRequest(slackMessage(), moved.dependencies, { finalAttempt: false });
    expect(moved.posts[0]).toBe("Settings updated to revision 5.");
    expect(moved.savedRevisions).toEqual([5]);

    const unchanged = processorHarness({
      workspace: workspaceResult({ settingsRevision: 5 }),
      state: { workspaceId, conversationId: "44444444-4444-4444-8444-444444444444", settingsRevision: 5 },
    });
    await processSlackRequest(slackMessage(), unchanged.dependencies, { finalAttempt: false });
    expect(unchanged.posts.some((text) => text.startsWith("Settings updated"))).toBe(false);
    expect(unchanged.savedRevisions).toEqual([]);
  });

  it("explains the member limit with links to the member's threads, without running a turn", async () => {
    const harness = processorHarness({
      workspace: {
        outcome: "LIMIT_REACHED",
        limit: "MEMBER",
        maximum: 3,
        starterThreads: [thread, { ...thread, threadTs: "1695500000.000002" }],
      },
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.turns).toHaveLength(0);
    expect(harness.posts).toEqual([[
      "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:",
      "• <https://slack.com/archives/C0123456789/p1695500000000001|Thread 1>",
      "• <https://slack.com/archives/C0123456789/p1695500000000002|Thread 2>",
    ].join("\n")]);
    expect(harness.finished).toHaveLength(1);
  });

  it("explains the organization limit", async () => {
    const harness = processorHarness({
      workspace: { outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: 20, starterThreads: [] },
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.posts[0]).toMatch(/^This organization already has 20 AgentX workspaces/);
  });

  it("reports a failed workspace setup and does not run the request", async () => {
    const harness = processorHarness({
      workspace: workspaceResult({ status: "PREPARING", operationId: prepareOperationId, created: true }),
      preparation: "FAILED",
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.turns).toHaveLength(0);
    expect(harness.posts.at(-1)).toBe("AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry.");
    expect(harness.finished).toHaveLength(1);
  });

  it("posts a safe failure when the orchestrator turn fails", async () => {
    const harness = processorHarness({ turn: async () => { throw new Error("RUNTIME_UNAVAILABLE: Bedrock throttled the request"); } });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.posts.at(-1)).toBe("AgentX could not complete the request: RUNTIME_UNAVAILABLE: Bedrock throttled the request");
    expect(harness.finished).toHaveLength(1);
  });

  it("leaves infrastructure failures for SQS to redeliver, and reports them on the final attempt", async () => {
    const retry = processorHarness({ ensureError: new Error("control plane unavailable") });
    await expect(processSlackRequest(slackMessage(), retry.dependencies, { finalAttempt: false })).rejects.toThrow(/unavailable/);
    expect(retry.posts).toHaveLength(0);
    expect(retry.finished).toHaveLength(0);

    const final = processorHarness({ ensureError: new Error("control plane unavailable") });
    await processSlackRequest(slackMessage(), final.dependencies, { finalAttempt: true });
    expect(final.posts).toEqual(["AgentX could not process this request: control plane unavailable"]);
    expect(final.finished).toHaveLength(1);
  });

  it("escapes Slack control characters in the abandonment notice (M5)", async () => {
    const final = processorHarness({ ensureError: new Error("<!here> control plane unavailable") });
    await processSlackRequest(slackMessage(), final.dependencies, { finalAttempt: true });
    expect(final.posts).toEqual(["AgentX could not process this request: &lt;!here&gt; control plane unavailable"]);
    expect(final.finished).toHaveLength(1);
  });

  it("reuses the same tool request IDs when a Slack event is processed again after a crash", async () => {
    const turnIds: string[][] = [];
    const turn = async (input: TurnInput) => {
      turnIds.push([input.requestId(), input.requestId()]);
      return "done";
    };
    await processSlackRequest(slackMessage(), processorHarness({ turn }).dependencies, { finalAttempt: false });
    await processSlackRequest(slackMessage(), processorHarness({ turn }).dependencies, { finalAttempt: false });
    expect(turnIds[0]).toEqual(turnIds[1]);
    expect(new Set(turnIds[0]).size).toBe(2);
  });
});

function queueMessage(eventId: string, groupId: string, receiveCount = 1): QueueMessage {
  return {
    body: JSON.stringify(slackMessage({ eventId })),
    receiptHandle: `receipt-${eventId}`,
    groupId,
    receiveCount,
  };
}

function fakeQueue(batches: QueueMessage[][]) {
  const deleted: string[] = [];
  const extended: string[] = [];
  const queue: QueueClient = {
    receive: async () => {
      const next = batches.shift();
      if (next) return next;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    },
    delete: async (receipt) => {
      deleted.push(receipt);
    },
    extendVisibility: async (receipt) => {
      extended.push(receipt);
    },
  };
  return { queue, deleted, extended };
}

const groupOptions = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };

describe("thread-ordered queue consumer", () => {
  it("runs one thread's requests in order while other threads run in parallel", async () => {
    const { queue, deleted } = fakeQueue([[
      queueMessage("Ev000000A1", "thread-a"),
      queueMessage("Ev000000A2", "thread-a"),
      queueMessage("Ev000000B1", "thread-b"),
    ]]);
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = new AbortController();
    const handled = new Set<string>();
    const consumer = runConsumer(queue, async (message) => {
      events.push(`start ${message.eventId}`);
      if (message.eventId === "Ev000000A1") await firstBlocked;
      events.push(`end ${message.eventId}`);
      handled.add(message.eventId);
      if (message.eventId === "Ev000000B1") releaseFirst();
      if (handled.size === 3) controller.abort();
    }, { ...groupOptions, concurrency: 4, signal: controller.signal });
    await consumer;
    expect(events.indexOf("end Ev000000B1")).toBeLessThan(events.indexOf("end Ev000000A1"));
    expect(events.indexOf("end Ev000000A1")).toBeLessThan(events.indexOf("start Ev000000A2"));
    expect(deleted).toEqual(["receipt-Ev000000B1", "receipt-Ev000000A1", "receipt-Ev000000A2"]);
  });

  it("keeps a failed request and the rest of its thread for redelivery", async () => {
    const { queue, deleted } = fakeQueue([]);
    const handled: string[] = [];
    await processGroup(queue, async (message) => {
      handled.push(message.eventId);
      if (message.eventId === "Ev000000A1") throw new Error("control plane unavailable");
    }, [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000A2", "thread-a")], groupOptions, () => undefined);
    expect(handled).toEqual(["Ev000000A1"]);
    expect(deleted).toEqual([]);
  });

  it("marks the last allowed delivery as the final attempt and discards malformed messages", async () => {
    const { queue, deleted } = fakeQueue([]);
    const attempts: boolean[] = [];
    await processGroup(queue, async (_message, context) => {
      attempts.push(context.finalAttempt);
    }, [
      queueMessage("Ev000000A1", "thread-a", 4),
      queueMessage("Ev000000A2", "thread-a", 5),
      { body: "not json", receiptHandle: "receipt-bad", groupId: "thread-a", receiveCount: 1 },
    ], groupOptions, () => undefined);
    expect(attempts).toEqual([false, true]);
    expect(deleted).toEqual(["receipt-Ev000000A1", "receipt-Ev000000A2", "receipt-bad"]);
  });

  it("extends visibility while a long request is still running", async () => {
    const { queue, extended } = fakeQueue([]);
    await processGroup(queue, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }, [queueMessage("Ev000000A1", "thread-a")], { ...groupOptions, heartbeatMilliseconds: 10 }, () => undefined);
    expect(extended.length).toBeGreaterThanOrEqual(2);
    expect(new Set(extended)).toEqual(new Set(["receipt-Ev000000A1"]));
  });
});

describe("Slack reply formatting in the processor", () => {
  it("posts the turn's reply in Slack formatting", async () => {
    const harness = processorHarness({
      turn: async () => "Created [<https://linear.app/x/issue/CHA-6>](<https://linear.app/x/issue/CHA-6>).\\nNothing else changed.",
    });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.posts.at(-1)).toBe("Created <https://linear.app/x/issue/CHA-6>.\nNothing else changed.");
  });

  it("formats a failed turn's message too, so an error cannot notify the channel", async () => {
    const harness = processorHarness({ turn: async () => { throw new Error("vendor said <!channel>"); } });
    await processSlackRequest(slackMessage(), harness.dependencies, { finalAttempt: false });
    expect(harness.posts.at(-1)).toBe("AgentX could not complete the request: vendor said &lt;!channel&gt;");
  });
});
