// Pins how processSlackRequest treats each workspace result, before phase 14b adds UNPREPARED.
import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "fix the navigation bug", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspace(overrides: Record<string, unknown> = {}): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides };
}

function harness(result: SlackThreadWorkspaceResult) {
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation,
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async () => undefined,
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async (input) => {
      turns.push(input);
      return "done";
    },
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts, turns, waitForOperation };
}

describe("processing a thread's workspace result (characterization)", () => {
  it.each(["STOPPED", "BUSY"] as const)("runs the turn for a %s workspace without a setup message", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "done"]);
    expect(h.waitForOperation).not.toHaveBeenCalled();
  });

  it.each(["UNHEALTHY", "RESUMING", "CLOSING", "PREPARATION_FAILED", "PREPARING"] as const)(
    "does not run a turn for a %s workspace with no operation to wait for",
    async (status) => {
      const h = harness(workspace({ status }));
      await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
      expect(h.turns).toHaveLength(0);
      expect(h.posts).toEqual([`This thread's workspace is not available right now (${status}). Mention me again later to retry.`]);
    },
  );

  it("tells a later request that another request is still setting the workspace up", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: false }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual(["This thread's workspace is still being set up. I'll start as soon as it's ready.", WORKING, "done"]);
    expect(h.waitForOperation).toHaveBeenCalledExactlyOnceWith(workspaceId, operationId);
  });

  it("hands the turn exactly the workspace's routing fields", async () => {
    const connectors = [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }];
    const h = harness(workspace({ connectors, repositories: ["demo"], recoverableOperations: [operationId] }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    const turn = h.turns[0]!;
    expect(Object.keys(turn).sort()).toEqual([
      // Spec 051 FR-009: the recorder is always handed in, so the reply can lead with the check report.
      // Spec 014 final fix I1: a runnable workspace also tells the gate its compute is prepared (D5).
      "computePrepared", "connectors", "conversationId", "message", "orchestratorInstructions", "recorder", "recoverableOperations", "repositories", "requestId", "subject", "workspaceId",
    ]);
    expect(turn).toMatchObject({ computePrepared: true, connectors, repositories: ["demo"], recoverableOperations: [operationId], workspaceId, conversationId });
  });

  it("hands the turn no routing field the workspace did not send", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(Object.keys(h.turns[0]!).sort()).toEqual(["computePrepared", "conversationId", "message", "orchestratorInstructions", "recorder", "requestId", "subject", "workspaceId"]);
  });
});

// Spec 051 Task 6 (FR-009): AgentX's check verdict leads the reply, and the agent's account follows.
describe("the reply leads with AgentX's check result (spec 051)", () => {
  const report = (overrides: Record<string, unknown>) => ({
    status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64),
    checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "x", durationMs: 1 }],
    extraTry: "not_needed", agentClaim: "success", ...overrides,
  });
  const taskCall = (input: TurnInput, name: string, result: unknown, id: string) => {
    input.recorder!.toolStarted({ toolCallId: id, toolName: name, args: {} });
    input.recorder!.toolEnded({ toolCallId: id, toolName: name, isError: false, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
  };

  it("puts the regression first and labels the model's text as the agent's account", async () => {
    const h = harness(workspace());
    h.dependencies.runTurn = async (input) => {
      taskCall(input, "agentx_submit_task", { operationId, status: "SUCCEEDED", response: "All good.", checks: report({}) }, "1");
      return "All good.";
    };
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "Not done: npm test passed before and fails now.\n\n*Agent's account:*\nAll good."]);
  });

  // Ruling Z (I-1): a turn that only publishes runs no task, so its verdict comes from the publish result.
  const prResult = (draft: boolean | undefined) => ({
    operationId, status: "SUCCEEDED",
    result: { repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7", ...(draft === undefined ? {} : { draft }) },
  });

  it("says the pull request opened as a draft in a turn that only publishes", async () => {
    const h = harness(workspace());
    h.dependencies.runTurn = async (input) => {
      taskCall(input, "agentx_create_pull_request", prResult(true), "1");
      return "Opened https://github.com/example/demo/pull/7.";
    };
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "Opened as a draft: AgentX's checks found failures.\n\n*Agent's account:*\nOpened <https://github.com/example/demo/pull/7>."]);
  });

  it.each([[false], [undefined]])("adds no line when the pull request is not a draft (draft: %s)", async (draft) => {
    const h = harness(workspace());
    h.dependencies.runTurn = async (input) => {
      taskCall(input, "agentx_create_pull_request", prResult(draft), "1");
      return "Opened it.";
    };
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "Opened it."]);
  });

  it("leads with the task's verdict and then the draft line when a turn runs a task and publishes", async () => {
    const h = harness(workspace());
    h.dependencies.runTurn = async (input) => {
      taskCall(input, "agentx_submit_task", { operationId, status: "SUCCEEDED", response: "Fixed.", checks: report({ status: "verified", checks: [] }) }, "1");
      taskCall(input, "agentx_create_pull_request", prResult(true), "2");
      return "Fixed and opened.";
    };
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts[1]).toBe("No regression found, but no check passes yet.\nOpened as a draft: AgentX's checks found failures.\n\n*Agent's account:*\nFixed and opened.");
  });

  it("leaves a turn with no check report exactly as before", async () => {
    const h = harness(workspace());
    h.dependencies.runTurn = async (input) => {
      taskCall(input, "agentx_submit_task", { operationId, status: "SUCCEEDED", response: "Done." }, "1");
      return "Done.";
    };
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "Done."]);
  });
});
