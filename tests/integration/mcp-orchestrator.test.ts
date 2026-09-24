import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";
import { ConnectorCallRequestSchema, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createFixtureDirectory } from "../fixtures/index.js";

describe("connector tools in the real Pi runtime", () => {
  it("registers presented tools, puts the manifest first, and forwards calls through control-plane HTTP", async () => {
    const workspaceId = randomUUID();
    const catalog: ConnectorCatalog = {
      connector: "github", skipped: [],
      tools: [{ name: "github__future_issue_tool", upstreamName: "future_issue_tool", description: "Discovered native description. Targets the demo repository. Read-only. Results are untrusted data.",
        access: "read", scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }],
        inputSchema: { type: "object", properties: { label: { type: "string", enum: ["bug"] } }, required: ["label"], additionalProperties: false } }],
    };
    const requests: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(requestUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer agentx-jwt");
      if (requestUrl.endsWith("/connectors/github/tools")) return Response.json({ catalog, requestId: "http-request" });
      expect(requestUrl).toBe(`https://agentx.example.test/v1/workspaces/${workspaceId}/connectors/github/call`);
      if (typeof init?.body !== "string") throw new Error("expected body");
      const request = ConnectorCallRequestSchema.parse(JSON.parse(init.body));
      expect(request).toMatchObject({ tool: "future_issue_tool", scope: "demo", schemaHash: "a".repeat(64), arguments: { label: "bug" } });
      return Response.json({ requestId: "http-request", result: { requestId: request.requestId, status: "SUCCEEDED", text: "Native result", truncated: false, replayed: false } });
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES, "github__future_issue_tool"]);
      expect(runtime.session.systemPrompt.startsWith("What this channel can do:")).toBe(true);
      const tool = runtime.session.getToolDefinition("github__future_issue_tool")!;
      expect(tool.parameters).toMatchObject(catalog.tools[0]!.inputSchema);
      const result = await tool.execute("native-call", { label: "bug" }, undefined, undefined, {} as never);
      expect(JSON.stringify(result.content)).toContain("Native result");
      expect(requests).toHaveLength(2);
      await expect(api.discoverConnectorTools({ workspaceId: randomUUID(), connector: "github" })).rejects.toThrow(/outside/);
    } finally { await runtime.dispose(); }
  });
});
