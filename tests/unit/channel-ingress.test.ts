// Spec 062 FR-021, FR-024, FR-030, SC-003: the channel API accepts only signed, fresh, bound and linked requests.
import { describe, expect, it, vi } from "vitest";
import { generateWebhookSecret, webhookHeaders, type ChannelAdapterRecord, type ChannelEvent, type ChannelQueueItem } from "@agentx/contracts";
import { createChannelIngressHandler, type ChannelIngressDependencies } from "../../packages/broker/src/aws/channel-ingress.js";

const NOW = Date.parse("2026-11-08T10:00:00.000Z");
const secret = generateWebhookSecret();
const conversation = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };
const adapter: ChannelAdapterRecord = {
  channel: "whatsapp", callbackUrl: "https://adapter.example.com/rovara",
  capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
  projects: ["web"], stepUp: ["plan_approval", "admin"], secretName: "agentx/test/channel-adapter/whatsapp",
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin",
};
const message = {
  version: 2, channel: "whatsapp", eventId: "wamid.HBgL1", conversation, actor, text: "fix the navigation bug", receivedAt: "2026-11-08T09:59:59.000Z",
};
const decision = {
  version: 1, channel: "whatsapp", eventId: "wamid.HBgL2", conversation, actor, requestId: "7f1c2a4e-9b0d-4c3e-8a5f-1d2e3f4a5b6c",
  expectedRevision: 3, artifactDigest: "a".repeat(64), decision: "REQUEST_CHANGES", reason: "keep the old menu", receivedAt: "2026-11-08T09:59:59.000Z",
};

function harness(overrides: Partial<ChannelIngressDependencies> = {}) {
  const issueLinkCode = vi.fn(async () => ({ code: "c".repeat(32), expiresAt: NOW / 1000 + 600 }));
  const claims = new Set<string>();
  const queued: ChannelQueueItem[] = [];
  const events: ChannelEvent[] = [];
  const deps: ChannelIngressDependencies = {
    getAdapter: async (channel) => (channel === "whatsapp" ? adapter : undefined),
    getSecret: async () => secret,
    getBinding: async (ref) => (ref.space === conversation.space ? { ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" } : undefined),
    linkedDeveloper: async (who) => (who.userId === actor.userId ? "dev-1" : undefined),
    issueLinkCode,
    linkUrl: (code) => `https://rovara.example.com/review/link/${code}`,
    claim: async (key) => { if (claims.has(key)) return false; claims.add(key); return true; },
    release: async (key) => { claims.delete(key); },
    enqueue: vi.fn(async (item: ChannelQueueItem) => { queued.push(item); }),
    sendEvent: vi.fn(async (event: ChannelEvent) => { events.push(event); }),
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  };
  const handler = createChannelIngressHandler(deps);
  let counter = 0;
  const post = (path: string, value: unknown, options: { id?: string; timestamp?: number; signWith?: string; tamper?: boolean } = {}) => {
    const body = JSON.stringify(value);
    const id = options.id ?? `msg_${++counter}`;
    const headers = webhookHeaders({ secret: options.signWith ?? secret, id, timestamp: options.timestamp ?? NOW / 1000, body });
    return handler({ rawPath: path, body: options.tamper === true ? body.replace("navigation", "billing") : body, headers, requestContext: { http: { method: "POST" } } });
  };
  return { deps, handler, post, queued, events, claims, issueLinkCode };
}

const MESSAGES = "/v1/channels/whatsapp/messages";
const DECISIONS = "/v1/channels/whatsapp/decisions";
const status = (response: { statusCode: number; body: string }) => ({ statusCode: response.statusCode, ...(JSON.parse(response.body) as Record<string, unknown>) });

describe("an accepted message", () => {
  it("is queued with the bound project and linked developer, and acknowledged", async () => {
    const { post, queued, events } = harness();
    expect(status(await post(MESSAGES, message))).toEqual({ statusCode: 202, status: "accepted" });
    expect(queued).toEqual([{ kind: "message", message, projectName: "web", developerId: "dev-1", stepUp: ["plan_approval", "admin"] }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "ack", channel: "whatsapp", conversation, data: { inReplyTo: "wamid.HBgL1" } });
  });

  it("queues a decision without an ack", async () => {
    const { post, queued, events } = harness();
    expect((await post(DECISIONS, decision)).statusCode).toBe(202);
    expect(queued).toEqual([{ kind: "decision", decision, projectName: "web", developerId: "dev-1", stepUp: ["plan_approval", "admin"] }]);
    expect(events).toEqual([]);
  });

  it("is still accepted, once, when the ack cannot be sent", async () => {
    const { post, queued } = harness({ sendEvent: async () => { throw new Error("queue down"); } });
    expect((await post(MESSAGES, message)).statusCode).toBe(202);
    expect(queued).toHaveLength(1);
  });
});

describe("refusals run nothing (SC-003)", () => {
  it.each([
    ["a bad signature", { tamper: true }, 401, "bad_signature"],
    ["another secret", { signWith: generateWebhookSecret() }, 401, "bad_signature"],
    ["a stale timestamp", { timestamp: NOW / 1000 - 301 }, 401, "stale_timestamp"],
  ])("refuses %s", async (_name, options, statusCode, error) => {
    const { post, queued, events } = harness();
    expect(status(await post(MESSAGES, message, options))).toEqual({ statusCode, error });
    expect(queued).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses an unregistered channel and slack, which has its own ingress", async () => {
    const { post } = harness();
    expect((await post("/v1/channels/telegram/messages", { ...message, channel: "telegram" })).statusCode).toBe(404);
    expect((await post("/v1/channels/slack/messages", message)).statusCode).toBe(404);
  });

  it("refuses a body claiming another channel, so one adapter cannot speak for another", async () => {
    const telegram = { ...message, channel: "telegram", conversation: { ...conversation, channel: "telegram" }, actor: { ...actor, channel: "telegram" } };
    const { post, queued } = harness();
    expect(status(await post(MESSAGES, telegram))).toEqual({ statusCode: 403, error: "channel_mismatch" });
    expect(queued).toEqual([]);
  });

  it("refuses an unbound space, and a space bound to a project the adapter is not registered for", async () => {
    const unbound = harness();
    expect(status(await unbound.post(MESSAGES, { ...message, conversation: { ...conversation, space: "group=Other" } }))).toEqual({ statusCode: 403, error: "space_not_bound" });
    const otherProject = harness({ getBinding: async (ref) => ({ ...ref, projectName: "billing", updatedAt: "2026-11-01T00:00:00.000Z" }) });
    expect(status(await otherProject.post(MESSAGES, message))).toEqual({ statusCode: 403, error: "space_not_bound" });
    expect([...unbound.queued, ...otherProject.queued]).toEqual([]);
  });

  it("refuses an actor from another tenant than the conversation", async () => {
    const { post } = harness();
    expect(status(await post(MESSAGES, { ...message, actor: { ...actor, tenant: "+14155550199" } }))).toEqual({ statusCode: 403, error: "actor_tenant_mismatch" });
  });

  it("refuses an invalid body and a missing secret", async () => {
    expect(status(await harness().post(MESSAGES, { ...message, text: "" }))).toEqual({ statusCode: 400, error: "invalid_body" });
    expect((await harness({ getSecret: async () => undefined }).post(MESSAGES, message)).statusCode).toBe(503);
  });
});

describe("replays and duplicates", () => {
  it("runs a replayed webhook-id once", async () => {
    const { post, queued } = harness();
    await post(MESSAGES, message, { id: "msg_same" });
    expect(status(await post(MESSAGES, message, { id: "msg_same" }))).toEqual({ statusCode: 200, status: "duplicate" });
    expect(queued).toHaveLength(1);
  });

  it("runs an adapter's resend of the same event once, under a new webhook-id", async () => {
    const { post, queued } = harness();
    await post(MESSAGES, message);
    expect(status(await post(MESSAGES, message))).toEqual({ statusCode: 200, status: "duplicate" });
    expect(queued).toHaveLength(1);
  });

  it("releases its claims when queueing fails, so the adapter's retry runs", async () => {
    let fail = true;
    const queued: ChannelQueueItem[] = [];
    const { post } = harness({ enqueue: async (item) => { if (fail) throw new Error("queue down"); queued.push(item); } });
    expect((await post(MESSAGES, message, { id: "msg_retry" })).statusCode).toBe(500);
    fail = false;
    expect((await post(MESSAGES, message, { id: "msg_retry" })).statusCode).toBe(202);
    expect(queued).toHaveLength(1);
  });
});

describe("unlinked actors (FR-030)", () => {
  const stranger = { ...actor, userId: "+919000000001" };

  it("run nothing and get one link_required event an hour", async () => {
    const { post, queued, events, issueLinkCode } = harness();
    expect(status(await post(MESSAGES, { ...message, actor: stranger }))).toEqual({ statusCode: 202, status: "link_required" });
    expect(status(await post(MESSAGES, { ...message, eventId: "wamid.HBgL9", actor: stranger }))).toEqual({ statusCode: 202, status: "link_required" });
    expect(queued).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "link_required", conversation,
      data: { linkUrl: `https://rovara.example.com/review/link/${"c".repeat(32)}`, expiresAt: "2026-11-08T10:10:00.000Z", actor: stranger },
    });
    expect(issueLinkCode).toHaveBeenCalledTimes(1);
  });

  it("cannot post a decision either", async () => {
    const { post, queued } = harness();
    expect(status(await post(DECISIONS, { ...decision, actor: stranger }))).toEqual({ statusCode: 202, status: "link_required" });
    expect(queued).toEqual([]);
  });

  it("get their notice on the retry when sending it failed", async () => {
    let fail = true;
    const events: ChannelEvent[] = [];
    const { post } = harness({ sendEvent: async (event) => { if (fail) throw new Error("queue down"); events.push(event); } });
    expect((await post(MESSAGES, { ...message, actor: stranger }, { id: "msg_link" })).statusCode).toBe(500);
    fail = false;
    expect((await post(MESSAGES, { ...message, actor: stranger }, { id: "msg_link" })).statusCode).toBe(202);
    expect(events.map((event) => event.type)).toEqual(["link_required"]);
  });
});
