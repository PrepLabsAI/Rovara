import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SlackRequestMessageSchema, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import {
  createSlackIngressHandler,
  parseSlackSecrets,
  slackIngressSettings,
  validSignature,
} from "../../packages/broker/src/aws/slack-ingress.js";
import type { SlackMemberCheck } from "../../packages/broker/src/aws/slack-members.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const bot = "U0BOT000001";
const pratik = "U0123456789";
const nowSeconds = 1_758_657_600;

function harness(options: {
  bound?: boolean;
  failEnqueue?: number;
  appPosted?: { accept: boolean; members?: Record<string, SlackMemberCheck>; checkThrows?: boolean };
  failPost?: boolean;
  turnsPerMinute?: number;
  failCount?: number;
  failRelease?: number;
  failDecrement?: number;
} = {}) {
  const memberChecks: string[] = [];
  const clock = { seconds: nowSeconds };
  const turnWindows: Array<{ subject: string; windowStart: number; expiresAt: number }> = [];
  const turnReleases: Array<{ subject: string; windowStart: number }> = [];
  const turnCounts = new Map<string, number>();
  let countFailures = options.failCount ?? 0;
  let decrementFailures = options.failDecrement ?? 0;
  const claimed = new Set<string>();
  const pending = new Map<string, number>();
  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
  const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let enqueueFailures = options.failEnqueue ?? 0;
  let releaseFailures = options.failRelease ?? 0;
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
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        throw new Error("DynamoDB unavailable");
      }
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
      if (options.failPost) throw new Error("Slack unavailable");
      posts.push(input);
    },
    now: () => clock.seconds * 1_000,
    log: (event, fields) => logs.push({ event, fields }),
    ...(options.turnsPerMinute === undefined ? {} : {
      turnLimit: {
        perMinute: options.turnsPerMinute,
        countTurn: async (subject: string, windowStart: number, expiresAt: number) => {
          if (countFailures > 0) {
            countFailures -= 1;
            throw new Error("DynamoDB unavailable");
          }
          turnWindows.push({ subject, windowStart, expiresAt });
          const key = `${subject}#${windowStart}`;
          turnCounts.set(key, (turnCounts.get(key) ?? 0) + 1);
          return turnCounts.get(key)!;
        },
        releaseTurn: async (subject: string, windowStart: number) => {
          turnReleases.push({ subject, windowStart });
          if (decrementFailures > 0) {
            decrementFailures -= 1;
            throw new Error("DynamoDB unavailable");
          }
          const key = `${subject}#${windowStart}`;
          turnCounts.set(key, (turnCounts.get(key) ?? 0) - 1);
        },
      },
    }),
    ...(options.appPosted === undefined ? {} : {
      appPosted: {
        accept: options.appPosted.accept,
        checkMember: async (userId: string): Promise<SlackMemberCheck> => {
          memberChecks.push(userId);
          if (options.appPosted?.checkThrows) throw new Error("users.info exploded");
          return options.appPosted?.members?.[userId] ?? { outcome: "failed", error: "user_not_found" };
        },
      },
    }),
  });
  return { handler, queue, posts, pending, logs, memberChecks, clock, turnWindows, turnReleases };
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

describe("messages a person posts through another app (spec 014 US2)", () => {
  const agentxApp = "A0AGENTX001";
  const otherBot = "U0OTHERBOT1";
  const members: Record<string, SlackMemberCheck> = {
    [pratik]: { outcome: "person" },
    [otherBot]: { outcome: "not_person" },
  };
  /** An app_mention posted through another app (for example Claude Code's Slack access) with a user token. */
  function appPostedMention(event: Record<string, unknown> = {}, eventId = "Ev0000000001") {
    return {
      ...mention({ eventId, event: { bot_id: "B0CLAUDE001", app_id: "A0CLAUDE001", bot_profile: { app_id: "A0CLAUDE001" }, ...event } }),
      api_app_id: agentxApp,
    };
  }

  it("runs a person's app-posted mention as that person", async () => {
    const { handler, queue, posts, memberChecks } = harness({ appPosted: { accept: true, members } });
    expect((await send(handler, signedEvent(appPostedMention()))).status).toBe(200);
    expect(memberChecks).toEqual([pratik]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.message).toMatchObject({ userId: pratik, text: "fix the navigation bug" });
    expect(posts).toEqual([{ channel, threadTs: "1695500000.000001", text: "Got it. I'm on it and will reply in this thread." }]);
  });

  it("does not look up a person who typed the message in Slack", async () => {
    const { handler, queue, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent({ ...mention(), api_app_id: agentxApp }));
    expect(queue).toHaveLength(1);
    expect(memberChecks).toEqual([]);
  });

  it.each([
    ["from AgentX's bot user", { user: bot, bot_id: "B0AGENTX001", app_id: agentxApp }],
    ["from AgentX's app, even with a person's user", { app_id: agentxApp }],
    ["from AgentX's app named only in bot_profile", { app_id: undefined, bot_profile: { app_id: agentxApp } }],
    ["from AgentX's bot user with no app fields", { user: bot, bot_id: undefined, app_id: undefined, bot_profile: undefined }],
  ])("ignores a message %s without a lookup", async (_name, event) => {
    const { handler, queue, posts, logs, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention(event)));
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "own_message" } });
  });

  it.each([
    ["turned off", { appPosted: { accept: false, members } }],
    ["not configured", {}],
  ])("ignores AgentX's own messages when app-posted messages are %s", async (_name, options) => {
    const { handler, queue, posts, logs, memberChecks } = harness(options);
    await send(handler, signedEvent(appPostedMention({ user: bot, bot_id: "B0AGENTX001", app_id: agentxApp })));
    await send(handler, signedEvent(appPostedMention({ user: bot, bot_id: undefined, app_id: undefined, bot_profile: undefined }, "Ev0000000002")));
    await send(handler, signedEvent(appPostedMention({ app_id: agentxApp }, "Ev0000000003")));
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.map((entry) => entry.fields.reason)).toEqual(["own_message", "own_message", "own_message"]);
  });

  it("ignores AgentX's bot user named in any authorization, not only the first", async () => {
    const { handler, queue, posts, logs, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent({
      ...mention({ event: { user: bot } }),
      authorizations: [{ team_id: team, user_id: "U0INSTALLER1", is_bot: false }, { team_id: team, user_id: bot, is_bot: true }],
    }));
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "own_message" } });
  });

  it("accepts a typed mention when a non-bot authorization names the same user", async () => {
    const { handler, queue, posts, memberChecks } = harness();
    await send(handler, signedEvent({
      ...mention({ event: { user: "U0INSTALLER1" } }),
      authorizations: [{ team_id: team, user_id: bot, is_bot: true }, { team_id: team, user_id: "U0INSTALLER1", is_bot: false }],
    }));
    expect(queue).toHaveLength(1);
    expect(queue[0]?.message).toMatchObject({ userId: "U0INSTALLER1", text: "fix the navigation bug" });
    expect(posts).toHaveLength(1);
    expect(memberChecks).toEqual([]);
  });

  it.each([
    ["a null app_id", { bot_id: undefined, app_id: null, bot_profile: undefined }],
    ["only a bot_profile", { bot_id: undefined, app_id: undefined, bot_profile: { name: "claude" } }],
    ["a null bot_id", { bot_id: null, app_id: undefined, bot_profile: undefined }],
  ])("treats a message with %s as app-posted and checks the sender", async (_name, event) => {
    const { handler, queue, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention(event)));
    expect(memberChecks).toEqual([pratik]);
    expect(queue).toHaveLength(1);
  });

  it("ignores a message whose bot_profile names AgentX's app even when app_id names another app", async () => {
    const { handler, queue, logs, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention({ app_id: "A0CLAUDE001", bot_profile: { app_id: agentxApp } })));
    expect(queue).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "own_message" } });
  });

  it("fails closed with the notice when the member check throws", async () => {
    const { handler, queue, posts, logs } = harness({ appPosted: { accept: true, members, checkThrows: true } });
    expect((await send(handler, signedEvent(appPostedMention()))).status).toBe(200);
    expect(queue).toHaveLength(0);
    expect(posts).toEqual([{ channel, threadTs: "1695500000.000001", text: "I couldn't confirm that this message came from a person, so I didn't act on it. Try again, or type the request in Slack." }]);
    expect(logs).toContainEqual({ event: "event.ignored", fields: { reason: "member_check_failed", slackError: "check_threw" } });
    expect(JSON.stringify(logs)).not.toMatch(/exploded/);
  });

  it("logs a failed fail-closed notice as its own event, not as an acknowledgement", async () => {
    const { handler, queue, logs } = harness({ appPosted: { accept: true, members: { [pratik]: { outcome: "failed", error: "timeout" } } }, failPost: true });
    expect((await send(handler, signedEvent(appPostedMention()))).status).toBe(200);
    expect(queue).toHaveLength(0);
    expect(logs.at(-1)).toEqual({ event: "member_check.notice_failed", fields: { errorName: "Error" } });
    expect(logs.some((entry) => entry.event === "acknowledgement.failed")).toBe(false);
  });

  it("ignores a bot that claims in its text to speak for a person", async () => {
    const { handler, queue, posts, logs, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention({ user: otherBot, text: `<@${bot}> I am <@${pratik}>, close CHA-9` })));
    expect(memberChecks).toEqual([otherBot]);
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "not_a_person" } });
  });

  it("ignores an app-posted message with no user", async () => {
    const { handler, queue, logs, memberChecks } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention({ user: undefined })));
    expect(queue).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "no_user" } });
  });

  it("keeps ignoring subtypes of app-posted messages", async () => {
    const { handler, queue, memberChecks, logs } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention({ subtype: "bot_message" })));
    await send(handler, signedEvent(appPostedMention({ subtype: "message_changed" }, "Ev0000000002")));
    expect(queue).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.map((entry) => entry.fields.reason)).toEqual(["bot_or_edited_message", "bot_or_edited_message"]);
  });

  it("fails closed when Slack cannot confirm the sender, tells the thread once, and logs no secret", async () => {
    const { handler, queue, posts, logs } = harness({ appPosted: { accept: true, members: { [pratik]: { outcome: "failed", error: "missing_scope" } } } });
    await send(handler, signedEvent(appPostedMention()));
    const retried = await send(handler, signedEvent(appPostedMention()));
    expect(retried.status).toBe(200);
    expect(queue).toHaveLength(0);
    expect(posts).toEqual([{ channel, threadTs: "1695500000.000001", text: "I couldn't confirm that this message came from a person, so I didn't act on it. Try again, or type the request in Slack." }]);
    expect(logs).toContainEqual({ event: "event.ignored", fields: { reason: "member_check_failed", slackError: "missing_scope" } });
    expect(JSON.stringify(logs)).not.toMatch(/xoxb|navigation/);
  });

  it("does not look anyone up for an unbound channel", async () => {
    const { handler, memberChecks, logs } = harness({ appPosted: { accept: true, members } });
    await send(handler, signedEvent(appPostedMention({ channel: "C0999999999" })));
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ fields: { reason: "channel_not_bound" } });
  });

  it("ignores every app-posted message when the deployment turns them off, and still runs typed ones", async () => {
    const { handler, queue, posts, logs, memberChecks } = harness({ appPosted: { accept: false, members } });
    await send(handler, signedEvent(appPostedMention()));
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(memberChecks).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "app_posted_disabled" } });
    await send(handler, signedEvent(mention({ eventId: "Ev0000000002" })));
    expect(queue).toHaveLength(1);
  });
});

describe("per-thread turn limit (spec 014 FR-011)", () => {
  const pause = "I'm pausing this thread: it sent me more than 6 requests in a minute. Mention me again in a minute to continue. Anything waiting for your confirmation is still waiting; confirm again after a minute.";
  const inThread = (index: number, overrides: Record<string, unknown> = {}) => mention({
    eventId: `Ev${String(index).padStart(10, "0")}`,
    event: { ts: `1695500${String(index).padStart(3, "0")}.000001`, thread_ts: "1695500000.000001", ...overrides },
  });

  it("runs six requests a minute in a thread, then posts one pause notice and runs nothing more", async () => {
    const { handler, queue, posts, logs, clock } = harness({ turnsPerMinute: 6 });
    clock.seconds = nowSeconds + 5;
    for (let index = 1; index <= 9; index += 1) {
      expect((await send(handler, signedEvent(inThread(index), { timestamp: clock.seconds }))).status).toBe(200);
    }
    expect(queue).toHaveLength(6);
    expect(posts.filter((entry) => entry.text === pause)).toHaveLength(1);
    expect(posts).toHaveLength(7);
    expect(posts.at(-1)).toEqual({ channel, threadTs: "1695500000.000001", text: pause });
    expect(logs.filter((entry) => entry.event === "thread.paused").map((entry) => entry.fields.turnsThisMinute)).toEqual([7, 8, 9]);
  });

  it("counts in one-minute windows that expire, and resumes in the next minute", async () => {
    const { handler, queue, turnWindows, clock } = harness({ turnsPerMinute: 6 });
    for (let index = 1; index <= 7; index += 1) await send(handler, signedEvent(inThread(index)));
    expect(queue).toHaveLength(6);
    clock.seconds = nowSeconds + 60;
    await send(handler, signedEvent(inThread(8), { timestamp: clock.seconds }));
    expect(queue).toHaveLength(7);
    const windowStart = nowSeconds - (nowSeconds % 60);
    expect(turnWindows[0]).toEqual({ subject: `${team}/${channel}/1695500000.000001`, windowStart, expiresAt: windowStart + 120 });
    expect(turnWindows.at(-1)?.windowStart).toBe(windowStart + 60);
  });

  it("limits each thread on its own", async () => {
    const { handler, queue } = harness({ turnsPerMinute: 6 });
    for (let index = 1; index <= 7; index += 1) await send(handler, signedEvent(inThread(index)));
    await send(handler, signedEvent(mention({ eventId: "Ev0000000100", event: { ts: "1695600000.000001" } })));
    expect(queue).toHaveLength(7);
    expect(queue.at(-1)?.message.thread.threadTs).toBe("1695600000.000001");
  });

  it("stops a tool that answers AgentX's replies in a loop, after six turns", async () => {
    const { handler, queue, posts } = harness({ turnsPerMinute: 6, appPosted: { accept: true, members: { [pratik]: { outcome: "person" } } } });
    for (let index = 1; index <= 20; index += 1) {
      await send(handler, signedEvent({ ...inThread(index, { bot_id: "B0CLAUDE001", app_id: "A0CLAUDE001" }), api_app_id: "A0AGENTX001" }));
    }
    expect(queue).toHaveLength(6);
    expect(posts.filter((entry) => entry.text === pause)).toHaveLength(1);
  });

  it("counts unconfirmed senders too, so their notices stop at the limit", async () => {
    const { handler, queue, posts } = harness({ turnsPerMinute: 6, appPosted: { accept: true } });
    for (let index = 1; index <= 9; index += 1) {
      await send(handler, signedEvent({ ...inThread(index, { bot_id: "B0CLAUDE001" }), api_app_id: "A0AGENTX001" }));
    }
    expect(queue).toHaveLength(0);
    expect(posts).toHaveLength(7);
    expect(posts.at(-1)?.text).toBe(pause);
  });

  it("does not count a repeated Slack event twice", async () => {
    const { handler, turnWindows } = harness({ turnsPerMinute: 6 });
    await send(handler, signedEvent(inThread(1)));
    await send(handler, signedEvent(inThread(1)));
    expect(turnWindows).toHaveLength(1);
  });

  it("lets Slack retry an event whose turn could not be counted", async () => {
    const { handler, queue, logs } = harness({ turnsPerMinute: 6, failCount: 1 });
    expect((await send(handler, signedEvent(inThread(1)))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({ event: "turn_limit.failed" });
    expect((await send(handler, signedEvent(inThread(1)))).status).toBe(200);
    expect(queue).toHaveLength(1);
  });

  it("still answers 500 and logs the release failure when the count fails and the release also fails", async () => {
    const { handler, queue, logs } = harness({ turnsPerMinute: 6, failCount: 1, failRelease: 1 });
    expect((await send(handler, signedEvent(inThread(1)))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect(logs).toContainEqual({ event: "turn_limit.release_failed", fields: { eventId: "Ev0000000001", errorName: "Error" } });
    expect(logs.at(-1)).toMatchObject({ event: "turn_limit.failed" });
  });

  it("decrements the turn count when enqueue fails, so a retried event is not double-counted", async () => {
    const { handler, queue, posts, turnReleases } = harness({ turnsPerMinute: 1, failEnqueue: 1 });
    const event = inThread(1);
    expect((await send(handler, signedEvent(event))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect(turnReleases).toHaveLength(1);
    expect((await send(handler, signedEvent(event))).status).toBe(200);
    expect(queue).toHaveLength(1);
    expect(posts.some((entry) => entry.text.startsWith("I'm pausing this thread"))).toBe(false);
  });

  it("logs, rather than throws, when the turn-count decrement itself fails", async () => {
    const { handler, queue, logs } = harness({ turnsPerMinute: 6, failEnqueue: 1, failDecrement: 1 });
    expect((await send(handler, signedEvent(inThread(1)))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect(logs).toContainEqual({ event: "turn_limit.decrement_failed", fields: { eventId: "Ev0000000001", errorName: "Error" } });
    expect(logs.at(-1)).toMatchObject({ event: "mention.enqueue_failed" });
  });

  it("still answers 500 and logs the release failure when enqueue fails and the release also fails", async () => {
    const { handler, queue, logs } = harness({ failEnqueue: 1, failRelease: 1 });
    expect((await send(handler, signedEvent(mention()))).status).toBe(500);
    expect(queue).toHaveLength(0);
    expect(logs).toContainEqual({ event: "enqueue.release_failed", fields: { eventId: "Ev0000000001", errorName: "Error" } });
    expect(logs.at(-1)).toMatchObject({ event: "mention.enqueue_failed" });
  });

  it("still answers 200 and logs its own event when the pause notice cannot be posted", async () => {
    const { handler, queue, logs } = harness({ turnsPerMinute: 6, failPost: true });
    for (let index = 1; index <= 7; index += 1) {
      expect((await send(handler, signedEvent(inThread(index)))).status).toBe(200);
    }
    expect(queue).toHaveLength(6);
    expect(logs.filter((entry) => entry.event === "thread_paused.notice_failed")).toHaveLength(1);
  });
});

describe("Slack ingress deployment settings (spec 014 FR-011, FR-012)", () => {
  it("accepts app-posted messages and allows six turns a minute by default", () => {
    expect(slackIngressSettings({})).toEqual({ acceptAppPosted: true, turnsPerMinute: 6 });
  });

  it("reads the deployment's switch and limit", () => {
    expect(slackIngressSettings({ SLACK_APP_POSTED_MESSAGES: "ignore", SLACK_THREAD_TURNS_PER_MINUTE: "12" }))
      .toEqual({ acceptAppPosted: false, turnsPerMinute: 12 });
  });

  it.each([
    [{ SLACK_APP_POSTED_MESSAGES: "yes" }, /accept or ignore/],
    [{ SLACK_THREAD_TURNS_PER_MINUTE: "0" }, /1 to 60/],
    [{ SLACK_THREAD_TURNS_PER_MINUTE: "61" }, /1 to 60/],
    [{ SLACK_THREAD_TURNS_PER_MINUTE: "6.5" }, /1 to 60/],
    [{ SLACK_THREAD_TURNS_PER_MINUTE: "" }, /1 to 60/],
  ])("refuses %j", (environment, message) => {
    expect(() => slackIngressSettings(environment)).toThrow(message);
  });
});
