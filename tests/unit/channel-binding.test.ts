// Spec 062 Phase 2: neutral channel bindings, and that Slack binding keys and rows do not move.
import { describe, expect, it } from "vitest";
import {
  ChannelBindingSchema, channelBindingAttributes, channelBindingFromSlack, channelBindingKey, channelBindingPartition,
  channelBindingSortPrefix, isChannelBindingKeyOf, readChannelBindingItem, slackBindingOf, type ChannelBinding,
} from "@rovara-code/contracts";

const slackRef = { channel: "slack", tenant: "T0123ABCD", space: "C0456EFGH" };
const whatsappRef = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x" };
const slackBinding = { teamId: "T0123ABCD", channelId: "C0456EFGH", projectName: "web", updatedAt: "2026-11-08T10:00:00.000Z" };
const whatsappBinding: ChannelBinding = { ...whatsappRef, projectName: "web", updatedAt: "2026-11-08T10:00:00.000Z" };

describe("Slack bindings are unchanged", () => {
  it("keep today's key", () => {
    expect(channelBindingKey(slackRef)).toEqual({ pk: "SLACK_BINDING#T0123ABCD", sk: "CHANNEL#C0456EFGH" });
    expect(channelBindingPartition("slack", "T0123ABCD")).toBe("SLACK_BINDING#T0123ABCD");
    expect(channelBindingSortPrefix("slack")).toBe("CHANNEL#");
  });

  it("keep today's stored attributes", () => {
    expect(channelBindingAttributes(channelBindingFromSlack(slackBinding))).toEqual({ entityType: "SLACK_BINDING", ...slackBinding });
  });

  it("read a stored row, including one with a legacy projectRevision, and convert back", () => {
    const row = { ...channelBindingKey(slackRef), entityType: "SLACK_BINDING", ...slackBinding, projectRevision: 3, updatedBy: "owner" };
    const binding = readChannelBindingItem(slackRef, row);
    expect(binding).toEqual({ ...slackRef, projectName: "web", updatedAt: slackBinding.updatedAt });
    expect(slackBindingOf(binding!)).toEqual(slackBinding);
  });

  it("query an unset or malformed team as given, so it finds nothing rather than throwing", () => {
    expect(channelBindingPartition("slack", "")).toBe("SLACK_BINDING#");
  });
});

describe("other channels", () => {
  it("use their own partition and sort prefix", () => {
    expect(channelBindingKey(whatsappRef)).toEqual({ pk: "BINDING#whatsapp/+14155550100", sk: "SPACE#group=AbC-12_x" });
    expect(channelBindingSortPrefix("whatsapp")).toBe("SPACE#");
  });

  it("store and read the neutral fields", () => {
    const attributes = channelBindingAttributes(whatsappBinding);
    expect(attributes).toEqual({ entityType: "CHANNEL_BINDING", ...whatsappBinding });
    expect(readChannelBindingItem(whatsappRef, { ...channelBindingKey(whatsappRef), ...attributes })).toEqual(whatsappBinding);
  });

  it("cannot reach a Slack binding's partition", () => {
    expect(channelBindingPartition("whatsapp", "T0123ABCD")).not.toBe(channelBindingPartition("slack", "T0123ABCD"));
  });

  it("refuse a tenant with a slash, so the partition is unambiguous", () => {
    expect(() => channelBindingPartition("whatsapp", "a/b")).toThrow();
    expect(() => channelBindingKey({ ...whatsappRef, tenant: "a/b" })).toThrow();
  });

  it("refuse Slack conversions", () => {
    expect(() => slackBindingOf(whatsappBinding)).toThrow();
  });
});

describe("reading and checking stored rows", () => {
  it("reads no row as unbound", () => {
    expect(readChannelBindingItem(slackRef, undefined)).toBeUndefined();
  });

  it("throws for a malformed row or one naming another space, rather than reading it as unbound", () => {
    expect(() => readChannelBindingItem(slackRef, { ...slackBinding, projectName: "Not A Name!" })).toThrow();
    expect(() => readChannelBindingItem(slackRef, { ...slackBinding, channelId: "C0999ZZZZ" })).toThrow();
    expect(() => readChannelBindingItem(whatsappRef, { ...whatsappBinding, channel: "telegram" })).toThrow();
  });

  it("checks a row's key without throwing", () => {
    expect(isChannelBindingKeyOf(channelBindingKey(slackRef), slackRef)).toBe(true);
    expect(isChannelBindingKeyOf({ pk: "SLACK_BINDING#T0123ABCD", sk: "CHANNEL#C0999ZZZZ" }, slackRef)).toBe(false);
    expect(isChannelBindingKeyOf(channelBindingKey(slackRef), { ...slackRef, space: "not-a-channel" })).toBe(false);
  });

  it("refuses a Slack binding with a non-Slack ID", () => {
    expect(ChannelBindingSchema.safeParse({ ...slackRef, space: "group=1", projectName: "web", updatedAt: slackBinding.updatedAt }).success).toBe(false);
  });
});
