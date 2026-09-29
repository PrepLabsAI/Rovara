// Spec 025 FR-031, D5, D6, C3, C4: sharing decided at POST /v1/dev/tasks.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentXError, DEFAULT_DEVELOPER_TASK_POLICY, type ChannelInfoRequest, type ChannelInfoResponse } from "@agentx/contracts";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, OMAR, bindChannel, createDeveloperTaskBroker, grantProject, registerRevision, unbindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const SECOND = "C0SECOND001";
const PRIVATE = "G0PRIVATE01";
const names = async (request: ChannelInfoRequest): Promise<ChannelInfoResponse> => ({
  ok: true,
  channels: request.channelIds.map((channelId) => (channelId === PRIVATE
    ? { channelId, name: "payments-secret", isPrivate: true }
    : { channelId, name: channelId === SECOND ? "payments-ops" : "payments-dev", isPrivate: false })),
});
type Db = Awaited<ReturnType<typeof createDeveloperTaskBroker>>["db"];
const workspaces = (db: Db) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: Db) => db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");
const taskOf = (body: Record<string, unknown>) => body.task as { taskId: string; shared: boolean; share?: Record<string, unknown> };

describe("sharing at the start (FR-031)", () => {
  it("shares a start that asks to, in the project's default mode, with the channel's name (D6)", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
    expect(response.status).toBe(200);
    const task = taskOf(response.body);
    expect(task).toMatchObject({ shared: true, share: { mode: "view", channelId: SLACK_CHANNEL, channelName: "payments-dev", sharedReason: "requested" } });
    // C6: the answer does not wait for the notifier's post.
    expect(task.share).not.toHaveProperty("threadUrl");
    expect(db.get(`DEVTASK#${task.taskId}`, "META")).toMatchObject({
      shared: true, shareVersion: 1,
      share: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, channelName: "payments-dev", mode: "view", sharedReason: "requested", sharedAt: expect.any(String) as string },
    });
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK_INDEX" && item.taskId === task.taskId)).toEqual([expect.objectContaining({ shared: true })]);
  });

  it("shares every start on a project that requires it, and says why (US3 scenario 2)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await registerRevision(handler, 2, { share: "required" });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    expect(task).toMatchObject({ shared: true, share: { sharedReason: "required", mode: "view" } });
  });

  it("keeps continue where the project allows it, and makes it view with the reason where it does not (US3 scenario 8)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "continue" }))).body).share).toMatchObject({ mode: "continue" });
    await registerRevision(handler, 2, { shareMode: { default: "view", allowContinue: false } });
    const forced = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "continue" }))).body);
    expect(forced.share).toMatchObject({ mode: "view", modeReason: "continue_not_allowed" });
  });

  it("shares ledger's tasks view only whatever the developer asks (US3's independent test)", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await registerRevision(handler, 2, { share: "required", shareMode: { default: "view", allowContinue: false } });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: false, shareMode: "continue" }))).body);
    expect(task).toMatchObject({ shared: true, share: { mode: "view", sharedReason: "required", modeReason: "continue_not_allowed" } });
  });

  it("refuses CHANNEL_AMBIGUOUS before anything is written when a required share has two channels (Review Focus 5)", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await bindChannel(handler, PRIVATE);
    await registerRevision(handler, 2, { share: "required" });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(409);
    const error = response.body.error as { code: string; message: string };
    expect(error.code).toBe("CHANNEL_AMBIGUOUS");
    expect(error.message).toContain("#payments-dev");
    expect(error.message).toContain(PRIVATE);
    expect(error.message).not.toContain("payments-secret");
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "CHANNEL_AMBIGUOUS" } })]);
  });

  it("uses a named channel, by name or by ID", async () => {
    const { handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    await bindChannel(handler, SECOND);
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#payments-ops" }))).body).share).toMatchObject({ channelId: SECOND });
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: SLACK_CHANNEL }))).body).share).toMatchObject({ channelId: SLACK_CHANNEL });
  });

  it("refuses CHANNEL_REQUIRED when no channel is bound, or the named one is not bound", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const unknown = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#elsewhere" }));
    expect(unknown.body.error).toMatchObject({ code: "CHANNEL_REQUIRED", message: "`#elsewhere` is not a channel of `payments`; its channels are #payments-dev" });
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "CHANNEL_REQUIRED" } })]);
    grantProject(db, MAYA);
    await unbindChannel(handler, SLACK_CHANNEL);
    const none = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true }));
    expect(none.body.error).toMatchObject({ code: "CHANNEL_REQUIRED", message: "project `payments` has no Slack channel bound to it, so the task cannot be shared" });
    expect(workspaces(db)).toHaveLength(0);
  });

  it("says the names could not be read, not that the channel is wrong, when Slack does not answer (review minor 2)", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelInfo: async () => ({ ok: false, error: "slack_unavailable" }) });
    const named = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: "#payments-dev" }));
    expect(named.body.error).toMatchObject({ code: "CHANNEL_REQUIRED", message: `AgentX could not read the channel names from Slack; name the channel by its ID: ${SLACK_CHANNEL}` });
    expect(workspaces(db)).toHaveLength(0);
    expect(taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: SLACK_CHANNEL }))).body).share).toMatchObject({ channelId: SLACK_CHANNEL });
  });

  it("refuses a share, audited, when the route is given a bound channel but no Slack team ID, and writes nothing else", async () => {
    // The hosted router finds no binding without a team ID, so this guard is reached only by
    // dependencies that report a channel anyway: call the task routes directly with such a checkAccess.
    const { db, actions } = await createDeveloperTaskBroker({ channelInfo: names });
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, slackUserId: MAYA.slackUserId! };
    const refusal = await routeDeveloperTaskRequest({
      documentClient: db, tableName: "state", actions, now: () => Date.now(),
      checkAccess: async () => ({ revision: 1, policy: DEFAULT_DEVELOPER_TASK_POLICY, access: "granted", channelIds: [SLACK_CHANNEL] }),
      projectChannelIds: async () => [],
      boundChannels: async (channelIds) => channelIds.map((channelId) => ({ channelId, name: "payments-dev", isPrivate: false })),
    }, caller, { method: "POST", path: "/v1/dev/tasks", headers: {}, requestId: randomUUID(), body: JSON.stringify(start({ shareToChannel: true })) }, new URL("https://agentx.test/v1/dev/tasks")).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(AgentXError);
    expect((refusal as AgentXError).code).toBe("CHANNEL_REQUIRED");
    expect((refusal as AgentXError).message).toContain("this AgentX has no Slack workspace set, so tasks cannot be shared");
    expect(workspaces(db)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ action: "start", outcome: "refused", error: { code: "CHANNEL_REQUIRED" } })]);
  });

  it("never stores or shows a private channel's name, even to a Slack-linked developer (R10)", async () => {
    // Q10: a private channel takes a share only from a member, so Maya is in this one.
    const { db, handler, dev } = await createDeveloperTaskBroker({ channelInfo: names, channelMembers: async (request) => ({ ok: true, memberOf: request.slackUserId === MAYA.slackUserId ? request.channelIds.filter((id) => id === SLACK_CHANNEL || id === PRIVATE) : [] }) });
    await bindChannel(handler, PRIVATE);
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, channel: PRIVATE }))).body);
    expect(task).toMatchObject({ shared: true, share: { channelId: PRIVATE } });
    expect(task.share).not.toHaveProperty("channelName");
    const stored = db.get(`DEVTASK#${task.taskId}`, "META") as { share: Record<string, unknown> };
    expect(stored.share).toMatchObject({ channelId: PRIVATE });
    expect(stored.share).not.toHaveProperty("channelName");
    expect(JSON.stringify(db.find((item) => item.taskId === task.taskId))).not.toContain("payments-secret");
  });

  it("gives a developer with no Slack link channel IDs only, and shows no names to them (R10, Q10)", async () => {
    const { db, dev, channelInfo } = await createDeveloperTaskBroker({ channelInfo: names });
    grantProject(db, OMAR);
    const task = taskOf((await dev(OMAR, "POST", "/v1/dev/tasks", start({ shareToChannel: true }))).body);
    expect(task.share).toMatchObject({ channelId: SLACK_CHANNEL });
    expect(task.share).not.toHaveProperty("channelName");
    // Q10: the channel's privacy is read, since a private channel needs its sharer's membership;
    // its name is still never stored or shown to this developer.
    expect(channelInfo).toHaveBeenCalledWith({ kind: "channel-info", channelIds: [SLACK_CHANNEL] });
    expect(JSON.stringify(db.find((item) => item.taskId === task.taskId))).not.toContain("payments-dev");
  });

  it("keeps a private start private, and reads no channel names for it", async () => {
    const { db, dev, channelInfo } = await createDeveloperTaskBroker({ channelInfo: names });
    const task = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body);
    expect(task.shared).toBe(false);
    expect(task).not.toHaveProperty("share");
    expect(db.get(`DEVTASK#${task.taskId}`, "META")).not.toHaveProperty("share");
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("answers a retried shared start with the first task (R8)", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelInfo: names });
    const body = start({ shareToChannel: true, shareMode: "continue" });
    const first = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", body)).body);
    const again = taskOf((await dev(MAYA, "POST", "/v1/dev/tasks", body)).body);
    expect(again.taskId).toBe(first.taskId);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
  });
});
