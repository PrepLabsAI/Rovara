// Spec 062 Phase 3: the channel adapter protocol's contracts, signing and linking helpers.
import { describe, expect, it } from "vitest";
import {
  ChannelAdapterRegistrationSchema, ChannelDecisionSchema, ChannelEventSchema, adapterMayDecide, channelAdapterKey,
  channelAdapterSecretName, channelEventId, channelLinkCodeKey, channelLinkKey, developerChannelLinkKey, generateLinkCode,
  generateWebhookSecret, linkCodeHash, LinkCodeSchema, maskChannelUserId, shapeApprovalRequest, signWebhook, verifyWebhook,
  webhookHeaders, type ChannelCapabilities,
} from "@agentx/contracts";

const whatsapp = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };
const capabilities: ChannelCapabilities = { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false };
const registration = { callbackUrl: "https://adapter.example.com/rovara", capabilities, projects: ["web"] };
const digest = "a".repeat(64);
const requestId = "7f1c2a4e-9b0d-4c3e-8a5f-1d2e3f4a5b6c";

describe("Standard Webhooks signing", () => {
  // The published Standard Webhooks test vector.
  const vector = { secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330, body: '{"test": 2432232314}' };

  it("matches the published test vector", () => {
    expect(signWebhook(vector)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifies its own headers, matching header names in any case", () => {
    const headers = Object.fromEntries(Object.entries(webhookHeaders(vector)).map(([key, value]) => [key.toUpperCase(), value]));
    expect(verifyWebhook({ secret: vector.secret, headers, body: vector.body, nowSeconds: vector.timestamp + 10 })).toEqual({ ok: true, id: vector.id, timestamp: vector.timestamp });
  });

  it("accepts one matching signature among several, as during secret rotation", () => {
    const headers = { ...webhookHeaders(vector), "webhook-signature": `v1,AAAA ${signWebhook(vector)}` };
    expect(verifyWebhook({ secret: vector.secret, headers, body: vector.body, nowSeconds: vector.timestamp }).ok).toBe(true);
  });

  it.each([
    ["a changed body", { body: '{"test": 1}' }, "bad_signature"],
    ["another secret", { secret: generateWebhookSecret() }, "bad_signature"],
    ["a timestamp over 5 minutes old", { nowSeconds: vector.timestamp + 301 }, "stale_timestamp"],
    ["a timestamp over 5 minutes ahead", { nowSeconds: vector.timestamp - 301 }, "stale_timestamp"],
  ])("refuses %s", (_name, change, reason) => {
    const input = { secret: vector.secret, headers: webhookHeaders(vector), body: vector.body, nowSeconds: vector.timestamp, ...change };
    expect(verifyWebhook(input)).toEqual({ ok: false, reason });
  });

  it("refuses missing headers, a non-numeric timestamp and a non-v1 scheme", () => {
    const headers = webhookHeaders(vector);
    const base = { secret: vector.secret, body: vector.body, nowSeconds: vector.timestamp };
    expect(verifyWebhook({ ...base, headers: { ...headers, "webhook-id": undefined } })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyWebhook({ ...base, headers: { ...headers, "webhook-timestamp": "1e9" } })).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verifyWebhook({ ...base, headers: { ...headers, "webhook-signature": headers["webhook-signature"]!.replace("v1,", "v1a,") } })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("makes secrets in the whsec_ form that sign and verify", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const message = { secret, id: "msg_1", timestamp: 1_700_000_000, body: "{}" };
    expect(verifyWebhook({ secret, headers: webhookHeaders(message), body: "{}", nowSeconds: 1_700_000_000 }).ok).toBe(true);
    expect(() => signWebhook({ ...message, secret: "not-a-secret" })).toThrow();
  });
});

describe("adapter registration", () => {
  it("defaults step-up to plan approval and administration", () => {
    expect(ChannelAdapterRegistrationSchema.parse(registration).stepUp).toEqual(["plan_approval", "admin"]);
  });

  it.each([
    ["an http callback", { ...registration, callbackUrl: "http://adapter.example.com/rovara" }],
    ["a callback on a private address", { ...registration, callbackUrl: "https://10.0.0.1/rovara" }],
    ["a callback on a local name", { ...registration, callbackUrl: "https://adapter.internal/rovara" }],
    ["no projects", { ...registration, projects: [] }],
    ["a repeated project", { ...registration, projects: ["web", "web"] }],
    ["more buttons than any surface has", { ...registration, capabilities: { ...capabilities, buttons: 11 } }],
    ["an unknown field", { ...registration, secret: "x" }],
  ])("refuses %s", (_name, value) => {
    expect(ChannelAdapterRegistrationSchema.safeParse(value).success).toBe(false);
  });

  it("keys adapters by channel and refuses slack, which is built in", () => {
    expect(channelAdapterKey("whatsapp")).toEqual({ pk: "CHANNEL_ADAPTERS", sk: "CHANNEL#whatsapp" });
    expect(channelAdapterSecretName("agentx/prod/", "whatsapp")).toBe("agentx/prod/channel-adapter/whatsapp");
    expect(() => channelAdapterKey("slack")).toThrow();
    expect(() => channelAdapterSecretName("agentx/prod/", "slack")).toThrow();
  });
});

describe("decisions and step-up", () => {
  const decision = {
    version: 1, channel: "whatsapp", eventId: "wamid.HBgL", conversation: whatsapp, actor, requestId, expectedRevision: 3,
    artifactDigest: digest, decision: "APPROVE", reason: "looks right", receivedAt: "2026-11-08T10:00:00.000Z",
  };

  it("accepts a decision echoing the request's revision and digest", () => {
    expect(ChannelDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("refuses a decision whose conversation or actor is on another channel", () => {
    expect(ChannelDecisionSchema.safeParse({ ...decision, actor: { ...actor, channel: "telegram" } }).success).toBe(false);
    expect(ChannelDecisionSchema.safeParse({ ...decision, channel: "telegram" }).success).toBe(false);
  });

  it("refuses a stepped-up kind from the adapter and allows the rest", () => {
    expect(adapterMayDecide({ stepUp: ["plan_approval", "admin"] }, "plan_approval")).toBe(false);
    expect(adapterMayDecide({ stepUp: ["admin"] }, "plan_approval")).toBe(true);
    expect(adapterMayDecide({ stepUp: ["plan_approval", "admin"] }, "other")).toBe(true);
  });

  const request = { text: "The plan is ready.", kind: "plan_approval" as const, requestId, expectedRevision: 3, artifactDigest: digest, taskUrl: "https://rovara.example.com/tasks/1" };
  const actions = [{ decision: "APPROVE" as const, label: "Approve" }, { decision: "REQUEST_CHANGES" as const, label: "Request changes" }];

  it("sends a stepped-up approval with the task page link and no actions", () => {
    const shaped = shapeApprovalRequest({ capabilities, stepUp: ["plan_approval"] }, request, actions);
    expect(shaped.actions).toBeUndefined();
    expect(shaped.text).toContain("Approve on the task page: https://rovara.example.com/tasks/1");
  });

  it("sends buttons when the adapter has enough, and numbered replies when it has none", () => {
    expect(shapeApprovalRequest({ capabilities, stepUp: [] }, request, actions).actions).toHaveLength(2);
    const buttonless = shapeApprovalRequest({ capabilities: { ...capabilities, buttons: 0 }, stepUp: [] }, request, actions);
    expect(buttonless.text).toContain("Reply 1 to approve, reply 2 to request changes.");
  });
});

describe("events", () => {
  const base = { version: 1, id: channelEventId(), channel: "whatsapp", conversation: whatsapp, createdAt: "2026-11-08T10:00:00.000Z" };

  it("accepts each event type's data and refuses another type's", () => {
    expect(ChannelEventSchema.safeParse({ ...base, type: "done", data: { text: "Opened a pull request." } }).success).toBe(true);
    expect(ChannelEventSchema.safeParse({ ...base, type: "pr", data: { url: "https://github.com/o/r/pull/1", title: "Fix nav" } }).success).toBe(true);
    expect(ChannelEventSchema.safeParse({ ...base, type: "pr", data: { text: "x" } }).success).toBe(false);
    expect(ChannelEventSchema.safeParse({ ...base, type: "pr", data: { url: "http://github.com/o/r/pull/1", title: "x" } }).success).toBe(false);
  });

  it("refuses an event for Slack or for another channel's conversation", () => {
    expect(ChannelEventSchema.safeParse({ ...base, channel: "slack", type: "done", data: { text: "x" } }).success).toBe(false);
    expect(ChannelEventSchema.safeParse({ ...base, channel: "telegram", type: "done", data: { text: "x" } }).success).toBe(false);
  });

  it("makes event IDs in the evt_ form", () => {
    expect(channelEventId()).toMatch(/^evt_[A-Za-z0-9_-]{24}$/);
    expect(channelEventId()).not.toBe(channelEventId());
  });
});

describe("account linking", () => {
  it("makes one-time codes and stores only their hash", () => {
    const code = generateLinkCode();
    expect(LinkCodeSchema.safeParse(code).success).toBe(true);
    expect(linkCodeHash(code)).toMatch(/^[a-f0-9]{64}$/);
    expect(linkCodeHash(code)).not.toContain(code);
    expect(channelLinkCodeKey(linkCodeHash(code)).pk).toBe(`CHANNEL_LINK_CODE#${linkCodeHash(code)}`);
    expect(() => channelLinkCodeKey(code)).toThrow();
  });

  it("keys a link under the actor and under the developer", () => {
    expect(channelLinkKey(actor)).toEqual({ pk: "CHANNEL_LINK#whatsapp/+14155550100", sk: "USER#+919876544821" });
    expect(developerChannelLinkKey("dev-1", actor)).toEqual({ pk: "DEVELOPER_CHANNEL_LINKS#dev-1", sk: "whatsapp/+14155550100/+919876544821" });
  });

  it("never links a Slack actor, whom Slack verifies itself", () => {
    expect(() => channelLinkKey({ channel: "slack", tenant: "T0123ABCD", userId: "U0123456789" })).toThrow();
  });

  it("masks a user ID for the confirmation", () => {
    expect(maskChannelUserId("+919876544821")).toBe("+91 ••• 4821");
    expect(maskChannelUserId("12345")).toBe("•••");
  });
});
