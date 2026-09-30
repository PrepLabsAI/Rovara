// tests/contract/admin-read-bindings.test.ts
// Spec 025 A11: channel bindings, with public channels' names and private channels by ID only.
import { describe, expect, it, vi } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, issuer } from "../support/slack-broker.js";

describe("GET /v1/admin/slack/bindings (FR-038, FR-030)", () => {
  it("lists the environment team's bindings with public names, and a private channel by ID only", async () => {
    const channelInfo = vi.fn(async (request: { channelIds: string[] }) => ({
      ok: true as const,
      channels: request.channelIds.map((channelId) => (channelId === SLACK_CHANNEL
        ? { channelId, name: "payments-dev", isPrivate: false }
        : { channelId, name: "secret-launch", isPrivate: true })),
    }));
    const { admin, handler } = await createAdminReadBroker({ channelInfo });
    await bindChannel(handler, "C0PRIVATE01");
    const answer = await admin("GET", "/v1/admin/slack/bindings");
    expect(answer.body).toEqual({
      bindings: [
        { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, channelName: "payments-dev", private: false, projectName: "payments", updatedAt: expect.any(String) as unknown },
        { teamId: SLACK_TEAM, channelId: "C0PRIVATE01", private: true, projectName: "payments", updatedAt: expect.any(String) as unknown },
      ],
      notices: [],
      requestId: expect.any(String) as unknown,
    });
    expect(JSON.stringify(answer.body)).not.toContain("secret-launch");
  });

  it("lists channels by ID with a notice when the name lookup is not set up or fails", async () => {
    const unset = await createAdminReadBroker({ channelInfo: null });
    expect((await unset.admin("GET", "/v1/admin/slack/bindings")).body).toMatchObject({
      bindings: [{ channelId: SLACK_CHANNEL, projectName: "payments" }], notices: ["channel_names_unavailable"],
    });
    const failing = await createAdminReadBroker({ channelInfo: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect((await failing.admin("GET", "/v1/admin/slack/bindings")).body.notices).toEqual(["channel_names_unavailable"]);
  });

  it("redacts a token-shaped public channel name (A16) and lists a channel the lookup does not return by ID", async () => {
    const planted = `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"a".repeat(24)}`;
    const channelInfo = async (request: { channelIds: string[] }) => ({
      ok: true as const,
      channels: request.channelIds.filter((channelId) => channelId === SLACK_CHANNEL).map((channelId) => ({ channelId, name: planted, isPrivate: false })),
    });
    const { admin, handler } = await createAdminReadBroker({ channelInfo });
    await bindChannel(handler, "C0MISSING01");
    const answer = await admin("GET", "/v1/admin/slack/bindings");
    const bindings = answer.body.bindings as Array<Record<string, unknown>>;
    expect(bindings[0]).toMatchObject({ channelId: SLACK_CHANNEL, private: false });
    expect(bindings[0]?.channelName).toContain("[REDACTED]");
    expect(JSON.stringify(answer.body)).not.toContain(planted);
    // A channel Slack did not return (deleted, or the bot cannot see it) is listed by ID, with neither name nor privacy.
    expect(bindings[1]).toEqual({ teamId: SLACK_TEAM, channelId: "C0MISSING01", projectName: "payments", updatedAt: expect.any(String) as unknown });
    expect(answer.body.notices).toEqual([]);
  });

  it("asks for team= where the environment records no Slack team, and refuses a malformed one", async () => {
    const { admin } = await createAdminReadBroker({ slackTeamId: null });
    expect((await admin("GET", "/v1/admin/slack/bindings")).body.error).toEqual({
      code: "CONFIG_INVALID", message: "this environment records no Slack team; send team=<team ID>, such as team=T0123456789",
    });
    expect((await admin("GET", `/v1/admin/slack/bindings?team=${SLACK_TEAM}`)).body.bindings).toHaveLength(1);
    expect((await admin("GET", "/v1/admin/slack/bindings?team=<script>")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a non-admin", async () => {
    const { admin } = await createAdminReadBroker();
    expect((await admin("GET", "/v1/admin/slack/bindings", { admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("private channel names for a member admin (A11, Q7 as answered)", () => {
  const userinfo: typeof globalThis.fetch = async (input) => ((typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith("/.well-known/openid-configuration")
    ? Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" })
    : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }));
  const channelInfo = async (request: { channelIds: string[] }) => ({ ok: true as const, channels: request.channelIds.map((channelId) => (channelId === "C0PRIVATE01" ? { channelId, name: "secret-launch", isPrivate: true } : { channelId, name: "payments-dev", isPrivate: false })) });
  async function broker(options: { linked: boolean; member: boolean; membersFail?: boolean; membersThrow?: boolean; name?: string }) {
    const harness = await createAdminReadBroker({
      channelInfo: options.name === undefined ? channelInfo : async (request) => ({ ok: true as const, channels: (await channelInfo(request)).channels.map((channel) => (channel.isPrivate ? { ...channel, name: options.name } : channel)) }),
      channelMembers: async (request) => (options.membersThrow ? Promise.reject(Object.assign(new Error("members down"), { name: "TimeoutError" })) : options.membersFail ? { ok: false, error: "slack_unavailable" } : { ok: true, memberOf: options.member && request.slackUserId === "U0ADA00001" ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] }),
      brokerExtra: { adminReads: { me: { issuer, fetch: userinfo, slackUserByEmail: async () => (options.linked ? { ok: true, userId: "U0ADA00001" } : { ok: true }) } } },
    });
    await bindChannel(harness.handler, "C0PRIVATE01");
    return harness;
  }
  const privateRow = async (options: { linked: boolean; member: boolean; membersFail?: boolean; membersThrow?: boolean; name?: string }) =>
    ((await (await broker(options)).admin("GET", "/v1/admin/slack/bindings")).body.bindings as Array<Record<string, unknown>>).find((row) => row.channelId === "C0PRIVATE01");

  it("shows a private channel's name when the admin's linked Slack user is a member of it", async () => {
    expect(await privateRow({ linked: true, member: true })).toMatchObject({ channelName: "secret-launch", private: true });
  });

  it("lists it by ID only when the admin is not a member, has no Slack link, or the check fails", async () => {
    for (const options of [{ linked: true, member: false }, { linked: false, member: true }, { linked: true, member: true, membersFail: true }, { linked: true, member: true, membersThrow: true }]) {
      const row = await privateRow(options);
      expect(row, JSON.stringify(options)).toMatchObject({ private: true });
      expect(row, JSON.stringify(options)).not.toHaveProperty("channelName");
    }
  });

  it("redacts a revealed private channel's name the same way as a public one (A16)", async () => {
    const planted = `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"a".repeat(24)}`;
    const row = await privateRow({ linked: true, member: true, name: planted });
    expect(row).toMatchObject({ private: true });
    expect(row?.channelName).toContain("[REDACTED]");
    expect(JSON.stringify(row)).not.toContain(planted);
  });
});
