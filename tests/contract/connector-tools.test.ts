import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createConnectorTools } from "../../packages/orchestrator/src/connector-tools.js";
import { capabilitiesManifest } from "../../packages/orchestrator/src/manifest.js";
import { ORCHESTRATION_TOOL_NAMES, assertOrchestrationOnly } from "../../packages/orchestrator/src/orchestration-tools.js";

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const catalog = (scopes: string[]): ConnectorCatalog => ({
  connector: "github",
  skipped: [],
  tools: [{
    name: "github__list_issues", upstreamName: "list_issues", description: "List issues.", access: "read",
    inputSchema: { type: "object", properties: { state: { type: "string" }, ...(scopes.length > 1 ? { target: { type: "string", enum: scopes } } : {}) }, required: scopes.length > 1 ? ["target"] : [] },
    scopes: scopes.map((alias, index) => ({ alias, schemaHash: hash(String(index)) })),
  }],
});
const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };

describe("connector tool bridge", () => {
  it("calls the single scope without asking the model for a target", async () => {
    const invoke = vi.fn(async () => ({ status: "SUCCEEDED" }));
    const [tool] = createConnectorTools([catalog(["demo"])], invoke, context);
    await tool!.execute("call-1", { state: "OPEN" }, undefined, undefined, {} as never);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      connector: "github", scope: "demo", tool: "list_issues", schemaHash: hash("0"), arguments: { state: "OPEN" },
    }));
  });

  it("routes a target to its scope's hash, strips it from the arguments, and refuses an unknown target", async () => {
    const invoke = vi.fn(async () => ({ status: "SUCCEEDED" }));
    const [tool] = createConnectorTools([catalog(["api", "web"])], invoke, context);
    await tool!.execute("call-1", { state: "OPEN", target: "web" }, undefined, undefined, {} as never);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ scope: "web", schemaHash: hash("1"), arguments: { state: "OPEN" } }));
    const refused = await tool!.execute("call-2", { state: "OPEN", target: "mobile" }, undefined, undefined, {} as never);
    expect(JSON.stringify(refused.content)).toContain("target must be one of api, web");
    const missing = await tool!.execute("call-3", { state: "OPEN" }, undefined, undefined, {} as never);
    expect(JSON.stringify(missing.content)).toContain("target must be one of api, web");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("keeps a call's request ID stable on replay and distinct between targets", async () => {
    const invoke = vi.fn(async () => ({ status: "SUCCEEDED" }));
    const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
    const [tool] = createConnectorTools([catalog(["api", "web"])], invoke, context, { requestId: () => ids.shift()! });
    await tool!.execute("call-1", { target: "api" }, undefined, undefined, {} as never);
    await tool!.execute("call-1", { target: "api" }, undefined, undefined, {} as never);
    await tool!.execute("call-1", { target: "web" }, undefined, undefined, {} as never);
    const requestIds = invoke.mock.calls.map(([input]) => (input as { requestId: string }).requestId);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[2]).not.toBe(requestIds[0]);
  });
});

describe("assertOrchestrationOnly with connector tools", () => {
  it("accepts in-house plus connector tool names when catalogs are supplied, and rejects them (and bash) without", async () => {
    const invoke = vi.fn(async () => ({ status: "SUCCEEDED" }));
    const catalogs = [catalog(["demo"])];
    const connectorTools = createConnectorTools(catalogs, invoke, context);
    const tools = [...ORCHESTRATION_TOOL_NAMES.map((name) => ({ name })), ...connectorTools];
    expect(() => assertOrchestrationOnly(tools, catalogs)).not.toThrow();
    expect(() => assertOrchestrationOnly(tools)).toThrow(/forbidden/);
    expect(() => assertOrchestrationOnly([...tools, { name: "bash" }], catalogs)).toThrow(/forbidden/);
  });
});

describe("capabilities manifest", () => {
  it("names what the channel can do and says plainly what is not connected", () => {
    const manifest = capabilitiesManifest({
      repositories: ["demo", "docs"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo", "docs"], connected: true }],
      catalogs: [catalog(["demo", "docs"])],
    });
    expect(manifest).toBe([
      "What this channel can do:",
      "- Repository code and files (demo, docs): agentx_submit_task, agentx_follow_up",
      "- Pull requests (demo, docs): agentx_create_pull_request and the pull-request tools",
      "- GitHub issues (demo, docs): github__* tools",
      "Not connected for this channel: Linear, Jira, Asana. If asked about something that is not connected, say it is not connected for this channel and do not attempt a workaround.",
      "Closing this thread's workspace is a command, not a tool: the user writes \"close this workspace\".",
    ].join("\n"));
  });

  it("lists a configured connector without a working credential, or without tools, as not connected", () => {
    const manifest = capabilitiesManifest({
      repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: false }],
      catalogs: [],
    });
    expect(manifest).toContain("Not connected for this channel: GitHub issues, Linear, Jira, Asana.");
    expect(manifest).not.toContain("github__*");
  });
});
