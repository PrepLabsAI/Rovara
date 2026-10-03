// Spec 025 User Story 5 and SC-004, end to end: agentx mcp's server, the broker in process, an admin
// sign-in and a developer sign-in. Each read tool's result is compared with the expected result
// committed here (US5's "committed snapshot"; never regenerated, never vitest -u).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { failureIndexKey, usageIndexKey } from "../../packages/contracts/src/index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { MAYA, bearerFor, recordStream } from "../support/developer-task-broker.js";
import { ADMIN_TOKEN, NON_ADMIN_TOKEN, REFRESH_TOKEN, adminSignedInClient } from "../support/mcp-broker-client.js";
import { call } from "../support/slack-broker.js";

const PLANTED = [`ghp_${"Q".repeat(36)}`, `xoxb-${"2".repeat(12)}-planted`, `agxr_${"z".repeat(43)}`];
const ADMIN_TOOLS = ["agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage", "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces"];
/** Times and IDs change each run; everything else is compared as committed. */
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")) as unknown;

async function failedTask(options: Parameters<typeof createAdminReadBroker>[0] = {}, beforeFailure: (harness: Awaited<ReturnType<typeof createAdminReadBroker>>, ids: { taskId: string; workspaceId: string; prepareId: string }) => Promise<void> = async () => undefined) {
  const harness = await createAdminReadBroker(options);
  const stream = recordStream(harness.db);
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await beforeFailure(harness, { taskId, workspaceId: task.workspaceId, prepareId });
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
    // FR-038: admin reads change nothing. Every command the eight tool calls send is a read.
    const sentBefore = harness.db.commandNames().length;

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
    const workspaceAnswer = (await mcp.tool("agentx_admin_list_workspaces")).value;
    const workspaceRows = workspaceAnswer.workspaces as Array<{ owner: Record<string, unknown> }>;
    expect(workspaceRows.map((row) => row.owner.developer_id)).toStrictEqual([MAYA.developerId]);
    // #214's additive identity is checked above; the committed legacy result stays unchanged.
    const legacyWorkspaceAnswer = { ...workspaceAnswer, workspaces: workspaceRows.map((row) => ({ ...row, owner: Object.fromEntries(Object.entries(row.owner).filter(([key]) => key !== "developer_id")) })) };
    expect(normalized(legacyWorkspaceAnswer)).toEqual({
      workspaces: [{ id: "<uuid>", project: "payments", origin: "ai_tool", owner: { task_id: "<uuid>", developer: "`Maya Chen`" }, status: "PREPARATION_FAILED", busy: false, last_activity_at: "<time>" }],
      // #213: a workspace whose setup failed no longer counts toward the limits.
      limits: { per_person: 3, per_organization: 20, source: "parameters" }, counts: { organization: 0 }, truncated: false,
    });
    expect((await mcp.tool("agentx_admin_usage", { group_by: "origin" })).value).toMatchObject({ group_by: "origin", truncated: false });
    expect((await mcp.tool("agentx_admin_health")).value).toMatchObject({ version: { developer_api: "1.2", admin_api: "1.1" }, worker_modes: [{ mode: "ec2-ebs", configured: true }] });
    expect((await mcp.tool("agentx_admin_list_credentials")).value).toMatchObject({ references: expect.any(Array) as unknown });
    const sentByTools = harness.db.commandNames().slice(sentBefore);
    expect(sentByTools.length).toBeGreaterThan(0);
    expect([...new Set(sentByTools)].sort()).toEqual(["GetCommand", "QueryCommand"]);
  });

  it("lists the admin read tools in the first tools/list after connecting, for a client that lists once (issue 203)", async () => {
    const { harness } = await failedTask();
    const mcp = await adminSignedInClient(harness);
    // Codex lists once and does not re-list on list_changed: no poll here.
    expect((await mcp.names()).filter((name) => name.startsWith("agentx_admin_") && ADMIN_TOOLS.includes(name))).toEqual(ADMIN_TOOLS);
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
    const confused = await adminSignedInClient(harness, { adminToken: (await bearerFor(MAYA)).slice("Bearer ".length) });
    await expect.poll(async () => (await confused.names()).includes("agentx_admin_health")).toBe(true);
    expect((await confused.tool("agentx_admin_list_projects")).error).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("carries no planted secret in any admin result or log line (SC-004)", async () => {
    // R21: a planted value in every source an admin tool reads. Each source a route or the index
    // writer redacts on its way in is also planted as an older release would have stored it.
    const channelInfo = async (request: { channelIds: string[] }) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: `deploys-${PLANTED[1]}`, isPrivate: false })) });
    const { harness } = await failedTask({ channelInfo }, async (broker, ids) => {
      // The developer's display name, as the task record carries it into the indexes and the workspace owner.
      const task = broker.db.get(`DEVTASK#${ids.taskId}`, "META") as Record<string, unknown>;
      broker.db.set({ ...task, developerName: `Maya ${PLANTED[2]}` });
      // A usage event: the worker's telemetry, indexed as a USAGE# item under the developer's name.
      await broker.events(ids.workspaceId, ids.prepareId, [{ type: "usage", payload: {
        schemaVersion: 1, outcome: "FAILED", provider: "bedrock", modelId: "m", cacheRetention: "short",
        tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }, cacheReadRatio: 0, costUsd: 0.01,
      } }]);
    });
    const at = new Date(Date.now() - 60_000).toISOString();
    // A turn record written by an older release, before its text was redacted, with the orchestrator's usage.
    harness.db.set({
      pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000100", sk: `TURN#${at}#EvPLANT00001`, exportPk: "TURNS", exportSk: `${at}#EvPLANT00001`, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], eventId: "EvPLANT00001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000100", receivedAt: at,
      requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered", startedAt: at, finishedAt: at, durationMs: 1,
      requestText: `use ${PLANTED[1]} and ${PLANTED[2]}`, responseText: `done with ${PLANTED[0]}`,
      usage: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: `model-${PLANTED[0]}`, cacheRetention: "short", tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 }, cacheReadRatio: 0, costUsd: 0.001 },
    });
    // A worker_unavailable failure (health's latest dispatch failure) and a usage item, as an older release indexed them, unredacted.
    const operationId = "44444444-4444-4444-8444-444444444444";
    const workspaceId = "55555555-5555-4555-8555-555555555555";
    const developer = { kind: "developer", developerId: MAYA.developerId, provider: "slack", name: `Maya ${PLANTED[0]}` };
    harness.db.set({ ...failureIndexKey(at, operationId), entityType: "FAILURE_INDEX", operationId, workspaceId, project: "payments", origin: "ai_tool", requester: developer,
      kind: "task", status: "FAILED", category: "worker_unavailable", error: `RUNTIME_UNAVAILABLE: no capacity (token ${PLANTED[1]} ${PLANTED[2]})`, endedAt: at });
    harness.db.set({ ...usageIndexKey(at, operationId), entityType: "USAGE_INDEX", operationId, workspaceId, project: "payments", origin: "ai_tool", requester: developer,
      at, durationMs: 1_000, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    // A connector credential whose secret name carries a planted value (the secret's value is never read).
    harness.db.set({ pk: "CREDENTIALS", sk: "REF#tracker-key", ref: "tracker-key", type: "static-secret", secretName: `agentx/connectors/${PLANTED[0]}`, registeredBy: `${ADMIN_TOKEN} ${PLANTED[1]}`, registeredAt: at });
    // A project field an admin tool shows: revision 2's repository URL.
    const registered = await call(harness.handler, {
      method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
      body: {
        definition: {
          name: "payments", revision: 2, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
          repositories: [{ name: "demo", url: `https://github.com/example/${PLANTED[0]}.git`, path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        },
        runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
      },
    });
    expect(registered.status).toBe(201);

    const mcp = await adminSignedInClient(harness);
    await expect.poll(async () => (await mcp.names()).includes("agentx_admin_turns")).toBe(true);
    const answers: Record<string, Awaited<ReturnType<typeof mcp.tool>>> = {};
    for (const name of ADMIN_TOOLS) answers[name] = await mcp.tool(name, name === "agentx_admin_turns" ? { since: new Date(Date.now() - 3_600_000).toISOString() } : name === "agentx_admin_usage" ? { group_by: "requester" } : {});
    // Not vacuous: every tool answered, and each planted source came back (redacted).
    for (const name of ADMIN_TOOLS) expect(answers[name]?.isError, name).toBe(false);
    const turnsAnswer = JSON.stringify(answers.agentx_admin_turns?.value);
    expect(turnsAnswer).toContain("EvPLANT00001");
    expect(turnsAnswer).toContain("[REDACTED]");
    const shown = (name: string) => JSON.stringify(answers[name]?.value);
    expect(shown("agentx_admin_list_channels")).toContain("`deploys-[REDACTED]`");
    expect(shown("agentx_admin_list_credentials")).toContain("agentx/connectors/[REDACTED]");
    expect(shown("agentx_admin_list_projects")).toContain("https://github.com/example/[REDACTED].git");
    expect(shown("agentx_admin_failed_tasks")).toContain("`Maya [REDACTED]` (developer)");
    expect(shown("agentx_admin_failed_tasks")).toContain("RUNTIME_UNAVAILABLE: no capacity (token [REDACTED] [REDACTED])");
    expect(shown("agentx_admin_health")).toContain("RUNTIME_UNAVAILABLE: no capacity (token [REDACTED] [REDACTED])");
    expect(shown("agentx_admin_usage")).toContain("developer:Maya [REDACTED]");
    expect(shown("agentx_admin_list_workspaces")).toContain("`Maya [REDACTED]`");
    for (const secret of [...PLANTED, ADMIN_TOKEN, mcp.developerToken, REFRESH_TOKEN]) {
      expect(mcp.answers.join("\n")).not.toContain(secret);
      expect(mcp.stderr.join("")).not.toContain(secret);
    }
  });
});
