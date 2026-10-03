// tests/contract/action-gate-characterization.test.ts
// Pins what the action gate wires into (spec 014 phase 14c part 2), on the code before the gate
// exists (mainline plus 14a, 14b and 14c part 1): the tools a turn offers, how a connector call
// reaches the control plane, and what agentx_create_pull_request answers in a thread with no compute.
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog, SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { NO_WORKSPACE_TO_PUBLISH, type OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
const model = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const catalog: ConnectorCatalog = {
  connector: "tracker", skipped: [],
  tools: [
    { name: "tracker__list_items", upstreamName: "list_items", description: "List items.", access: "read",
      scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: { status: { type: "string" } }, required: [] } },
    { name: "tracker__close_item", upstreamName: "close_item", description: "Close an item.", access: "write",
      scopes: [{ alias: "payments", schemaHash: "b".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ],
};
const connectors = [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }];

function api(callConnectorTool = vi.fn(async () => ({ status: "SUCCEEDED" }))) {
  return {
    discoverConnectorTools: vi.fn(async () => catalog), callConnectorTool,
    submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
    createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
  } satisfies OrchestrationApi;
}

describe("orchestrator wiring before the action gate (characterization)", () => {
  it("offers the in-house tools, then each connector tool, in order", async () => {
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-gate-char-"), projectInstructions: "Delegate.",
      api: api(), context, model, connectors,
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([
        "agentx_submit_task", "agentx_create_pull_request", "agentx_follow_up", "agentx_manage_pull_request",
        "tracker__list_items", "tracker__close_item",
      ]);
    } finally { await runtime.dispose(); }
  });

  it("sends a connector tool's call to the control plane unchanged when its definition runs", async () => {
    const callConnectorTool = vi.fn(async () => ({ status: "SUCCEEDED" }));
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-gate-char-"), projectInstructions: "Delegate.",
      api: api(callConnectorTool), context, model, connectors, requestId: () => "33333333-3333-4333-8333-333333333333",
    });
    try {
      await runtime.session.getToolDefinition("tracker__close_item")!.execute("call-1", { id: "TRK-9" }, undefined, undefined, {} as never);
      expect(callConnectorTool).toHaveBeenCalledExactlyOnceWith({
        workspaceId: context.workspaceId, connector: "tracker", requestId: "33333333-3333-4333-8333-333333333333",
        scope: "payments", tool: "close_item", schemaHash: "b".repeat(64), arguments: { id: "TRK-9" },
      });
    } finally { await runtime.dispose(); }
  });

  it("builds the hosted Slack runtime from the turn input with the same tools", async () => {
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvCHAR000001", receivedAt: "2026-09-25T10:00:00.000Z", userId: "U0123456789",
      thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "close TRK-9",
    };
    const runtime = await createHostedSlackRuntime({
      message, subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", ...context,
      orchestratorInstructions: "Delegate.", connectors, requestId: () => "33333333-3333-4333-8333-333333333333",
    }, { stateDirectory: await createFixtureDirectory("agentx-gate-char-"), api: api(), model });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([
        "agentx_submit_task", "agentx_create_pull_request", "agentx_follow_up", "agentx_manage_pull_request",
        "tracker__list_items", "tracker__close_item",
      ]);
    } finally { await runtime.dispose(); }
  });

  it("answers NO_WORKSPACE, without calling the control plane, for a pull request in a thread with no compute", async () => {
    const calls = api();
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-gate-char-"), projectInstructions: "Delegate.",
      api: calls, context, model, connectors, worker: { prepared: () => false, ensureReady: async () => undefined },
    });
    try {
      const result = await runtime.session.getToolDefinition("agentx_create_pull_request")!.execute("call-1", { repository: "demo", title: "Fix" }, undefined, undefined, {} as never);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(NO_WORKSPACE_TO_PUBLISH) }]);
      expect(calls.createPullRequest).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });
});
