// tests/contract/mcp-admin-tools.test.ts
// Spec 025 FR-030: the admin read tools, their inputs, outputs and text, against a fake admin client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_READ_TOOLS, DEVELOPER_TOOLS, ToolError, createAgentXMcpServer, type AdminControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const PLANTED = `xoxb-${"1".repeat(10)}-planted-bot-token`;

async function connect(admin: Partial<AdminControlPlaneClient> | undefined) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => true,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" }), now: () => 0, sleep: async () => undefined,
    newRequestId: () => "33333333-3333-4333-8333-333333333333", ...(admin === undefined ? {} : { admin: admin as AdminControlPlaneClient }),
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: ADMIN_READ_TOOLS, adminOffer: async () => ({ admin: undefined }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(clientSide);
  await expect.poll(async () => (await client.listTools()).tools.length).toBe(DEVELOPER_TOOLS.length + ADMIN_READ_TOOLS.length);
  return client;
}

describe("the admin read tools (FR-030)", () => {
  it("are exactly FR-030's eight, each with an output schema and no em dash", async () => {
    expect(ADMIN_READ_TOOLS.map((tool) => tool.name)).toEqual([
      "agentx_admin_health", "agentx_admin_failed_tasks", "agentx_admin_turns", "agentx_admin_usage",
      "agentx_admin_list_projects", "agentx_admin_list_channels", "agentx_admin_list_credentials", "agentx_admin_list_workspaces",
    ]);
    const tools = (await (await connect({})).listTools()).tools.filter((tool) => tool.name.startsWith("agentx_admin_"));
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
    expect(JSON.stringify(tools)).not.toContain("\u2014");
  });

  it("shows failed tasks with FR-030's fields, and the turn record link", async () => {
    const failures = vi.fn(async () => ({
      since: "2026-09-29T08:00:00.000Z", until: "2026-09-30T08:00:00.000Z",
      failures: [{ operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", project: "payments", origin: "ai_tool" as const,
        requester: { kind: "developer" as const, developerId: "d".repeat(64), provider: "slack" as const, name: "Maya Chen" }, kind: "prepare", status: "FAILED" as const,
        category: "setup_failed" as const, error: "npm ci exited 1", endedAt: "2026-09-30T07:00:00.000Z", taskId: "33333333-3333-4333-8333-333333333333" }],
    }));
    const client = await connect({ failures });
    const result = await client.callTool({ name: "agentx_admin_failed_tasks", arguments: { project: "payments", limit: 10 } });
    expect(failures).toHaveBeenCalledWith({ project: "payments", limit: 10 });
    expect(result.structuredContent).toEqual({
      failures: [{ time: "2026-09-30T07:00:00.000Z", project: "payments", origin: "ai_tool", requester: "`Maya Chen` (developer)", workspace_id: "22222222-2222-4222-8222-222222222222",
        operation_id: "11111111-1111-4111-8111-111111111111", operation_kind: "prepare", category: "setup_failed", error: "npm ci exited 1", turn_record: { task_id: "33333333-3333-4333-8333-333333333333" } }],
      since: "2026-09-29T08:00:00.000Z", until: "2026-09-30T08:00:00.000Z",
    });
    expect(JSON.stringify(result.content)).toContain("1 failure");
  });

  it("passes the turn filters through, with task_id as task, and hands back the next cursor", async () => {
    const turns = vi.fn(async () => ({ turns: [{ origin: "ai_tool", taskId: "33333333-3333-4333-8333-333333333333", requestText: `echo ${PLANTED}` }], cursor: "next-page" }));
    const client = await connect({ turns });
    const result = await client.callTool({ name: "agentx_admin_turns", arguments: { since: "2026-09-29T00:00:00.000Z", task_id: "33333333-3333-4333-8333-333333333333", limit: 5 } });
    expect(turns).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", task: "33333333-3333-4333-8333-333333333333", limit: 5 });
    expect(result.structuredContent).toMatchObject({ next_cursor: "next-page" });
    // FR-029: every result is redacted, whatever the control plane sent.
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  });

  it("refuses thread and task_id together, and a time that is not ISO", async () => {
    const client = await connect({ turns: vi.fn() });
    expect(toolError(await client.callTool({ name: "agentx_admin_turns", arguments: { since: "2026-09-29T00:00:00.000Z", thread: "T0/C0/1.1", task_id: "33333333-3333-4333-8333-333333333333" } }))).toMatchObject({ code: "INVALID_REQUEST" });
    expect((await client.callTool({ name: "agentx_admin_turns", arguments: { since: "yesterday" } })).isError).toBe(true);
  });

  it("shows usage, projects, channels, credentials and workspaces in snake_case", async () => {
    const client = await connect({
      usage: async () => ({ groupBy: "project" as const, since: "s", until: "u", truncated: false, groups: [{ key: "payments", turns: 2, tasks: 1, taskDurationMs: 60_000, inputTokens: 10, outputTokens: 2, costUsd: 0.5, costUnknown: 0 }] }),
      projects: async () => ({ projects: [{ name: "payments", latestRevision: 2, registeredAt: "r", repositories: [{ name: "demo", url: "https://github.com/example/demo.git" }], runtimeMode: "ec2-ebs", connectors: [], developerTasks: { enabled: true, share: "optional" as const, shareMode: { default: "view" as const, allowContinue: true }, channelMembersMayUse: true } }] }),
      bindings: async () => ({ notices: [], bindings: [{ teamId: "T0BSHLLUGBD", channelId: "C0123456789", channelName: "payments-dev", private: false, projectName: "payments", updatedAt: "t" }] }),
      credentials: async () => ({ credentials: [{ ref: "github-app", type: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:gh", builtIn: true }] }),
      workspaces: async () => ({ workspaces: [], limits: { perPerson: 3, perOrganization: 20, source: "parameters" as const }, counts: { organization: 0 }, truncated: false }),
    });
    expect((await client.callTool({ name: "agentx_admin_usage", arguments: { group_by: "project" } })).structuredContent).toMatchObject({ groups: [{ key: "payments", turns: 2, tasks: 1, task_duration_ms: 60_000, input_tokens: 10, output_tokens: 2, cost_usd: 0.5, cost_unknown: 0 }] });
    expect((await client.callTool({ name: "agentx_admin_list_projects", arguments: {} })).structuredContent).toMatchObject({ projects: [{ name: "payments", latest_revision: 2, runtime_mode: "ec2-ebs", developer_tasks: { share: "optional" } }] });
    expect((await client.callTool({ name: "agentx_admin_list_channels", arguments: {} })).structuredContent).toMatchObject({ bindings: [{ channel_id: "C0123456789", channel_name: "payments-dev", project: "payments" }] });
    expect((await client.callTool({ name: "agentx_admin_list_credentials", arguments: {} })).structuredContent).toMatchObject({ references: [{ ref: "github-app", type: "github-app", built_in: true }] });
    expect((await client.callTool({ name: "agentx_admin_list_workspaces", arguments: {} })).structuredContent).toMatchObject({ limits: { per_person: 3, per_organization: 20, source: "parameters" } });
  });

  it("answers ADMIN_REQUIRED when the server holds no admin client", async () => {
    const client = await connect(undefined);
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("passes a refusal through as its tool error", async () => {
    const client = await connect({ health: async () => { throw new ToolError("ADMIN_REQUIRED", "AgentX refused this computer's admin sign-in, or it has expired", "run npx @charterarc/agentx login --admin"); } });
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("shows the dead-letter queues' own check (ruling R18), and says their status", async () => {
    const health = {
      version: { developerApi: "1.2", adminApi: "1.0" }, alarms: [{ name: "agentx-staging-errors", state: "OK" }], alarmsCheck: { status: "ok" as const },
      deadLetterQueues: [{ name: "agentx-staging-dlq", depth: 3 }], deadLetterQueuesCheck: { status: "warn" as const, detail: "3 messages waiting" },
      slack: { status: "ok" as const }, github: { status: "ok" as const }, workerModes: [{ mode: "ec2-ebs", configured: true }], workspaces: { READY: 2 }, workspacesTruncated: false,
    };
    const client = await connect({ health: async () => health });
    const result = await client.callTool({ name: "agentx_admin_health", arguments: {} });
    expect(result.structuredContent).toMatchObject({ dead_letter_queues: [{ name: "agentx-staging-dlq", depth: 3 }], dead_letter_queues_check: { status: "warn", detail: "3 messages waiting" } });
    expect(JSON.stringify(result.content)).toContain("Dead-letter queues: warn");
    // An older control plane sends no queue check: the answer still reads, without the field.
    const older: Partial<typeof health> = { ...health };
    delete older.deadLetterQueuesCheck;
    const olderResult = await (await connect({ health: async () => older as never })).callTool({ name: "agentx_admin_health", arguments: {} });
    expect(olderResult.isError).toBeFalsy();
    expect(olderResult.structuredContent).not.toHaveProperty("dead_letter_queues_check");
  });

  it("passes the unreadable items' skipped count through for failures and usage", async () => {
    const client = await connect({
      failures: async () => ({ since: "s", until: "u", failures: [], skipped: 2 }),
      usage: async () => ({ groupBy: "day" as const, since: "s", until: "u", truncated: false, groups: [], skipped: 4 }),
    });
    expect((await client.callTool({ name: "agentx_admin_failed_tasks", arguments: {} })).structuredContent).toMatchObject({ skipped: 2 });
    expect((await client.callTool({ name: "agentx_admin_usage", arguments: { group_by: "day" } })).structuredContent).toMatchObject({ skipped: 4 });
    const without = await connect({
      failures: async () => ({ since: "s", until: "u", failures: [] }),
      usage: async () => ({ groupBy: "day" as const, since: "s", until: "u", truncated: false, groups: [] }),
    });
    expect((await without.callTool({ name: "agentx_admin_failed_tasks", arguments: {} })).structuredContent).not.toHaveProperty("skipped");
    expect((await without.callTool({ name: "agentx_admin_usage", arguments: { group_by: "day" } })).structuredContent).not.toHaveProperty("skipped");
  });

  it("lists credentials under references, so FR-029's redaction keeps the list and its secret names", async () => {
    const client = await connect({ credentials: async () => ({ credentials: [{ ref: "jira", type: "static-secret", secretName: "agentx/staging/connectors/jira", registeredAt: "2026-09-01T00:00:00.000Z" }] }) });
    const result = await client.callTool({ name: "agentx_admin_list_credentials", arguments: {} });
    expect(result.structuredContent).toEqual({ references: [{ ref: "jira", type: "static-secret", secret_name: "agentx/staging/connectors/jira", registered_at: "2026-09-01T00:00:00.000Z" }] });
    expect(JSON.stringify(result.content)).toContain("1 connector credential registered: jira (static-secret).");
  });

  it("marks a workspace owner's developer name inert", async () => {
    const client = await connect({
      workspaces: async () => ({
        workspaces: [{ id: "22222222-2222-4222-8222-222222222222", project: "payments", origin: "ai_tool" as const, owner: { taskId: "33333333-3333-4333-8333-333333333333", developerName: "Maya Chen" }, status: "READY" as const, busy: false, lastActivityAt: "t" }],
        limits: { perPerson: 3, perOrganization: 20, source: "setting" as const }, counts: { organization: 1 }, truncated: false,
      }),
    });
    expect((await client.callTool({ name: "agentx_admin_list_workspaces", arguments: {} })).structuredContent).toMatchObject({ workspaces: [{ owner: { task_id: "33333333-3333-4333-8333-333333333333", developer: "`Maya Chen`" } }] });
  });

  it("each description says when to use the tool and what to do next", () => {
    for (const tool of ADMIN_READ_TOOLS) {
      expect(tool.description, tool.name).toMatch(/\bUse it\b/);
      expect(tool.description, tool.name).toMatch(/\b(then|next|Next|after|before)\b/);
    }
  });
});
