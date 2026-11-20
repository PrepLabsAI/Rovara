// tests/contract/admin-read-bindings.test.ts
// Spec 025 A11: channel bindings, with public channels' names and private channels by ID only.
import { describe, expect, it, vi } from "vitest";
import { channelLabels } from "../../packages/broker/src/aws/admin-reads.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, issuer } from "../support/slack-broker.js";

describe("GET /v1/admin/slack/bindings (FR-038, FR-030)", () => {

  it("lists channels by ID with a notice when the name lookup is not set up or fails", async () => {
    const unset = await createAdminReadBroker({ channelInfo: null });
    expect((await unset.admin("GET", "/v1/admin/slack/bindings")).body).toMatchObject({
      bindings: [{ channelId: SLACK_CHANNEL, projectName: "payments" }], notices: ["channel_names_unavailable"],
    });
    const failing = await createAdminReadBroker({ channelInfo: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect((await failing.admin("GET", "/v1/admin/slack/bindings")).body.notices).toEqual(["channel_names_unavailable"]);
  });

  it("asks for team= where the environment records no Slack team, and refuses a malformed one", async () => {
    const { admin } = await createAdminReadBroker({ slackTeamId: null });
    expect((await admin("GET", "/v1/admin/slack/bindings")).body.error).toEqual({
      code: "CONFIG_INVALID", message: "this environment records no Slack team; send team=<team ID>, such as team=T0123456789",
    });
    expect((await admin("GET", `/v1/admin/slack/bindings?team=${SLACK_TEAM}`)).body.bindings).toHaveLength(1);
    expect((await admin("GET", "/v1/admin/slack/bindings?team=<script>")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  // Ruling R24 (A11): an environment that records its Slack team lists that team only.
  it("refuses team= where the environment records its Slack team, and says to leave it out", async () => {
    const { admin } = await createAdminReadBroker();
    for (const team of [SLACK_TEAM, "T0OTHER0001"]) {
      expect((await admin("GET", `/v1/admin/slack/bindings?team=${team}`)).body.error).toEqual({
        code: "CONFIG_INVALID", message: "this environment records its Slack team; leave out team",
      });
    }
    expect((await admin("GET", "/v1/admin/slack/bindings")).body.bindings).toHaveLength(1);
  });

});

describe("private channel names for a member admin (A11, Q7 as answered)", () => {
  const userinfo: typeof globalThis.fetch = async (input) => ((typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith("/.well-known/openid-configuration")
    ? Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" })
    : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }));
  const channelInfo = async (request: { channelIds: string[] }) => ({ ok: true as const, channels: request.channelIds.map((channelId) => (channelId === "C0PRIVATE01" ? { channelId, name: "secret-launch", isPrivate: true } : { channelId, name: "payments-dev", isPrivate: false })) });
  async function broker(options: { linked: boolean; member: boolean; membersFail?: boolean; membersThrow?: boolean; name?: string }) {
    const name = options.name;
    const harness = await createAdminReadBroker({
      channelInfo: name === undefined ? channelInfo : async (request) => ({ ok: true as const, channels: (await channelInfo(request)).channels.map((channel) => (channel.isPrivate ? { ...channel, name } : channel)) }),
      channelMembers: async (request) => (options.membersThrow ? Promise.reject(Object.assign(new Error("members down"), { name: "TimeoutError" })) : options.membersFail ? { ok: false, error: "slack_unavailable" } : { ok: true, memberOf: options.member && request.slackUserId === "U0ADA00001" ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] }),
      brokerExtra: { adminReads: { me: { issuer, fetch: userinfo, slackUserByEmail: async () => (options.linked ? { ok: true, userId: "U0ADA00001" } : { ok: true }) } } },
    });
    await bindChannel(harness.handler, "C0PRIVATE01");
    return harness;
  }
  const privateRow = async (options: { linked: boolean; member: boolean; membersFail?: boolean; membersThrow?: boolean; name?: string }) =>
    ((await (await broker(options)).admin("GET", "/v1/admin/slack/bindings")).body.bindings as Array<Record<string, unknown>>).find((row) => row.channelId === "C0PRIVATE01");

  it("lists it by ID only when the admin is not a member, has no Slack link, or the check fails", async () => {
    for (const options of [{ linked: true, member: false }, { linked: false, member: true }, { linked: true, member: true, membersFail: true }, { linked: true, member: true, membersThrow: true }]) {
      const row = await privateRow(options);
      expect(row, JSON.stringify(options)).toMatchObject({ private: true });
      expect(row, JSON.stringify(options)).not.toHaveProperty("channelName");
    }
  });

});

it("scoped admin label and membership callbacks keep identical ids in their workspace", async () => {
  const { privateChannelsFor } = await import("../../packages/broker/src/aws/admin-reads.js");
  for (const [companyId, teamId] of [["org_aaaaaaaaaaaaaaaaaaaa", "T0AAAAAAA"], ["org_bbbbbbbbbbbbbbbbbbbb", "T0BBBBBBB"]] as const) {
    const workspace = { companyId, teamId };
    const channelInfo = vi.fn(async () => ({ ok: true as const, channels: [] }));
    const channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: [] }));
    const deps = { channelInfo, channelMembers, log: vi.fn(), slackWorkspaces: { requireCompany: async () => companyId }, workspace };
    await channelLabels(deps as never, ["C0SHARED"]);
    await privateChannelsFor(deps as never, "U0SHARED", ["C0SHARED"]);
    expect(channelInfo).toHaveBeenCalledExactlyOnceWith({ kind: "channel-info", channelIds: ["C0SHARED"], workspace });
    expect(channelMembers).toHaveBeenCalledExactlyOnceWith({ kind: "channel-members", slackUserId: "U0SHARED", channelIds: ["C0SHARED"], workspace });
  }
});

it("admin directory callbacks refuse absent, malformed or foreign scope without transport", async () => {
  const { privateChannelsFor } = await import("../../packages/broker/src/aws/admin-reads.js");
  for (const workspace of [undefined, { companyId: "invalid-canary", teamId: "T0AAAAAAA" }, { companyId: "org_bbbbbbbbbbbbbbbbbbbb", teamId: "T0AAAAAAA" }]) {
    const channelInfo = vi.fn(), channelMembers = vi.fn();
    const deps = { channelInfo, channelMembers, log: vi.fn(), slackWorkspaces: { requireCompany: async () => "org_aaaaaaaaaaaaaaaaaaaa" }, workspace };
    expect(await channelLabels(deps as never, ["C0SHARED"])).toEqual({ labels: new Map(), available: false });
    expect(await privateChannelsFor(deps as never, "U0SHARED", ["C0SHARED"])).toEqual(new Set());
    expect(channelInfo).not.toHaveBeenCalled(); expect(channelMembers).not.toHaveBeenCalled();
  }
});
