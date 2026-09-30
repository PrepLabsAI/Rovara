// tests/contract/mcp-tools.test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import {
  DEVELOPER_TOOLS, NEXT_STEPS, REQUIRED_SERVER_MINOR, ToolError, UPGRADE_AGENTX_STEP, compatibilityChecker, createAgentXMcpServer,
  type ControlPlaneClient, type ToolContext,
} from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const PLANTED = "xoxb-3333333333-planted-secret";
const view = (status: DeveloperTaskView["status"], extra: Partial<DeveloperTaskView> = {}): DeveloperTaskView => ({
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status, startingRevision: 7, client: "Claude Code", shared: false,
  createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z", events: [], ...extra,
});
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]?.text ?? "";

async function connect(client: Partial<ControlPlaneClient>, overrides: Partial<ToolContext> = {}, clientName = "claude-code", log?: (entry: Record<string, unknown>) => void) {
  let now = 0;
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.4.0",
    adminSignedIn: async () => false,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2" }),
    now: () => now, sleep: async (ms) => { now += ms; await new Promise((resolve) => setTimeout(resolve, 1)); },
    newRequestId: () => "33333333-3333-4333-8333-333333333333",
    ...overrides,
  });
  const server = createAgentXMcpServer({ version: "0.4.0", context, ...(log === undefined ? {} : { log }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: clientName, version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

describe("the tool list (FR-027, FR-028, SC-010)", () => {
  it("lists exactly the module's developer tools, each with an output schema", async () => {
    const { tools } = await (await connect({})).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(tools.map((tool) => tool.name)).toEqual([
      "agentx_whoami", "agentx_list_projects", "agentx_start_task", "agentx_get_task", "agentx_wait_for_task",
      "agentx_list_tasks", "agentx_continue_task", "agentx_cancel_task", "agentx_close_task", "agentx_share_task", "agentx_open_pull_request",
    ]);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
    expect(JSON.stringify(tools)).not.toContain("\u2014");
  });

  it("serves the module's own titles, descriptions and inputs (SC-010)", async () => {
    const { tools } = await (await connect({})).listTools();
    for (const [index, tool] of tools.entries()) {
      const definition = DEVELOPER_TOOLS[index]!;
      expect(tool.title, tool.name).toBe(definition.title);
      expect(tool.description, tool.name).toBe(definition.description);
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toEqual(Object.keys(definition.inputSchema));
      expect(Object.keys(tool.outputSchema?.properties ?? {}), tool.name).toEqual(Object.keys(definition.outputSchema));
    }
  });

  it("says what updated_at means wherever a tool returns it (25c note 4)", async () => {
    const { tools } = await (await connect({})).listTools();
    const found: Array<{ tool: string; description: unknown }> = [];
    const walk = (tool: string, node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const properties = (node as { properties?: Record<string, unknown> }).properties;
      if (properties?.updated_at !== undefined) found.push({ tool, description: (properties.updated_at as { description?: unknown }).description });
      for (const value of Object.values(node)) walk(tool, value);
    };
    for (const tool of tools) walk(tool.name, tool.outputSchema);
    expect(found.map((entry) => entry.tool)).toEqual(expect.arrayContaining(["agentx_get_task", "agentx_list_tasks"]));
    for (const entry of found) expect(entry.description, entry.tool).toBe("when the latest request on this task started; share changes do not move it");
  });

  it("offers the owner's share tool and no admin tool in this phase (Q2: an admin switches a mode with the CLI)", async () => {
    const { tools } = await (await connect({})).listTools();
    expect(tools.map((tool) => tool.name).filter((name) => name.includes("share") || name.includes("admin"))).toEqual(["agentx_share_task"]);
  });
});

describe("tool errors (FR-049, ruling F3)", () => {
  it("still reads as an error after the client listed the tools (SDK 1.30.1 validates structuredContent then)", async () => {
    const mcp = await connect({ getTask: async () => { throw new ToolError("TASK_NOT_FOUND", `task ${TASK} doesn't exist`); } });
    await mcp.listTools();
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toBeUndefined();
    expect(toolError(result)).toEqual({ code: "TASK_NOT_FOUND", message: `task ${TASK} doesn't exist`, next_step: NEXT_STEPS.TASK_NOT_FOUND });
  });

  it("answers an unexpected failure without its words, and logs only the tool and code", async () => {
    const log = vi.fn();
    const mcp = await connect({ getTask: async () => { throw new Error(`boom ${PLANTED}`); } }, {}, "claude-code", log);
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(toolError(result)).toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(JSON.stringify(result)).not.toContain("boom");
    expect(log).toHaveBeenCalledWith({ event: "tool.failed", tool: "agentx_get_task", code: "CONTROL_PLANE_UNAVAILABLE", error: "Error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(PLANTED);
  });

  it("does not repeat a full stop that ends the message or the next step", async () => {
    const mcp = await connect({ getTask: async () => { throw new ToolError("TASK_BUSY", "the task is still working.", "wait for it."); } });
    expect(text(await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } }))).toBe("TASK_BUSY: the task is still working. Next step: wait for it.");
  });

  it("refuses input outside a tool's schema without calling AgentX", async () => {
    const getTask = vi.fn();
    const result = await (await connect({ getTask })).callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 601 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("wait_seconds");
    expect(getTask).not.toHaveBeenCalled();
  });
});

describe("agentx_start_task (US1, US2)", () => {
  it("hands off and answers at once, passing the client's name and a request ID", async () => {
    const startTask = vi.fn(async () => view("STARTING"));
    const getTask = vi.fn();
    const mcp = await connect({ startTask, getTask });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix the flaky retry test" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ task_id: TASK, status: "STARTING", project: "payments", starting_revision: 7, shared: false, share_mode: null });
    expect(result.structuredContent).not.toHaveProperty("timed_out");
    expect(startTask).toHaveBeenCalledWith({ requestId: "33333333-3333-4333-8333-333333333333", project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect(getTask).not.toHaveBeenCalled();
    expect(text(result)).toContain(TASK);
    expect(text(result)).toContain("agentx_get_task");
  });

  it("passes the caller's request_id and title through unchanged", async () => {
    const startTask = vi.fn(async () => view("STARTING"));
    await (await connect({ startTask })).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "a\nb", title: "Short", request_id: "66666666-6666-4666-8666-666666666666" } });
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ requestId: "66666666-6666-4666-8666-666666666666", title: "Short", instructions: "a\nb" }));
  });

  it("waits when asked, sending progress, and returns the finished task", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("SUCCEEDED", { summary: "All tests pass." }));
    const mcp = await connect({ startTask: async () => view("STARTING"), getTask });
    const progress: unknown[] = [];
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "run the tests", wait_seconds: 60 } }, undefined, { onprogress: (update) => progress.push(update) });
    expect(result.structuredContent).toMatchObject({ status: "SUCCEEDED", summary: "All tests pass.", timed_out: false });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ progress: 0, total: 60 });
  });

  it("still answers with the started task when checking on it fails during the wait, saying it was not a timeout", async () => {
    const log = vi.fn();
    const getTask = vi.fn(async () => { throw new ToolError("CONTROL_PLANE_UNAVAILABLE", "could not reach AgentX"); });
    const result = await (await connect({ startTask: async () => view("STARTING"), getTask }, {}, "claude-code", log)).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x", wait_seconds: 30 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ task_id: TASK, status: "STARTING", timed_out: false, wait_failed: { code: "CONTROL_PLANE_UNAVAILABLE", message: "could not reach AgentX" } });
    expect(text(result)).toContain("could not reach AgentX");
    expect(text(result)).toContain("agentx_get_task");
    expect(log).toHaveBeenCalledWith({ event: "tool.wait_failed", tool: "agentx_start_task", code: "CONTROL_PLANE_UNAVAILABLE" });
  });

  it("gives agentx_wait_for_task's failed check the same accurate answer", async () => {
    const log = vi.fn();
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING")).mockRejectedValueOnce(new Error(`socket ${PLANTED}`));
    const result = await (await connect({ getTask }, {}, "claude-code", log)).callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 30 } });
    expect(result.structuredContent).toMatchObject({ status: "RUNNING", timed_out: false, wait_failed: { code: "CONTROL_PLANE_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(log).toHaveBeenCalledWith({ event: "tool.wait_failed", tool: "agentx_wait_for_task", code: "CONTROL_PLANE_UNAVAILABLE" });
  });

  it("does not read the task again at once after starting it", async () => {
    const getTask = vi.fn(async () => view("SUCCEEDED"));
    let now = 0;
    const polls: number[] = [];
    getTask.mockImplementation(async () => { polls.push(now); return view("SUCCEEDED"); });
    await (await connect({ startTask: async () => view("STARTING"), getTask }, { now: () => now, sleep: async (ms) => { now += ms; } })).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x", wait_seconds: 30 } });
    expect(polls).toEqual([2_000]);
  });

  it("refuses instructions over 65,536 bytes as INVALID_REQUEST without calling AgentX", async () => {
    const startTask = vi.fn();
    const result = await (await connect({ startTask })).callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "\u20ac".repeat(21_846) } });
    expect(toolError(result)).toMatchObject({ code: "INVALID_REQUEST" });
    expect(startTask).not.toHaveBeenCalled();
  });

  it("returns a control-plane refusal as a tool error with code, message and next step (FR-049)", async () => {
    const mcp = await connect({ startTask: async () => { throw new ToolError("PROJECT_ACCESS_DENIED", "you don't have access to `payments`: ask an admin"); } });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x" } });
    expect(toolError(result)).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin", next_step: "join one of the project's Slack channels, or ask an admin for access" });
  });
});

describe("request IDs when the AI tool leaves request_id out (Task 15 fix round 1)", () => {
  const counter = () => { let next = 0; return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`; };

  it("sends the same requestId for a repeated identical start, even with another wait, and returns it", async () => {
    const startTask = vi.fn(async () => view("SUCCEEDED"));
    const mcp = await connect({ startTask }, { newRequestId: counter() });
    const first = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix the flaky retry test" } });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix the flaky retry test", wait_seconds: 30 } });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix the other test" } });
    const ids = startTask.mock.calls.map((call) => (call as unknown as [{ requestId: string }])[0].requestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(first.structuredContent).toMatchObject({ request_id: ids[0] });
  });

  it("gives the same instructions a fresh requestId after 15 minutes, so a deliberate repeat starts new work", async () => {
    let now = 0;
    const startTask = vi.fn(async () => view("STARTING"));
    const mcp = await connect({ startTask }, { newRequestId: counter(), now: () => now });
    const start = () => mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "run the tests" } });
    await start();
    now = 14 * 60_000;
    await start();
    now = 15 * 60_000;
    await start();
    const ids = startTask.mock.calls.map((call) => (call as unknown as [{ requestId: string }])[0].requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("keeps the caller's own request_id, and tells projects, tools and tasks apart", async () => {
    const startTask = vi.fn(async () => view("STARTING"));
    const continueTask = vi.fn(async () => view("RUNNING"));
    const mcp = await connect({ startTask, continueTask }, { newRequestId: counter() });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x", request_id: "66666666-6666-4666-8666-666666666666" } });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "billing", instructions: "x" } });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x" } });
    await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "x", title: "Other" } });
    const continued = await mcp.callTool({ name: "agentx_continue_task", arguments: { task_id: TASK, instructions: "x" } });
    await mcp.callTool({ name: "agentx_continue_task", arguments: { task_id: TASK, instructions: "x", wait_seconds: 0 } });
    const starts = startTask.mock.calls.map((call) => (call as unknown as [{ requestId: string }])[0].requestId);
    const continues = continueTask.mock.calls.map((call) => (call as unknown as [string, { requestId: string }])[1].requestId);
    expect(starts[0]).toBe("66666666-6666-4666-8666-666666666666");
    expect(new Set([...starts, continues[0]]).size).toBe(5);
    expect(continues[1]).toBe(continues[0]);
    expect(continued.structuredContent).toMatchObject({ request_id: continues[0] });
  });

  it("repeats an identical pull request call with the same requestId, and returns it", async () => {
    const openPullRequest = vi.fn(async () => ({ task: view("SUCCEEDED"), operationId: "55555555-5555-4555-8555-555555555555", operationStatus: "ACCEPTED" as const }));
    const mcp = await connect({ openPullRequest }, { newRequestId: counter() });
    const first = await mcp.callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "Fix", body: "b" } });
    await mcp.callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "Fix", body: "b" } });
    await mcp.callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "Fix", body: "other" } });
    const ids = openPullRequest.mock.calls.map((call) => (call as unknown as [string, { requestId: string }])[1].requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(first.structuredContent).toMatchObject({ request_id: ids[0] });
  });

  it("tells the AI tool how to retry safely", () => {
    for (const name of ["agentx_start_task", "agentx_continue_task", "agentx_open_pull_request"]) {
      expect(DEVELOPER_TOOLS.find((tool) => tool.name === name)?.description, name).toContain("send your own request_id, or repeat the call unchanged");
    }
  });
  it("sends the same requestId for two identical cancels, so a retry hits AgentX's idempotency (final review M3)", async () => {
    const cancelTask = vi.fn(async () => view("CANCELLED"));
    const mcp = await connect({ cancelTask }, { newRequestId: counter() });
    await mcp.callTool({ name: "agentx_cancel_task", arguments: { task_id: TASK } });
    await mcp.callTool({ name: "agentx_cancel_task", arguments: { task_id: TASK } });
    const ids = cancelTask.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("gives a cancel sent after a continue a new requestId, so it stops the new turn", async () => {
    const cancelTask = vi.fn(async () => view("CANCELLED"));
    const continueTask = vi.fn(async () => view("RUNNING"));
    const mcp = await connect({ cancelTask, continueTask }, { newRequestId: counter() });
    await mcp.callTool({ name: "agentx_cancel_task", arguments: { task_id: TASK } });
    await mcp.callTool({ name: "agentx_continue_task", arguments: { task_id: TASK, instructions: "Try again" } });
    await mcp.callTool({ name: "agentx_cancel_task", arguments: { task_id: TASK } });
    const ids = cancelTask.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("still gives each close a fresh requestId (final review M3)", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED", { closing: true }), closed: false }));
    const mcp = await connect({ closeTask }, { newRequestId: counter() });
    await mcp.callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    await mcp.callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    const ids = closeTask.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

});

describe("the other task tools (FR-030)", () => {
  it("continues a task, waiting when asked", async () => {
    const continueTask = vi.fn(async () => view("RUNNING"));
    const getTask = vi.fn(async () => view("SUCCEEDED"));
    const result = await (await connect({ continueTask, getTask })).callTool({ name: "agentx_continue_task", arguments: { task_id: TASK, instructions: "Add a test.", wait_seconds: 20 } });
    expect(continueTask).toHaveBeenCalledWith(TASK, { requestId: "33333333-3333-4333-8333-333333333333", instructions: "Add a test." });
    expect(result.structuredContent).toMatchObject({ status: "SUCCEEDED", timed_out: false });
  });

  it("waits for a task with agentx_wait_for_task, and gives timed_out when it outlives the wait", async () => {
    const getTask = vi.fn(async () => view("RUNNING"));
    const result = await (await connect({ getTask })).callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 10, events: 3 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "RUNNING", timed_out: true });
    expect(getTask).toHaveBeenCalledWith(TASK, 3, expect.objectContaining({ deadlineMs: 10_000, signal: expect.any(AbortSignal) as unknown }));
    expect(text(result)).toContain("keeps running");
  });

  it("stops the wait when the AI tool cancels the call (MCP cancellation, Review Focus 2)", async () => {
    const getTask = vi.fn(async () => view("RUNNING"));
    const mcp = await connect({ getTask }, { sleep: (_ms, signal) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }) });
    const controller = new AbortController();
    const call = mcp.callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 600 } }, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(call).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const calls = getTask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getTask.mock.calls.length).toBe(calls);
  });

  it("lists tasks newest first, as AgentX returns them", async () => {
    const listTasks = vi.fn(async () => [{ taskId: TASK, title: "Fix", project: "payments", status: "RUNNING" as const, shared: false, createdAt: "c", updatedAt: "u" }]);
    const result = await (await connect({ listTasks })).callTool({ name: "agentx_list_tasks", arguments: { status: "RUNNING" } });
    expect(listTasks).toHaveBeenCalledWith({ limit: 20, status: "RUNNING" });
    expect(result.structuredContent).toEqual({ tasks: [{ task_id: TASK, title: "Fix", project: "payments", status: "RUNNING", created_at: "c", updated_at: "u", shared: false }] });
  });

  it("cancels a task and shows its status after the request", async () => {
    const cancelTask = vi.fn(async () => view("CANCELLED"));
    const result = await (await connect({ cancelTask })).callTool({ name: "agentx_cancel_task", arguments: { task_id: TASK } });
    expect(cancelTask).toHaveBeenCalledWith(TASK, "33333333-3333-4333-8333-333333333333");
    expect(result.structuredContent).toMatchObject({ status: "CANCELLED" });
  });

  it("lists projects with channels and policy, and no description (R28)", async () => {
    const projects = async () => ({
      developer: { id: "d".repeat(64), name: "Maya Chen", provider: "slack" as const },
      projects: [
        { name: "payments", latestRevision: 3, access: "channel" as const, channels: [{ channelId: "C0PAY0001", name: "payments" }], tasks: { enabled: true, share: "optional" as const, shareMode: { default: "view" as const, allowContinue: false }, channelMembersMayUse: true } },
        { name: "legacy", latestRevision: 1, access: "granted" as const, channels: [] },
      ],
      notices: ["slack_unavailable" as const],
    });
    const result = await (await connect({ projects })).callTool({ name: "agentx_list_projects", arguments: {} });
    expect(result.structuredContent).toEqual({
      projects: [
        { name: "payments", access: "channel", bound_channels: [{ id: "C0PAY0001", name: "payments" }], tasks_enabled: true, share_policy: "optional", share_mode_policy: { default: "view", allow_continue: false } },
        // A project without a task policy is shown as closed to tasks, the way the broker treats it.
        { name: "legacy", access: "granted", bound_channels: [], tasks_enabled: false, share_policy: "optional", share_mode_policy: { default: "view", allow_continue: true } },
      ],
      notices: ["slack_unavailable"],
    });
    expect(text(result)).toContain("Slack could not be reached");
  });
});

describe("every tool result is redacted and capped (FR-029, SC-004)", () => {
  it("removes a planted secret from the task's summary, events and failure", async () => {
    const leaky = view("FAILED", { summary: `used ${PLANTED}`, events: [{ at: "t", kind: "error", text: PLANTED }], failure: { category: "task_failed", message: PLANTED } });
    const result = await (await connect({ getTask: async () => leaky })).callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  });

  it("removes a planted secret from an error message", async () => {
    const mcp = await connect({ getTask: async () => { throw new ToolError("CONTROL_PLANE_UNAVAILABLE", `bad ${PLANTED}`); } });
    expect(JSON.stringify(await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } }))).not.toContain(PLANTED);
  });

  it("removes a planted secret from progress notifications", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING", { events: [{ at: "t", kind: "tool", text: `export SLACK_BOT_TOKEN=${PLANTED}` }] })).mockResolvedValueOnce(view("SUCCEEDED"));
    const progress: unknown[] = [];
    await (await connect({ getTask })).callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 30 } }, undefined, { onprogress: (update) => progress.push(update) });
    expect(progress.length).toBeGreaterThan(0);
    expect(JSON.stringify(progress)).not.toContain(PLANTED);
  });

  it("caps what reaches the model, even when AgentX sends more than it should", async () => {
    const changedFiles = Array.from({ length: 500 }, (_, index) => ({ repository: "demo", path: `src/${index}.ts`, added: 1, removed: 0 }));
    const huge = view("SUCCEEDED", { title: "t".repeat(50_000), changedFiles });
    const result = await (await connect({ getTask: async () => huge })).callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    const structured = result.structuredContent as { title: string; changed_files: unknown[] };
    expect(structured.title.length).toBeLessThanOrEqual(4_000);
    expect(structured.changed_files.length).toBeLessThanOrEqual(200);
    expect(text(result).length).toBeLessThanOrEqual(20_000);
  });
});

describe("the error and progress caps (Task 15 fix round 1)", () => {
  it("cuts an error's text to 2,000 characters", async () => {
    const mcp = await connect({ getTask: async () => { throw new ToolError("TASK_BUSY", "w".repeat(5_000)); } });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.isError).toBe(true);
    expect(text(result).startsWith("TASK_BUSY: www")).toBe(true);
    expect(text(result).length).toBe(2_000);
  });

  it("cuts a progress message to 300 characters", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING", { events: [{ at: "t", kind: "tool", text: "p".repeat(5_000) }] })).mockResolvedValueOnce(view("SUCCEEDED"));
    const progress: Array<{ message?: string }> = [];
    await (await connect({ getTask })).callTool({ name: "agentx_wait_for_task", arguments: { task_id: TASK, wait_seconds: 30 } }, undefined, { onprogress: (update) => progress.push(update as { message?: string }) });
    expect(progress[0]?.message?.startsWith("RUNNING: ppp")).toBe(true);
    expect(progress[0]?.message?.length).toBe(300);
  });
});

describe("versions (FR-048, R23, ruling S1)", () => {
  it("answers UPGRADE_REQUIRED from every tool when the control plane is not compatible", async () => {
    const projects = vi.fn();
    const mcp = await connect({ projects }, { compatibility: async () => { throw new ToolError("UPGRADE_REQUIRED", "AgentX answers API 2.0"); } });
    for (const name of ["agentx_whoami", "agentx_list_projects"]) {
      expect(toolError(await mcp.callTool({ name, arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
    }
    expect(projects).not.toHaveBeenCalled();
  });

  it("shows the upgrade notice in agentx_whoami, with who the developer is", async () => {
    const projects = async () => ({ developer: { id: "d".repeat(64), name: "Maya Chen", provider: "slack" as const, slackUserId: "U0MAYA001" }, projects: [], notices: [] });
    const mcp = await connect({ projects }, { compatibility: async () => ({ env: "staging", apiVersion: "1.2", notice: "a newer AgentX CLI is available" }), adminSignedIn: async () => true });
    const result = await mcp.callTool({ name: "agentx_whoami", arguments: {} });
    expect(result.structuredContent).toEqual({
      environment: "staging", developer_name: "Maya Chen", sign_in_method: "slack", slack_user: "U0MAYA001", admin: true,
      server_version: "0.4.0", control_plane_api_version: "1.2", upgrade_notice: "a newer AgentX CLI is available",
    });
    expect(text(result)).toContain("admin sign-in");
  });

  const configured = (apiVersion: string) => ({ configuration: vi.fn(async () => ({ env: "staging", apiVersion, baseUrl: "https://agentx.example.test" })) });

  it("needs minor version 2: a 1.0 control plane asks for an AgentX upgrade (ruling S1)", async () => {
    expect(REQUIRED_SERVER_MINOR).toBe(2);
    const failure = await compatibilityChecker(configured("1.0") as unknown as ControlPlaneClient)().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({ code: "UPGRADE_REQUIRED", nextStep: UPGRADE_AGENTX_STEP });
  });

  it("refuses another major version, asking for a CLI upgrade when AgentX is newer", async () => {
    await expect(compatibilityChecker(configured("2.0") as unknown as ControlPlaneClient)()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", nextStep: NEXT_STEPS.UPGRADE_REQUIRED });
    await expect(compatibilityChecker(configured("0.9") as unknown as ControlPlaneClient)()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", nextStep: UPGRADE_AGENTX_STEP });
  });

  it("works with 1.2 and gives a notice for a newer minor", async () => {
    expect(await compatibilityChecker(configured("1.2") as unknown as ControlPlaneClient)()).toEqual({ env: "staging", apiVersion: "1.2" });
    // C20: a 25b control plane (1.1) has no share route, so only an AgentX upgrade helps.
    await expect(compatibilityChecker(configured("1.1") as unknown as ControlPlaneClient)()).rejects.toMatchObject({ code: "UPGRADE_REQUIRED", nextStep: UPGRADE_AGENTX_STEP });
    const newer = await compatibilityChecker(configured("1.3") as unknown as ControlPlaneClient)();
    expect(newer).toMatchObject({ env: "staging", apiVersion: "1.3" });
    expect(newer.notice).toContain("mcp install");
  });

  it("asks AgentX again only after 10 minutes, and never keeps a refusal", async () => {
    let now = 0;
    const client = configured("1.2");
    const check = compatibilityChecker(client as unknown as ControlPlaneClient, { now: () => now });
    await check();
    now = 599_999;
    await check();
    expect(client.configuration).toHaveBeenCalledTimes(1);
    now = 600_000;
    await check();
    expect(client.configuration).toHaveBeenCalledTimes(2);

    const old = configured("1.0");
    const refusing = compatibilityChecker(old as unknown as ControlPlaneClient, { now: () => 0 });
    await expect(refusing()).rejects.toBeInstanceOf(ToolError);
    await expect(refusing()).rejects.toBeInstanceOf(ToolError);
    expect(old.configuration).toHaveBeenCalledTimes(2);
  });
});

describe("agentx_open_pull_request and agentx_close_task return at once (R22, Owner decision 6)", () => {
  it("opens a draft and answers with the started operation, calling AgentX once", async () => {
    const openPullRequest = vi.fn(async () => ({ task: view("RUNNING"), operationId: "55555555-5555-4555-8555-555555555555", operationStatus: "ACCEPTED" as const }));
    const result = await (await connect({ openPullRequest })).callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "Fix the retry test" } });
    expect(result.structuredContent).toMatchObject({ operation_id: "55555555-5555-4555-8555-555555555555", operation_status: "ACCEPTED", task: { task_id: TASK, status: "RUNNING" } });
    expect(result.structuredContent).not.toHaveProperty("timed_out");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(openPullRequest.mock.calls[0]?.[1]).toMatchObject({ requestId: "33333333-3333-4333-8333-333333333333", draft: true });
    expect(text(result)).toContain("agentx_get_task");
  });

  it("returns the PR's URL when a retried call finds it already published", async () => {
    const pullRequest = { repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", state: "open" as const };
    const openPullRequest = vi.fn(async () => ({ task: view("SUCCEEDED"), operationId: "55555555-5555-4555-8555-555555555555", operationStatus: "SUCCEEDED" as const, pullRequest }));
    const result = await (await connect({ openPullRequest })).callTool({ name: "agentx_open_pull_request", arguments: { task_id: TASK, title: "x", request_id: "66666666-6666-4666-8666-666666666666" } });
    expect(result.structuredContent).toMatchObject({ operation_status: "SUCCEEDED", pull_request: pullRequest });
    expect(openPullRequest.mock.calls[0]?.[1]).toMatchObject({ requestId: "66666666-6666-4666-8666-666666666666" });
  });

  it("starts the close and answers at once with closing, calling AgentX once", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED", { closing: true }), closed: false }));
    const result = await (await connect({ closeTask })).callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ task_id: TASK, closing: true, closed: false });
    expect(result.structuredContent).not.toHaveProperty("timed_out");
    expect(closeTask).toHaveBeenCalledTimes(1);
    expect(text(result)).toContain("agentx_get_task");
  });

  it("uses AgentX's own words for a close that is not done, redacted", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED", { closing: true }), closed: false, message: `the close preflight is running on demo ${PLANTED}; check back with agentx_get_task` }));
    const result = await (await connect({ closeTask })).callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    expect(text(result)).toContain("the close preflight is running on demo");
    expect(text(result)).not.toContain(PLANTED);
  });

  it("says why when a retried close finds unpublished work", async () => {
    const closeTask = vi.fn(async () => ({ task: view("SUCCEEDED"), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] }));
    const result = await (await connect({ closeTask })).callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] });
    expect(text(result)).toContain("agentx_open_pull_request");
  });

  it("shows a refused close in agentx_get_task", async () => {
    const getTask = async () => view("SUCCEEDED", { unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
    const result = await (await connect({ getTask })).callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
  });
});
