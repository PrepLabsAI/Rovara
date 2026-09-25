import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadPrepareResult, SlackThreadWorkspaceResult, TurnRecord } from "../../packages/contracts/src/index.js";
import { deterministicUuid } from "../../packages/slack-service/src/ids.js";
import { LIMIT_REFUSAL, createLazyWorker, unavailableRefusal } from "../../packages/slack-service/src/lazy-worker.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const otherThread = { ...thread, threadTs: "1695500000.000002" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";
const SLOW = "This thread's workspace is taking longer than expected to set up. It continues in the background; mention me again in this thread in a few minutes.";
const MEMBER_LIMIT = [
  "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:",
  "• <https://slack.com/archives/C0123456789/p1695500000000001|Thread 1>",
  "• <https://slack.com/archives/C0123456789/p1695500000000002|Thread 2>",
].join("\n");
const started: SlackThreadPrepareResult = { outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true };

function lazyHarness(
  prepare: SlackThreadPrepareResult | Error,
  waited = "SUCCEEDED",
  options: { wait?: () => Promise<{ status: string }>; waitDeadlineMilliseconds?: number } = {},
) {
  const posts: string[] = [];
  const logs: string[] = [];
  const prepareWorkspace = vi.fn(async () => {
    if (prepare instanceof Error) throw prepare;
    return prepare;
  });
  const waitForOperation = vi.fn(options.wait ?? (async () => ({ status: waited })));
  const worker = createLazyWorker({
    api: { prepareWorkspace, waitForOperation },
    post: async (text) => {
      posts.push(text);
    },
    log: (event) => {
      logs.push(event);
    },
    eventId: "Ev0000000001",
    ...(options.waitDeadlineMilliseconds === undefined ? {} : { waitDeadlineMilliseconds: options.waitDeadlineMilliseconds }),
  });
  return { worker, posts, logs, prepareWorkspace, waitForOperation };
}

describe("the lazy worker", () => {
  it("prepares once for parallel tool calls and says so once", async () => {
    const h = lazyHarness(started);
    expect(h.worker.prepared()).toBe(false);
    expect(await Promise.all([h.worker.ensureReady(), h.worker.ensureReady()])).toEqual([undefined, undefined]);
    expect(h.prepareWorkspace).toHaveBeenCalledExactlyOnceWith(deterministicUuid("Ev0000000001:prepare"));
    expect(h.waitForOperation).toHaveBeenCalledExactlyOnceWith(workspaceId, operationId);
    expect(h.posts).toEqual([SETTING_UP]);
    expect(h.worker.prepared()).toBe(true);
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
  });

  it("tells the thread another request is already setting it up", async () => {
    const h = lazyHarness({ ...started, created: false });
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.posts).toEqual([STILL]);
  });

  it("continues at once when another request already finished preparing", async () => {
    const h = lazyHarness({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false });
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.posts).toEqual([]);
    expect(h.waitForOperation).not.toHaveBeenCalled();
    expect(h.worker.prepared()).toBe(true);
  });

  it("posts the limit with the member's threads and refuses, without retrying in the turn", async () => {
    const h = lazyHarness({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread, otherThread] });
    expect(await h.worker.ensureReady()).toEqual(LIMIT_REFUSAL);
    expect(LIMIT_REFUSAL.message).toMatch(/Do not retry/);
    expect(LIMIT_REFUSAL.message).toMatch(/answer any part of the request that does not need the worker/);
    expect(h.posts).toEqual([MEMBER_LIMIT]);
    expect(await h.worker.ensureReady()).toEqual(LIMIT_REFUSAL);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.worker.prepared()).toBe(false);
    expect(h.logs).toEqual(["request.limit_reached"]);
  });

  it("reports a failed setup in the thread and refuses the worker for the rest of the turn", async () => {
    const h = lazyHarness(started, "FAILED");
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("workspace setup failed"));
    expect(h.posts).toEqual([SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry."]);
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("workspace setup failed"));
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.logs).toEqual(["workspace.preparation_failed"]);
  });

  it("reports a setup it could not confirm and refuses the worker for the rest of the turn", async () => {
    const h = lazyHarness(started, "SUCCEEDED", { wait: async () => {
      throw new TypeError("fetch failed");
    } });
    const refusal = unavailableRefusal("workspace setup could not be confirmed");
    expect(await h.worker.ensureReady()).toEqual(refusal);
    expect(refusal.message).toMatch(/Do not retry this tool in this turn/);
    expect(h.posts).toEqual([SETTING_UP, "AgentX could not set up this thread's workspace (UNCONFIRMED). Mention me again in this thread to retry."]);
    expect(await h.worker.ensureReady()).toEqual(refusal);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.waitForOperation).toHaveBeenCalledOnce();
    expect(h.logs).toEqual(["workspace.preparation_failed"]);
    expect(h.worker.prepared()).toBe(false);
  });

  it("stops waiting mid-turn at its deadline and says setup continues in the background", async () => {
    const h = lazyHarness(started, "SUCCEEDED", { wait: () => new Promise(() => undefined), waitDeadlineMilliseconds: 20 });
    const refusal = unavailableRefusal("workspace setup is taking longer than expected; it continues in the background");
    expect(await h.worker.ensureReady()).toEqual(refusal);
    expect(h.posts).toEqual([SETTING_UP, SLOW]);
    expect(await h.worker.ensureReady()).toEqual(refusal);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.logs).toEqual(["workspace.preparation_slow"]);
    expect(h.worker.prepared()).toBe(false);
  });

  it("refuses without posting when the thread's workspace is closed", async () => {
    const h = lazyHarness({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" });
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("this thread's workspace is closed; start a new Slack thread for coding work"));
    expect(h.posts).toEqual([]);
  });

  it("fails the tool call, once per turn, when the control plane cannot be reached", async () => {
    const h = lazyHarness(new Error("thread workspace preparation failed: 503"));
    await expect(h.worker.ensureReady()).rejects.toThrow(/503/);
    await expect(h.worker.ensureReady()).rejects.toThrow(/503/);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
  });
});

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "what's open in Linear?", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspaceResult(overrides: Record<string, unknown>): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides } as SlackThreadWorkspaceResult;
}

function processorHarness(result: SlackThreadWorkspaceResult, turn: (input: TurnInput) => Promise<string>, prepare: SlackThreadPrepareResult = started) {
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const saved: Array<{ workspaceId: string; conversationId: string }> = [];
  const records: TurnRecord[] = [];
  const prepareWorkspace = vi.fn(async () => prepare);
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      prepareWorkspace,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation,
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async (_subject, state) => {
        saved.push(state);
      },
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async (input) => {
      turns.push(input);
      return turn(input);
    },
    post: async (_thread, text) => {
      posts.push(text);
    },
    turnRecords: {
      write: async (record) => {
        records.push(record);
        return "written";
      },
    },
  };
  return { dependencies, posts, turns, saved, records, prepareWorkspace, waitForOperation };
}

describe("processing a thread with no compute", () => {
  it("answers without setting up a workspace when the turn never needs the worker", async () => {
    const h = processorHarness(workspaceResult({ status: "UNPREPARED", created: true }), async () => "3 issues are open.");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "3 issues are open."]);
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
    expect(h.waitForOperation).not.toHaveBeenCalled();
    expect(h.turns[0]?.worker?.prepared()).toBe(false);
    expect(h.saved).toEqual([{ workspaceId, conversationId }]);
  });

  it("sets up the workspace mid-turn, once, when the turn first needs the worker", async () => {
    const h = processorHarness(workspaceResult({ status: "UNPREPARED" }), async (input) => {
      expect(await input.worker!.ensureReady()).toBeUndefined();
      return "Listed the files.";
    });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, SETTING_UP, "Listed the files."]);
    expect(h.prepareWorkspace).toHaveBeenCalledExactlyOnceWith(deterministicUuid("Ev0000000001:prepare"));
  });

  it("still answers when the limit stops the worker part", async () => {
    const h = processorHarness(
      workspaceResult({ status: "UNPREPARED" }),
      async (input) => {
        expect(await input.worker!.ensureReady()).toEqual(LIMIT_REFUSAL);
        return "3 issues are open. The coding part did not run.";
      },
      { outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread, otherThread] },
    );
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, MEMBER_LIMIT, "3 issues are open. The coding part did not run."]);
    expect(h.records.map((record) => record.disposition)).toEqual(["answered"]);
  });

  it("gives a thread that already has compute no worker handle, as with an older control plane", async () => {
    const h = processorHarness(workspaceResult({ status: "PREPARING", operationId, created: true }), async () => "done");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SETTING_UP, WORKING, "done"]);
    expect(h.turns[0]).not.toHaveProperty("worker");
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
  });

  it("does not use the prepare route for a thread whose setup failed", async () => {
    const h = processorHarness(workspaceResult({ status: "PREPARATION_FAILED" }), async () => "done");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual(["This thread's workspace is not available right now (PREPARATION_FAILED). Mention me again later to retry."]);
    expect(h.turns).toEqual([]);
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
  });
});

describe("the hosted runtime and the lazy worker", () => {
  it("hands the worker handle to the task tools", async () => {
    const access = { prepared: () => false, ensureReady: vi.fn(async () => unavailableRefusal("no workspace")) };
    const api = { submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() };
    const runtime = await createHostedSlackRuntime(
      { message: message(), subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", workspaceId, conversationId, orchestratorInstructions: "Delegate.", requestId: () => operationId, worker: access },
      { stateDirectory: await createFixtureDirectory("agentx-lazy-runtime-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } },
    );
    try {
      const result = await runtime.session.getToolDefinition("agentx_submit_task")!.execute("call-1", { prompt: "list" }, undefined, undefined, {} as never);
      expect(access.ensureReady).toHaveBeenCalledOnce();
      expect(api.submitTask).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(unavailableRefusal("no workspace")) }]);
    } finally {
      await runtime.dispose();
    }
  });
});
