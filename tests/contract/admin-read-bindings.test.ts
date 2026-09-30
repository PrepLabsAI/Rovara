// tests/contract/admin-read-bindings.test.ts
// Spec 025 A11: channel bindings, with public channels' names and private channels by ID only.
import { describe, expect, it, vi } from "vitest";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { bindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

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
