// tests/contract/mcp-share-tool.test.ts
// Spec 025 FR-030, FR-049, C20, C21: sharing through the MCP tools, against a fake control plane.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import { NEXT_STEPS, UPGRADE_AGENTX_STEP, compatibilityChecker, createAgentXMcpServer, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const TASK = "44444444-4444-4444-8444-444444444444";
const view = (extra: Partial<DeveloperTaskView> = {}): DeveloperTaskView => ({
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status: "RUNNING", startingRevision: 7, client: "Claude Code", shared: false,
  createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z", events: [], ...extra,
});

async function connect(client: Partial<ControlPlaneClient>, overrides: Partial<ToolContext> = {}) {
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.5.0", adminSignedIn: async () => false,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined,
    newRequestId: () => "33333333-3333-4333-8333-333333333333",
    ...overrides,
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  await mcp.listTools();
  return mcp;
}
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]?.text ?? "";

describe("share fields in task results (FR-030, C21)", () => {
  it("says a start was shared because the project requires it, view only because continue is not allowed", async () => {
    const shared = view({ shared: true, share: { mode: "view", channelId: "C0123456789", channelName: "payments-dev", sharedReason: "required", modeReason: "continue_not_allowed" } });
    const mcp = await connect({ startTask: vi.fn(async () => shared) });
    const result = await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix it", share_mode: "continue" } });
    expect(result.structuredContent).toMatchObject({
      shared: true, share_mode: "view", share_reason: "required by project", share_mode_reason: "continue not allowed by project",
      channel: { id: "C0123456789", name: "payments-dev" }, share_posting: true,
    });
    // Q6: the start answers at once; the link comes later through agentx_get_task.
    expect(result.structuredContent).not.toHaveProperty("thread_url");
    expect(text(result)).toContain("#payments-dev");
    expect(text(result)).toContain("agentx_get_task");
  });

  it("gives the thread link once it is posted, and the channel's turns", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view({
      shared: true,
      share: { mode: "continue", channelId: "C0123456789", sharedReason: "requested", threadUrl: "https://slack.com/archives/C0123456789/p1695500000000100" },
      channelTurns: [{ author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:05:00.000Z", request: "run the linter", outcome: "answered" }],
    })) });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({
      share_mode: "continue", thread_url: "https://slack.com/archives/C0123456789/p1695500000000100",
      channel_turns: [{ author: "Priya", slack_user: "U0PRIYA001", at: "2026-09-29T10:05:00.000Z", request: "run the linter", outcome: "answered" }],
    });
    expect(result.structuredContent).not.toHaveProperty("share_reason");
    expect(result.structuredContent).not.toHaveProperty("share_posting");
    expect(text(result)).toContain("https://slack.com/archives/C0123456789/p1695500000000100");
  });

  it("names a private channel by its ID only, as AgentX sends it (R10)", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view({ shared: true, share: { mode: "view", channelId: "G0PRIVATE01", sharedReason: "requested" } })) });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ channel: { id: "G0PRIVATE01" } });
    expect((result.structuredContent as { channel: Record<string, unknown> }).channel).not.toHaveProperty("name");
    expect(text(result)).toContain("channel G0PRIVATE01");
    expect(text(result)).not.toContain("#");
  });

  it("says when the thread could not be posted", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view({ shared: true, share: { mode: "view", channelId: "C0123456789", sharedReason: "requested", postFailed: true } })) });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ share_post_failed: true });
    expect(result.structuredContent).not.toHaveProperty("share_posting");
    expect(text(result)).toContain("could not post");
  });

  it("keeps share_mode null for a private task", async () => {
    const mcp = await connect({ getTask: vi.fn(async () => view()) });
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: TASK } });
    expect(result.structuredContent).toMatchObject({ shared: false, share_mode: null });
    expect(result.structuredContent).not.toHaveProperty("channel");
    expect(text(result)).not.toContain("Shared");
  });
});

describe("agentx_share_task (FR-030)", () => {
  it("shares a task, or changes its mode, with a remembered request ID", async () => {
    const shareTask = vi.fn(async () => view({ shared: true, share: { mode: "continue", channelId: "C0123456789", sharedReason: "requested" } }));
    const mcp = await connect({ shareTask });
    const result = await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "continue", channel: "#payments-dev" } });
    expect(shareTask).toHaveBeenCalledWith(TASK, { requestId: "33333333-3333-4333-8333-333333333333", shareMode: "continue", channel: "#payments-dev" });
    expect(result.structuredContent).toMatchObject({ task_id: TASK, shared: true, share_mode: "continue", request_id: "33333333-3333-4333-8333-333333333333" });
    expect(text(result)).toContain("open to the channel");
  });

  it("sends a new request ID for view, then continue, then view again, and ends in view (Task 15 review)", async () => {
    // The control plane answers a repeated request ID with its stored answer, as the broker does.
    const answers = new Map<string, DeveloperTaskView>();
    let mode: "view" | "continue" = "view";
    const shareTask = vi.fn(async (_taskId: string, request: { requestId: string; shareMode?: "view" | "continue" }) => {
      const stored = answers.get(request.requestId);
      if (stored !== undefined) return stored;
      mode = request.shareMode ?? mode;
      const answer = view({ shared: true, share: { mode, channelId: "C0123456789", sharedReason: "requested" } });
      answers.set(request.requestId, answer);
      return answer;
    });
    let next = 0;
    const mcp = await connect({ shareTask }, { newRequestId: () => `33333333-3333-4333-8333-${String(++next).padStart(12, "0")}` });
    const modes: unknown[] = [];
    for (const shareMode of ["view", "continue", "view"]) {
      modes.push((await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: shareMode } })).structuredContent?.share_mode);
    }
    const ids = shareTask.mock.calls.map(([, request]) => request.requestId);
    expect(new Set(ids).size).toBe(3);
    expect(modes).toEqual(["view", "continue", "view"]);
    expect(mode).toBe("view");
  });

  it("forgets the other mode whether or not the earlier call named the channel", async () => {
    const shareTask = vi.fn(async (_taskId: string, request: { requestId: string; shareMode?: "view" | "continue" }) =>
      view({ shared: true, share: { mode: request.shareMode ?? "view", channelId: "C0123456789", sharedReason: "requested" } }));
    let next = 0;
    const mcp = await connect({ shareTask }, { newRequestId: () => `33333333-3333-4333-8333-${String(++next).padStart(12, "0")}` });
    await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "view" } });
    await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "continue", channel: "#payments-dev" } });
    await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "view" } });
    // A retry of the last call, unchanged, is still the same request.
    await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "view" } });
    expect(shareTask.mock.calls.map(([, request]) => request.requestId)).toEqual([
      "33333333-3333-4333-8333-000000000001", "33333333-3333-4333-8333-000000000002", "33333333-3333-4333-8333-000000000003", "33333333-3333-4333-8333-000000000003",
    ]);
  });

  it("refuses an empty channel, as the contract does, and calls nothing", async () => {
    const shareTask = vi.fn();
    const startTask = vi.fn();
    const mcp = await connect({ shareTask, startTask });
    expect(await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, channel: "" } })).toMatchObject({ isError: true });
    expect(await mcp.callTool({ name: "agentx_start_task", arguments: { project: "payments", instructions: "Fix it", share_to_channel: true, channel: "" } })).toMatchObject({ isError: true });
    expect(shareTask).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
  });

  it("sends only what was given", async () => {
    const shareTask = vi.fn(async () => view({ shared: true, share: { mode: "view", channelId: "C0123456789", sharedReason: "requested" } }));
    const mcp = await connect({ shareTask });
    await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK } });
    expect(shareTask).toHaveBeenCalledWith(TASK, { requestId: "33333333-3333-4333-8333-333333333333" });
  });

  it("passes CHANNEL_AMBIGUOUS through with the channels named and a next step that fits (F9)", async () => {
    const { ToolError } = await import("../../packages/mcp/src/index.js");
    const mcp = await connect({ shareTask: vi.fn(async () => { throw new ToolError("CHANNEL_AMBIGUOUS", "project `payments` has several Slack channels: #payments-dev, #payments-ops"); }) });
    const error = toolError(await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK } }));
    expect(error).toMatchObject({ code: "CHANNEL_AMBIGUOUS", next_step: NEXT_STEPS.CHANNEL_AMBIGUOUS });
    expect(error.message).toContain("#payments-ops");
  });

  it("asks for an AgentX upgrade against a 1.1 control plane, which has no share route, and calls nothing (C20, Q7)", async () => {
    const shareTask = vi.fn();
    const configured = { configuration: vi.fn(async () => ({ env: "staging", apiVersion: "1.1", baseUrl: "https://agentx.example.test" })) };
    const mcp = await connect({ ...configured, shareTask }, { compatibility: compatibilityChecker(configured as unknown as ControlPlaneClient) });
    const error = toolError(await mcp.callTool({ name: "agentx_share_task", arguments: { task_id: TASK, share_mode: "view" } }));
    expect(error).toMatchObject({ code: "UPGRADE_REQUIRED", next_step: UPGRADE_AGENTX_STEP });
    expect(shareTask).not.toHaveBeenCalled();
  });
});
