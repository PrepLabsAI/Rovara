import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SlackRequestMessageSchema, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import {
  createSlackIngressHandler,
  parseSlackSecrets,
  validSignature,
} from "../../packages/broker/src/aws/slack-ingress.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const bot = "U0BOT000001";
const pratik = "U0123456789";
const nowSeconds = 1_758_657_600;

function harness(options: { bound?: boolean; failEnqueue?: number } = {}) {
  const claimed = new Set<string>();
  const pending = new Map<string, number>();
  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
  const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let enqueueFailures = options.failEnqueue ?? 0;
  const handler = createSlackIngressHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    getBinding: async (teamId, channelId) =>
      options.bound === false || channelId !== channel
        ? undefined
        : { teamId, channelId, projectName: "payments", updatedAt: "2026-09-23T21:00:00.000Z" },
    claimEvent: async (eventId) => {
      if (claimed.has(eventId)) return false;
      claimed.add(eventId);
      return true;
    },
    releaseEvent: async (eventId) => {
      claimed.delete(eventId);
    },
    changePending: async (subject, delta) => {
      const next = (pending.get(subject) ?? 0) + delta;
      pending.set(subject, next);
      return next;
    },
    enqueue: async (message, groupId) => {
      if (enqueueFailures > 0) {
        enqueueFailures -= 1;
        throw new Error("SQS unavailable");
      }
      queue.push({ message, groupId });
    },
    postMessage: async (input: { channel: string; threadTs: string; text: string }) => {
      posts.push(input);
    },
    now: () => nowSeconds * 1_000,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { handler, queue, posts, pending, logs };
}

function signedEvent(payload: unknown, options: { timestamp?: number; signature?: string; base64?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(options.timestamp ?? nowSeconds);
  const signature = options.signature ?? `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    version: "2.0",
    rawPath: "/v1/slack/events",
    headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature },
    body: options.base64 ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: options.base64 ?? false,
    requestContext: { requestId: "request", http: { method: "POST" } },
  };
}

function mention(overrides: { event?: Record<string, unknown>; eventId?: string; teamId?: string } = {}) {
  return {
    type: "event_callback",
    team_id: overrides.teamId ?? team,
    event_id: overrides.eventId ?? "Ev0000000001",
    authorizations: [{ team_id: team, user_id: bot, is_bot: true }],
    event: {
      type: "app_mention",
      user: pratik,
      team,
      channel,
      ts: "1695500000.000001",
      text: `<@${bot}> fix the navigation bug`,
      ...overrides.event,
    },
  };
}

async function send(handler: ReturnType<typeof harness>["handler"], event: ReturnType<typeof signedEvent>) {
  const response = await handler(event);
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe("Slack request signatures", () => {
  it("accepts only fresh, correctly signed requests", () => {
    const body = "{}";
    const good = `v0=${createHmac("sha256", signingSecret).update(`v0:${nowSeconds}:${body}`).digest("hex")}`;
    expect(validSignature(signingSecret, String(nowSeconds), good, body, nowSeconds * 1_000)).toBe(true);
    expect(validSignature(signingSecret, String(nowSeconds), good, "{ }", nowSeconds * 1_000)).toBe(false);
    expect(validSignature("other-secret-value-123", String(nowSeconds), good, body, nowSeconds * 1_000)).toBe(false);
    expect(validSignature(signingSecret, String(nowSeconds), good, body, (nowSeconds + 301) * 1_000)).toBe(false);
    expect(validSignature(signingSecret, undefined, good, body, nowSeconds * 1_000)).toBe(false);
    expect(validSignature(signingSecret, "12x", good, body, nowSeconds * 1_000)).toBe(false);
  });

  it("rejects unsigned and stale requests before reading the payload", async () => {
    const { handler, queue } = harness();
    expect((await send(handler, signedEvent(mention(), { signature: "v0=deadbeef" }))).status).toBe(401);
    expect((await send(handler, signedEvent(mention(), { timestamp: nowSeconds - 600 }))).status).toBe(401);
    expect(queue).toHaveLength(0);
  });

  it("answers Slack's URL verification challenge", async () => {
    const { handler } = harness();
    const response = await send(handler, signedEvent({ type: "url_verification", challenge: "challenge-value" }));
    expect(response).toEqual({ status: 200, body: { challenge: "challenge-value" } });
  });

  it("validates the stored secret shape", () => {
    expect(parseSlackSecrets(JSON.stringify({ signingSecret, botToken: "xoxb-1" }))).toEqual({ signingSecret, botToken: "xoxb-1" });
    expect(() => parseSlackSecrets(JSON.stringify({ signingSecret, botToken: "xapp-1" }))).toThrow(/xoxb-/);
    expect(() => parseSlackSecrets(JSON.stringify({ signingSecret: "short", botToken: "xoxb-1" }))).toThrow(/signingSecret/);
  });
});

describe("Slack mention ingress", () => {
  it("queues a new thread's mention in its thread lane and acknowledges it", async () => {
    const { handler, queue, posts } = harness();
    const response = await send(handler, signedEvent(mention(), { base64: true }));
    expect(response.status).toBe(200);
    expect(queue).toHaveLength(1);
    const subject = `${team}/${channel}/1695500000.000001`;
    expect(queue[0]?.groupId).toBe(createHash("sha256").update(subject).digest("hex"));
    expect(SlackRequestMessageSchema.parse(queue[0]?.message)).toMatchObject({
      eventId: "Ev0000000001",
      thread: { teamId: team, channelId: channel, threadTs: "1695500000.000001" },
      userId: pratik,
      text: "fix the navigation bug",
    });
    expect(posts).toEqual([{ channel, threadTs: "1695500000.000001", text: "Got it. I'm on it and will reply in this thread." }]);
  });

  it("uses the thread root for replies and reports requests queued ahead in the same thread", async () => {
    const { handler, queue, posts } = harness();
    await send(handler, signedEvent(mention()));
    await send(handler, signedEvent(mention({
      eventId: "Ev0000000002",
      event: { user: "U0456789012", ts: "1695500100.000002", thread_ts: "1695500000.000001", text: `<@${bot}> also add tests` },
    })));
    expect(queue.map((entry) => entry.groupId)).toEqual([queue[0]?.groupId, queue[0]?.groupId]);
    expect(queue[1]?.message.thread.threadTs).toBe("1695500000.000001");
    expect(posts[1]).toEqual({
      channel,
      threadTs: "1695500000.000001",
      text: "Got it. This is queued behind 1 earlier request in this thread.",
    });
  });

  it("processes a repeated Slack event only once", async () => {
    const { handler, queue, posts, logs } = harness();
    await send(handler, signedEvent(mention()));
    const retried = await send(handler, signedEvent(mention()));
    expect(retried.status).toBe(200);
    expect(queue).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(logs.some((entry) => entry.fields.reason === "duplicate_event")).toBe(true);
  });

  it.each([
    ["a bot message", { event: { bot_id: "B0123" } }, "bot_or_edited_message"],
    ["an edited message", { event: { subtype: "message_changed" } }, "bot_or_edited_message"],
    ["a direct message", { event: { channel: "D0123456789" } }, "not_a_channel"],
    ["a user from another organization", { event: { user_team: "T0OTHERORG" } }, "external_organization_user"],
    ["a non-mention event", { event: { type: "message" } }, "not_app_mention"],
    ["an unbound channel", { event: { channel: "C0999999999" } }, "channel_not_bound"],
  ])("ignores %s without queueing work", async (_name, overrides, reason) => {
    const { handler, queue, posts, logs } = harness();
    const response = await send(handler, signedEvent(mention(overrides)));
    expect(response.status).toBe(200);
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason } });
  });

  it("asks for a request when the mention has no text", async () => {
    const { handler, queue, posts } = harness();
    await send(handler, signedEvent(mention({ event: { text: `<@${bot}>   ` } })));
    expect(queue).toHaveLength(0);
    expect(posts[0]?.text).toBe("Please include a request after mentioning AgentX.");
  });

  it("lets Slack retry an event whose enqueue failed", async () => {
    const { handler, queue, pending } = harness({ failEnqueue: 1 });
    expect((await send(handler, signedEvent(mention()))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect([...pending.values()]).toEqual([0]);
    expect((await send(handler, signedEvent(mention()))).status).toBe(200);
    expect(queue).toHaveLength(1);
  });

  it("never logs the request text", async () => {
    const { handler, logs } = harness();
    await send(handler, signedEvent(mention()));
    expect(JSON.stringify(logs)).not.toContain("navigation");
  });
});
