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
      "connectors", "conversationId", "message", "orchestratorInstructions", "recoverableOperations", "repositories", "requestId", "subject", "workspaceId",
    ]);
    expect(turn).toMatchObject({ connectors, repositories: ["demo"], recoverableOperations: [operationId], workspaceId, conversationId });
  });

  it("hands the turn no routing field the workspace did not send", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(Object.keys(h.turns[0]!).sort()).toEqual(["conversationId", "message", "orchestratorInstructions", "requestId", "subject", "workspaceId"]);
  });
});
