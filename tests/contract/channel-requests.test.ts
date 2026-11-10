// Spec 062 Phase 4: what the channel API queued runs through the Slack processor; replies leave as adapter events, a
// decision answers exactly one confirmation, and a stepped-up confirmation is never approved from the adapter.
import { describe, expect, it, vi } from "vitest";
import { SLACK_FORMAT } from "../../packages/slack-service/src/slack-format.js";
import {
  CONFIRMATION_TTL_MS, ChannelEventSchema, conversationSubject,
  type ChannelEvent, type ChannelQueueItem, type PendingConfirmation, type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import { NO_LONGER_PENDING_TEXT, STEP_UP_TEXT, checkConfirmation, confirmationApprovalKind, confirmationDigest } from "../../packages/slack-service/src/confirmations.js";
import { CHATGPT_ELSEWHERE_TEXT, SLACK_ONLY_COMMAND_TEXT, channelRequestHandler, channelTurn, readChannelQueueItem } from "../../packages/slack-service/src/channel-requests.js";
import { PLAIN_FORMAT } from "../../packages/slack-service/src/conversation-format.js";
import { confirmationMessage } from "../../packages/slack-service/src/confirmations.js";
import { limitMessage, preparationFailedMessage } from "../../packages/slack-service/src/messages.js";
import type { TurnInput } from "../../packages/slack-service/src/slack-processor.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const conversation = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };
const subject = conversationSubject(conversation);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const postedAt = Date.parse("2026-11-08T10:00:00.000Z");
const message: ChannelQueueItem = {
  kind: "message", projectName: "web", developerId: "dev-1", stepUp: ["plan_approval", "admin"],
  message: { version: 2, channel: "whatsapp", eventId: "wamid.HBgL1", conversation, actor, text: "list open items", receivedAt: "2026-11-08T10:01:00.000Z" },
};
const pending = (kind: PendingConfirmation["calls"][number]["kind"]): PendingConfirmation => ({
  confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: actor.userId,
  calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9", kind }],
  postedAt: new Date(postedAt).toISOString(), expiresAt: new Date(postedAt + CONFIRMATION_TTL_MS).toISOString(),
});
const decision = (value: "APPROVE" | "REJECT", confirmation: PendingConfirmation, stepUp: ChannelQueueItem["stepUp"] = ["plan_approval", "admin"]): ChannelQueueItem => ({
  kind: "decision", projectName: "web", developerId: "dev-1", stepUp,
  decision: {
    version: 1, channel: "whatsapp", eventId: "wamid.HBgL2", conversation, actor, requestId: confirmation.confirmationId, expectedRevision: 1,
    artifactDigest: confirmationDigest(confirmation), decision: value, reason: "from the adapter", receivedAt: "2026-11-08T10:02:00.000Z",
  },
});

function harness(runTurn: (input: TurnInput) => Promise<string> = async () => "Nothing is *open*. See https://example.com/x for the tracker.") {
  const db = new FakeDynamoDb();
  const confirmations = createDynamoConfirmationStore(db, "threads", () => postedAt + 180_000);
  const events: ChannelEvent[] = [];
  const workspace: SlackThreadWorkspaceResult = { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding." };
  const turns: TurnInput[] = [];
  const handle = channelRequestHandler({
    processor: {
      api: () => ({
        ensureWorkspace: async () => workspace, startClose: async () => ({ outcome: "NOT_FOUND" }),
        completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: async () => "33333333-3333-4333-8333-333333333333",
      }),
      threads: { load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
      runTurn: async (input) => { turns.push(input); return runTurn(input); },
      confirmations,
      now: () => postedAt + 180_000,
      log: () => undefined,
    },
    send: async (event) => { events.push(ChannelEventSchema.parse(event)); },
    now: () => postedAt + 180_000,
    log: () => undefined,
  });
  const run = (item: ChannelQueueItem) => handle(item, { finalAttempt: false });
  return { db, confirmations, events, turns, run };
}

describe("an adapter message", () => {
  it("runs a turn for the conversation with plain replies, and its replies leave as message events, then done", async () => {
    const { events, turns, run } = harness();
    await run(message);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ subject, plainReplies: true, message: { userId: actor.userId, thread: conversation, text: "list open items" } });
    expect(events.map((event) => event.type)).toEqual(["message", "done"]);
    // The model was asked for plain text, and the processor passes it through as written.
    expect(events[0]).toMatchObject({ channel: "whatsapp", conversation, data: { text: "Nothing is *open*. See https://example.com/x for the tracker." } });
    expect(events[1]).toMatchObject({ data: { inReplyTo: "wamid.HBgL1" } });
  });

  it("asks for a confirmation as an approval request bound to its calls", async () => {
    const { events, run } = harness(async (input) => {
      input.gate?.asks.push({ tool: "tracker__close_item", argumentsHash: "b".repeat(64), summary: "tracker__close_item: id=TRK-9", kind: "destructive" } as never);
      return "I need your confirmation.";
    });
    await run(message);
    const approval = events.find((event) => event.type === "approval_request");
    expect(approval).toBeDefined();
    if (approval?.type !== "approval_request") throw new Error("no approval request");
    expect(approval.data).toMatchObject({ kind: "other", expectedRevision: 1, actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Cancel" }] });
    expect(approval.data.text).toMatch(/^Before I go ahead, please confirm:/);
    expect(approval.data.text).toContain("reply `yes`");
    expect(approval.data.text).not.toContain("<@");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("refuses a command only Slack offers, and runs no turn", async () => {
    const { events, turns, run } = harness();
    await run({ ...message, message: { ...message.message, text: "eval swebench verified astropy__astropy-12907" } });
    expect(turns).toEqual([]);
    expect(events[0]).toMatchObject({ type: "message", data: { text: SLACK_ONLY_COMMAND_TEXT } });
  });
});

describe("ChatGPT commands in an adapter conversation (FR-041)", () => {
  it.each(["connect chatgpt", "ChatGPT status", "disconnect my chatgpt."])("answers %s with the CLI commands, says nothing about the connection, and runs no turn", async (text) => {
    const { events, turns, run } = harness();
    await run({ ...message, message: { ...message.message, text } });
    expect(turns).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["message", "done"]);
    expect(events[0]).toMatchObject({ data: { text: CHATGPT_ELSEWHERE_TEXT } });
  });
});

describe("an adapter decision (FR-032)", () => {
  it("approves the confirmation it names and runs the confirmed calls", async () => {
    const { confirmations, turns, run } = harness(async () => "Closed TRK-9.");
    await confirmations.save(subject, pending("destructive"));
    await run(decision("APPROVE", pending("destructive")));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.gate?.approvals).toEqual([{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9" }]);
  });

  it("is refused for an admin-required confirmation when the adapter steps admin up, and allowed when it does not", async () => {
    const refused = harness();
    await refused.confirmations.save(subject, pending("admin"));
    await refused.run(decision("APPROVE", pending("admin")));
    expect(refused.turns).toEqual([]);
    expect(refused.events[0]).toMatchObject({ type: "message", data: { text: STEP_UP_TEXT } });

    const allowed = harness();
    await allowed.confirmations.save(subject, pending("admin"));
    await allowed.run(decision("APPROVE", pending("admin"), ["plan_approval"]));
    expect(allowed.turns).toHaveLength(1);
  });

  it("is refused for other calls than the confirmation lists", async () => {
    const { confirmations, events, turns, run } = harness();
    await confirmations.save(subject, pending("destructive"));
    const stale = decision("APPROVE", { ...pending("destructive"), calls: [{ ...pending("destructive").calls[0]!, argumentsHash: "c".repeat(64) }] });
    await run(stale);
    expect(turns).toEqual([]);
    expect(events[0]).toMatchObject({ type: "message", data: { text: NO_LONGER_PENDING_TEXT } });
  });

  it("cancels on a reject", async () => {
    const { confirmations, turns, run } = harness();
    await confirmations.save(subject, pending("destructive"));
    await run(decision("REJECT", pending("destructive")));
    expect(turns).toEqual([]);
    expect((await confirmations.load(subject))?.retiredAt).toBeDefined();
  });

  it("is refused as a typed yes too, so a reply cannot get round step-up", async () => {
    const db = new FakeDynamoDb();
    const store = createDynamoConfirmationStore(db, "threads", () => postedAt + 180_000);
    await store.save(subject, pending("admin"));
    const posts: string[] = [];
    const check = await checkConfirmation({ format: SLACK_FORMAT,
      message: { eventId: "wamid.HBgL3", text: "yes", userId: actor.userId, receivedAt: "2026-11-08T10:02:00.000Z" },
      subject, store, post: async (text) => { posts.push(text); }, log: () => undefined, now: postedAt + 180_000,
      mayApprove: (confirmation) => confirmationApprovalKind(confirmation) !== "admin",
    });
    expect(check).toEqual({ run: false, refused: "step_up" });
    expect(posts).toEqual([STEP_UP_TEXT]);
  });
});

describe("helpers", () => {
  it("reads only well-formed queue items, and defaults a missing step-up set to every kind", () => {
    const older: Record<string, unknown> = { ...message };
    delete older.stepUp;
    expect(readChannelQueueItem(older)?.stepUp).toEqual(["plan_approval", "admin"]);
    expect(readChannelQueueItem({ ...message, kind: "other" })).toBeUndefined();
  });

  it("maps a decision to the reply it stands for", () => {
    expect(channelTurn(decision("REJECT", pending("destructive")))).toMatchObject({ message: { text: "cancel", userId: actor.userId }, answer: { reply: "cancel" } });
  });

  it("writes the processor's texts in plain words for an adapter and leaves Slack's exactly as they were (FR-040)", () => {
    const confirmation = { ...pending("destructive"), calls: [{ ...pending("destructive").calls[0]!, summary: "tracker__close_item: title=a &lt;b&gt; &amp; c" }] };
    const plain = confirmationMessage(confirmation, PLAIN_FORMAT);
    expect(plain).toMatch(/^Before I go ahead, please confirm:\n• tracker__close_item: title=a <b> & c \(destructive\)\n/);
    expect(plain).toContain("reply `yes`");
    expect(plain).not.toMatch(/<@|@AgentX|Slack/);
    expect(confirmationMessage(confirmation, SLACK_FORMAT)).toBe(confirmationMessage(confirmation, SLACK_FORMAT));
    expect(confirmationMessage(confirmation, SLACK_FORMAT)).toMatch(/^<@\+919876544821>, before I go ahead/);
    expect(preparationFailedMessage("FAILED", undefined, PLAIN_FORMAT)).toBe("AgentX could not set up this conversation's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Message me again in this conversation to start fresh.");
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [] }, PLAIN_FORMAT)).toBe("You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Send `close this workspace` in a conversation you no longer need, or ask an administrator to raise the limit.");
  });
});
