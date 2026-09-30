// Spec 025 User Story 5 and SC-004, end to end: agentx mcp's server, the broker in process, an admin
// sign-in and a developer sign-in. Each read tool's result is compared with the expected result
// committed here (US5's "committed snapshot"; never regenerated, never vitest -u).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA, recordStream } from "../support/developer-task-broker.js";
import { ADMIN_TOKEN, NON_ADMIN_TOKEN, adminSignedInClient } from "../support/mcp-broker-client.js";

const PLANTED = [`ghp_${"Q".repeat(36)}`, `xoxb-${"2".repeat(12)}-planted`, `agxr_${"z".repeat(43)}`];
const ADMIN_TOOLS = ["agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage", "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces"];
/** Times and IDs change each run; everything else is compared as committed. */
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")) as unknown;

async function failedTask() {
  const harness = await createAdminReadBroker();
  const stream = recordStream(harness.db);
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(task.workspaceId, prepareId, "FAILED", { error: `npm ci exited 1 (token ${PLANTED[0]})` });
  // What the outbox publisher does with the same stream records (A4).
  await indexActivity(stream.take(), { get: async (key) => harness.db.get(key.pk, key.sk), put: async (item) => harness.db.set(item) }, () => undefined);
  return { harness, taskId };
}

describe("an admin looks at AgentX from an AI tool (US5)", () => {
  it("lists the admin read tools for an admin, answers each with no confirmation, and matches the committed results", async () => {
    const { harness, taskId } = await failedTask();
    const mcp = await adminSignedInClient(harness);
    await expect.poll(async () => (await mcp.names()).filter((name) => name.startsWith("agentx_admin_"))).toEqual(ADMIN_TOOLS);

    const failed = await mcp.tool("agentx_admin_failed_tasks");
    expect(normalized(failed.value)).toEqual({
      failures: [{
        time: "<time>", project: "payments", origin: "ai_tool", requester: "`Maya Chen` (developer)", workspace_id: "<uuid>", operation_id: "<uuid>",
        operation_kind: "prepare", category: "setup_failed", error: "npm ci exited 1 (token [REDACTED])", turn_record: { task_id: "<uuid>" },
      }],
      since: "<time>", until: "<time>",
    });
    expect((failed.value.failures as Array<{ turn_record: { task_id: string } }>)[0]?.turn_record.task_id).toBe(taskId);

    const turns = await mcp.tool("agentx_admin_turns", { since: new Date(Date.now() - 3_600_000).toISOString(), task_id: taskId });
    expect((turns.value.turns as Array<{ action: string; phase: string }>).map((turn) => `${turn.action}:${turn.phase}`)).toContain("start:accepted");

    expect(normalized((await mcp.tool("agentx_admin_list_projects")).value)).toEqual({ projects: [{
      name: "payments", latest_revision: 1, registered_at: "<time>", repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }], runtime_mode: "ec2-ebs", connectors: [],
      developer_tasks: { enabled: true, share: "optional", share_mode: { default: "view", allow_continue: true }, channel_members_may_use: true },
    }] });
    expect(normalized((await mcp.tool("agentx_admin_list_channels")).value)).toEqual({ bindings: [{ channel_id: "C0123456789", channel_name: "`payments-dev`", private: false, project: "payments", updated_at: "<time>" }], notices: [] });
    expect(normalized((await mcp.tool("agentx_admin_list_workspaces")).value)).toEqual({
      workspaces: [{ id: "<uuid>", project: "payments", origin: "ai_tool", owner: { task_id: "<uuid>", developer: "`Maya Chen`" }, status: "PREPARATION_FAILED", busy: false, last_activity_at: "<time>" }],
      limits: { per_person: 3, per_organization: 20, source: "parameters" }, counts: { organization: 1 }, truncated: false,
    });
    expect((await mcp.tool("agentx_admin_usage", { group_by: "origin" })).value).toMatchObject({ group_by: "origin", truncated: false });
    expect((await mcp.tool("agentx_admin_health")).value).toMatchObject({ version: { developer_api: "1.2", admin_api: "1.0" }, worker_modes: [{ mode: "ec2-ebs", configured: true }] });
    expect((await mcp.tool("agentx_admin_list_credentials")).value).toMatchObject({ references: expect.any(Array) as unknown });
  });

  it("offers no admin tool to a developer without an admin sign-in, and refuses a direct call with ADMIN_REQUIRED", async () => {
    const { harness } = await failedTask();
    const mcp = await adminSignedInClient(harness, { adminToken: null });
    expect((await mcp.names()).filter((name) => name.startsWith("agentx_admin_"))).toEqual([]);
    for (const name of ADMIN_TOOLS) expect((await mcp.tool(name, name === "agentx_admin_turns" ? { since: new Date().toISOString() } : name === "agentx_admin_usage" ? { group_by: "day" } : {})).error, name).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("answers ADMIN_REQUIRED for a sign-in without the admin claim, and for a developer token sent as one", async () => {
    const { harness } = await failedTask();
    const notAdmin = await adminSignedInClient(harness, { adminToken: NON_ADMIN_TOKEN });
    await expect.poll(async () => (await notAdmin.names()).includes("agentx_admin_health")).toBe(true);
    expect((await notAdmin.tool("agentx_admin_health")).error).toMatchObject({ code: "ADMIN_REQUIRED" });
    const confused = await adminSignedInClient(harness, { adminToken: (await adminSignedInClient(harness)).developerToken });
    await expect.poll(async () => (await confused.names()).includes("agentx_admin_health")).toBe(true);
    expect((await confused.tool("agentx_admin_list_projects")).error).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("carries no planted secret in any admin result or log line (SC-004)", async () => {
    const { harness } = await failedTask();
    // A turn record written by an older release, before its text was redacted.
    const at = new Date(Date.now() - 60_000).toISOString();
    harness.db.set({
      pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000100", sk: `TURN#${at}#EvPLANT00001`, exportPk: "TURNS", exportSk: `${at}#EvPLANT00001`, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], eventId: "EvPLANT00001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000100", receivedAt: at,
      requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered", startedAt: at, finishedAt: at, durationMs: 1,
      requestText: `use ${PLANTED[1]} and ${PLANTED[2]}`, responseText: `done with ${PLANTED[0]}`,
    });
    const mcp = await adminSignedInClient(harness);
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_turns")).toBe(true);
    for (const name of ADMIN_TOOLS) await mcp.tool(name, name === "agentx_admin_turns" ? { since: new Date(Date.now() - 3_600_000).toISOString() } : name === "agentx_admin_usage" ? { group_by: "project" } : {});
    for (const secret of [...PLANTED, ADMIN_TOKEN]) {
      expect(mcp.answers.join("\n")).not.toContain(secret);
      expect(mcp.stderr.join("")).not.toContain(secret);
    }
  });
});
