import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentXError, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { TurnObservationSchema } from "../../packages/contracts/src/turns.js";
import { createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const operation = "0f0e0d0c-0b0a-4908-8706-050403020100";
const catalog: ConnectorCatalog = {
  connector: "github", skipped: [],
  tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List issues. Targets the demo repository. Read-only.", access: "read",
    scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }],
    inputSchema: { type: "object", properties: { state: { type: "string", enum: ["OPEN", "CLOSED"] } }, required: [], additionalProperties: false } }],
};

function api(overrides: Partial<OrchestrationApi> = {}): OrchestrationApi {
  return {
    discoverConnectorTools: async () => catalog,
    callConnectorTool: async (input) => ({ requestId: input.requestId, status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }),
    submitTask: async () => ({ operation: { id: operation } }),
    taskResult: async () => ({ operationId: operation, status: "SUCCEEDED", response: "README.md" }),
    taskStatus: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
    ...overrides,
  };
}

async function runtimeFor(orchestration: OrchestrationApi, recorder: TurnRecorder) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  const runtime = await createOrchestratorRuntime({
    stateDirectory: await createFixtureDirectory("agentx-turn-recording-"), projectInstructions: "Delegate coding.",
    api: orchestration, context: { workspaceId: randomUUID(), conversationId: randomUUID() },
    model: FAUX_MODEL, modelRuntime, turnRecorder: recorder,
    repositories: ["demo"], connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
  });
  return { runtime, faux };
}

describe("turn recording in the real Pi runtime", () => {
  it("records offered tools, every call with its validation and outcome, usage, and an empty final answer", async () => {
    const recorder = new TurnRecorder();
    const { runtime, faux } = await runtimeFor(api(), recorder);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("github__list_issues", { state: "OPEN" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("agentx_update_pull_request", { repository: "demo", pullRequestNumber: 3 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("agentx_submit_task", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("agentx_submit_task", { prompt: "list files" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(""),
    ]);
    try {
      await runOrchestratorTurn(runtime, "what's in demo?", recorder);
    } finally { await runtime.dispose(); }
    const observation = TurnObservationSchema.parse(recorder.observation());
    expect(observation.offeredTools.map((tool) => tool.name)).toEqual([
      "agentx_submit_task", "agentx_create_pull_request", "agentx_follow_up", "agentx_manage_pull_request", "github__list_issues",
    ]);
    expect(observation.calls.map(({ name, connector, validation, outcome }) => ({ name, connector, validation, outcome }))).toEqual([
      { name: "github__list_issues", connector: "github", validation: "ok", outcome: "SUCCEEDED" },
      { name: "agentx_update_pull_request", connector: undefined, validation: "unknown_tool", outcome: "FAILED" },
      { name: "agentx_submit_task", connector: undefined, validation: "schema_error", outcome: "FAILED" },
      { name: "agentx_submit_task", connector: undefined, validation: "ok", outcome: "SUCCEEDED" },
    ]);
    expect(observation.workerOperations).toEqual([operation]);
    expect(observation).toMatchObject({ stopReason: "stop", emptyResponse: true, model: { provider: "agentx-faux", modelId: "scripted" } });
    expect(observation.usage?.outcome).toBe("SUCCEEDED");
    expect(observation.usage?.tokens.total).toBeGreaterThan(0);
  });

  it("reads a refused connector call as a policy denial", async () => {
    const recorder = new TurnRecorder();
    const refusing = api({ callConnectorTool: async () => { throw agentXError("FORBIDDEN", "GitHub MCP tool is not approved for this project"); } });
    const { runtime, faux } = await runtimeFor(refusing, recorder);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("github__list_issues", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("GitHub refused that."),
    ]);
    try {
      expect(await runOrchestratorTurn(runtime, "list issues", recorder)).toBe("GitHub refused that.");
    } finally { await runtime.dispose(); }
    expect(recorder.observation().calls[0]).toMatchObject({ validation: "policy_denied", outcome: "FAILED", reason: "FORBIDDEN" });
    expect(recorder.observation().emptyResponse).toBe(false);
  });

  it("measures usage as FAILED when the model errors", async () => {
    const recorder = new TurnRecorder();
    const { runtime, faux } = await runtimeFor(api(), recorder);
    // Worded to avoid Pi's automatic retry patterns (rate limits, overload, 5xx), so the error ends the turn.
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "the request was malformed" })]);
    try {
      await expect(runOrchestratorTurn(runtime, "hello", recorder)).rejects.toThrow("the request was malformed");
    } finally { await runtime.dispose(); }
    expect(recorder.observation()).toMatchObject({ stopReason: "error", emptyResponse: false, usage: { outcome: "FAILED" } });
  });
});

describe("turn recording is best effort", () => {
  it("keeps the turn when the recorder cannot take the offer, and says so in usageError", async () => {
    const recorder = new TurnRecorder();
    vi.spyOn(recorder, "offer").mockImplementation(() => { throw new Error("offer broke"); });
    const { runtime, faux } = await runtimeFor(api(), recorder);
    faux.setResponses([fauxAssistantMessage("Hello.")]);
    try {
      expect(await runOrchestratorTurn(runtime, "hi", recorder)).toBe("Hello.");
    } finally { await runtime.dispose(); }
    expect(recorder.observation().usageError).toBe("model was not offered");
  });

  it("keeps the turn's answer when session stats cannot be read, and says so in usageError", async () => {
    const recorder = new TurnRecorder();
    const { runtime, faux } = await runtimeFor(api(), recorder);
    faux.setResponses([fauxAssistantMessage("Hello.")]);
    vi.spyOn(runtime.session, "getSessionStats").mockImplementation(() => { throw new Error("stats broke"); });
    try {
      expect(await runOrchestratorTurn(runtime, "hi", recorder)).toBe("Hello.");
    } finally { await runtime.dispose(); }
    expect(recorder.observation()).toMatchObject({ usageError: "session stats unavailable: stats broke" });
    expect(recorder.observation().usage).toBeUndefined();
  });

  it("keeps the turn's own error when measuring also fails", async () => {
    const recorder = new TurnRecorder();
    const { runtime, faux } = await runtimeFor(api(), recorder);
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "the request was malformed" })]);
    vi.spyOn(recorder, "measure").mockImplementation(() => { throw new Error("measure broke"); });
    try {
      await expect(runOrchestratorTurn(runtime, "hello", recorder)).rejects.toThrow("the request was malformed");
    } finally { await runtime.dispose(); }
    expect(recorder.observation().usageError).toBe("usage measurement failed: measure broke");
  });

  it("keeps a connector call's error when the error observer throws", async () => {
    const recorder = new TurnRecorder();
    vi.spyOn(recorder, "connectorFailed").mockImplementation(() => { throw new Error("observer broke"); });
    const refusing = api({ callConnectorTool: async () => { throw agentXError("FORBIDDEN", "GitHub MCP tool is not approved for this project"); } });
    const { runtime, faux } = await runtimeFor(refusing, recorder);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("github__list_issues", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("GitHub refused that."),
    ]);
    try {
      expect(await runOrchestratorTurn(runtime, "list issues", recorder)).toBe("GitHub refused that.");
    } finally { await runtime.dispose(); }
    const toolResult = runtime.session.messages.find((message) => (message as { role?: string }).role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain("GitHub MCP tool is not approved for this project");
    expect(recorder.observation().calls[0]).toMatchObject({ validation: "ok", outcome: "FAILED" });
  });
});
