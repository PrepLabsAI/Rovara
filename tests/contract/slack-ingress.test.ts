import { createHash, createHmac } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { CLOSED_SHARED_NOTICE, SlackRequestMessageSchema, VIEW_ONLY_NOTICE, sharedNoticeClaim, sharedNoticeKey, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import {
  createSlackIngressHandler,
  parseSlackSecrets,
  recordThreadNoteThroughBroker,
  stopTaskThroughBroker,
  SLACK_TASK_THREADS_OFF_NOTICE,
  SlackWorkflowStartError,
  slackIngressSettings,
  validSignature,
} from "../../packages/broker/src/aws/slack-ingress.js";
import type { SlackMemberCheck } from "../../packages/broker/src/aws/slack-members.js";
import { WORKFLOW_CHOICE_WAITING_NOTICE, WorkflowChoiceWaitingError, workflowChoiceRefusal, workflowStartedNotice, workflowStartFailureNotice, type WorkflowChoiceOutcome } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { chatPostEphemeral } from "../../packages/broker/src/aws/slack-web.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

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
  stop?: { outcome?: "CANCEL_REQUESTED" | "NOTHING_RUNNING" | "NOT_OWNER"; throws?: boolean };
  workflowStart?: { throws?: boolean; errorCode?: string };
  workflowChoice?: { throws?: boolean; waiting?: boolean };
  workflowSelection?: { outcome?: WorkflowChoiceOutcome; throws?: boolean; errorCode?: string };
  /** threadTs to the requester of the Quick or Full choice waiting there. */
  pendingChoice?: Record<string, string>;
  shared?: { threads: Record<string, { mode: "view" | "continue"; closed?: boolean; taskId?: string; workflowThread?: true }>; lookupThrows?: boolean; claimThrows?: boolean };
  threadNote?: { outcome?: "captured" | "duplicate" | "refused"; throws?: boolean };
} = {}) {
  const stopCalls: Array<{ thread: unknown; userId: string }> = [];
  const workflowStarts: Array<{ thread: unknown; userId: string; instructions: string; requestId: string }> = [];
  const workflowChoices: Array<{ thread: unknown; userId: string; instructions: string; requestId: string }> = [];
  const workflowSelections: Array<{ thread: unknown; userId: string; workflowPath: "QUICK" | "FULL" }> = [];
  const pendingLookups: string[] = [];
  const threadNotes: Array<{ taskId: string; thread: unknown; userId: string; messageTs: string; eventId: string; text: string }> = [];
  const ephemerals: Array<{ channel: string; threadTs: string; user: string; text: string }> = [];
  const memberChecks: string[] = [];
  const clock = { seconds: nowSeconds };
  const turnWindows: Array<{ subject: string; windowStart: number; expiresAt: number }> = [];
  const turnReleases: Array<{ subject: string; windowStart: number }> = [];
  const turnCounts = new Map<string, number>();
  // The hourly claim is the one the AWS wiring sends (F13), evaluated by the fake table.
  const threadsTable = new FakeDynamoDb();
  const strict = new StrictSlackWeb();
  const noticedAt = (subject: string) => sharedNoticeKeyItem(threadsTable, subject)?.noticedAt;
  let countFailures = options.failCount ?? 0;
  let decrementFailures = options.failDecrement ?? 0;
  const claimed = new Set<string>();
  const pending = new Map<string, number>();
  const queue: Array<{ message: SlackRequestMessage; groupId: string; queuedBehind?: number }> = [];
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
    enqueue: async (message, groupId, queuedBehind) => {
      if (enqueueFailures > 0) {
        enqueueFailures -= 1;
        throw new Error("SQS unavailable");
      }
      queue.push({ message, groupId, queuedBehind });
    },
    postMessage: async (input: { channel: string; threadTs: string; text: string }) => {
      if (options.failPost) throw new Error("Slack unavailable");
      await strict.postMessage(input);
      posts.push(input);
    },
    postEphemeral: async (input: { channel: string; threadTs: string; user: string; text: string }) => {
      if (options.failPost) throw new Error("Slack unavailable");
      strict.postEphemeral(input);
      ephemerals.push(input);
    },
    ...(options.shared === undefined ? {} : {
      sharedTask: {
        lookup: async (thread: { threadTs: string }) => {
          if (options.shared?.lookupThrows) throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" });
          const found = options.shared?.threads[thread.threadTs];
          return found === undefined ? undefined : { mode: found.mode, closed: found.closed ?? false, ...(found.taskId === undefined ? {} : { taskId: found.taskId }),
            ...(found.workflowThread === true ? { workflowThread: true as const } : {}) };
        },
        claimNotice: async (subject: string, now: number, kind: "view" | "closed") => {
          if (options.shared?.claimThrows) throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" });
          try {
            await threadsTable.send(new UpdateCommand({ TableName: "threads", ...sharedNoticeClaim(subject, now, kind) }));
            return true;
          } catch (error) {
            if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
            throw error;
          }
        },
      },
    }),
    now: () => clock.seconds * 1_000,
    log: (event, fields) => logs.push({ event, fields }),
    ...(options.stop === undefined ? {} : {
      stopTask: async (thread: unknown, userId: string) => {
        stopCalls.push({ thread, userId });
        if (options.stop?.throws) throw new Error("broker unavailable");
        return options.stop?.outcome ?? "CANCEL_REQUESTED";
      },
    }),
    ...(options.workflowStart === undefined ? {} : {
      startWorkflow: async (input: { thread: unknown; userId: string; instructions: string; requestId: string }) => {
        workflowStarts.push(input);
        if (options.workflowStart?.throws) throw new SlackWorkflowStartError(options.workflowStart.errorCode ?? "UNKNOWN");
      },
    }),
    ...(options.workflowChoice === undefined ? {} : {
      requestWorkflowChoice: async (input: { thread: unknown; userId: string; instructions: string; requestId: string }) => {
        workflowChoices.push(input);
        if (options.workflowChoice?.waiting) throw new WorkflowChoiceWaitingError();
        if (options.workflowChoice?.throws) throw new Error("Slack unavailable");
      },
    }),
    ...(options.workflowSelection === undefined ? {} : {
      chooseWorkflowPath: async (input: { thread: unknown; userId: string; workflowPath: "QUICK" | "FULL" }) => {
        workflowSelections.push(input);
        if (options.workflowSelection?.throws) throw new SlackWorkflowStartError(options.workflowSelection.errorCode ?? "UNKNOWN");
        return options.workflowSelection?.outcome ?? "started";
      },
    }),
    ...(options.pendingChoice === undefined ? {} : {
      pendingWorkflowChoice: async (thread: { threadTs: string }) => {
        pendingLookups.push(thread.threadTs);
        const userId = options.pendingChoice?.[thread.threadTs];
        return userId === undefined ? undefined : { choiceId: "11111111-1111-4111-8111-111111111111", userId };
      },
    }),
    ...(options.threadNote === undefined ? {} : {
      recordThreadNote: async (input: { taskId: string; thread: unknown; userId: string; messageTs: string; eventId: string; text: string }) => {
        threadNotes.push(input);
        if (options.threadNote?.throws) throw new Error("private note body must not appear in this error");
        return { outcome: options.threadNote?.outcome ?? "captured" };
      },
    }),
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
  return { handler, queue, posts, pending, logs, memberChecks, clock, turnWindows, turnReleases, stopCalls, workflowStarts, workflowChoices, workflowSelections, pendingLookups, threadNotes, ephemerals, noticedAt,
    claimedEvents: () => [...claimed] };
}

function sharedNoticeKeyItem(table: FakeDynamoDb, subject: string): { noticedAt?: unknown } | undefined {
  const key = sharedNoticeKey(subject);
  return table.get(key.pk, key.sk);
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

  it("records every reply in a workflow task thread, mention or not, and never asks Slack to retry a refusal", async () => {
    const workflowThread = { "1695500000.000001": { mode: "view" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true as const } };
    const h = harness({ shared: { threads: workflowThread }, threadNote: { outcome: "captured" } });
    const reply = (eventId: string, event: Record<string, unknown>) => signedEvent(mention({ eventId, event: { thread_ts: "1695500000.000001", ...event } }));
    expect((await send(h.handler, reply("EvNote01", { ts: "1695500002.000007", text: `<@${bot}> Please keep the old flag.` }))).status).toBe(200);
    expect((await send(h.handler, reply("EvNote02", { type: "message", channel_type: "channel", ts: "1695500002.000007", text: `<@${bot}> Please keep the old flag.` }))).status).toBe(200);
    expect((await send(h.handler, reply("EvNote03", { type: "message", channel_type: "channel", user: "U0TEAMMATE1", ts: "1695500003.000001", text: "Also check the mobile layout" }))).status).toBe(200);
    expect(h.threadNotes.map((note) => [note.userId, note.messageTs, note.text])).toEqual([
      [pratik, "1695500002.000007", "Please keep the old flag."],
      [pratik, "1695500002.000007", "Please keep the old flag."],
      ["U0TEAMMATE1", "1695500003.000001", "Also check the mobile layout"],
    ]);
    expect(h.queue).toHaveLength(0);
    expect(h.posts.map((post) => post.text)).not.toContain(VIEW_ONLY_NOTICE);
    expect(JSON.stringify(h.logs)).not.toContain("old flag");
    const refused = harness({ shared: { threads: workflowThread }, threadNote: { outcome: "refused" } });
    expect((await send(refused.handler, reply("EvNote04", { ts: "1695500004.000001", text: "late note" }))).status).toBe(200);
    const down = harness({ shared: { threads: workflowThread }, threadNote: { throws: true } });
    expect((await send(down.handler, reply("EvNote05", { ts: "1695500005.000001", text: "note" }))).status).toBe(500);
  });

  it("ignores channel messages outside workflow threads without claiming them", async () => {
    const h = harness({ shared: { threads: {} }, threadNote: {} });
    await send(h.handler, signedEvent(mention({ eventId: "EvPlain1", event: { type: "message", thread_ts: "1695500009.000001", ts: "1695500009.000002", text: "unrelated chat" } })));
    await send(h.handler, signedEvent(mention({ eventId: "EvPlain2", event: { type: "message", ts: "1695500010.000001", text: "top level chat" } })));
    await send(h.handler, signedEvent(mention({ eventId: "EvPlain3", event: { type: "message", subtype: "message_changed", thread_ts: "1695500000.000001", ts: "1695500011.000001", text: "edit" } })));
    expect(h.threadNotes).toEqual([]); expect(h.queue).toEqual([]); expect(h.posts).toEqual([]); expect(h.claimedEvents()).toEqual([]);
  });

  it("acknowledges a saved mention privately, stays silent for a plain reply, and releases the claim when saving fails", async () => {
    const threads = { "1695500000.000001": { mode: "view" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true as const } };
    const h = harness({ shared: { threads }, threadNote: { outcome: "captured" } });
    await send(h.handler, signedEvent(mention({ eventId: "EvAck01", event: { thread_ts: "1695500000.000001", ts: "1695500006.000001", text: `<@${bot}> Keep the copy short.` } })));
    await send(h.handler, signedEvent(mention({ eventId: "EvAck02", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500006.000002", text: "Agreed" } })));
    expect(h.ephemerals).toEqual([{ channel, threadTs: "1695500000.000001", user: pratik, text: "Saved. I'll include this at the next step." }]);
    expect(h.posts).toEqual([]);
    // A plain reply in a workflow thread is claimed, so Slack's retry of it is not saved twice.
    expect(h.claimedEvents()).toEqual(["EvAck01", "EvAck02"]);
    // The broker cannot be reached: the claim is released, so Slack's retry is handled as new.
    const down = harness({ shared: { threads }, threadNote: { throws: true } });
    const event = signedEvent(mention({ eventId: "EvAck03", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500006.000003", text: "Retry me" } }));
    expect((await send(down.handler, event)).status).toBe(500);
    expect(down.claimedEvents()).toEqual([]);
    expect(JSON.stringify(down.logs)).not.toContain("Retry me");
    // An empty mention and a bare plain reply save nothing.
    const quiet = harness({ shared: { threads }, threadNote: {} });
    await send(quiet.handler, signedEvent(mention({ eventId: "EvAck04", event: { thread_ts: "1695500000.000001", ts: "1695500006.000004", text: `<@${bot}>   ` } })));
    await send(quiet.handler, signedEvent(mention({ eventId: "EvAck05", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500006.000005", text: "   " } })));
    expect(quiet.threadNotes).toEqual([]);
    expect(quiet.posts).toEqual([]);
  });

  it("does not save the plain-message copy of an @AgentX stop as a note", async () => {
    const threads = { "1695500000.000001": { mode: "view" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true as const } };
    const h = harness({ shared: { threads }, threadNote: {}, stop: { outcome: "CANCEL_REQUESTED" } });
    await send(h.handler, signedEvent(mention({ eventId: "EvStopCopy1", event: { thread_ts: "1695500000.000001", ts: "1695500007.000001", text: `<@${bot}> stop` } })));
    await send(h.handler, signedEvent(mention({ eventId: "EvStopCopy2", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500007.000001", text: `<@${bot}> stop` } })));
    expect(h.stopCalls).toHaveLength(1);
    expect(h.threadNotes).toEqual([]);
  });

  it("ignores a reply in a workflow thread when the ingress cannot look up task threads", async () => {
    const h = harness({ threadNote: {} });
    await send(h.handler, signedEvent(mention({ eventId: "EvNoShared1", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500008.000001", text: "a reply" } })));
    expect(h.threadNotes).toEqual([]);
    expect(h.claimedEvents()).toEqual([]);
    expect(h.logs.at(-1)).toMatchObject({ event: "event.ignored", fields: { reason: "not_task_thread" } });
  });

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

  it("tells the Slack service how many earlier requests each one was queued behind (spec 014 FR-026)", async () => {
    const { handler, queue } = harness();
    await send(handler, signedEvent(mention()));
    await send(handler, signedEvent(mention({
      eventId: "Ev0000000002",
      event: { user: "U0456789012", ts: "1695500100.000002", thread_ts: "1695500000.000001", text: `<@${bot}> also add tests` },
    })));
    expect(queue.map((entry) => entry.queuedBehind)).toEqual([0, 1]);
  });

  it("does not say Got it for a message that is only a confirmation answer, and still queues it", async () => {
    for (const [index, text] of ["yes", "Yes, to all in this thread.", "cancel", "ok", "sure", "nope"].entries()) {
      const { handler, queue, posts, logs } = harness();
      const response = await send(handler, signedEvent(mention({ eventId: `Ev00000001${index}`, event: { text: `<@${bot}> ${text}` } })));
      expect(response.status, text).toBe(200);
      expect(queue.map((entry) => [entry.message.text, entry.queuedBehind]), text).toEqual([[text, 0]]);
      expect(posts, text).toEqual([]);
      expect(logs.at(-1), text).toMatchObject({ event: "mention.accepted", fields: { eventId: `Ev00000001${index}`, pendingInThread: 1 } });
    }
  });

  it("says Got it for a confirmation word followed by a request", async () => {
    const { handler, queue, posts } = harness();
    await send(handler, signedEvent(mention({ event: { text: `<@${bot}> yes please close CHA-1` } })));
    expect(queue).toHaveLength(1);
    expect(posts).toEqual([{ channel, threadTs: "1695500000.000001", text: "Got it. I'm on it and will reply in this thread." }]);
  });

  it("still says how many requests a confirmation answer is queued behind", async () => {
    const { handler, queue, posts } = harness();
    await send(handler, signedEvent(mention()));
    await send(handler, signedEvent(mention({ eventId: "Ev0000000002", event: { ts: "1695500100.000002", thread_ts: "1695500000.000001", text: `<@${bot}> yes` } })));
    expect(queue.map((entry) => entry.queuedBehind)).toEqual([0, 1]);
    expect(posts.map((entry) => entry.text)).toEqual(["Got it. I'm on it and will reply in this thread.", "Got it. This is queued behind 1 earlier request in this thread."]);
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

describe("the stop command (#126)", () => {
  const stopMention = (text: string, eventId = "EvStop00001") => signedEvent(mention({ eventId, event: { text: `<@${bot}> ${text}` } }));

  it("stops the thread's running task before the queue, and says so in the thread", async () => {
    const { handler, queue, posts, stopCalls, pending } = harness({ stop: { outcome: "CANCEL_REQUESTED" } });
    expect((await send(handler, stopMention("stop"))).status).toBe(200);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.userId).toBe(pratik);
    expect(stopCalls[0]?.thread).toMatchObject({ teamId: team, channelId: channel });
    expect(queue).toEqual([]);
    expect([...pending.values()]).toEqual([]);
    expect(posts.map((post) => post.text)).toEqual(["Stopping the running task. I'll reply here once it has stopped."]);
  });

  it("passes the message to the orchestrator when nothing is running", async () => {
    const { handler, queue, posts, stopCalls } = harness({ stop: { outcome: "NOTHING_RUNNING" } });
    await send(handler, stopMention("cancel it"));
    expect(stopCalls).toHaveLength(1);
    expect(queue.map((entry) => entry.message.text)).toEqual(["cancel it"]);
    expect(posts.map((post) => post.text)).not.toContain("Stopping the running task. I'll reply here once it has stopped.");
  });

  it("treats only a whole-message stop as the command", async () => {
    const { handler, queue, stopCalls } = harness({ stop: {} });
    await send(handler, stopMention("stop using tabs in index.html", "EvStop00002"));
    expect(stopCalls).toEqual([]);
    expect(queue.map((entry) => entry.message.text)).toEqual(["stop using tabs in index.html"]);
  });

  it("tells the thread when the stop could not be requested, and does not queue it", async () => {
    const { handler, queue, posts, logs } = harness({ stop: { throws: true } });
    expect((await send(handler, stopMention("please stop the task"))).status).toBe(200);
    expect(queue).toEqual([]);
    expect(posts.map((post) => post.text)).toEqual(["I couldn't stop the running task. Try again in a moment."]);
    expect(logs.map((entry) => entry.event)).toContain("stop.failed");
  });

  it("leaves stop as an ordinary request when the ingress has no stop wiring", async () => {
    const { handler, queue } = harness();
    await send(handler, stopMention("stop"));
    expect(queue.map((entry) => entry.message.text)).toEqual(["stop"]);
  });

});

describe("starting a task from a Slack mention (gap 3)", () => {
  const starting = { shared: { threads: {} }, workflowStart: {}, workflowChoice: {}, workflowSelection: {} };
  /** The choice thread below has a Quick or Full question waiting for pratik. */
  const waitingForPratik = { pendingChoice: { "1695500000.000100": pratik } };
  const topThread = { teamId: team, channelId: channel, threadTs: "1695500000.000001" };
  const choiceThread = { teamId: team, channelId: channel, threadTs: "1695500000.000100" };
  const threadReply = (eventId: string, text: string, event: Record<string, unknown> = {}) =>
    signedEvent(mention({ eventId, event: { ts: "1695500000.000200", thread_ts: "1695500000.000100", text, ...event } }));

  it("asks Quick or Full for a plain mention, and queues nothing for the chat agent", async () => {
    const { handler, queue, posts, workflowStarts, workflowChoices } = harness(starting);
    await send(handler, signedEvent(mention({ eventId: "EvPlainStart1", event: { text: `<@${bot}> Add password reset` } })));
    expect(workflowChoices).toEqual([{ thread: topThread, userId: pratik, instructions: "Add password reset", requestId: "EvPlainStart1" }]);
    expect(workflowStarts).toEqual([]);
    expect(queue).toEqual([]);
    // The question itself is posted by the choice wiring, with its buttons.
    expect(posts).toEqual([]);
  });

  it("keeps the chat agent reachable with chat:, in an existing chat thread, and for a stop with nothing running", async () => {
    const { handler, queue, workflowChoices, workflowStarts } = harness({ ...starting, stop: { outcome: "NOTHING_RUNNING" } });
    await send(handler, signedEvent(mention({ eventId: "EvChat1", event: { text: `<@${bot}> chat: what does retry.ts do?` } })));
    await send(handler, threadReply("EvChat2", `<@${bot}> also bump the version`));
    await send(handler, signedEvent(mention({ eventId: "EvChat3", event: { ts: "1695500000.000300", text: `<@${bot}> stop` } })));
    expect(queue.map((entry) => entry.message.text)).toEqual(["what does retry.ts do?", "also bump the version", "stop"]);
    expect(workflowChoices).toEqual([]);
    expect(workflowStarts).toEqual([]);
  });

  it("keeps plain mentions on the chat agent when this ingress cannot start tasks", async () => {
    const { handler, queue } = harness({ shared: { threads: {} } });
    await send(handler, signedEvent(mention({ eventId: "EvNoBroker1", event: { text: `<@${bot}> Add password reset` } })));
    expect(queue.map((entry) => entry.message.text)).toEqual(["Add password reset"]);
  });

  it("starts a task on the path a prefix names, in any thread, and confirms it in one line", async () => {
    const { handler, queue, posts, workflowStarts, workflowChoices } = harness(starting);
    await send(handler, signedEvent(mention({ eventId: "EvQuick1", event: { text: `<@${bot}> quick: fix the typo` } })));
    await send(handler, signedEvent(mention({ eventId: "EvFull1", event: { ts: "1695500000.000300", text: `<@${bot}> workflow full: Add SSO` } })));
    await send(handler, threadReply("EvFull2", `<@${bot}> full: Add SSO here`));
    expect(workflowStarts).toEqual([
      { thread: topThread, userId: pratik, instructions: "fix the typo", workflowPath: "QUICK", requestId: "EvQuick1" },
      { thread: { ...topThread, threadTs: "1695500000.000300" }, userId: pratik, instructions: "Add SSO", workflowPath: "FULL", requestId: "EvFull1" },
      { thread: choiceThread, userId: pratik, instructions: "Add SSO here", workflowPath: "FULL", requestId: "EvFull2" },
    ]);
    expect(posts.map((post) => post.text)).toEqual([workflowStartedNotice("QUICK"), workflowStartedNotice("FULL"), workflowStartedNotice("FULL")]);
    expect(workflowChoices).toEqual([]);
    expect(queue).toEqual([]);
  });

  it("accepts a loose answer by mention, and confirms the start", async () => {
    const { handler, queue, posts, workflowSelections } = harness({ ...starting, ...waitingForPratik });
    await send(handler, threadReply("EvPick1", `<@${bot}> quick please`));
    expect(workflowSelections).toEqual([{ thread: choiceThread, userId: pratik, workflowPath: "QUICK" }]);
    expect(posts.map((post) => post.text)).toEqual([workflowStartedNotice("QUICK")]);
    expect(queue).toEqual([]);
  });

  it("answers privately when an answer starts nothing", async () => {
    for (const outcome of ["not_requester", "other_path", "starting", "none"] as const) {
      const h = harness({ ...starting, ...waitingForPratik, workflowSelection: { outcome } });
      await send(h.handler, threadReply(`EvPick-${outcome}`, `<@${bot}> Full`));
      expect(h.ephemerals.map((entry) => [entry.user, entry.text])).toEqual([[pratik, workflowChoiceRefusal(outcome)]]);
      expect(h.posts).toEqual([]);
      expect(h.queue).toEqual([]);
    }
    expect(workflowChoiceRefusal("not_requester")).toBe("Only the person who asked can choose.");
  });

  it("leaves a path-like reply in a thread with no question waiting to the chat agent", async () => {
    const { handler, queue, posts, workflowSelections } = harness({ ...starting, pendingChoice: {} });
    await send(handler, threadReply("EvChatPath1", `<@${bot}> full please`));
    await send(handler, threadReply("EvChatPath2", `<@${bot}> let's do full`));
    expect(workflowSelections).toEqual([]);
    expect(queue.map((entry) => entry.message.text)).toEqual(["full please", "let's do full"]);
    expect(posts.map((post) => post.text)).not.toContain(SLACK_TASK_THREADS_OFF_NOTICE);
  });

  it("asks for the request when a mention names only a path", async () => {
    const { handler, posts, workflowChoices, workflowStarts, queue } = harness(starting);
    await send(handler, signedEvent(mention({ eventId: "EvPathOnly1", event: { text: `<@${bot}> quick` } })));
    await send(handler, signedEvent(mention({ eventId: "EvPathOnly2", event: { ts: "1695500000.000300", text: `<@${bot}> Full please` } })));
    expect(workflowChoices).toEqual([]);
    expect(workflowStarts).toEqual([]);
    expect(queue).toEqual([]);
    expect(posts.map((post) => post.text)).toEqual(Array.from({ length: 2 }, () => "Add your request after it, for example `quick: fix the login typo`."));
  });

  it("says a question is already waiting when a new request is made in its thread", async () => {
    const { handler, posts } = harness({ ...starting, workflowChoice: { waiting: true } });
    await send(handler, threadReply("EvSecondRequest1", `<@${bot}> workflow: add SSO too`));
    expect(posts.map((post) => post.text)).toEqual([WORKFLOW_CHOICE_WAITING_NOTICE]);
  });

  it("accepts a plain reply in a thread waiting for the requester's choice, and claims no other channel message", async () => {
    const plain = (eventId: string, text: string, user = pratik) => threadReply(eventId, text, { type: "message", user });
    const waiting = harness({ ...starting, pendingChoice: { "1695500000.000100": pratik } });
    await send(waiting.handler, plain("EvPlainPick1", "full"));
    expect(waiting.workflowSelections).toEqual([{ thread: choiceThread, userId: pratik, workflowPath: "FULL" }]);
    expect(waiting.claimedEvents()).toEqual(["EvPlainPick1"]);
    expect(waiting.posts.map((post) => post.text)).toEqual([workflowStartedNotice("FULL")]);
    // Another member's answer, any other text, and the plain copy of an @AgentX answer are left alone, unclaimed.
    await send(waiting.handler, plain("EvPlainPick2", "quick", "U0TEAMMATE1"));
    await send(waiting.handler, plain("EvPlainPick3", "sounds good"));
    await send(waiting.handler, plain("EvPlainPick4", `<@${bot}> quick`));
    expect(waiting.workflowSelections).toHaveLength(1);
    expect(waiting.claimedEvents()).toEqual(["EvPlainPick1"]);
    expect(waiting.pendingLookups).toEqual(["1695500000.000100", "1695500000.000100"]);
    // With no choice waiting in the thread, the answer is ignored and not claimed.
    const nothing = harness({ ...starting, pendingChoice: {} });
    await send(nothing.handler, plain("EvPlainPick5", "full"));
    expect(nothing.workflowSelections).toEqual([]);
    expect(nothing.claimedEvents()).toEqual([]);
    expect(nothing.queue).toEqual([]);
  });

  it("explains a start failure in plain words with a reference", async () => {
    const failing = harness({ ...starting, workflowStart: { throws: true, errorCode: "UNKNOWN" } });
    await send(failing.handler, signedEvent(mention({ eventId: "EvStartFail1", event: { text: `<@${bot}> quick: Add password reset` } })));
    expect(failing.posts.at(-1)?.text).toBe(workflowStartFailureNotice("UNKNOWN", "EvStartFail1"));
    expect(failing.posts.at(-1)?.text).toContain("EvStartFail1");
    const limited = harness({ ...starting, ...waitingForPratik, workflowSelection: { throws: true, errorCode: "WORKSPACE_LIMIT" } });
    await send(limited.handler, threadReply("EvStartFail2", `<@${bot}> quick`));
    expect(limited.posts.at(-1)?.text).toContain("open-task limit");
  });

  it("refuses to start or choose a Slack task with an admin message when the ingress cannot read task threads", async () => {
    const { handler, posts, queue, workflowStarts, workflowChoices, workflowSelections } = harness({ workflowStart: {}, workflowChoice: {}, workflowSelection: {}, ...waitingForPratik });
    await send(handler, signedEvent(mention({ eventId: "EvNoThreads1", event: { text: `<@${bot}> quick: Add password reset` } })));
    await send(handler, signedEvent(mention({ eventId: "EvNoThreads2", event: { text: `<@${bot}> Add password reset` } })));
    await send(handler, threadReply("EvNoThreads3", `<@${bot}> Full`));
    expect(workflowStarts).toEqual([]);
    expect(workflowChoices).toEqual([]);
    expect(workflowSelections).toEqual([]);
    expect(queue).toEqual([]);
    expect(posts.map((post) => post.text)).toEqual(Array.from({ length: 3 }, () => SLACK_TASK_THREADS_OFF_NOTICE));
  });
});

describe("shared task threads (spec 025 FR-035, C10)", () => {
  // `at` signs the request at the harness clock's time, so a request an hour later is still fresh.
  const reply = (eventId: string, text = `<@${bot}> also bump the version`, at = nowSeconds) =>
    signedEvent(mention({ eventId, event: { ts: "1695500000.000200", thread_ts: "1695500000.000100", text } }), { timestamp: at });

  it("answers a mention in a view-only thread with the fixed notice, and queues nothing (US3 scenario 4)", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } }, turnsPerMinute: 6 });
    const response = await send(h.handler, reply("Ev0000000101"));
    expect(response.status).toBe(200);
    expect(h.queue).toEqual([]);
    expect(h.pending.size).toBe(0);
    expect(h.turnWindows).toEqual([]);
    expect(h.posts).toEqual([{ channel, threadTs: "1695500000.000100", text: VIEW_ONLY_NOTICE }]);
  });

  it("says it at most once an hour per thread", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } } });
    await send(h.handler, reply("Ev0000000102"));
    h.clock.seconds += 1_800;
    expect((await send(h.handler, reply("Ev0000000103", undefined, h.clock.seconds))).status).toBe(200);
    expect(h.posts).toHaveLength(1);
    h.clock.seconds += 1_801;
    expect((await send(h.handler, reply("Ev0000000104", undefined, h.clock.seconds))).status).toBe(200);
    expect(h.posts).toHaveLength(2);
    expect(h.queue).toEqual([]);
    expect(h.noticedAt(`${team}/${channel}/1695500000.000100`)).toBe(nowSeconds + 3_601);
  });

  it("gives a closed task's thread the closed notice, whatever its mode (C24)", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "continue", closed: true } } } });
    await send(h.handler, reply("Ev0000000105"));
    expect(h.posts).toEqual([{ channel, threadTs: "1695500000.000100", text: CLOSED_SHARED_NOTICE }]);
    expect(h.queue).toEqual([]);
  });

  it("gives the closed notice once the task closes, even within the hour of a view-only notice (live check)", async () => {
    const threads: Record<string, { mode: "view" | "continue"; closed?: boolean }> = { "1695500000.000100": { mode: "view" } };
    const h = harness({ shared: { threads } });
    await send(h.handler, reply("Ev0000000111"));
    expect(h.posts.map((post) => post.text)).toEqual([VIEW_ONLY_NOTICE]);
    // The task closes 18 minutes later: the closed notice has its own hourly claim.
    threads["1695500000.000100"] = { mode: "view", closed: true };
    h.clock.seconds += 18 * 60;
    await send(h.handler, reply("Ev0000000112", undefined, h.clock.seconds));
    expect(h.posts.map((post) => post.text)).toEqual([VIEW_ONLY_NOTICE, CLOSED_SHARED_NOTICE]);
    // A second mention within the hour of the closed notice gets nothing.
    h.clock.seconds += 30 * 60;
    await send(h.handler, reply("Ev0000000113", undefined, h.clock.seconds));
    expect(h.posts).toHaveLength(2);
    // Closed wins: a closed thread never gets the view-only notice again, even once the view claim lapses.
    h.clock.seconds += 20 * 60;
    await send(h.handler, reply("Ev0000000114", undefined, h.clock.seconds));
    expect(h.posts.map((post) => post.text)).toEqual([VIEW_ONLY_NOTICE, CLOSED_SHARED_NOTICE]);
    expect(h.queue).toEqual([]);
  });

  it("does not stop anything from a view-only thread", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } }, stop: {} });
    await send(h.handler, reply("Ev0000000106", `<@${bot}> stop`));
    expect(h.stopCalls).toEqual([]);
  });

  it("queues a continue thread's mention exactly as any thread message, in the thread's group (FR-035)", async () => {
    const shared = harness({ shared: { threads: { "1695500000.000100": { mode: "continue" } } }, turnsPerMinute: 6 });
    const plain = harness({ turnsPerMinute: 6 });
    await send(shared.handler, reply("Ev0000000107"));
    await send(plain.handler, reply("Ev0000000107"));
    expect(shared.queue).toHaveLength(1);
    expect(shared.queue).toEqual(plain.queue);
    expect(shared.posts).toEqual(plain.posts);
    expect(shared.turnWindows).toEqual(plain.turnWindows);
  });

  it("answers 500 and releases the event when the shared record cannot be read, so Slack retries", async () => {
    const shared = { threads: {}, lookupThrows: true };
    const h = harness({ shared });
    const response = await send(h.handler, reply("Ev0000000108"));
    expect(response.status).toBe(500);
    expect(h.queue).toEqual([]);
    expect(h.logs).toContainEqual({ event: "shared_task.lookup_failed", fields: { eventId: "Ev0000000108", errorName: "InternalServerError" } });
    // The claim was released, so Slack's retry of the same event is handled as new.
    shared.lookupThrows = false;
    expect((await send(h.handler, reply("Ev0000000108"))).status).toBe(200);
    expect(h.queue).toHaveLength(1);
  });

  it("treats every thread as ordinary without the shared-task switch (the legacy deployment)", async () => {
    const h = harness();
    await send(h.handler, reply("Ev0000000109"));
    expect(h.queue).toHaveLength(1);
  });

  it("stays silent and queues nothing when the notice claim throws", async () => {
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } }, claimThrows: true }, turnsPerMinute: 6 });
    const response = await send(h.handler, reply("Ev0000000111"));
    expect(response.status).toBe(200);
    expect(h.posts).toEqual([]);
    expect(h.queue).toEqual([]);
    expect(h.turnWindows).toEqual([]);
    expect(h.logs).toContainEqual({ event: "shared_task.notice_claim_failed", fields: { eventId: "Ev0000000111", errorName: "InternalServerError" } });
    expect(h.logs).toContainEqual({ event: "shared_task.not_run", fields: { eventId: "Ev0000000111", closed: false, notified: false } });
  });

  it("never logs the mention's text", async () => {
    const secret = "PLANTED-REQUEST-TEXT-7f3a";
    const h = harness({ shared: { threads: { "1695500000.000100": { mode: "view" } } } });
    await send(h.handler, reply("Ev0000000110", `<@${bot}> ${secret}`));
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    expect(h.logs).toContainEqual({ event: "shared_task.not_run", fields: { eventId: "Ev0000000110", closed: false, notified: true } });
  });

  it("never answers the task owner with the view-only notice in their own Slack workflow thread", async () => {
    const h = harness({ shared: { threads: { "1695500000.000001": { mode: "view", taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true } } } });
    await send(h.handler, signedEvent(mention({ eventId: "EvOwner01", event: { thread_ts: "1695500000.000001", ts: "1695500002.000001", text: `<@${bot}> looks good so far` } })));
    expect(h.posts.map((post) => post.text)).not.toContain(VIEW_ONLY_NOTICE);
    expect(h.queue).toHaveLength(0);
  });

  it("sends a stop in a Slack workflow thread to the broker, which decides, and never queues it", async () => {
    const threads = { "1695500000.000001": { mode: "view" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true as const } };
    const stopped = harness({ shared: { threads }, stop: { outcome: "CANCEL_REQUESTED" } });
    await send(stopped.handler, signedEvent(mention({ eventId: "EvOwnerStop1", event: { thread_ts: "1695500000.000001", ts: "1695500002.000002", text: `<@${bot}> stop` } })));
    expect(stopped.stopCalls).toHaveLength(1);
    expect(stopped.stopCalls[0]?.userId).toBe(pratik);
    expect(stopped.stopCalls[0]?.thread).toMatchObject({ teamId: team, channelId: channel, threadTs: "1695500000.000001" });
    expect(stopped.posts.map((post) => post.text)).toEqual(["Stopping the running task. I'll reply here once it has stopped."]);
    expect(stopped.queue).toHaveLength(0);
    const refused = harness({ shared: { threads }, stop: { outcome: "NOTHING_RUNNING" } });
    await send(refused.handler, signedEvent(mention({ eventId: "EvMateStop1", event: { thread_ts: "1695500000.000001", ts: "1695500002.000003", text: `<@${bot}> stop` } })));
    expect(refused.stopCalls).toHaveLength(1);
    expect(refused.posts.map((post) => post.text)).not.toContain(VIEW_ONLY_NOTICE);
    expect(refused.queue).toHaveLength(0);
    // Nothing to stop: only the sender hears so, privately.
    expect(refused.posts).toEqual([]);
    expect(refused.ephemerals).toEqual([{ channel, threadTs: "1695500000.000001", user: pratik, text: "Nothing is running for this task right now." }]);
    expect(stopped.ephemerals).toEqual([]);
    // A teammate's stop while the owner's task runs: told privately who can stop it, never "nothing is running".
    const teammate = harness({ shared: { threads }, stop: { outcome: "NOT_OWNER" } });
    await send(teammate.handler, signedEvent(mention({ eventId: "EvMateStop2", event: { user: "U0TEAMMATE1", thread_ts: "1695500000.000001", ts: "1695500002.000005", text: `<@${bot}> stop` } })));
    expect(teammate.stopCalls.map((call) => call.userId)).toEqual(["U0TEAMMATE1"]);
    expect(teammate.posts).toEqual([]);
    expect(teammate.queue).toEqual([]);
    expect(teammate.ephemerals).toEqual([{ channel, threadTs: "1695500000.000001", user: "U0TEAMMATE1", text: "Only the person who started this task can stop it." }]);
  });

  it("saves the text of a reply posted with a file, and saves a plain \"stop\" as a reply rather than stopping", async () => {
    const threads = { "1695500000.000001": { mode: "view" as const, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true as const } };
    const h = harness({ shared: { threads }, threadNote: {}, stop: {} });
    await send(h.handler, signedEvent(mention({ eventId: "EvFile01", event: { type: "message", subtype: "file_share", thread_ts: "1695500000.000001", ts: "1695500003.000010", text: "Here is the mockup", files: [{ id: "F0123" }] } })));
    await send(h.handler, signedEvent(mention({ eventId: "EvPlainStop", event: { type: "message", thread_ts: "1695500000.000001", ts: "1695500003.000011", text: "stop" } })));
    expect(h.threadNotes.map((note) => note.text)).toEqual(["Here is the mockup", "stop"]);
    expect(h.stopCalls).toEqual([]);
  });

  it("still gives a closed Slack workflow thread the closed notice", async () => {
    const h = harness({ shared: { threads: { "1695500000.000001": { mode: "view", closed: true, taskId: "11111111-1111-4111-8111-111111111111", workflowThread: true } } }, stop: {} });
    await send(h.handler, signedEvent(mention({ eventId: "EvClosed01", event: { thread_ts: "1695500000.000001", ts: "1695500002.000004", text: `<@${bot}> stop` } })));
    expect(h.posts.map((post) => post.text)).toEqual([CLOSED_SHARED_NOTICE]);
    expect(h.stopCalls).toEqual([]);
    expect(h.queue).toHaveLength(0);
  });
});

describe("the broker adapters for thread replies (no 500 for an expected refusal)", () => {
  const input = { taskId: "11111111-1111-4111-8111-111111111111", thread: { teamId: team, channelId: channel, threadTs: "1695500000.000001" }, userId: "U0TEAMMATE1", messageTs: "1695500002.000001", eventId: "EvAdapt1", text: "A note" };
  const answering = (statusCode: number, body: unknown) => async () => ({ statusCode, body: JSON.stringify(body) });

  it("answers the broker's outcome, a refusal for any 4xx, and throws for a broker failure", async () => {
    expect(await recordThreadNoteThroughBroker(answering(200, { outcome: "duplicate" }), input)).toEqual({ outcome: "duplicate" });
    expect(await recordThreadNoteThroughBroker(answering(403, { error: { code: "FORBIDDEN" } }), input)).toEqual({ outcome: "refused" });
    expect(await recordThreadNoteThroughBroker(answering(400, { error: { code: "CONFIG_INVALID" } }), input)).toEqual({ outcome: "refused" });
    await expect(recordThreadNoteThroughBroker(answering(500, { error: "x" }), input)).rejects.toThrow(/thread note failed/);
    await expect(recordThreadNoteThroughBroker(answering(200, { outcome: "maybe" }), input)).rejects.toThrow(/thread note failed/);
  });

  it("reads the stop outcome, including a teammate's NOT_OWNER, and throws for anything else", async () => {
    const thread = { teamId: team, channelId: channel, threadTs: "1695500000.000001" };
    expect(await stopTaskThroughBroker(answering(200, { outcome: "NOT_OWNER" }), thread, "U0TEAMMATE1")).toBe("NOT_OWNER");
    expect(await stopTaskThroughBroker(answering(200, { outcome: "CANCEL_REQUESTED", targetOperationId: "x" }), thread, pratik)).toBe("CANCEL_REQUESTED");
    await expect(stopTaskThroughBroker(answering(200, { outcome: "MAYBE" }), thread, pratik)).rejects.toThrow(/stop failed/);
    await expect(stopTaskThroughBroker(answering(403, { error: { code: "FORBIDDEN" } }), thread, pratik)).rejects.toThrow(/stop failed/);
  });

});

describe("chat.postEphemeral", () => {
  it("sends a private message to one person in the thread, and reports Slack's error code", async () => {
    const strict = new StrictSlackWeb();
    await chatPostEphemeral("xoxb-test", { channel, threadTs: "1695500000.000001", user: pratik, text: "Saved." }, strict.fetch);
    expect(strict.ephemerals).toEqual([{ channel, threadTs: "1695500000.000001", user: pratik, text: "Saved." }]);
    strict.failNext("chat.postEphemeral", "user_not_in_channel");
    await expect(chatPostEphemeral("xoxb-test", { channel, user: pratik, text: "Saved." }, strict.fetch)).rejects.toMatchObject({ slackError: "user_not_in_channel" });
  });
});
