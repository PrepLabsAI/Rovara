// Spec 062 Phase 7c2: Slack's request routing moves behind the channel API. The Slack adapter's front checks Slack's
// signature, reads a plain reply only in a thread Rovara posted in, and hands the rest on; the channel API runs the
// router, which posts through the adapter's commands and queues on the channel request queue; the orchestrator runs
// what was queued as Slack threads, routed requests and confirmation presses included.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SLACK_CONFIRMATION_ACTION_ID, builtInAdapterRecord, generateWebhookSecret, webhookHeaders,
  type ChannelQueueItem, type DirectoryUser, type InboundMessage, type SlackRequestMessage,
} from "../../packages/contracts/src/index.js";
import { createChannelIngressHandler, type ChannelIngressDependencies } from "../../packages/broker/src/aws/channel-ingress.js";
import { confirmationAction, createSlackChannelCommandsHandler, createSlackChannelEventsHandler, createSlackChannelForwarder } from "../../packages/broker/src/aws/slack-adapter.js";
import { slackChannelSurface, slackChannelTransport } from "../../packages/broker/src/aws/slack-channel-router.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createSlackAdapterFront, createSlackMentionRouter, inboundOfSlackMention, slackMentionOfInbound, type SlackMention } from "../../packages/broker/src/aws/slack-ingress.js";
import type { SlackNoticeChannel } from "../../packages/broker/src/aws/slack-notice-channel.js";
import { createSlackAdapterClient } from "../../packages/slack-service/src/slack-adapter-client.js";
import { slackChannelRequests } from "../../packages/slack-service/src/slack-channel.js";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const SIGNING = "slack-signing-secret";
const SECRET = generateWebhookSecret();
const TEAM = "T0123456789";
const CHANNEL = "C0123456789";
const THREAD = "1695500000.000001";
const thread = { teamId: TEAM, channelId: CHANNEL, threadTs: THREAD };
const conversation = { channel: "slack", tenant: TEAM, space: CHANNEL, thread: THREAD };
const actor = { channel: "slack", tenant: TEAM, userId: "U0123456789" };

/** A Slack Events API request, signed as Slack signs it. */
function slackEvent(event: Record<string, unknown>, options: { signWith?: string } = {}) {
  const body = JSON.stringify({ type: "event_callback", team_id: TEAM, api_app_id: "A0AGENTX", event_id: "EvROUTE0001", authorizations: [{ user_id: "U0AGENTX01", is_bot: true }], event });
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = `v0=${createHmac("sha256", options.signWith ?? SIGNING).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { rawPath: "/v1/slack/events", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
}

function front(rovaraThreads: string[] = []) {
  const handedOff: InboundMessage[] = [];
  const handler = createSlackAdapterFront({
    secrets: async () => ({ signingSecret: SIGNING }),
    isRovaraThread: async (where) => rovaraThreads.includes(where.threadTs),
    handOff: async (message) => { handedOff.push(message); },
    now: () => NOW,
  });
  return { handler, handedOff };
}

describe("the Slack adapter's front", () => {
  it("hands a mention on with the bot's own mention removed, its message ID, and nothing decided", async () => {
    const { handler, handedOff } = front();
    const response = await handler(slackEvent({ type: "app_mention", channel: CHANNEL, user: "U0123456789", text: "<@U0AGENTX01> fix the menu", ts: THREAD }));
    expect(response.statusCode).toBe(200);
    expect(handedOff).toEqual([{
      version: 2, channel: "slack", eventId: "EvROUTE0001", conversation, actor, text: "fix the menu",
      receivedAt: new Date(NOW).toISOString(), messageId: THREAD,
    }]);
  });

  it("reads a plain reply only in a thread Rovara posted in, as not addressed to it", async () => {
    const reply = { type: "message", channel: CHANNEL, user: "U0123456789", text: "looks good", ts: "1695500000.000009", thread_ts: THREAD };
    const elsewhere = front();
    expect((await elsewhere.handler(slackEvent(reply))).statusCode).toBe(200);
    expect(elsewhere.handedOff).toEqual([]);
    const ours = front([THREAD]);
    await ours.handler(slackEvent(reply));
    expect(ours.handedOff[0]).toMatchObject({ text: "looks good", addressed: false, messageId: "1695500000.000009" });
  });

  it("marks a message posted through another app, keeps an empty mention, and refuses a bad signature", async () => {
    const { handler, handedOff } = front();
    await handler(slackEvent({ type: "app_mention", channel: CHANNEL, user: "U0123456789", text: "<@U0AGENTX01>", ts: THREAD, bot_id: "B0OTHER" }));
    expect(handedOff[0]).toMatchObject({ text: " ", viaApp: true });
    expect((await handler(slackEvent({ type: "app_mention", channel: CHANNEL, user: "U0123456789", text: "x", ts: THREAD }, { signWith: "wrong" }))).statusCode).toBe(401);
    expect(handedOff).toHaveLength(1);
  });

  it("drops Rovara's own messages before anything is handed on", async () => {
    const { handler, handedOff } = front([THREAD]);
    await handler(slackEvent({ type: "message", channel: CHANNEL, user: "U0AGENTX01", text: "Got it.", ts: "1695500000.000010", thread_ts: THREAD }));
    expect(handedOff).toEqual([]);
  });

  it("gives the router the same mention Slack's own ingress parses", () => {
    const parsed: SlackMention = { kind: "message", eventId: "EvROUTE0001", thread, userId: "U0123456789", text: "<@U0AGENTX01> <@U0SOMEONE1> please look",
      messageTs: "1695500000.000009", isThreadReply: true, botUserId: "U0AGENTX01", appPosted: false };
    expect(slackMentionOfInbound(inboundOfSlackMention(parsed, NOW))).toMatchObject({
      kind: "message", eventId: "EvROUTE0001", thread, userId: "U0123456789", messageTs: "1695500000.000009", isThreadReply: true, appPosted: false,
      // The other person's mention stays, as Slack's own ingress keeps it.
      text: "<@U0SOMEONE1> please look",
    });
  });
});

describe("the channel API routes the built-in adapter's messages", () => {
  const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", secretName: "agentx/test/channel-adapter/slack" });
  const message: InboundMessage = { version: 2, channel: "slack", eventId: "EvROUTE0002", conversation, actor, text: "stop", receivedAt: new Date(NOW).toISOString(), messageId: THREAD };
  function ingress(surface: NonNullable<ChannelIngressDependencies["surfaces"]>["slack"]) {
    const queued: ChannelQueueItem[] = [];
    const claims = new Set<string>();
    const handler = createChannelIngressHandler({
      getAdapter: async (channel) => (channel === "slack" ? builtIn : undefined), getSecret: async () => SECRET,
      getBinding: async (ref) => ({ ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      linkedDeveloper: vi.fn(), issueLinkCode: vi.fn(), linkUrl: (code) => code,
      claim: async (key) => { if (claims.has(key)) return false; claims.add(key); return true; }, release: async (key) => { claims.delete(key); },
      enqueue: async (item) => { queued.push(item); }, sendEvent: vi.fn(), surfaces: { slack: surface }, now: () => NOW, log: () => undefined,
    });
    const post = (id = "m1") => {
      const body = JSON.stringify(message);
      return handler({ rawPath: "/v1/channels/slack/messages", body, headers: webhookHeaders({ secret: SECRET, id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
    };
    return { post, queued, claims };
  }

  it("hands each message to the router with its bound project, and queues nothing itself", async () => {
    const surface = vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ ok: true }) }));
    const { post, queued } = ingress(surface);
    expect((await post()).statusCode).toBe(200);
    expect(surface).toHaveBeenCalledWith(message, { projectName: "web" });
    expect(queued).toEqual([]);
  });

  it("answers 500 when the router does, and frees the request for the adapter's retry", async () => {
    const { post, claims } = ingress(async () => ({ statusCode: 500, body: "{}" }));
    expect((await post()).statusCode).toBe(500);
    expect(claims.size).toBe(0);
  });
});

describe("the router through the channel transport", () => {
  function transport(user: DirectoryUser | null = { userId: "U0123456789", bot: false, deleted: false }) {
    const queued: Array<{ item: ChannelQueueItem; groupId: string }> = [];
    const posts: Array<Record<string, unknown>> = [];
    const pending = new Map<string, number>();
    const notices: SlackNoticeChannel = {
      post: async (input) => { posts.push(input); return { ts: "1700000000.000300" }; },
      update: vi.fn(), postEphemeral: async (input) => { posts.push({ ephemeral: true, ...input }); }, createPlanCanvas: vi.fn(), deleteCanvas: vi.fn(),
    };
    const routerTransport = slackChannelTransport({
      notices, user: async () => user ?? undefined, enqueue: async (item, groupId) => { queued.push({ item, groupId }); },
      changePending: async (subject, delta) => { const next = (pending.get(subject) ?? 0) + delta; pending.set(subject, next); return next; },
      projectName: () => "web", now: () => NOW,
    });
    return { routerTransport, queued, posts, pending };
  }
  const request: SlackRequestMessage = { version: 1, eventId: "EvROUTE0003", thread, userId: "U0123456789", text: "what changed?", receivedAt: new Date(NOW).toISOString() };

  it("runs Slack's own router: a plain request is claimed, counted, queued on the channel queue with how many are ahead, and acknowledged", async () => {
    const { routerTransport, queued, posts } = transport();
    const claims = new Set<string>();
    const pending = new Map<string, number>([[`${TEAM}/${CHANNEL}/${THREAD}`, 1]]);
    const route = createSlackMentionRouter({
      getBinding: async () => ({ teamId: TEAM, channelId: CHANNEL, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      claimEvent: async (id) => { if (claims.has(id)) return false; claims.add(id); return true; }, releaseEvent: async () => undefined,
      changePending: async (subject, delta) => { const next = (pending.get(subject) ?? 0) + delta; pending.set(subject, next); return next; },
      enqueue: (message, groupId, behind) => routerTransport.enqueue(message, groupId, behind),
      postMessage: async (input) => { await routerTransport.postMessage(input); },
      now: () => NOW,
    });
    const mention = slackMentionOfInbound({ version: 2, channel: "slack", eventId: "EvROUTE0004", conversation, actor, text: "fix the menu", receivedAt: new Date(NOW).toISOString(), messageId: "1695500000.000011" });
    expect((await route(mention)).statusCode).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.item).toMatchObject({ kind: "message", projectName: "web", stepUp: [], queuedBehind: 1, message: { channel: "slack", eventId: "EvROUTE0004", text: "fix the menu", conversation } });
    expect(posts).toEqual([{ channel: CHANNEL, threadTs: THREAD, text: "Got it. This is queued behind 1 earlier request in this thread." }]);
    // A repeat of the event runs nothing.
    await route(mention);
    expect(queued).toHaveLength(1);
  });

  it("is taken end to end: the adapter forwards a plain mention, the channel API's router queues it for the chat agent, and the forwarder accepts the router's answer", async () => {
    // As the legacy deployment runs it: no Slack tasks, so a plain mention is the chat agent's.
    const { routerTransport, queued } = transport();
    const claims = new Set<string>();
    const route = createSlackMentionRouter({
      getBinding: async () => ({ teamId: TEAM, channelId: CHANNEL, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      claimEvent: async (id) => { if (claims.has(id)) return false; claims.add(id); return true; }, releaseEvent: async () => undefined,
      changePending: async () => 0,
      enqueue: (message, groupId, behind) => routerTransport.enqueue(message, groupId, behind),
      postMessage: async (input) => { await routerTransport.postMessage(input); },
      now: () => NOW,
    });
    const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", secretName: "agentx/production/channel-adapter/slack" });
    const ingressClaims = new Set<string>();
    const ingress = createChannelIngressHandler({
      getAdapter: async (channel) => (channel === "slack" ? builtIn : undefined), getSecret: async () => SECRET,
      getBinding: async (ref) => ({ ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      linkedDeveloper: vi.fn(), issueLinkCode: vi.fn(), linkUrl: (code) => code,
      claim: async (key) => { if (ingressClaims.has(key)) return false; ingressClaims.add(key); return true; }, release: async (key) => { ingressClaims.delete(key); },
      enqueue: vi.fn(), sendEvent: vi.fn(), surfaces: { slack: slackChannelSurface(route, new AsyncLocalStorage()) }, now: () => NOW, log: () => undefined,
    });
    const forward = createSlackChannelForwarder({
      channelApiUrl: "https://api.example.com", secret: async () => SECRET, now: () => NOW,
      fetch: async (url, init) => {
        const path = new URL(url instanceof Request ? url.url : url.toString()).pathname;
        const response = await ingress({ rawPath: path, body: typeof init?.body === "string" ? init.body : "", headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
        return new Response(response.body, { status: response.statusCode });
      },
    });
    const hi: InboundMessage = { version: 2, channel: "slack", eventId: "EvROUTE0009", conversation, actor, text: "hi", receivedAt: new Date(NOW).toISOString(), messageId: THREAD };
    await expect(forward(hi)).resolves.toBeUndefined();
    expect(queued.map((entry) => entry.item)).toMatchObject([{ kind: "message", projectName: "web", message: { eventId: "EvROUTE0009", text: "hi" } }]);
  });

  it("marks a routed request and a task question for the orchestrator", async () => {
    const { routerTransport, queued } = transport();
    await routerTransport.route(request, "g", undefined);
    await routerTransport.route(request, "g", { taskId: "task-1", noteTs: "1695500000.000012", chat: true });
    expect(queued.map((entry) => (entry.item as Extract<ChannelQueueItem, { kind: "message" }>).routing)).toEqual([
      { kind: "suggest" }, { kind: "task_question", taskId: "task-1", noteId: "1695500000.000012", chat: true },
    ]);
  });

  it("counts an answered choice as pending before it is queued", async () => {
    const { routerTransport, queued, pending } = transport();
    await routerTransport.enqueueAnswer({ thread, userId: "U0123456789", text: "what changed?", eventId: "EvAnswer0001" });
    expect(pending.get(`${TEAM}/${CHANNEL}/${THREAD}`)).toBe(1);
    expect(queued[0]!.item).toMatchObject({ message: { eventId: "EvAnswer0001" } });
  });

  it.each([
    ["a person", { userId: "U0123456789", bot: false, deleted: false }, { outcome: "person" }],
    ["a bot", { userId: "U0123456789", bot: true, deleted: false }, { outcome: "not_person" }],
    ["a deactivated person", { userId: "U0123456789", bot: false, deleted: true }, { outcome: "not_person" }],
    ["someone the directory does not know", null, { outcome: "failed", error: "user_not_found" }],
  ] as const)("confirms %s as Slack's own check does", async (_name, user, expected) => {
    expect(await transport(user).routerTransport.checkMember("U0123456789")).toEqual(expected);
  });
});

describe("the orchestrator's Slack surface", () => {
  function surface(routed?: Parameters<typeof slackChannelRequests>[0]["routed"]) {
    const turns: string[] = [];
    const logs: string[] = [];
    const finish = vi.fn(async () => undefined);
    const handle = slackChannelRequests({
      processor: {
        api: () => ({ ensureWorkspace: async () => ({ outcome: "WORKSPACE", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false, orchestratorInstructions: "x" }),
          startClose: async () => ({ outcome: "NOT_FOUND" }), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: async () => "33333333-3333-4333-8333-333333333333" }) as never,
        threads: { load: async () => ({ workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish },
        runTurn: async (input) => { turns.push(input.message.text); return "Done."; },
        log: () => undefined,
      },
      send: async () => undefined,
      ...(routed === undefined ? {} : { routed }),
      log: (event) => { logs.push(event); },
      now: () => NOW,
    });
    return { handle, turns, logs, finish };
  }
  const item = (extra: Partial<Extract<ChannelQueueItem, { kind: "message" }>> = {}): ChannelQueueItem => ({
    kind: "message", projectName: "web", stepUp: [],
    message: { version: 2, channel: "slack", eventId: "EvROUTE0005", conversation, actor, text: "what changed?", receivedAt: new Date(NOW).toISOString() }, ...extra,
  });

  it("runs a routed request through its router, which may answer it as a turn", async () => {
    const routed = vi.fn(async (input: { answer: (message: SlackRequestMessage) => Promise<void>; message: SlackRequestMessage }) => { await input.answer(input.message); });
    const { handle, turns } = surface(routed);
    await handle(item({ routing: { kind: "suggest" } }), { finalAttempt: false });
    expect(routed).toHaveBeenCalledTimes(1);
    expect(turns).toEqual(["what changed?"]);
  });

  it("answers a confirmation press as the typed reply it stands for, and drops any other action", async () => {
    const { handle, logs, finish } = surface();
    const press = confirmationAction({ version: 1, eventId: "EvAgxApprove444", thread, userId: "U0123456789", text: "yes", receivedAt: new Date(NOW).toISOString() });
    expect(press).toMatchObject({ actionId: SLACK_CONFIRMATION_ACTION_ID, value: "yes", conversation });
    await handle({ kind: "action", action: press, projectName: "web", stepUp: [] }, { finalAttempt: false });
    await handle({ kind: "action", action: { ...press, actionId: "workflow.approve" }, projectName: "web", stepUp: [] }, { finalAttempt: false });
    expect(logs).toContain("channel.action_unhandled");
    // The press reached the processor as the thread's reply and finished there, once; the other action ran nothing.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(`${TEAM}/${CHANNEL}/${THREAD}`);
  });
});

describe("Rovara's threads and the service's posts", () => {
  it("are remembered when the adapter posts an event or a command in them", async () => {
    const marked: string[] = [];
    const markThread = async (channelId: string, threadTs: string) => { marked.push(`${channelId}/${threadTs}`); };
    const slackFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, ts: "1700000000.000400" }), { status: 200 }));
    const events = createSlackChannelEventsHandler({ secret: async () => SECRET, botToken: async () => "xoxb", claim: async () => true, release: async () => undefined,
      messageTs: { get: async () => undefined, put: async () => undefined }, markThread, fetch: slackFetch, now: () => NOW });
    const event = { version: 1, id: "evt_aaaaaaaaaaaaaaaaaaaa", channel: "slack", conversation, createdAt: new Date(NOW).toISOString(), type: "message", data: { text: "Done." } };
    const body = JSON.stringify(event);
    await events({ rawPath: "/v1/slack/channel-events", body, headers: webhookHeaders({ secret: SECRET, id: event.id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
    const commands = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb", markThread, fetch: slackFetch, now: () => NOW });
    const client = createSlackAdapterClient({ commandsUrl: "https://api.example.com/v1/slack/channel-commands", secret: async () => SECRET, now: () => NOW,
      fetch: async (_url, init) => {
        const response = await commands({ rawPath: "/v1/slack/channel-commands", body: typeof init?.body === "string" ? init.body : "", headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
        return new Response(response.body, { status: response.statusCode, headers: response.headers });
      } });
    expect(await client.post({ ...thread, channelId: "C0000000002", threadTs: "1695500000.000020" }, "Should this be a task?")).toBe("1700000000.000400");
    await client.postPrivate(thread, "U0123456789", "Only you see this.");
    expect(marked).toEqual([`${CHANNEL}/${THREAD}`, "C0000000002/1695500000.000020"]);
    expect(slackFetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))).toEqual([
      "https://slack.com/api/chat.postMessage", "https://slack.com/api/chat.postMessage", "https://slack.com/api/chat.postEphemeral",
    ]);
  });
});
