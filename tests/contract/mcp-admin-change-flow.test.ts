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
const logs = () => lines.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
/** Everything but the change path's own records: what a declined change must leave unchanged. */
const stateOf = (db: { items: Map<string, Record<string, unknown>> }) => JSON.stringify([...db.items.entries()]
  .filter(([, item]) => !["ADMIN_CHANGE", "ADMIN_CHANGE_REQUEST", "ADMIN_CHANGE_AUDIT"].includes(String(item.entityType)))
  .sort(([left], [right]) => left.localeCompare(right)));

describe("an admin changes AgentX from an AI tool (US6)", () => {
  it("binds a channel after the pop-up's yes, and the record says who, how, when and with which trace ID (SC-011)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const bound = await mcp.tool("agentx_admin_bind_channel", { channel: "#ledger-dev", project: "payments" });
    expect(bound.value).toMatchObject({ outcome: "applied", method: "elicitation" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toMatchObject({ projectName: "payments" });
    const record = ((await mcp.tool("agentx_admin_changes")).value.changes as Array<Record<string, unknown>>)[0]!;
    expect(record).toMatchObject({
      change_id: bound.value.change_id, outcome: "confirmed", admin: "Ada", client: { cliVersion: expect.any(String) as unknown, mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
      methods_offered: ["elicitation", "slack"], method_used: "elicitation", proposed_at: expect.any(String) as unknown, confirmation_requested_at: expect.any(String) as unknown,
      answered_at: expect.any(String) as unknown, applied_at: expect.any(String) as unknown, result: expect.any(Object) as unknown,
    });
    const traced = logs().filter((entry) => entry.changeId === bound.value.change_id);
    expect(traced.map((entry) => entry.event)).toEqual(expect.arrayContaining(["admin_change.proposed", "admin_change.claimed", "admin_change.applied"]));
    for (const entry of traced) expect(entry.traceId, String(entry.event)).toBe(record.trace_id);
  });

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
    // FR-051: one record per request, each declined.
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT").map((item) => item.outcome)).toEqual(calls.map(() => "declined"));
  });

  it("confirms by the Slack button in a client without the pop-up, even after the wait, and never twice", async () => {
    const broker = await createAdminChangeBroker();
    let pressed = false;
    const mcp = await adminSignedInClient(broker, {
      elicitation: false, clock: broker.clock, config: CONFIG,
      onSleep: async () => {
        const waiting = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.slackRequestedAt !== undefined && item.status === "pending")[0];
        if (waiting !== undefined && !pressed) { pressed = true; await broker.press(String(waiting.changeId), "confirm"); }
      },
    });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_unbind_channel")).toBe(true);
    const unbound = await mcp.tool("agentx_admin_unbind_channel", { channel: SLACK_CHANNEL });
    expect(unbound.value).toMatchObject({ outcome: "applied", method: "slack" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeUndefined();
    expect(await broker.press(String(unbound.value.change_id), "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(broker.audit(String(unbound.value.change_id))).toMatchObject({ outcome: "confirmed", methodUsed: "slack", pressedBy: ADMIN_SLACK });
  });

  it("answers awaiting_confirmation after five minutes, and the record reads expired after ten", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: false, clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const waiting = await mcp.tool("agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" });
    expect(waiting.value).toMatchObject({ outcome: "awaiting_confirmation" });
    broker.clock.advance(6 * 60_000);
    const record = ((await mcp.tool("agentx_admin_changes")).value.changes as Array<Record<string, unknown>>)[0];
    expect(record).toMatchObject({ change_id: waiting.value.change_id, outcome: "expired" });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01")).toBeUndefined();
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

  it("keeps a planted secret out of the change records, the tool results and the logs (SC-004)", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_register_project_revision")).toBe(true);
    await mcp.tool("agentx_admin_register_project_revision", { definition: { name: "payments", revision: 2, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: `Use ${PLANTED}.` } });
    await mcp.tool("agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: `agentx/connectors/${PLANTED}` });
    await mcp.tool("agentx_admin_changes");
    expect(JSON.stringify(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT"))).not.toContain(PLANTED);
    expect(mcp.answers.join("\n")).not.toContain(PLANTED);
    expect(lines.join("\n")).not.toContain(PLANTED);
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

describe("one trace ID from the MCP server to the stored change (SC-011, FR-052, ruling C20)", () => {
  it("stores the trace ID agentx mcp sent, and sends it on every call of that change", async () => {
    const broker = await createAdminChangeBroker();
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const bound = await mcp.tool("agentx_admin_bind_channel", { channel: "C0LEDGER01", project: "payments" });
    expect(bound.value).toMatchObject({ outcome: "applied" });
    const changeId = String(bound.value.change_id);
    const calls = mcp.sent.filter((request) => (request.path === "/v1/admin/changes" && request.method === "POST") || request.path.startsWith(`/v1/admin/changes/${changeId}`));
    expect(calls.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /v1/admin/changes", `POST /v1/admin/changes/${changeId}/apply`]);
    const sentTrace = calls[0]!.traceId;
    expect(sentTrace).toEqual(expect.any(String));
    for (const request of calls) expect(request.traceId).toBe(sentTrace);
    expect(broker.pending(changeId)).toMatchObject({ traceId: sentTrace });
    expect(broker.audit(changeId)).toMatchObject({ traceId: sentTrace });
    const traced = logs().filter((entry) => entry.changeId === changeId);
    expect(traced.length).toBeGreaterThan(0);
    for (const entry of traced) expect(entry.traceId, String(entry.event)).toBe(sentTrace);
  });

  it("keeps the trace ID through the Slack step, the press and the notifier's message", async () => {
    const broker = await createAdminChangeBroker();
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
        await slack.deliver(String(waiting.changeId), "admin_change_outcome");
      },
    });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_unbind_channel")).toBe(true);
    const unbound = await mcp.tool("agentx_admin_unbind_channel", { channel: SLACK_CHANNEL });
    expect(unbound.value).toMatchObject({ outcome: "applied", method: "slack" });
    const changeId = String(unbound.value.change_id);
    const sentTrace = mcp.sent.find((request) => request.path === "/v1/admin/changes" && request.method === "POST")!.traceId;
    for (const request of mcp.sent.filter((entry) => entry.path.startsWith(`/v1/admin/changes/${changeId}`))) expect(request.traceId, request.path).toBe(sentTrace);
    expect(broker.audit(changeId)).toMatchObject({ traceId: sentTrace, outcome: "confirmed", methodUsed: "slack" });
    const traced = logs().filter((entry) => entry.changeId === changeId);
    expect(traced.map((entry) => entry.event)).toEqual(expect.arrayContaining(["admin_change.proposed", "admin_change.applied"]));
    for (const entry of traced) expect(entry.traceId, String(entry.event)).toBe(sentTrace);
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    for (const entry of slack.logged.filter((line) => line.changeId === changeId)) expect(entry.traceId, String(entry.event)).toBe(sentTrace);
    expect(slack.logged.map((line) => line.event)).toContain("admin_change.dm_posted");
  });
});

describe("a private channel in the confirmation, end to end (B4, R4, Q7)", () => {
  const channelInfo = async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: channelId === "C0PRIVATE01" ? "secret-launch" : "payments-dev", isPrivate: channelId === "C0PRIVATE01" })) });
  const memberAdmin = async (request: ChannelMembersRequest) => ({ ok: true as const, memberOf: request.slackUserId === ADMIN_SLACK ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] });
  const nonMember = async () => ({ ok: true as const, memberOf: [] as string[] });

  it("names it in the pop-up for a member admin; the audit record and another admin's read show its ID only", async () => {
    const broker = await createAdminChangeBroker({ channelInfo, channelMembers: memberAdmin });
    const mcp = await adminSignedInClient(broker, { elicitation: "accept", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    const bound = await mcp.tool("agentx_admin_bind_channel", { channel: "C0PRIVATE01", project: "payments" });
    expect(bound.value).toMatchObject({ outcome: "applied", method: "elicitation" });
    expect(mcp.asked).toHaveLength(1);
    expect(mcp.asked[0]).toContain("#secret-launch (C0PRIVATE01, a private channel)");
    const changeId = String(bound.value.change_id);
    const record = ((await mcp.tool("agentx_admin_changes")).value.changes as Array<Record<string, unknown>>)[0]!;
    expect(record).toMatchObject({ change_id: changeId, effect: expect.stringContaining("C0PRIVATE01 (a private channel)") as unknown });
    expect(JSON.stringify(record)).not.toContain("secret-launch");
    expect(JSON.stringify(broker.audit(changeId))).not.toContain("secret-launch");
    const other = await broker.get(changeId, "another-admin");
    expect((other.body.change as { effect: string }).effect).toContain("C0PRIVATE01 (a private channel)");
    expect(JSON.stringify(other.body)).not.toContain("secret-launch");
  });

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

  it("shows a non-member admin its ID in the pop-up and in the Slack message", async () => {
    const broker = await createAdminChangeBroker({ channelInfo, channelMembers: nonMember });
    const popUp = await adminSignedInClient(broker, { elicitation: "decline", clock: broker.clock, config: CONFIG });
    await expect.poll(async () => (await popUp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    expect((await popUp.tool("agentx_admin_bind_channel", { channel: "C0PRIVATE01", project: "payments" })).error).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(popUp.asked).toHaveLength(1);
    expect(popUp.asked[0]).toContain("C0PRIVATE01 (a private channel)");
    expect(popUp.asked[0]).not.toContain("secret-launch");
    const slack = slackNotifier(broker);
    const noPopUp = await adminSignedInClient(broker, {
      elicitation: false, clock: broker.clock, config: CONFIG,
      onSleep: async () => {
        const waiting = broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.slackRequestedAt !== undefined && item.status === "pending")[0];
        if (waiting !== undefined && slack.posts.length === 0) await slack.deliver(String(waiting.changeId), "admin_change_dm");
      },
    });
    await expect.poll(async () => (await noPopUp.names()).includes("agentx_admin_bind_channel")).toBe(true);
    expect((await noPopUp.tool("agentx_admin_bind_channel", { channel: "C0PRIVATE01", project: "payments" })).value).toMatchObject({ outcome: "awaiting_confirmation" });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain("C0PRIVATE01 (a private channel)");
    expect(JSON.stringify(slack.posts)).not.toContain("secret-launch");
    expect(JSON.stringify([popUp.answers, noPopUp.answers])).not.toContain("secret-launch");
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
    // R3: the pending change keeps the raw definition it would apply (with its 30-day TTL), so the
    // planted value did reach AgentX; the sweep below proves it went nowhere else.
    expect(JSON.stringify(broker.db.find((item) => item.entityType === "ADMIN_CHANGE" && item.kind === "register_project_revision"))).toContain(PLANTED);
    // The credential tool's planted input is refused at planning, before any change is stored.
    const credential = await popUp.tool("agentx_admin_register_credential", { ref: "linear", type: "static-secret", secret_name: `agentx/connectors/${PLANTED}` });
    expect(credential.isError).toBe(true);
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
