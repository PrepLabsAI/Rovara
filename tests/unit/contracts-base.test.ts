import { describe, expect, it } from "vitest";
import {
  PluginKindSchema, PluginNameSchema, companyScoped, AudienceSchema, MAX_RUN_LIMIT_USD, OrgIdSchema, RunEstimateSchema, TRUST_RANK, isRunLimitBlockReason, minTrust, orgChannelBindingKey, orgScoped,
  runLimitBlockText, runLimitWaitingText, singleOrgIdForEnv, slackBindingKey, channelBindingKey, parseBundlePublicKey,
} from "@rovara-code/contracts";

// The base pieces lane L1 adds so Code needs none of Cloud's org, spend or team-record files (decisions 41, 45.6 and 51).
describe("company scope", () => {
  it("builds the one implicit company's id the way Cloud does, and the same every time", () => {
    const id = singleOrgIdForEnv("code");
    expect(OrgIdSchema.safeParse(id).success).toBe(true);
    expect(singleOrgIdForEnv("code")).toBe(id);
    expect(singleOrgIdForEnv("other")).not.toBe(id);
    expect(orgScoped(id, "PROJECT#web")).toBe(`ORG#${id}#PROJECT#web`);
    // One implementation: Cloud's name is W0's function.
    expect(orgScoped).toBe(companyScoped);
    expect(PluginNameSchema).toBe(PluginKindSchema);
  });

  it("scopes Pratik's Slack binding key to exactly Cloud's Slack binding key, and leaves the stored unscoped key alone", () => {
    const orgId = singleOrgIdForEnv("code");
    const ref = { channel: "slack", tenant: "T0123ABCD", space: "C0123ABCD" };
    expect(orgChannelBindingKey(orgId, ref)).toEqual(slackBindingKey(orgId, "T0123ABCD", "C0123ABCD"));
    expect(channelBindingKey(ref)).toEqual({ pk: "SLACK_BINDING#T0123ABCD", sk: "CHANNEL#C0123ABCD" });
  });

  it("scopes another channel's binding key the same way", () => {
    const orgId = singleOrgIdForEnv("code");
    const key = orgChannelBindingKey(orgId, { channel: "teams", tenant: "tenant-1", space: "space-1" });
    expect(key.pk.startsWith(`ORG#${orgId}#BINDING#teams/`)).toBe(true);
    expect(key.sk).toBe("SPACE#space-1");
  });
});

describe("record trust", () => {
  it("never raises trust, and an empty list fails closed", () => {
    expect(minTrust("rovara", "member")).toBe("member");
    expect(minTrust()).toBe("outsider");
    expect(TRUST_RANK.outsider).toBeLessThan(TRUST_RANK.rovara);
  });

  it("accepts any adapter's source id in a permission snapshot, not a fixed list", () => {
    const acl = (source: string) => AudienceSchema.safeParse({ kind: "restricted", acl: { source, scope: "room-1", capturedAt: "2026-11-09T00:00:00.000Z", liveCheck: "none" } }).success;
    expect(acl("slack")).toBe(true);
    expect(acl("codehost:examplehost")).toBe(true);
    expect(acl("teams")).toBe(true);
    expect(acl("Not A Source")).toBe(false);
  });
});

describe("run cost", () => {
  it("knows its own blocked-plan words", () => {
    expect(isRunLimitBlockReason(runLimitBlockText(12, "admin"))).toBe(true);
    expect(isRunLimitBlockReason(runLimitWaitingText(12, "project_maintainer"))).toBe(true);
    expect(isRunLimitBlockReason("Something else")).toBe(false);
    expect(isRunLimitBlockReason(undefined)).toBe(false);
  });

  it("reads an estimate", () => {
    expect(RunEstimateSchema.safeParse({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 }).success).toBe(true);
    expect(MAX_RUN_LIMIT_USD).toBe(1000);
  });
});

describe("signing key", () => {
  it("refuses anything that is not a P-256 public key", () => {
    expect(() => parseBundlePublicKey("not a key")).toThrow(/PEM PUBLIC KEY/);
  });
});
