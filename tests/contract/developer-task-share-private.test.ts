// Spec 025 Q10 (owner answer, 2026-09-29): sharing into a private bound channel needs the developer to
// be a member of it, at the start and on the share route. A developer with no Slack link cannot be
// confirmed as a member; a membership lookup that fails refuses, never lets the share through.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChannelInfoRequest, ChannelInfoResponse, ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { MAYA, OMAR, bindChannel, createDeveloperTaskBroker, grantProject, unbindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";

const PRIVATE = "G0PRIVATE01";
const PUBLIC = "C0SECOND001";
const NOT_A_MEMBER = "you are not a member of that private channel; join it first, or share to one of the project's public channels";
const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const names = async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({
  ok: true,
  channels: request.channelIds.map((channelId) => (channelId === PRIVATE
    ? { channelId, name: "payments-secret", isPrivate: true }
    : { channelId, name: channelId === PUBLIC ? "payments-ops" : "payments-dev", isPrivate: false })),
});
/** Maya is in the test channel, and in the private one when `inPrivate`; nobody else is in anything. */
const members = (inPrivate: boolean) => async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true,
  memberOf: request.slackUserId === MAYA.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL || (inPrivate && id === PRIVATE)) : [],
});
type Db = Awaited<ReturnType<typeof createDeveloperTaskBroker>>["db"];
const workspaces = (db: Db) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: Db) => db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");
const taskOf = (body: Record<string, unknown>) => body.task as { taskId: string; shared: boolean; share?: Record<string, unknown> };

async function withPrivate(inPrivate: boolean, channelMembers = members(inPrivate)) {
  const harness = await createDeveloperTaskBroker({ channelInfo: names, channelMembers });
  await bindChannel(harness.handler, PRIVATE);
  return harness;
}

describe("sharing into a private channel needs membership (Q10)", () => {
  it("lets a member share into it, at the start and on the share route, without its name", async () => {
    const { db, dev } = await withPrivate(true);
    const started = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PRIVATE }))).body);
    expect(started).toMatchObject({ shared: true, share: { channelId: PRIVATE } });
    expect(started.share).not.toHaveProperty("channelName");
    const running = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    const shared = await dev(MAYA, "POST", `/v1/dev/tasks/${running.taskId}/share`, { requestId: randomUUID(), channel: PRIVATE });
    expect(shared.status).toBe(200);
    expect(taskOf(shared.body).share).toMatchObject({ channelId: PRIVATE });
    expect(JSON.stringify(db.find((item) => item.entityType === "DEVELOPER_TASK"))).not.toContain("payments-secret");
  });

  it("refuses a non-member at the start, audited, and writes nothing else", async () => {
    const { db, dev } = await withPrivate(false);
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PRIVATE }));
    expect(response.body.error).toEqual({ code: "CHANNEL_REQUIRED", message: NOT_A_MEMBER });
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "CHANNEL_REQUIRED" } })]);
  });

  it("refuses a non-member on the share route, and the task stays private", async () => {
    const { db, dev } = await withPrivate(false);
    const running = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    const response = await dev(MAYA, "POST", `/v1/dev/tasks/${running.taskId}/share`, { requestId: randomUUID(), channel: PRIVATE });
    expect(response.body.error).toEqual({ code: "CHANNEL_REQUIRED", message: NOT_A_MEMBER });
    expect(db.get(`DEVTASK#${running.taskId}`, "META")).toMatchObject({ shared: false });
    expect(db.get(`DEVTASK#${running.taskId}`, "META")).not.toHaveProperty("share");
  });

  it("refuses a non-member when the private channel is the project's only channel", async () => {
    const { db, handler, dev } = await withPrivate(false);
    grantProject(db, MAYA);
    await unbindChannel(handler, SLACK_CHANNEL);
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
    expect(response.body.error).toEqual({ code: "CHANNEL_REQUIRED", message: NOT_A_MEMBER });
    expect(workspaces(db)).toHaveLength(0);
  });

  it("refuses a developer with no Slack link, who cannot be confirmed as a member, and names no private channel", async () => {
    const { db, dev, channelMembers } = await withPrivate(true);
    grantProject(db, OMAR);
    const response = await dev(OMAR, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PRIVATE }));
    expect(response.body.error).toEqual({ code: "CHANNEL_REQUIRED", message: NOT_A_MEMBER });
    expect(JSON.stringify(response.body)).not.toContain("payments-secret");
    expect(channelMembers).not.toHaveBeenCalledWith(expect.objectContaining({ channelIds: [PRIVATE] }));
    expect(workspaces(db)).toHaveLength(0);
  });

  it("refuses SLACK_UNAVAILABLE when the membership lookup fails, whether Slack answers so or throws", async () => {
    const unavailable = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> =>
      (request.channelIds.length === 1 && request.channelIds[0] === PRIVATE ? { ok: false, error: "slack_unavailable" } : members(true)(request));
    const { db, dev } = await withPrivate(true, unavailable);
    grantProject(db, MAYA);
    const refused = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PRIVATE }));
    expect(refused.body.error).toMatchObject({ code: "SLACK_UNAVAILABLE", message: "Slack could not be reached to check your membership of that channel; try again shortly" });
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "SLACK_UNAVAILABLE" } })]);

    const throwing = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => {
      if (request.channelIds.length === 1 && request.channelIds[0] === PRIVATE) throw new Error("socket hang up");
      return members(true)(request);
    };
    const second = await withPrivate(true, throwing);
    grantProject(second.db, MAYA);
    const running = taskOf((await second.dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    const shared = await second.dev(MAYA, "POST", `/v1/dev/tasks/${running.taskId}/share`, { requestId: randomUUID(), channel: PRIVATE });
    expect(shared.body.error).toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(second.db.get(`DEVTASK#${running.taskId}`, "META")).not.toHaveProperty("share");
  });

  describe("when the channel's privacy is unknown, it is treated as private unless the sharer is a member", () => {
    const TRANSIENT = "Slack could not be reached to check whether that channel is private; try again shortly";
    const NOT_SET_UP = "AgentX cannot tell whether that channel is private; ask your AgentX admin to finish the Slack setup, or share to a channel you are a member of";
    const noInfo = async (): Promise<ChannelInfoResponse> => ({ ok: false, error: "slack_unavailable" });

    for (const [label, channelInfo, message] of [["Slack does not answer channel-info", noInfo, TRANSIENT], ["channel-info is not configured", null, NOT_SET_UP]] as const) {
      it(`${label}: a Slack-linked non-member is refused, audited, and nothing is written; a member still shares`, async () => {
        // PUBLIC is in fact public; with its privacy unknown, a non-member must not share into it.
        const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo, channelMembers: members(false) });
        await bindChannel(handler, PUBLIC);
        const refused = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PUBLIC }));
        expect(refused.body.error).toEqual({ code: "SLACK_UNAVAILABLE", message });
        expect(workspaces(db)).toHaveLength(0);
        expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "SLACK_UNAVAILABLE" } })]);
        const shared = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: SLACK_CHANNEL }))).body);
        expect(shared).toMatchObject({ shared: true, share: { channelId: SLACK_CHANNEL } });
      });

      it(`${label}: a developer with no Slack link is refused`, async () => {
        const { db, dev } = await createDeveloperTaskBroker({ channelInfo, channelMembers: members(false) });
        grantProject(db, OMAR);
        const refused = await dev(OMAR, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
        expect(refused.body.error).toEqual({ code: "SLACK_UNAVAILABLE", message });
        expect(workspaces(db)).toHaveLength(0);
      });
    }
  });

  it("leaves a public channel unaffected: a non-member shares into it, and no membership is asked", async () => {
    const { handler, dev, channelMembers } = await withPrivate(false);
    await bindChannel(handler, PUBLIC);
    channelMembers.mockClear();
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#payments-ops" }))).body);
    expect(task).toMatchObject({ shared: true, share: { channelId: PUBLIC, channelName: "payments-ops" } });
    expect(channelMembers).not.toHaveBeenCalledWith(expect.objectContaining({ channelIds: [PUBLIC] }));
  });
});
