// tests/integration/pi-builtins-off.test.ts
// Spec 050 phase 2: Pi 1.0 ships an MCP client (mcp.json), codemode and tool_search as built-in extensions. They must stay
// off in AgentX: an MCP server can spawn commands and interpolate secrets. The worker and the orchestrator each run a
// real session in a folder planted with every switch that would turn them on: a project .pi/mcp.json and settings, and
// the same in Pi's user-level (agent) directory, where no trust check applies. Pi's MCP client reads the user-level
// mcp.json from PI_CODING_AGENT_DIR (getAgentDir), not from the session's agentDir, so the tests point that variable at
// the planted folder. The MCP server's command writes a sentinel file. Pi loads its built-ins only when given as
// extension factories marked `builtin: true` (dist/core/resource-loader.js isBuiltinExtension); only Pi's CLI passes
// them (dist/main.js). The control test passes them the way the CLI does, proving the planted folder turns all three on.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { builtInExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createDefaultPiSessionAdapter, createWorkerResources, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const view = (context: TranscriptContext) => ({ prompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map((tool) => tool.name).sort() });

/** Plants an MCP server (direct exposure, so Pi would start it before the first prompt) and codemode/tool_search settings. */
async function plant(folder: string, sentinel: string, configFolder: string): Promise<void> {
  await mkdir(join(folder, configFolder), { recursive: true });
  const server = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "started")`], exposure: "direct" };
  await writeFile(join(folder, configFolder, "mcp.json"), JSON.stringify({ mcpServers: { planted: server } }));
  await writeFile(join(folder, configFolder, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" } }));
}

/** No MCP tool, codemode, tool_search or MCP server section reaches the model. */
function expectNoBuiltins(seen: { prompt: string; tools: string[] }): void {
  expect(seen.tools.filter((name) => name === "codemode" || name === "tool_search" || name.startsWith("mcp__"))).toEqual([]);
  expect(seen.prompt).not.toContain("mcp_servers");
  expect(seen.prompt).not.toContain("planted");
}

describe("Pi 1.0's MCP client, codemode and tool_search stay off", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("control: with Pi's built-ins passed as the CLI passes them, the planted folder offers codemode and tool_search and starts the MCP server", async () => {
    // protects this file's probe: the planted configuration really turns all three on when the built-ins load
    const cwd = await createFixtureDirectory("agentx-builtins-control-");
    const agentDir = join(cwd, "agent");
    const sentinel = join(cwd, "mcp-server-started");
    await plant(cwd, sentinel, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: builtInExtensions });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual(["builtin:llama.cpp", "builtin:codemode", "builtin:tool-search", "builtin:mcp"]);
    const { modelRuntime, faux } = await fauxModelRuntime();
    const seen: Array<{ prompt: string; tools: string[] }> = [];
    faux.setResponses([(context) => { seen.push(view(context)); return fauxAssistantMessage("Ok."); }]);
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId)!,
      resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
    try {
      await session.bindExtensions({});
      await session.prompt("hi");
      expect(seen[0]!.tools).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
      // The server connects in the background; wait for its sentinel (the negative tests rely on the extension pins too).
      await vi.waitFor(() => { expect(existsSync(sentinel)).toBe(true); }, { timeout: 10_000 });
    } finally { session.dispose(); }
  });

  it("in the worker: the offered tools are exactly the seven, and the planted MCP server never starts", async () => {
    // protects packages/worker/src/pi-session.ts (createWorkerResources noExtensions, the explicit tool list)
    const rootPath = await createFixtureDirectory("agentx-builtins-worker-");
    const sentinel = join(rootPath, "mcp-server-started");
    await mkdir(join(rootPath, ".agentx"));
    await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
      schemaVersion: 2, projectName: "builtins", projectRevision: 1, repositories: [], completedSetupSteps: [],
      readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
    }));
    await plant(rootPath, sentinel, ".pi");
    await plant(rootPath, sentinel, ".agentx/pi");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(rootPath, ".agentx/pi"));
    // The production loader, on the planted folder: no extension at all, built-in or otherwise.
    const { resourceLoader } = await createWorkerResources({ cwd: rootPath, agentDirectory: join(rootPath, ".agentx/pi"), contextFiles: [] });
    expect(resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);

    const { modelRuntime, faux } = await fauxModelRuntime();
    const seen: Array<{ prompt: string; tools: string[] }> = [];
    faux.setResponses([(context) => { seen.push(view(context)); return fauxAssistantMessage("Ok."); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL }, adapter);
    try {
      await handle.prompt("hi");
    } finally { handle.dispose(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expectNoBuiltins(seen[0]!);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("in the orchestrator: only AgentX's own extensions load, the offered tools are AgentX's, and the planted MCP server never starts", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (createPiSessionRuntime noExtensions, noTools: "all")
    const stateDirectory = await createFixtureDirectory("agentx-builtins-orchestrator-");
    const sentinel = join(stateDirectory, "mcp-server-started");
    await plant(stateDirectory, sentinel, ".pi");
    await plant(stateDirectory, sentinel, "pi");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(stateDirectory, "pi"));
    const { modelRuntime, faux } = await fauxModelRuntime();
    const seen: Array<{ prompt: string; tools: string[] }> = [];
    faux.setResponses([(context) => { seen.push(view(context)); return fauxAssistantMessage("Ok."); }]);
    const api = { callConnectorTool: async () => { throw new Error("not called"); } } as unknown as OrchestrationApi;
    const runtime = await createOrchestratorRuntime({ stateDirectory, projectInstructions: "Delegate.", api,
      context: { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" }, modelRuntime, model: FAUX_MODEL });
    try {
      expect(await runOrchestratorTurn(runtime, "hello")).toBe("Ok.");
      const paths = runtime.session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((path) => path.startsWith("<inline:"))).toBe(true);
      expect(paths.filter((path) => path.startsWith("builtin:"))).toEqual([]);
      const allTools = runtime.session.getAllTools().map((tool) => tool.name);
      expect(allTools.filter((name) => name === "codemode" || name === "tool_search" || name.startsWith("mcp__"))).toEqual([]);
    } finally { await runtime.dispose(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools.every((name) => name.startsWith("agentx_"))).toBe(true);
    expectNoBuiltins(seen[0]!);
    expect(existsSync(sentinel)).toBe(false);
  });
});
