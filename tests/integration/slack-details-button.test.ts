// tests/integration/slack-details-button.test.ts
import { describe, expect, it, vi } from "vitest";
import { DETAILS_ACTION, splitSlackMessage, type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { slackReplyText } from "../../packages/slack-service/src/slack-format.js";
import { DynamoTurnRecordWriter } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const message: SlackRequestMessage = {
  version: 1, eventId: "EvDETAILS001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
  text: "list open items",
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding.",
};
const value = "2026-09-24T10:00:00.000Z#EvDETAILS001";

interface Posted { text: string; blocks?: unknown[] }

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

function turnWithoutCalls(response: string) {
  return async (input: TurnInput): Promise<string> => {
    input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: response }], stopReason: "stop" }]);
    return response;
  };
}

function harness(runTurn: (input: TurnInput) => Promise<string>, options: { records?: boolean; postWithBlocks?: ProcessorDependencies["postWithBlocks"] } = {}) {
  const db = new FakeDynamoDb();
  const posts: Posted[] = [];
  const logs: string[] = [];
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
    post: async (_thread, text) => { posts.push({ text }); },
    postWithBlocks: options.postWithBlocks ?? (async (_thread, text, blocks) => { posts.push({ text, blocks }); }),
    log: (event, fields) => { logs.push(JSON.stringify({ event, ...fields })); },
    ...(options.records === false ? {} : { turnRecords: new DynamoTurnRecordWriter(db as never, "turns") }),
  };
  const stored = () => db.find((item) => String(item.sk).startsWith("TURN#"));
  return { dependencies, posts, logs, stored };
}

function button(post: Posted | undefined) {
  const actions = post?.blocks?.at(-1) as { type?: string; elements?: Array<{ action_id: string; value: string }> } | undefined;
  return actions?.type === "actions" ? actions.elements?.[0] : undefined;
}

describe("the Details button on replies (spec 014 FR-024)", () => {
  it("puts a Details button naming the turn's record under a reply that followed tool calls", async () => {
    const { dependencies, posts, stored } = harness(turnWithCall("Nothing is open."));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toEqual({ text: "Nothing is open.", blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Nothing is open." } },
      { type: "actions", block_id: "agentx_details", elements: [{ type: "button", action_id: DETAILS_ACTION, text: { type: "plain_text", text: "Details" }, value }] },
    ] });
    expect(posts.slice(0, -1).every((post) => post.blocks === undefined)).toBe(true);
    expect(stored()[0]).toMatchObject({ sk: `TURN#${value}`, responseText: "Nothing is open." });
  });

  it("carries the button on the last chunk of a long reply only, in sections Slack accepts", async () => {
    const reply = Array.from({ length: 3 }, (_, index) => `Part ${index}: ${"word ".repeat(700)}`).join("\n");
    const { dependencies, posts } = harness(turnWithCall(reply));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    const chunks = splitSlackMessage(slackReplyText(reply));
    expect(posts.slice(-chunks.length).map((post) => post.text)).toEqual(chunks);
    expect(posts.slice(-chunks.length, -1).every((post) => post.blocks === undefined)).toBe(true);
    expect(button(posts.at(-1))?.value).toBe(value);
    for (const block of posts.at(-1)!.blocks! as Array<{ type: string; text?: { text: string } }>) {
      if (block.type === "section") expect(block.text!.text.length).toBeLessThanOrEqual(3_000);
    }
  });

  it("adds no button when the turn called no tools, or when no record will be written", async () => {
    const quiet = harness(turnWithoutCalls("Hello."));
    await processSlackRequest(message, quiet.dependencies, { finalAttempt: false });
    expect(quiet.posts.every((post) => post.blocks === undefined)).toBe(true);
    const unrecorded = harness(turnWithCall("Nothing is open."), { records: false });
    await processSlackRequest(message, unrecorded.dependencies, { finalAttempt: false });
    expect(unrecorded.posts.every((post) => post.blocks === undefined)).toBe(true);
  });

  it("posts the reply as text when Slack refuses the blocks, and says so in the log", async () => {
    const { dependencies, posts, logs, stored } = harness(turnWithCall("Nothing is open."), {
      postWithBlocks: async () => { throw new Error("Slack chat.postMessage failed: invalid_blocks"); },
    });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toEqual({ text: "Nothing is open." });
    expect(logs).toContain(JSON.stringify({ event: "reply.details_failed", eventId: "EvDETAILS001", errorName: "Error" }));
    expect(stored()[0]).toMatchObject({ responseText: "Nothing is open." });
    expect(logs.join("\n")).not.toContain("Nothing is open.");
  });

  it("adds the button to a failed turn's reply after a tool call, so the member can see what went wrong", async () => {
    const { dependencies, posts } = harness(turnWithCall(new Error("model down")));
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(posts.at(-1)?.text).toBe("AgentX could not complete the request: model down");
    expect(button(posts.at(-1))?.value).toBe(value);
  });
});
