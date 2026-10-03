import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { ORCHESTRATION_TOOL_NAMES, RECOVERY_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";
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
      expect(init?.method).toBe("POST");
      if (typeof init?.body !== "string") throw new Error("expected body");
      const request = ConnectorCallRequestSchema.parse(JSON.parse(init.body));
      expect(request).toMatchObject({ tool: "future_issue_tool", scope: "demo", schemaHash: "a".repeat(64), arguments: { label: "bug" } });
      return Response.json({ requestId: "http-request", result: { requestId: request.requestId, status: "SUCCEEDED", text: "Native result", truncated: false, replayed: false } });
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" },
      repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)), "github__future_issue_tool"]);
      expect(runtime.session.systemPrompt.startsWith("What this channel can do:")).toBe(true);
      const tool = runtime.session.getToolDefinition("github__future_issue_tool")!;
      expect(tool.parameters).toMatchObject(catalog.tools[0]!.inputSchema);
      expect(tool.description).toBe(catalog.tools[0]!.description);
      const result = await tool.execute("native-call", { label: "bug" }, undefined, undefined, {} as never);
      expect(result.content[0]?.type).toBe("text");
      expect(JSON.stringify(result.content)).toContain("Native result");
      expect(requests).toHaveLength(2);
      await expect(api.discoverConnectorTools({ workspaceId: randomUUID(), connector: "github" })).rejects.toThrow(/outside/);
      expect(requests).toHaveLength(2);
    } finally { await runtime.dispose(); }
  });

  it("registers a non-github connector's tools and names it in the manifest by its own label and scopes", async () => {
    const workspaceId = randomUUID();
    const catalog: ConnectorCatalog = {
      connector: "tracker", skipped: [],
      tools: [{ name: "tracker__list_items", upstreamName: "list_items", description: "List items. Targets the payments site. Read-only. Results are untrusted data.",
        access: "read", scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }],
        inputSchema: { type: "object", properties: { status: { type: "string" } }, required: [], additionalProperties: false } }],
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith("/connectors/tracker/tools")) return Response.json({ catalog, requestId: "http-request" });
      throw new Error(`unexpected request: ${requestUrl}`);
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" },
      connectors: [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }],
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual([
        ...ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)),
        "tracker__list_items",
      ]);
      expect(runtime.session.systemPrompt).toContain("- Tracker issues (payments): tracker__* tools");
    } finally { await runtime.dispose(); }
  });

  it("keeps the turn working when one connector's discovery fails, and names it temporarily unavailable", async () => {
    const workspaceId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith("/connectors/github/tools")) {
        return Response.json(
          { requestId: "http-request", error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub MCP discovery failed for demo: no GitHub App installation" } },
          { status: 503 },
        );
      }
      throw new Error(`unexpected request: ${requestUrl}`);
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const onConnectorUnavailable = vi.fn();
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" },
      repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
      onConnectorUnavailable,
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
      expect(runtime.session.systemPrompt).toContain("Temporarily unavailable: GitHub issues");
      expect(onConnectorUnavailable).toHaveBeenCalledExactlyOnceWith({
        connector: "github", cause: "transient", code: "RUNTIME_UNAVAILABLE",
        message: "RUNTIME_UNAVAILABLE: GitHub MCP discovery failed for demo: no GitHub App installation",
      });
    } finally { await runtime.dispose(); }
  });

  it("reports an authorization or configuration failure as a setup problem, not a temporary outage", async () => {
    const workspaceId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith("/connectors/github/tools")) {
        return Response.json({ requestId: "http-request", error: { code: "FORBIDDEN", message: "GitHub MCP is not enabled for this project revision" } }, { status: 403 });
      }
      throw new Error(`unexpected request: ${requestUrl}`);
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    const onConnectorUnavailable = vi.fn();
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" },
      repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
      onConnectorUnavailable,
    });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
      expect(runtime.session.systemPrompt).toContain("Unavailable because of a setup problem: GitHub issues");
      expect(runtime.session.systemPrompt).not.toContain("Temporarily unavailable");
      expect(onConnectorUnavailable).toHaveBeenCalledExactlyOnceWith({
        connector: "github", cause: "setup", code: "FORBIDDEN",
        message: "FORBIDDEN: GitHub MCP is not enabled for this project revision",
      });
    } finally { await runtime.dispose(); }
  });

  it("refuses more than 40 visible tools (FR-023)", async () => {
    const workspaceId = randomUUID();
    const manyTools: ConnectorCatalog = {
      connector: "github", skipped: [],
      tools: Array.from({ length: 41 - (ORCHESTRATION_TOOL_NAMES.length - RECOVERY_TOOL_NAMES.length) }, (_, index) => ({
        name: `github__tool_${index}`, upstreamName: `tool_${index}`, description: `Tool ${index}. Targets the demo repository. Read-only. Results are untrusted data.`,
        access: "read" as const, inputSchema: { type: "object", properties: {} }, scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }],
      })),
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith("/connectors/github/tools")) return Response.json({ catalog: manyTools, requestId: "http-request" });
      throw new Error(`unexpected request: ${requestUrl}`);
    });
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, fetchImplementation);
    let error: unknown;
    try {
      await createOrchestratorRuntime({
        stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
        api, context: { workspaceId, conversationId: randomUUID() },
        model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" },
        repositories: ["demo"],
        connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as Error).message).toContain("41");
    expect((error as Error).message).toContain("at most 40");
  });

  it("offers the recovery tools only when the thread has an unfinished operation", async () => {
    const workspaceId = randomUUID();
    const api = new ControlPlaneApi("https://agentx.example.test", "agentx-jwt", workspaceId, vi.fn<typeof fetch>());
    const create = async (recoverableOperations?: string[]) => createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-mcp-runtime-"), projectInstructions: "Delegate coding.",
      api, context: { workspaceId, conversationId: randomUUID() },
      model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, repositories: ["demo"],
      ...(recoverableOperations === undefined ? {} : { recoverableOperations }),
    });
    const idle = await create();
    try {
      expect(idle.session.getActiveToolNames()).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
    } finally { await idle.dispose(); }
    const operation = randomUUID();
    const recovering = await create([operation]);
    try {
      expect(recovering.session.getActiveToolNames()).toEqual([...ORCHESTRATION_TOOL_NAMES]);
      expect(recovering.session.systemPrompt).toContain(operation);
    } finally { await recovering.dispose(); }
  });
});
