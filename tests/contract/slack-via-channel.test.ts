// Spec 062 Phase 7b (FR-073, FR-074): Slack through the channel API as the built-in adapter. A Slack request is signed
// and handed to the real channel API, queued without linking, run as a Slack thread, and answered with events that the
// real event sender signs and delivers to the Slack adapter, which posts them to Slack: all in-process.
import { describe, expect, it, vi } from "vitest";
import {
  DETAILS_ACTION, builtInAdapterRecord, channelEventGroupId, confirmationBlocks, detailsReplyBlocks, generateWebhookSecret, usableWebhookSecret, webhookHeaders,
  type ChannelEvent, type ChannelQueueItem, type SlackRequestMessage, type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { adapterForChannel, builtInAdapterFromEnvironment, getChannelAdapter } from "../../packages/broker/src/aws/channel-adapters.js";
import { createChannelEventSender, type SqsRecord } from "../../packages/broker/src/aws/channel-events.js";
import { createChannelIngressHandler, type ChannelIngressDependencies } from "../../packages/broker/src/aws/channel-ingress.js";
import { createSlackChannelEventsHandler, createSlackChannelForwarder, type SlackChannelEventsDependencies } from "../../packages/broker/src/aws/slack-adapter.js";
import { channelRequestHandler } from "../../packages/slack-service/src/channel-requests.js";
import { slackChannelRequests } from "../../packages/slack-service/src/slack-channel.js";
import type { TurnInput } from "../../packages/slack-service/src/slack-processor.js";
import { DynamoTurnRecordWriter } from "../../packages/slack-service/src/turn-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const SECRET = generateWebhookSecret();
const API = "https://api.example.com";
const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: `${API}/v1/slack/channel-events`, secretName: "agentx/test/channel-adapter/slack" });
const thread = { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" };
const conversation = { channel: "slack", tenant: thread.teamId, space: thread.channelId, thread: thread.threadTs };
const request: SlackRequestMessage = { version: 1, eventId: "EvVIACHANNEL1", thread, userId: "U0123456789", text: "list open items", receivedAt: "2026-11-11T09:59:59.000Z" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const workspace: SlackThreadWorkspaceResult = { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding." };

interface SlackCall { method: string; body: Record<string, unknown> }

const urlOf = (url: string | URL | Request) => (url instanceof Request ? url.url : url.toString());
const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === "string" ? init.body : "");

/** Slack's Web API: records each call and answers ok with a new timestamp, or what `answer` says. */
function slackApi(answer: (call: SlackCall) => Record<string, unknown> | Error = () => ({ ok: true })) {
  const calls: SlackCall[] = [];
  let ts = 100;
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const call = { method: new URL(urlOf(url)).pathname.replace("/api/", ""), body: JSON.parse(bodyOf(init)) as Record<string, unknown> };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify({ ts: `1700000000.000${++ts}`, ...result }), { status: 200 });
  });
  return { calls, fetchFn };
}

function slackAdapter(overrides: Partial<SlackChannelEventsDependencies> = {}, slack = slackApi()) {
  const claims = new Set<string>();
  const keys = new Map<string, string>();
  const handler = createSlackChannelEventsHandler({
    secret: async () => SECRET,
    botToken: async () => "xoxb-test",
    claim: async (id) => { if (claims.has(id)) return false; claims.add(id); return true; },
    release: async (id) => { claims.delete(id); },
    messageTs: { get: async (subject, key) => keys.get(`${subject}#${key}`), put: async (subject, key, ts) => { keys.set(`${subject}#${key}`, ts); } },
    fetch: slack.fetchFn,
    now: () => NOW,
    ...overrides,
  });
  const deliver = (event: ChannelEvent, options: { signWith?: string } = {}) => {
    const body = JSON.stringify(event);
    return handler({ rawPath: "/v1/slack/channel-events", body, headers: webhookHeaders({ secret: options.signWith ?? SECRET, id: event.id, timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
  };
  return { handler, deliver, claims, keys, slack };
}

const event = <T extends Exclude<ChannelEvent["type"], "direct">>(type: T, data: Extract<ChannelEvent, { type: T }>["data"], id = `evt_${"a".repeat(20)}${Math.random().toString(36).slice(2, 8)}`): ChannelEvent =>
  ({ version: 1, id, channel: "slack", conversation, createdAt: new Date(NOW).toISOString(), type, data }) as ChannelEvent;

describe("a Slack conversation through the channel API", () => {
  function system(runTurn: (input: TurnInput) => Promise<string>) {
    const requests: ChannelQueueItem[] = [];
    const events: ChannelEvent[] = [];
    const linkedDeveloper = vi.fn(async () => { throw new Error("a Slack actor is never looked up for a link"); });
    const ingressDeps: ChannelIngressDependencies = {
      getAdapter: async (channel) => (channel === "slack" ? builtIn : undefined),
      getSecret: async () => SECRET,
      getBinding: async (ref) => (ref.channel === "slack" && ref.space === thread.channelId ? { ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" } : undefined),
      linkedDeveloper,
      issueLinkCode: vi.fn(),
      linkUrl: (code) => `${API}/review/link/${code}`,
      claim: (() => { const claims = new Set<string>(); return async (key: string) => { if (claims.has(key)) return false; claims.add(key); return true; }; })(),
      release: async () => undefined,
      enqueue: async (item) => { requests.push(item); },
      sendEvent: async (channelEvent) => { events.push(channelEvent); },
      now: () => NOW,
      log: () => undefined,
    };
    const ingress = createChannelIngressHandler(ingressDeps);
    const forward = createSlackChannelForwarder({
      channelApiUrl: API, secret: async () => SECRET, now: () => NOW,
      fetch: async (url, init) => {
        const response = await ingress({ rawPath: new URL(urlOf(url)).pathname, body: bodyOf(init), headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
        return new Response(response.body, { status: response.statusCode });
      },
    });
    const db = new FakeDynamoDb();
    const turns: TurnInput[] = [];
    const orchestrator = channelRequestHandler({
      processor: {} as never,
      send: async () => { throw new Error("Slack's conversations use their own surface"); },
      surfaces: {
        slack: slackChannelRequests({
          processor: {
            api: () => ({ ensureWorkspace: async () => workspace, startClose: async () => ({ outcome: "NOT_FOUND" }), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: async () => "33333333-3333-4333-8333-333333333333" }),
            threads: { load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
            runTurn: async (input) => { turns.push(input); return runTurn(input); },
            turnRecords: new DynamoTurnRecordWriter(db as never, "turns"),
            log: () => undefined,
          },
          send: async (channelEvent) => { events.push(channelEvent); },
          now: () => NOW,
        }),
      },
      log: () => undefined,
    });
    const adapter = slackAdapter();
    const sender = createChannelEventSender({
      getAdapter: async (channel) => (channel === "slack" ? builtIn : undefined), getSecret: async () => SECRET, checkAddresses: async () => undefined, now: () => NOW, log: () => undefined,
      fetch: async (_url, init) => {
        const response = await adapter.handler({ rawPath: "/v1/slack/channel-events", body: bodyOf(init), headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
        return new Response(response.body, { status: response.statusCode });
      },
    });
    const flush = async () => {
      const batch: SqsRecord[] = events.splice(0).map((channelEvent, index) => ({ messageId: String(index), body: JSON.stringify(channelEvent), attributes: { MessageGroupId: channelEventGroupId(channelEvent) } }));
      return sender({ Records: batch });
    };
    return { forward, requests, events, orchestrator, flush, slack: adapter.slack, turns, linkedDeveloper };
  }

  it("is queued with Slack's verified identity, run as a Slack thread, and its reply is posted in the thread with its Details button", async () => {
    const reply = "There are *2* open items.";
    const { forward, requests, events, orchestrator, flush, slack, turns, linkedDeveloper } = system(async (input) => {
      input.recorder?.offer({ manifest: "m", tools: [{ name: "tracker__list_items", description: "d" }], connectorOf: new Map([["tracker__list_items", "tracker"]]), model: { provider: "p", modelId: "m" } });
      input.recorder?.toolStarted({ toolCallId: "c1", toolName: "tracker__list_items", args: {} });
      input.recorder?.toolEnded({ toolCallId: "c1", toolName: "tracker__list_items", isError: false, result: { content: [{ type: "text", text: JSON.stringify({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }) }] } });
      input.recorder?.agentEnded([{ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" }]);
      return reply;
    });
    await forward(request);
    // No link and no step-up: Slack's actors keep Slack's identity, in any channel bound to a project.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "message", projectName: "web", stepUp: [], message: { channel: "slack", eventId: request.eventId, conversation } });
    expect(requests[0]).not.toHaveProperty("developerId");
    expect(linkedDeveloper).not.toHaveBeenCalled();
    // Nor an ack: the ingress says "Got it" in Slack itself.
    expect(events).toEqual([]);

    await orchestrator(requests[0]!, { finalAttempt: false });
    // A Slack thread's subject and Slack's markup, as on Slack's own queue.
    expect(turns[0]).toMatchObject({ subject: "T0123456789/C0123456789/1695500000.000001", message: { thread, userId: request.userId } });
    expect(turns[0]).not.toHaveProperty("plainReplies");

    expect(await flush()).toEqual({ batchItemFailures: [] });
    // The reply is posted once, in the thread, with the Details button.
    const posts = slack.calls.filter((call) => call.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ channel: thread.channelId, thread_ts: thread.threadTs, text: reply, blocks: detailsReplyBlocks(reply, `${request.receivedAt}#${request.eventId}`) });
    expect(JSON.stringify(posts[0]!.body.blocks)).toContain(DETAILS_ACTION);
  });

  it("refuses a request signed with another secret, and queues nothing", async () => {
    const { requests } = system(async () => "x");
    const forward = createSlackChannelForwarder({ channelApiUrl: API, secret: async () => generateWebhookSecret(), now: () => NOW,
      fetch: async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 }) });
    await expect(forward(request)).rejects.toThrow(/HTTP 401/);
    expect(requests).toEqual([]);
  });
});

describe("the forwarder", () => {
  const answering = (status: number, body: unknown) => createSlackChannelForwarder({ channelApiUrl: API, secret: async () => SECRET, now: () => NOW, fetch: async () => new Response(JSON.stringify(body), { status }) });

  it("takes an accepted, duplicate or router-handled answer, and nothing else", async () => {
    await expect(answering(202, { status: "accepted" })(request)).resolves.toBeUndefined();
    await expect(answering(200, { status: "duplicate" })(request)).resolves.toBeUndefined();
    // Phase 7c2: the channel API's Slack router handled it, and answers as Slack's ingress does.
    await expect(answering(200, { ok: true })(request)).resolves.toBeUndefined();
    await expect(answering(200, { ok: false })(request)).rejects.toThrow();
    await expect(answering(200, {})(request)).rejects.toThrow();
    await expect(answering(202, { status: "link_required" })(request)).rejects.toThrow();
    await expect(answering(500, { error: "try_again" })(request)).rejects.toThrow();
  });
});

describe("the Slack adapter's events", () => {
  it("posts a message once, however often it is delivered", async () => {
    const { deliver, slack } = slackAdapter();
    const reply = event("message", { text: "Done." });
    expect((await deliver(reply)).statusCode).toBe(200);
    expect(JSON.parse((await deliver(reply)).body)).toEqual({ status: "duplicate" });
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage"]);
  });

  it("refuses an event not signed with the adapter's secret", async () => {
    const { deliver, slack } = slackAdapter();
    expect((await deliver(event("message", { text: "Done." }), { signWith: generateWebhookSecret() })).statusCode).toBe(401);
    expect(slack.calls).toEqual([]);
  });

  it("edits a keyed message in place: the progress note", async () => {
    const { deliver, slack } = slackAdapter();
    await deliver(event("message", { text: "Working on it.", key: "progress:1" }));
    await deliver(event("message", { text: "Still working: 3 minutes.", key: "progress:1" }));
    expect(slack.calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(slack.calls[1]!.body).toMatchObject({ channel: thread.channelId, ts: "1700000000.000101", text: "Still working: 3 minutes." });
  });

  it("shows a private message only to its person", async () => {
    const { deliver, slack } = slackAdapter();
    await deliver(event("message", { text: "Only you can see this.", audience: { kind: "ephemeral", actor: { channel: "slack", tenant: thread.teamId, userId: "U0123456789" } } }));
    expect(slack.calls).toEqual([{ method: "chat.postEphemeral", body: { channel: thread.channelId, thread_ts: thread.threadTs, user: "U0123456789", text: "Only you can see this." } }]);
  });

  it("asks for a confirmation with Slack's own Approve and Cancel buttons", async () => {
    const { deliver, slack } = slackAdapter();
    const requestId = "44444444-4444-4444-8444-444444444444";
    await deliver(event("approval_request", { text: "Before I go ahead, please confirm.", kind: "other", requestId, expectedRevision: 1, artifactDigest: "a".repeat(64),
      actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Cancel" }] }));
    expect(slack.calls[0]!.body.blocks).toEqual(confirmationBlocks("Before I go ahead, please confirm.", requestId));
  });

  it("posts the text alone when Slack refuses the blocks", async () => {
    const slack = slackApi((call) => (call.body.blocks === undefined ? { ok: true } : { ok: false, error: "invalid_blocks" }));
    const { deliver } = slackAdapter({}, slack);
    expect((await deliver(event("message", { text: "Done.", actions: [{ type: "button", actionId: "turn.details", value: "v", label: "Details" }] }))).statusCode).toBe(200);
    expect(slack.calls.map((call) => call.body.blocks === undefined)).toEqual([false, true]);
  });

  it.each([
    ["a rate limit", { ok: false, error: "ratelimited" }, 429],
    ["a refusal Slack will repeat", { ok: false, error: "channel_not_found" }, 422],
    ["a lost connection", new TypeError("fetch failed"), 503],
  ] as const)("answers %s so the sender knows whether to retry, and frees the event for the retry", async (_name, answer, status) => {
    const { deliver, claims } = slackAdapter({}, slackApi(() => answer));
    expect((await deliver(event("message", { text: "Done." }))).statusCode).toBe(status);
    expect(claims.size).toBe(0);
  });

  it("ignores the ack and an empty done", async () => {
    const { deliver, slack } = slackAdapter();
    await deliver(event("ack", { inReplyTo: "EvVIACHANNEL1" }));
    await deliver(event("done", { inReplyTo: "EvVIACHANNEL1" }));
    expect(slack.calls).toEqual([]);
  });
});

describe("the event sender keeps a conversation in order", () => {
  it("holds a conversation's later events behind one that is retried, and delivers other conversations'", async () => {
    const delivered: string[] = [];
    const sender = createChannelEventSender({
      getAdapter: async () => builtIn, getSecret: async () => SECRET, checkAddresses: async () => undefined, now: () => NOW, log: () => undefined,
      fetch: async (_url, init) => {
        const text = (JSON.parse(bodyOf(init)) as { data: { text: string } }).data.text;
        delivered.push(text);
        return new Response(null, { status: text === "first" ? 503 : 200 });
      },
    });
    const other = { ...conversation, thread: "1695500000.000002" };
    const records = [
      event("message", { text: "first" }),
      { ...event("message", { text: "elsewhere" }), conversation: other } as ChannelEvent,
      event("message", { text: "second" }),
    ].map((channelEvent, index) => ({ messageId: String(index), body: JSON.stringify(channelEvent), attributes: { MessageGroupId: channelEventGroupId(channelEvent) } }));
    expect(await sender({ Records: records })).toEqual({ batchItemFailures: [{ itemIdentifier: "0" }, { itemIdentifier: "2" }] });
    expect(delivered).toEqual(["first", "elsewhere"]);
  });
});

describe("the built-in adapter's settings", () => {
  const environment = {
    BUILT_IN_ADAPTER: "enabled", BUILT_IN_ADAPTER_CHANNEL: "slack", BUILT_IN_ADAPTER_CALLBACK_URL: `${API}/v1/slack/channel-events`, BUILT_IN_ADAPTER_SECRET_NAME: "agentx/test/channel-adapter/slack",
  };
  const registry = (item?: Record<string, unknown>) => ({ documentClient: { send: vi.fn(async () => ({ Item: item })) }, tableName: "state" });

  it("make the built-in adapter only when it is enabled and fully named", () => {
    expect(builtInAdapterFromEnvironment(environment)).toMatchObject({ channel: "slack", builtIn: true, stepUp: [], capabilities: { ephemeral: true, edits: true } });
    expect(builtInAdapterFromEnvironment({ ...environment, BUILT_IN_ADAPTER: "disabled" })).toBeUndefined();
    expect(builtInAdapterFromEnvironment({ ...environment, BUILT_IN_ADAPTER_SECRET_NAME: "" })).toBeUndefined();
    expect(builtInAdapterFromEnvironment({ ...environment, BUILT_IN_ADAPTER_CALLBACK_URL: "http://localhost/events" })).toBeUndefined();
  });

  it("answer the built-in adapter for its channel without the registry, and a registered one only while the registry is on", async () => {
    const stored = registry({ ...builtIn, channel: "chatops", builtIn: true, commandsUrl: "https://adapter.example.com/commands", projects: ["web"], stepUp: ["admin"], updatedBy: "admin" });
    expect(await adapterForChannel(stored, "slack", { builtIn, registry: false })).toBe(builtIn);
    expect(await adapterForChannel(stored, "slack", { registry: true })).toBeUndefined();
    expect(await adapterForChannel(stored, "chatops", { builtIn, registry: false })).toBeUndefined();
    // A stored row is a registered adapter, whatever it says, and keeps its commands URL.
    const read = await adapterForChannel(stored, "chatops", { builtIn, registry: true });
    expect(read).toMatchObject({ channel: "chatops", commandsUrl: "https://adapter.example.com/commands" });
    expect(read).not.toHaveProperty("builtIn");
    expect(await getChannelAdapter(stored, "chatops")).toEqual(read);
  });

  it("read the deployment's generated secret as a signing secret, and a revoked one as none", () => {
    const generated = "A".repeat(32) + "b".repeat(16) + "0123456789abcdef";
    expect(usableWebhookSecret(generated)).toBe(`whsec_${generated}`);
    expect(usableWebhookSecret(SECRET)).toBe(SECRET);
    expect(usableWebhookSecret("revoked_abc")).toBeUndefined();
    expect(usableWebhookSecret(undefined)).toBeUndefined();
  });
});

describe("the channel API and a registered adapter", () => {
  it("still requires a link, a registered project and step-up for every channel but the built-in one", async () => {
    const registered = { ...builtIn, channel: "chatops", builtIn: undefined, projects: ["web"], stepUp: ["plan_approval" as const, "admin" as const] };
    const queued: ChannelQueueItem[] = [];
    const ingress = createChannelIngressHandler({
      getAdapter: async (channel) => (channel === "chatops" ? registered : undefined), getSecret: async () => SECRET,
      getBinding: async (ref) => ({ ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      linkedDeveloper: async () => "dev-1", issueLinkCode: vi.fn(), linkUrl: (code) => code,
      claim: async () => true, release: async () => undefined, enqueue: async (item) => { queued.push(item); }, sendEvent: async () => undefined, now: () => NOW, log: () => undefined,
    });
    const body = JSON.stringify({ version: 2, channel: "chatops", eventId: "e1", conversation: { channel: "chatops", tenant: "T1", space: "S1", thread: "t" }, actor: { channel: "chatops", tenant: "T1", userId: "U1" }, text: "hi", receivedAt: "2026-11-11T09:59:59.000Z" });
    const response = await ingress({ rawPath: "/v1/channels/chatops/messages", body, headers: webhookHeaders({ secret: SECRET, id: "m1", timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } });
    expect(response.statusCode).toBe(202);
    expect(queued[0]).toMatchObject({ developerId: "dev-1", stepUp: ["plan_approval", "admin"] });
    // Slack's path answers nothing unless the deployment's built-in adapter is on.
    const slackBody = JSON.stringify({ version: 2, channel: "slack", eventId: "EvX0001", conversation, actor: { channel: "slack", tenant: thread.teamId, userId: "U0123456789" }, text: "hi", receivedAt: "2026-11-11T09:59:59.000Z" });
    expect((await ingress({ rawPath: "/v1/channels/slack/messages", body: slackBody, headers: webhookHeaders({ secret: SECRET, id: "m2", timestamp: NOW / 1000, body: slackBody }), requestContext: { http: { method: "POST" } } })).statusCode).toBe(404);
  });

  it("drops a Slack item when the orchestrator has no Slack surface, and runs nothing", async () => {
    const logs: string[] = [];
    const handle = channelRequestHandler({ processor: {} as never, send: vi.fn(), log: (name) => { logs.push(name); } });
    await handle({ kind: "message", projectName: "web", stepUp: [], message: { version: 2, channel: "slack", eventId: "EvX0002", conversation, actor: { channel: "slack", tenant: thread.teamId, userId: "U0123456789" }, text: "hi", receivedAt: "2026-11-11T09:59:59.000Z" } }, { finalAttempt: false });
    expect(logs).toEqual(["channel.surface_missing"]);
  });
});
