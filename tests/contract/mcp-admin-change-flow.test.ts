// tests/contract/mcp-admin-change-flow.test.ts
// Spec 025 User Story 6, SC-005, SC-011, SC-013, end to end: agentx mcp's server, the broker in
// process, an admin sign-in, a client with or without elicitation, and the Slack press.
import { randomUUID } from "node:crypto";
import type { ChannelInfoRequest, ChannelMembersRequest } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { ADMIN_SLACK, createAdminChangeBroker } from "../support/admin-change-broker.js";
import { MAYA, OMAR, grantProject } from "../support/developer-task-broker.js";
import { adminSignedInClient } from "../support/mcp-broker-client.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

const CONFIG = { adminApiVersion: "1.1", confirm: { elicitation: true, slack: true } };
const PLANTED = `ghp_${"E".repeat(36)}`;
let lines: string[] = [];
beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); }); });
afterEach(() => vi.restoreAllMocks());
/** Everything but the change path's own records: what a declined change must leave unchanged. */
const stateOf = (db: { items: Map<string, Record<string, unknown>> }) => JSON.stringify([...db.items.entries()]
  .filter(([, item]) => !["ADMIN_CHANGE", "ADMIN_CHANGE_REQUEST", "ADMIN_CHANGE_AUDIT"].includes(String(item.entityType)))
  .sort(([left], [right]) => left.localeCompare(right)));

describe("an admin changes AgentX from an AI tool (US6)", () => {

  it("leaves AgentX's state as it was for every change tool the admin declines (SC-005)", async () => {
    const broker = await createAdminChangeBroker();
    grantProject(broker.db, OMAR);
    const started = await broker.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = broker.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    await broker.finish(task.workspaceId, String((broker.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "SUCCEEDED");
    const mcp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_set_workspace_limits")).toBe(true);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["agentx_admin_register_project_revision", { definition: { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } }],
      ["agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" }],
      ["agentx_admin_unbind_channel", { channel: SLACK_CHANNEL }],
      ["agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: "agentx/connectors/linear" }],
      ["agentx_admin_stop_workspace", { workspace_id: task.workspaceId }],
      ["agentx_admin_grant_project_access", { project: "payments", developer: "U0NEW00001" }],
      ["agentx_admin_revoke_project_access", { project: "payments", developer: OMAR.developerId }],
      ["agentx_admin_revoke_signin", { developer: MAYA.developerId }],
      ["agentx_admin_set_workspace_limits", { per_person: 5 }],
    ];
    for (const [name, args] of calls) {
      const before = stateOf(broker.db);
      const answer = await mcp.tool(name, args);
      expect(answer.error, name).toMatchObject({ code: "CONFIRMATION_DECLINED" });
      expect(stateOf(broker.db), name).toBe(before);
    }
    // revoke_signin acts outside the table, through DeveloperIdentity: no declined call reached it.
    // stop_workspace's cancel acts only through the table (the cancel operation and its outbox), so stateOf covers it.
    expect(broker.endedSessions).toEqual([]);
    // FR-051: one record per request, each declined.
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT").map((item) => item.outcome)).toEqual(calls.map(() => "declined"));
  });

  it("reaches DeveloperIdentity once for an accepted revoke, and changes the table for an accepted stop (SC-005's positive controls)", async () => {
    const broker = await createAdminChangeBroker();
    const started = await broker.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const task = broker.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    await broker.finish(task.workspaceId, String((broker.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "SUCCEEDED");
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_revoke_signin")).toBe(true);
    expect((await mcp.tool("agentx_admin_revoke_signin", { developer: MAYA.developerId })).value).toMatchObject({ outcome: "applied" });
    expect(broker.endedSessions).toEqual([expect.objectContaining({ kind: "end-developer-sessions", developerId: MAYA.developerId })]);
    const before = stateOf(broker.db);
    const stopped = await mcp.tool("agentx_admin_stop_workspace", { workspace_id: task.workspaceId });
    expect(stopped.value).toMatchObject({ outcome: "applied", result: { outcome: "CANCEL_REQUESTED" } });
    const target = String((stopped.value.result as { targetOperationId: string }).targetOperationId);
    // The cancel acts only through the table: the task operation's status, and a cancel invocation in the outbox for the runtime.
    expect(broker.db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${target}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(broker.db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "cancel")).toHaveLength(1);
    expect(stateOf(broker.db)).not.toBe(before);
    expect(broker.endedSessions).toHaveLength(1);
  });

  it("offers no change tool, and refuses a direct call, when neither method is available (FR-041, US6 scenario 4)", async () => {
    const broker = await createAdminChangeBroker({ slackLinked: false });
    const mcp = await adminSignedInClient(broker, { elicitation: false, clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_changes")).toBe(true);
    expect((await mcp.names()).filter((name) => name.startsWith("agentx_admin_") && !["agentx_admin_changes", "agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage", "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces"].includes(name))).toEqual([]);
    expect((await mcp.tool("agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" })).error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
  });

  it("changes the per-person limit with no stack update, and the next creation uses it (SC-013, US6 scenario 7)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_set_workspace_limits")).toBe(true);
    expect((await mcp.tool("agentx_admin_set_workspace_limits", { per_person: 1 })).value).toMatchObject({ outcome: "applied" });
    expect((await ensureWorkspace(broker.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000501`, "U0PRIYA001")).body).toMatchObject({ outcome: "WORKSPACE" });
    expect((await ensureWorkspace(broker.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000502`, "U0PRIYA001")).body).toMatchObject({ outcome: "LIMIT_REACHED", maximum: 1 });
    // The harness has no CloudFormation client at all: nothing could have updated a stack.
  });

});

/**
 * The notifier as the stream would run it (E13), on the broker's own table: the Slack Confirm
 * message for a change whose Slack step started, and its edit once the change ends. Slack is a
 * recording fake; nothing leaves the process.
 */
function slackNotifier(broker: Awaited<ReturnType<typeof createAdminChangeBroker>>) {
  const posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const handler = createNotifierHandler({
    documentClient: broker.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined,
    post: async (input) => { posts.push(input); return { ts: "1696237200.000100", channel: "D0ADMINDM1" }; },
    update: async (input) => { updates.push(input); },
    now: () => broker.clock.now(), log: (entry) => logged.push(entry), deliveryFailed: () => undefined,
  });
  const deliver = (changeId: string, kind: "admin_change_dm" | "admin_change_outcome") => handler({ Records: [{
    eventSource: "aws:sqs", messageId: randomUUID(), receiptHandle: "r1",
    body: JSON.stringify({ id: `${changeId}:${kind === "admin_change_dm" ? "dm" : "outcome"}`, kind, changeId, at: new Date(broker.clock.now()).toISOString() }),
  }] });
  return { posts, updates, logged, deliver };
}

const REVISION = (orchestratorInstructions: string) => ({ definition: { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions } });

describe("a private channel in the confirmation, end to end (B4, R4, Q7)", () => {
  const channelInfo = async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: channelId === "C0PRIVATE01" ? "secret-launch" : "payments-dev", isPrivate: channelId === "C0PRIVATE01" })) });
  const memberAdmin = async (request: ChannelMembersRequest) => ({ ok: true as const, memberOf: request.slackUserId === ADMIN_SLACK ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] });

  it("names it in the Slack message for a member admin, and the record keeps its ID only", async () => {
    const broker = await createAdminChangeBroker({ channelInfo, channelMembers: memberAdmin });
    const slack = slackNotifier(broker);
    let pressed = false;
    const mcp = await adminSignedInClient(broker, {
      elicitation: false, clock: broker.clock, config: CONFIG,
      onSleep: async () => {
        const waiting = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.slackRequestedAt !== undefined && item.status === "pending")[0];
        if (waiting === undefined || pressed) return;
        pressed = true;
        await slack.deliver(String(waiting.changeId), "admin_change_dm");
        await broker.press(String(waiting.changeId), "confirm");
      },
    });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const bound = await mcp.tool("agentx_admin_bind_channel", { channel: "C0PRIVATE01", project: "payments" });
    expect(bound.value).toMatchObject({ outcome: "applied", method: "slack" });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({ channel: ADMIN_SLACK, text: expect.stringContaining("#secret-launch") as unknown });
    const changeId = String(bound.value.change_id);
    expect(JSON.stringify(broker.audit(changeId))).not.toContain("secret-launch");
    expect(JSON.stringify((await mcp.tool("agentx_admin_changes")).value)).not.toContain("secret-launch");
    expect(JSON.stringify((await broker.get(changeId, "another-admin")).body)).not.toContain("secret-launch");
  });

});

describe("a planted secret, end to end (SC-004, ruling R3)", () => {
  it("never reaches a log line, a Slack post or edit, a pop-up, a tool result or an audit record", async () => {
    const broker = await createAdminChangeBroker();
    const slack = slackNotifier(broker);
    // A client without the pop-up: the revision's change reaches its Slack message, which is then cancelled.
    const mcp = await adminSignedInClient(broker, {
      elicitation: false, clock: broker.clock, config: CONFIG,
      onSleep: async () => {
        const waiting = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.slackRequestedAt !== undefined && item.status === "pending")[0];
        if (waiting === undefined || slack.posts.length > 0) return;
        await slack.deliver(String(waiting.changeId), "admin_change_dm");
        await broker.press(String(waiting.changeId), "cancel");
        await slack.deliver(String(waiting.changeId), "admin_change_outcome");
      },
    });
    const popUp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_register_project_revision")).toBe(true);
    await expect.poll(async () => (await popUp.names()).includes("agentx_admin_register_project_revision")).toBe(true);
    const revision = await mcp.tool("agentx_admin_register_project_revision", REVISION(`Use ${PLANTED}.`));
    expect(revision.error).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    expect((await popUp.tool("agentx_admin_register_project_revision", REVISION(`Also ${PLANTED}.`))).error).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(popUp.asked).toHaveLength(1);
    // R3 mitigation (controller ruling): a pending change keeps the raw definition only while it can
    // still apply; both changes were declined, so neither keeps its input or the planted value.
    const revisions = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.kind === "register_project_revision");
    expect(revisions.map((item) => item.status)).toEqual(["declined", "declined"]);
    for (const item of revisions) expect(item).not.toHaveProperty("input");
    expect(JSON.stringify(revisions)).not.toContain(PLANTED);
    // The credential tool's planted input is refused at planning, before any change is stored.
    const credential = await popUp.tool("agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: `agentx/connectors/${PLANTED}` });
    expect(credential.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.kind === "register_credential")).toEqual([]);
    await popUp.tool("agentx_admin_changes");
    await mcp.tool("agentx_admin_changes");
    const audits = broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT");
    expect(audits.map((item) => item.kind).sort()).toEqual(["register_credential", "register_project_revision", "register_project_revision"]);
    expect(JSON.stringify(audits)).toContain("[REDACTED]");
    const shown = {
      audits, answers: [...mcp.answers, ...popUp.answers], asked: popUp.asked, posts: slack.posts, updates: slack.updates,
      logs: [lines, mcp.stderr, popUp.stderr, slack.logged],
    };
    for (const [where, value] of Object.entries(shown)) expect(JSON.stringify(value), where).not.toContain(PLANTED);
  });
});

