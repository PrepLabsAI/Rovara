// Pins connector discovery and the Slack turn wiring as they were before discovery refresh, so the
// refresh wiring cannot change a turn that has nothing to refresh.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog, SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalog: ConnectorCatalog = { connector: "github", tools: [], skipped: [] };
const message: SlackRequestMessage = {
  version: 1, eventId: "EvCHAR0001", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
  thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "list issues",
};

function slackDependencies(extra: Partial<ProcessorDependencies> = {}) {
  const turns: TurnInput[] = [];
  const calls: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => ({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate." }),
      startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
    }),
    threads: {
      load: async () => { calls.push("load"); return { workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }; },
      saveConversation: async () => { calls.push("saveConversation"); },
      saveSettingsRevision: async () => { calls.push("saveSettingsRevision"); },
      close: async () => { calls.push("close"); },
      finish: async () => { calls.push("finish"); },
    },
    runTurn: async (input) => {
      turns.push(input);
      input.recorder?.offer({ manifest: "m", tools: [], connectorOf: new Map([["github__list_issues", "github"]]), model: { provider: "p", modelId: "m" } });
      input.recorder?.toolStarted({ toolCallId: "1", toolName: "github__list_issues", args: {} });
      input.recorder?.toolEnded({ toolCallId: "1", toolName: "github__list_issues", isError: false,
        result: { content: [{ type: "text", text: "{\"status\":\"FAILED\",\"reason\":\"schema_changed\"}" }] } });
      return "ok";
    },
    post: async () => undefined,
    ...extra,
  };
  return { dependencies, turns, calls };
}

describe("connector discovery and Slack turn wiring before refresh (characterization)", () => {
  it("discovers with a plain GET and no query string", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ catalog, requestId: "r" }));
    const api = new ControlPlaneApi("https://agentx.example.test", "t", workspaceId, fetchImplementation);
    await api.discoverConnectorTools({ workspaceId, connector: "github" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(String(url)).toBe(`https://agentx.example.test/v1/workspaces/${workspaceId}/connectors/github/tools`);
    expect(init?.method).toBe("GET");
  });

  it("asks the discovery API with exactly the workspace and connector name", async () => {
    const discover = vi.fn<NonNullable<OrchestrationApi["discoverConnectorTools"]>>(async ({ connector }) => ({ ...catalog, connector }));
    const api = { discoverConnectorTools: discover, submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
      createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } as OrchestrationApi;
    const { modelRuntime } = await fauxModelRuntime();
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-refresh-char-"), projectInstructions: "Delegate.", api,
      context: { workspaceId, conversationId: randomUUID() }, model: FAUX_MODEL, modelRuntime, repositories: ["demo"],
      connectors: [
        { name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true },
        { name: "linear", type: "linear", label: "Linear", scopes: ["team"], connected: true },
      ],
    });
    await runtime.dispose();
    expect(discover.mock.calls.map(([input]) => input)).toStrictEqual([
      { workspaceId, connector: "github" },
      { workspaceId, connector: "linear" },
    ]);
    expect(discover.mock.calls.map(([input]) => Object.keys(input))).toStrictEqual([["workspaceId", "connector"], ["workspaceId", "connector"]]);
  });

  it("runs a turn without a recorder and with the same thread calls when no sink is configured", async () => {
    const { dependencies, turns, calls } = slackDependencies();
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(Object.keys(turns[0]!).sort()).toStrictEqual(["conversationId", "message", "orchestratorInstructions", "requestId", "subject", "workspaceId"]);
    expect(calls).toStrictEqual(["load", "finish"]);
  });

  it("passes only the recorder when a sink is configured, and touches the thread store the same way", async () => {
    const { dependencies, turns, calls } = slackDependencies({ turnRecords: { write: async () => "written" } });
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(Object.keys(turns[0]!).sort()).toStrictEqual(["conversationId", "message", "orchestratorInstructions", "recorder", "requestId", "subject", "workspaceId"]);
    expect(calls).toStrictEqual(["load", "finish"]);
  });
});
