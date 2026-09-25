// Pins the orchestrator behaviour that turn recording wires into, so the wiring cannot change a turn
// that runs without a recorder.
import { randomUUID } from "node:crypto";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { agentXError, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createConnectorTools } from "../../packages/orchestrator/src/connector-tools.js";
import { createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createOrchestrationTools, type OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
const catalog: ConnectorCatalog = {
  connector: "github", skipped: [],
  tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List issues.", access: "read",
    scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }],
    inputSchema: { type: "object", properties: { state: { type: "string" } }, required: [] } }],
};

/** A session stub with only what runOrchestratorTurn used before recording existed. */
function stubRuntime(messages: unknown[], prompt = vi.fn(async () => undefined)) {
  const waitForIdle = vi.fn(async () => undefined);
  return { runtime: { session: { prompt, waitForIdle, messages } } as unknown as AgentSessionRuntime, prompt, waitForIdle };
}

describe("orchestrator behaviour without a turn recorder (characterization)", () => {
  it("rethrows a connector call's error unchanged from the bridge", async () => {
    const failure = agentXError("FORBIDDEN", "GitHub MCP tool is not approved for this project");
    const [tool] = createConnectorTools([catalog], async () => { throw failure; }, context);
    await expect(tool!.execute("call-1", { state: "OPEN" }, undefined, undefined, {} as never)).rejects.toBe(failure);
  });

  it("rethrows a non-AgentX connector error unchanged from the orchestration tools", async () => {
    const failure = new TypeError("fetch failed");
    const api = { callConnectorTool: async () => { throw failure; } } as unknown as OrchestrationApi;
    const tool = createOrchestrationTools(api, context, { connectorCatalogs: [catalog] }).find((entry) => entry.name === "github__list_issues");
    await expect(tool!.execute("call-1", {}, undefined, undefined, {} as never)).rejects.toBe(failure);
  });

  it("prompts without template expansion, waits for idle, and returns the last assistant text, touching nothing else", async () => {
    const { runtime, prompt, waitForIdle } = stubRuntime([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<thinking>x</thinking> Hello." }] },
    ]);
    expect(await runOrchestratorTurn(runtime, "hi")).toBe("Hello.");
    expect(prompt).toHaveBeenCalledWith("hi", { expandPromptTemplates: false });
    expect(waitForIdle).toHaveBeenCalledOnce();
  });

  it("throws the model's error as RUNTIME_UNAVAILABLE and propagates a prompt failure unchanged", async () => {
    const errored = stubRuntime([{ role: "assistant", stopReason: "error", errorMessage: "the request was malformed", content: [] }]);
    await expect(runOrchestratorTurn(errored.runtime, "hi")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: the request was malformed" });
    const failure = new Error("prompt broke");
    const broken = stubRuntime([], vi.fn(async () => { throw failure; }));
    await expect(runOrchestratorTurn(broken.runtime, "hi")).rejects.toBe(failure);
    expect(broken.waitForIdle).not.toHaveBeenCalled();
  });

  it("refuses an unknown model with RUNTIME_UNAVAILABLE before any connector discovery", async () => {
    const discoverConnectorTools = vi.fn(async () => catalog);
    const creating = createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-characterization-"), projectInstructions: "Delegate coding.",
      api: { discoverConnectorTools } as unknown as OrchestrationApi, context: { workspaceId: randomUUID(), conversationId: randomUUID() },
      model: { provider: "agentx-missing", modelId: "none" },
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
    });
    await expect(creating).rejects.toMatchObject({ name: "AgentXError", code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: configured orchestrator model is unavailable" });
    expect(discoverConnectorTools).not.toHaveBeenCalled();
  });
});
