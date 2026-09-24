import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";
import { ConnectorCallRequestSchema, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import type { SlackRequestMessage } from "../../packages/contracts/src/slack.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createFixtureDirectory } from "../fixtures/index.js";

describe("hosted Slack processor and MCP runtime", () => {
  it.each([true, false])("uses server-approved discovery and replies in the source thread (enabled=%s)", async (enabled) => {
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvMCP000001", receivedAt: new Date().toISOString(), userId: "U0123456789",
      thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" },
      text: "Create a test issue in demo.",
    };
    const workspaceId = randomUUID();
    const catalog: ConnectorCatalog = {
      connector: "github", skipped: [],
      tools: [{ name: "github__new_issue_tool", upstreamName: "new_issue_tool", description: "Discovered native write tool.", access: "write",
        scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }],
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }],
    };
    const invocationIds: string[] = [];
    const baseFetch = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256/);
      expect(headers.get("x-agentx-slack-user")).toBe(message.userId);
      expect(headers.get("x-agentx-slack-thread")).toBe("T0123456789/C0123456789/1695500000.000001");
      if (path.pathname.endsWith("/connectors/github/tools")) {
        expect(path.pathname).toBe(`/v1/service/workspaces/${workspaceId}/connectors/github/tools`);
        return Response.json({ catalog, requestId: "http-trace" });
      }
      expect(path.pathname).toBe(`/v1/service/workspaces/${workspaceId}/connectors/github/call`);
      if (typeof init?.body !== "string") throw new Error("expected body");
      const request = ConnectorCallRequestSchema.parse(JSON.parse(init.body));
      expect(request).toMatchObject({ tool: "new_issue_tool", scope: "demo", arguments: { title: "From Slack" } });
      const replayed = invocationIds.includes(request.requestId);
      invocationIds.push(request.requestId);
      return Response.json({ requestId: "http-trace", result: { requestId: request.requestId, status: "SUCCEEDED", text: "Issue created", replayed, truncated: false } });
    });
    const signedFetch = createSignedServiceFetch({
      region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      thread: message.thread, userId: message.userId, baseFetch,
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "slack-service", workspaceId, signedFetch);
    const post = vi.fn(async () => undefined);
    let turn = 0;
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: async () => ({
          outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false,
          orchestratorInstructions: "Delegate coding.",
          repositories: ["demo"], connectors: enabled ? [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }] : [],
        }),
        createConversation: async () => randomUUID(), waitForOperation: vi.fn(),
      }),
      threads: { load: async () => ({ workspaceId, conversationId: "11111111-1111-4111-8111-111111111111" }), saveConversation: vi.fn(), finish: vi.fn() },
      runTurn: async (input) => {
        const runtime = await createHostedSlackRuntime(input, {
          stateDirectory: await createFixtureDirectory("agentx-slack-mcp-"), api,
          model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
        });
        try {
          expect(runtime.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES, ...(enabled ? ["github__new_issue_tool"] : [])]);
          if (!enabled) return "Integration is not enabled.";
          const tool = runtime.session.getToolDefinition("github__new_issue_tool")!;
          expect(tool.parameters).toMatchObject(catalog.tools[0]!.inputSchema);
          // Reconstructed model turns may emit a different call ID for the same redelivered event.
          const callId = `model-call-${turn++}`;
          await tool.execute(callId, { title: "From Slack" }, undefined, undefined, {} as never);
          await tool.execute(callId, { title: "From Slack" }, undefined, undefined, {} as never);
          return "Issue created.";
        } finally { await runtime.dispose(); }
      },
      post,
    };
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    if (enabled) {
      expect(invocationIds).toHaveLength(4);
      expect(new Set(invocationIds).size).toBe(1);
      await processSlackRequest({ ...message, eventId: "EvMCP000002" }, dependencies, { finalAttempt: false });
      expect(new Set(invocationIds).size).toBe(2);
    } else expect(baseFetch).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith(message.thread, enabled ? "Issue created." : "Integration is not enabled.");
  });
});
