import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneApi } from "../../packages/cli/src/control-plane-api.js";
import { createOrchestratorRuntime } from "../../packages/cli/src/orchestrator.js";
import { mcpToolName } from "../../packages/cli/src/mcp-tools.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/cli/src/orchestration-tools.js";
import { GitHubMcpRequestSchema, type GitHubMcpTool } from "../../packages/contracts/src/github-mcp.js";
import { createFixtureDirectory } from "../fixtures/index.js";

describe("discovered tools in the real Pi runtime", () => {
  it("registers the discovered schema and forwards execution through authenticated control-plane HTTP", async () => {
    const workspaceId = randomUUID();
    const descriptor: GitHubMcpTool = {
      name: "future_issue_tool", repository: "demo", description: "Discovered native description", schemaHash: "a".repeat(64), access: "read",
      inputSchema: { type: "object", properties: { label: { type: "string", enum: ["bug"] } }, required: ["label"], additionalProperties: false },
    };
    const requests: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push(requestUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer agentx-jwt");
      if (requestUrl.endsWith("/github/tools?repository=demo")) return Response.json({ catalog: { tools: [descriptor] }, requestId: "http-request" });
      expect(requestUrl).toBe(`https://agentx.example.test/v1/workspaces/${workspaceId}/github/call`);
      expect(init?.method).toBe("POST");
      if (typeof init?.body !== "string") throw new Error("expected body");
      const request = GitHubMcpRequestSchema.parse(JSON.parse(init.body));
      expect(request).toMatchObject({ tool: "future_issue_tool", repository: "demo", schemaHash: descriptor.schemaHash, arguments: { label: "bug" } });
      return Response.json({ requestId: "http-request", result: { requestId: request.requestId, status: "SUCCEEDED", text: "Native result", truncated: false, replayed: false } });
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" }, githubMcpRepositories: ["demo"],
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES, mcpToolName(descriptor)]);
      const tool = runtime.session.getToolDefinition(mcpToolName(descriptor))!;
      expect(tool.parameters).toMatchObject(descriptor.inputSchema);
      expect(tool.description).toContain(descriptor.description);
      const result = await tool.execute("native-call", { label: "bug" }, undefined, undefined, {} as never);
      expect(result.content[0]?.type).toBe("text");
      expect(JSON.stringify(result.content)).toContain("Native result");
      expect(requests).toHaveLength(2);
      await expect(api.discoverGitHubTools({ workspaceId: randomUUID(), repository: "demo" })).rejects.toThrow(/outside/);
      expect(requests).toHaveLength(2);
    } finally { await runtime.dispose(); }
  });
});
