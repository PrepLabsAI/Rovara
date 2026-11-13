// Spec 062 Phase 1: the neutral conversation model, and that Slack's keys do not move.
import { describe, expect, it } from "vitest";
import {
  ActorRefSchema, ConversationRefSchema, InboundMessageSchema, SLACK_THREAD_OWNER_ISSUER, actorFromSlackRequester,
  conversationFromSlackThread, conversationOwnerIssuer, conversationSubject, inboundFromSlackRequest,
  parseConversationSubject, parseSlackThreadSubject, readSlackRequestMessage, slackRequestFromInbound,
  slackRequesterOf, slackThreadOf, slackThreadSubject, type ConversationRef, type InboundMessage, type SlackRequestMessage,
} from "@rovara-code/contracts";

const thread = { teamId: "T0123ABCD", channelId: "C0456EFGH", threadTs: "1760000000.000100" };
const slackRef: ConversationRef = { channel: "slack", tenant: "T0123ABCD", space: "C0456EFGH", thread: "1760000000.000100" };
const whatsappRef: ConversationRef = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const v1: SlackRequestMessage = {
  version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "fix the navigation bug", receivedAt: "2026-11-08T10:00:00.000Z",
};
const v2: InboundMessage = {
  version: 2, channel: "slack", eventId: "Ev0000000001", conversation: slackRef,
  actor: { channel: "slack", tenant: "T0123ABCD", userId: "U0123456789" }, text: "fix the navigation bug", receivedAt: "2026-11-08T10:00:00.000Z",
};

describe("Slack keys are unchanged", () => {
  it("a Slack conversation's subject is exactly today's thread subject", () => {
    expect(conversationSubject(conversationFromSlackThread(thread))).toBe(slackThreadSubject(thread));
    expect(conversationSubject(slackRef)).toBe("T0123ABCD/C0456EFGH/1760000000.000100");
  });

  it("a Slack conversation keeps the slack-thread owner issuer, so workspace owner keys do not move", () => {
    expect(conversationOwnerIssuer("slack")).toBe(SLACK_THREAD_OWNER_ISSUER);
  });

  it("converts a Slack thread and requester both ways", () => {
    expect(slackThreadOf(conversationFromSlackThread(thread))).toEqual(thread);
    const requester = { teamId: "T0123ABCD", userId: "U0123456789" };
    expect(slackRequesterOf(actorFromSlackRequester(requester))).toEqual(requester);
  });

  it("parses a three-segment subject as Slack, the same as the Slack parser", () => {
    const subject = slackThreadSubject(thread);
    expect(parseConversationSubject(subject)).toEqual(slackRef);
    expect(slackThreadOf(parseConversationSubject(subject))).toEqual(parseSlackThreadSubject(subject));
  });
});

describe("other channels", () => {
  it("use a four-segment subject that round-trips", () => {
    const subject = conversationSubject(whatsappRef);
    expect(subject).toBe("whatsapp/+14155550100/group=AbC-12_x/main");
    expect(parseConversationSubject(subject)).toEqual(whatsappRef);
  });

  it("get an owner issuer of their own that cannot equal Slack's or an OIDC issuer", () => {
    const issuer = conversationOwnerIssuer("whatsapp");
    expect(issuer).toBe("channel-thread:whatsapp");
    expect(issuer).not.toBe(SLACK_THREAD_OWNER_ISSUER);
    expect(issuer.startsWith("https:")).toBe(false);
  });

  it("refuse a Slack reference written as four segments, so each conversation has one subject", () => {
    expect(() => parseConversationSubject("slack/T0123ABCD/C0456EFGH/1760000000.000100")).toThrow();
  });

  it("refuse a non-Slack reference to Slack conversions", () => {
    expect(() => slackThreadOf(whatsappRef)).toThrow();
    expect(() => slackRequesterOf({ channel: "whatsapp", tenant: "+14155550100", userId: "+14155550123" })).toThrow();
  });
});

describe("validation", () => {
  it.each([
    ["a slash in an ID", { ...whatsappRef, space: "a/b" }],
    ["an empty ID", { ...whatsappRef, thread: "" }],
    ["an ID over 128 characters", { ...whatsappRef, tenant: "x".repeat(129) }],
    ["a space in an ID", { ...whatsappRef, thread: "a b" }],
    ["an upper-case channel", { ...whatsappRef, channel: "WhatsApp" }],
    ["a one-letter channel", { ...whatsappRef, channel: "w" }],
    ["a Slack reference with a non-Slack team ID", { ...slackRef, tenant: "team-1" }],
    ["a Slack reference with a malformed thread timestamp", { ...slackRef, thread: "main" }],
    ["an extra field", { ...whatsappRef, extra: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(ConversationRefSchema.safeParse(value).success).toBe(false);
  });

  it("refuses a Slack actor with a non-Slack user ID", () => {
    expect(ActorRefSchema.safeParse({ channel: "slack", tenant: "T0123ABCD", userId: "+14155550123" }).success).toBe(false);
  });

  it("refuses subjects with too few or too many segments", () => {
    expect(() => parseConversationSubject("T0123ABCD/C0456EFGH")).toThrow();
    expect(() => parseConversationSubject("a/b/c/d/e")).toThrow();
  });

  it("refuses an inbound message whose conversation or actor is on another channel", () => {
    expect(InboundMessageSchema.safeParse({ ...v2, conversation: whatsappRef }).success).toBe(false);
    expect(InboundMessageSchema.safeParse({ ...v2, channel: "whatsapp", conversation: whatsappRef }).success).toBe(false);
    expect(InboundMessageSchema.safeParse(v2).success).toBe(true);
  });
});

describe("queued requests", () => {
  it("converts a version 1 Slack request to an inbound message and back with no loss", () => {
    expect(inboundFromSlackRequest(v1)).toEqual(v2);
    expect(slackRequestFromInbound(v2)).toEqual(v1);
  });

  it("reads both versions as the Slack request the service handles today", () => {
    expect(readSlackRequestMessage(v1)).toEqual(v1);
    expect(readSlackRequestMessage(v2)).toEqual(v1);
  });

  it("reads nothing from a non-Slack inbound message, a Slack one with a non-Slack event ID, or junk", () => {
    const whatsapp: InboundMessage = {
      ...v2, channel: "whatsapp", conversation: whatsappRef, actor: { channel: "whatsapp", tenant: "+14155550100", userId: "+14155550123" },
    };
    expect(InboundMessageSchema.safeParse(whatsapp).success).toBe(true);
    expect(readSlackRequestMessage(whatsapp)).toBeUndefined();
    expect(readSlackRequestMessage({ ...v2, eventId: "wamid.HBgL" })).toBeUndefined();
    expect(readSlackRequestMessage({ version: 3 })).toBeUndefined();
    expect(readSlackRequestMessage("not json")).toBeUndefined();
  });
});
