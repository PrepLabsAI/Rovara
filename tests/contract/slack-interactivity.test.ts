// tests/contract/slack-interactivity.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  answeredConfirmationBlocks,
  confirmationBlocks,
  confirmationClickEventId,
  type PendingConfirmation,
  type SlackRequestMessage,
} from "../../packages/contracts/src/index.js";
import {
  UNKNOWN_BUTTON_TEXT,
  confirmationActionHandler,
  createSlackInteractivityHandler,
  type SlackActionHandler,
  type SlackBlockAction,
} from "../../packages/broker/src/aws/slack-interactivity.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const nowSeconds = 1_758_657_600;
const requester = "U0123456789";
const other = "U0456789012";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = `${thread.teamId}/${thread.channelId}/${thread.threadTs}`;
const pending: PendingConfirmation = {
  confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester,
  calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9", kind: "destructive" }],
  postedAt: new Date(nowSeconds * 1_000 - 60_000).toISOString(), expiresAt: new Date(nowSeconds * 1_000 - 60_000 + CONFIRMATION_TTL_MS).toISOString(),
};
const text = "<@U0123456789>, before I go ahead, please confirm:\n• tracker__close_item: id=TRK-9 (destructive)";

function payload(options: { actionId?: string; value?: string; user?: string; type?: string } = {}) {
  return {
    type: options.type ?? "block_actions",
    team: { id: thread.teamId },
    user: { id: options.user ?? requester, team_id: thread.teamId },
    container: { type: "message", message_ts: "1695500001.000002", channel_id: thread.channelId, thread_ts: thread.threadTs },
    message: { ts: "1695500001.000002", thread_ts: thread.threadTs, text, blocks: confirmationBlocks(text, pending.confirmationId) },
    response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc",
    trigger_id: "1.2.3",
    actions: [{ action_id: options.actionId ?? "agentx_confirm_approve", value: options.value ?? pending.confirmationId, block_id: "agentx_confirmation" }],
  };
}

function signed(body: unknown, options: { timestamp?: number; signature?: string } = {}) {
  const raw = `payload=${encodeURIComponent(typeof body === "string" ? body : JSON.stringify(body))}`;
  const timestamp = String(options.timestamp ?? nowSeconds);
  const signature = options.signature ?? `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return { rawPath: "/v1/slack/interactions", body: raw, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature, "content-type": "application/x-www-form-urlencoded" } };
}

function harness(options: { confirmation?: PendingConfirmation | undefined; failEnqueue?: boolean; extra?: SlackActionHandler[] } = {}) {
  const claimed = new Set<string>();
  const pendingCounts: number[] = [];
  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const ephemeral: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const released: string[] = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); };
  const confirmation = "confirmation" in options ? options.confirmation : pending;
  const handler = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    now: () => nowSeconds * 1_000,
    log,
    respondEphemeral: async (_url, value) => { ephemeral.push(value); },
    handlers: [confirmationActionHandler({
      loadConfirmation: async (key) => key === subject ? confirmation : undefined,
      claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
      releaseEvent: async (eventId) => { released.push(eventId); claimed.delete(eventId); },
      changePending: async (_subject, delta) => { pendingCounts.push(delta); return 1; },
      enqueue: async (message, groupId) => { if (options.failEnqueue) throw new Error("SQS down"); queue.push({ message, groupId }); },
      updateMessage: async (input) => { updates.push(input); },
      respondEphemeral: async (_url, value) => { ephemeral.push(value); },
      now: () => nowSeconds * 1_000,
      log,
    }), ...(options.extra ?? [])],
  });
  return { handler, queue, updates, ephemeral, logs, pendingCounts, released };
}

describe("Slack interactivity request URL (spec 014 D2)", () => {
  it("refuses a request whose signature does not verify or is stale, before reading it", async () => {
    const { handler, queue } = harness();
    expect((await handler(signed(payload(), { signature: "v0=bad" }))).statusCode).toBe(401);
    expect((await handler(signed(payload(), { timestamp: nowSeconds - 301 }))).statusCode).toBe(401);
    expect(queue).toHaveLength(0);
  });

  it("refuses a payload that is not JSON, and ignores anything but block_actions", async () => {
    const { handler, queue } = harness();
    expect((await handler(signed("not json"))).statusCode).toBe(400);
    expect((await handler(signed(payload({ type: "view_submission" })))).statusCode).toBe(200);
    expect(queue).toHaveLength(0);
  });

  it("queues the requester's Approve as a yes with an event ID derived from the confirmation, and replaces the buttons", async () => {
    const { handler, queue, updates, ephemeral, pendingCounts } = harness();
    expect((await handler(signed(payload()))).statusCode).toBe(200);
    expect(queue).toEqual([{ groupId: expect.stringMatching(/^[a-f0-9]{64}$/) as string, message: {
      version: 1, eventId: confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt), thread, userId: requester, text: "yes", receivedAt: new Date(nowSeconds * 1_000).toISOString(),
    } }]);
    expect(pendingCounts).toEqual([1]);
    const note = `Approved by <@${requester}>. Running it now.`;
    expect(updates).toEqual([{ channel: thread.channelId, ts: "1695500001.000002", text: `${text}\n${note}`, blocks: answeredConfirmationBlocks(text, note) }]);
    expect(ephemeral).toEqual([]);
  });

  it("queues the requester's Cancel as a cancel", async () => {
    const { handler, queue, updates } = harness();
    await handler(signed(payload({ actionId: "agentx_confirm_cancel" })));
    expect(queue[0]?.message).toMatchObject({ eventId: confirmationClickEventId(pending.confirmationId, "cancel", pending.postedAt), text: "cancel" });
    expect(updates[0]?.text).toContain(`Cancelled by <@${requester}>.`);
  });

  it("tells anyone else, privately, that only the requester can answer, and queues nothing", async () => {
    const { handler, queue, updates, ephemeral } = harness();
    await handler(signed(payload({ user: other })));
    expect(ephemeral).toEqual([`Only <@${requester}> can answer this confirmation.`]);
    expect(queue).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("says privately that a used, replaced or expired confirmation is no longer pending", async () => {
    for (const confirmation of [{ ...pending, retiredAt: new Date().toISOString(), usedBy: "Ev1234567890" }, { ...pending, confirmationId: "55555555-5555-5555-8555-555555555555" }, { ...pending, expiresAt: new Date(nowSeconds * 1_000).toISOString() }, undefined]) {
      const { handler, queue, ephemeral } = harness({ confirmation });
      await handler(signed(payload()));
      expect(queue).toHaveLength(0);
      expect(ephemeral).toEqual(["That confirmation is no longer pending, so nothing was run."]);
    }
  });

  it("queues a repeated click once", async () => {
    const { handler, queue, updates } = harness();
    await handler(signed(payload()));
    await handler(signed(payload()));
    expect(queue).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it("undoes the click and says so when it cannot be queued", async () => {
    const { handler, ephemeral, pendingCounts, released, updates } = harness({ failEnqueue: true });
    await handler(signed(payload()));
    expect(pendingCounts).toEqual([1, -1]);
    expect(released).toEqual([confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt)]);
    expect(ephemeral).toEqual(["I couldn't take that click. Press the button again, or reply `@AgentX yes`."]);
    expect(updates).toHaveLength(0);
  });

  it("hands other buttons to the handler that matches them, with what a modal needs, and answers an unknown one privately", async () => {
    const seen: SlackBlockAction[] = [];
    const details: SlackActionHandler = { matches: (id) => id === "agentx_details", handle: async (action) => { seen.push(action); } };
    const { handler, logs, ephemeral, queue } = harness({ extra: [details] });
    await handler(signed(payload({ actionId: "agentx_details", value: "turn-1" })));
    expect(seen).toEqual([{ actionId: "agentx_details", value: "turn-1", userId: requester, thread, messageTs: "1695500001.000002", messageText: text, responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" }]);
    expect(ephemeral).toEqual([]);
    // An old button after a rollback, or one from a later release: the clicker hears it, the thread does not.
    expect((await handler(signed(payload({ actionId: "something_else" })))).statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "unknown_action" } });
    expect(ephemeral).toEqual([UNKNOWN_BUTTON_TEXT]);
    expect(queue).toHaveLength(0);
  });

  it("queues a click on a confirmation re-posted under the same ID (a redelivered request), rather than dropping it as the earlier click", async () => {
    // Task 6 derives the confirmation ID from the originating event, so a redelivered event posts the
    // same ID again with a later postedAt. The click event ID carries postedAt, so the earlier click's
    // EVENT# claim (kept 14 days), the queue's deduplication and the turn's idempotency keys never
    // swallow the new click.
    const claimed = new Set<string>();
    const queue: SlackRequestMessage[] = [];
    let current: PendingConfirmation = pending;
    const handler = createSlackInteractivityHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      now: () => nowSeconds * 1_000,
      handlers: [confirmationActionHandler({
        loadConfirmation: async () => current,
        claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
        releaseEvent: async () => undefined,
        changePending: async () => 1,
        enqueue: async (message) => { queue.push(message); },
        updateMessage: async () => undefined,
        respondEphemeral: async () => undefined,
        now: () => nowSeconds * 1_000,
      })],
    });
    await handler(signed(payload()));
    current = { ...pending, postedAt: new Date(nowSeconds * 1_000 - 30_000).toISOString() };
    await handler(signed(payload()));
    expect(queue.map((message) => message.eventId)).toEqual([
      confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt),
      confirmationClickEventId(pending.confirmationId, "approve", current.postedAt),
    ]);
    expect(new Set(queue.map((message) => message.eventId)).size).toBe(2);
  });

  it("takes the clicking member only from Slack's signed payload, and ignores a click without a Slack response URL", async () => {
    const { handler, queue, logs } = harness();
    const forged = { ...payload(), response_url: "https://attacker.example/hook" };
    expect((await handler(signed(forged))).statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "malformed_action" } });
    expect(queue).toHaveLength(0);
    // A body altered after signing (another user) fails the signature, before it is read.
    const good = signed(payload());
    const tampered = { ...good, body: good.body.replace(requester, other) };
    expect((await handler(tampered)).statusCode).toBe(401);
    expect(queue).toHaveLength(0);
  });
});
