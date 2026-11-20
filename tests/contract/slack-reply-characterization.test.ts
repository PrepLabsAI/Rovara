// tests/contract/slack-reply-characterization.test.ts
// Pins how the Slack processor posts a turn's reply and what it records, before spec 014 phase 14d
// adds the Details button. The harness never passes postWithBlocks, so these hold afterwards too.
import { describe, expect, it, vi } from "vitest";
import { type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/slack-processor.js";
import { DynamoTurnRecordWriter } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const message: SlackRequestMessage = {
  version: 1, eventId: "EvCHAR000001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
  text: "list open items",
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding.",
};

function turnWithCall(response: string | Error) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.offer({ manifest: "m", tools: [{ name: "tracker__list_items", description: "d" }], connectorOf: new Map([["tracker__list_items", "tracker"]]), model: { provider: "p", modelId: "m" } });
    input.recorder?.toolStarted({ toolCallId: "c1", toolName: "tracker__list_items", args: { state: "OPEN" } });
    input.recorder?.toolEnded({ toolCallId: "c1", toolName: "tracker__list_items", isError: false,
      result: { content: [{ type: "text", text: JSON.stringify({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }) }] } });
    if (response instanceof Error) throw response;
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function harness(runTurn: (input: TurnInput) => Promise<string>) {
  const db = new FakeDynamoDb();
  const posts: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => workspace,
      startClose: async () => ({ outcome: "NOT_FOUND" }),
      completeClose: vi.fn(), waitForOperation: vi.fn(),
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({ workspaceId, conversationId }),
      saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
    },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
    turnRecords: new DynamoTurnRecordWriter(db as never, "turns"),
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  return { dependencies, posts, stored };
}

describe("reply posting and recording before the Details button (spec 014 phase 14d)", () => {

  it("posts and records a turn that fails after a tool call", async () => {
    const { dependencies, posts, stored } = harness(turnWithCall(new Error("model down")));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("AgentX could not complete the request: model down");
    expect(stored()[0]).toMatchObject({ disposition: "failed", calls: [expect.objectContaining({ name: "tracker__list_items" })] });
  });
});
