import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog, SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { processSlackRequest, type ProcessorDependencies, type ThreadState, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalog: ConnectorCatalog = { connector: "github", tools: [], skipped: [] };

function requestUrl(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

describe("discovery refresh after a changed tool definition", () => {
  it("adds refresh=1 to the discovery URL only when asked", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ catalog, requestId: "r" }));
    const api = new ControlPlaneApi("https://agentx.example.test", "t", workspaceId, fetchImplementation);
    await api.discoverConnectorTools({ workspaceId, connector: "github" });
    await api.discoverConnectorTools({ workspaceId, connector: "github", refresh: true });
    expect(fetchImplementation.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      `https://agentx.example.test/v1/workspaces/${workspaceId}/connectors/github/tools`,
      `https://agentx.example.test/v1/workspaces/${workspaceId}/connectors/github/tools?refresh=1`,
    ]);
  });

  it("asks for a refresh only for the connectors the thread remembers", async () => {
    const discover = vi.fn<NonNullable<OrchestrationApi["discoverConnectorTools"]>>(async ({ connector }) => ({ ...catalog, connector }));
    const api = { discoverConnectorTools: discover, submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
      createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } as OrchestrationApi;
    const { modelRuntime } = await fauxModelRuntime();
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-refresh-"), projectInstructions: "Delegate.", api,
      context: { workspaceId, conversationId: randomUUID() }, model: FAUX_MODEL, modelRuntime, repositories: ["demo"],
      connectors: [
        { name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true },
        { name: "other", type: "github", label: "Other", scopes: ["demo"], connected: true },
      ],
      refreshConnectors: ["github"],
    });
    await runtime.dispose();
    expect(discover.mock.calls.map(([input]) => input)).toEqual([
      { workspaceId, connector: "github", refresh: true },
      { workspaceId, connector: "other" },
    ]);
  });

  it("remembers a schema_changed connector after a turn and clears it after the next one", async () => {
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvREFRESH01", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
      thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "list issues",
    };
    let state: ThreadState = { workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" };
    const saved: string[][] = [];
    const turns: TurnInput[] = [];
    let drift = true;
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: async () => ({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate." }),
        startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
      }),
      threads: {
        load: async () => state, saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
        saveRefreshConnectors: async (_subject, connectors) => { saved.push(connectors); state = { ...state, refreshConnectors: connectors }; },
      },
      runTurn: async (input) => {
        turns.push(input);
        input.recorder?.offer({ manifest: "m", tools: [], connectorOf: new Map([["github__list_issues", "github"]]), model: { provider: "p", modelId: "m" } });
        input.recorder?.toolStarted({ toolCallId: "1", toolName: "github__list_issues", args: {} });
        input.recorder?.toolEnded({ toolCallId: "1", toolName: "github__list_issues", isError: false,
          result: { content: [{ type: "text", text: JSON.stringify(drift ? { status: "FAILED", reason: "schema_changed" } : { status: "SUCCEEDED" }) }] } });
        return "ok";
      },
      post: async () => undefined,
    };
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    expect(saved).toEqual([["github"]]);
    expect(turns[0]?.refreshConnectors).toBeUndefined();
    drift = false;
    await processSlackRequest({ ...message, eventId: "EvREFRESH02" }, dependencies, { finalAttempt: false });
    expect(turns[1]?.refreshConnectors).toEqual(["github"]);
    expect(saved).toEqual([["github"], []]);
    await processSlackRequest({ ...message, eventId: "EvREFRESH03" }, dependencies, { finalAttempt: false });
    expect(saved).toHaveLength(2);
  });

  it("keeps the reply when remembering the refresh fails", async () => {
    const posts: string[] = [];
    const logs: string[] = [];
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: async () => ({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate." }),
        startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
      }),
      threads: {
        load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }),
        saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
        saveRefreshConnectors: async () => { throw Object.assign(new Error("throttled"), { name: "ThrottlingException" }); },
      },
      runTurn: async (input) => {
        input.recorder?.offer({ manifest: "m", tools: [], connectorOf: new Map([["github__list_issues", "github"]]), model: { provider: "p", modelId: "m" } });
        input.recorder?.toolStarted({ toolCallId: "1", toolName: "github__list_issues", args: {} });
        input.recorder?.toolEnded({ toolCallId: "1", toolName: "github__list_issues", isError: false, result: { content: [{ type: "text", text: "{\"status\":\"FAILED\",\"reason\":\"schema_changed\"}" }] } });
        return "The tool changed; try again.";
      },
      post: async (_thread, text) => { posts.push(text); },
      log: (event, fields) => { logs.push(JSON.stringify({ event, ...fields })); },
    };
    await processSlackRequest({ version: 1, eventId: "EvREFRESH04", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789",
      thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "list issues" }, dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("The tool changed; try again.");
    expect(logs).toContain(JSON.stringify({ event: "thread.refresh_save_failed", eventId: "EvREFRESH04", errorName: "ThrottlingException" }));
  });
});

describe("discovery refresh edge cases", () => {
  const thread = { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1695500000.000001" };
  const base: SlackRequestMessage = { version: 1, eventId: "EvREFRESH10", receivedAt: "2026-09-24T10:00:00.000Z", userId: "U0123456789", thread, text: "list issues" };
  const workspaceApi = () => ({
    ensureWorkspace: async () => ({ outcome: "WORKSPACE" as const, workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate." }),
    startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
  });

  it("passes the remembered connectors from the hosted runtime to discovery", async () => {
    const discover = vi.fn<NonNullable<OrchestrationApi["discoverConnectorTools"]>>(async ({ connector }) => ({ ...catalog, connector }));
    const api = { discoverConnectorTools: discover, submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(),
      createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } as OrchestrationApi;
    const { modelRuntime } = await fauxModelRuntime();
    const input: TurnInput = {
      message: base, subject: "s", workspaceId, conversationId: randomUUID(), orchestratorInstructions: "Delegate.", requestId: () => randomUUID(),
      repositories: ["demo"], refreshConnectors: ["linear"],
      connectors: [
        { name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true },
        { name: "linear", type: "linear", label: "Linear", scopes: ["team"], connected: true },
      ],
    };
    const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-refresh-hosted-"), api, model: FAUX_MODEL, modelRuntime });
    await runtime.dispose();
    expect(discover.mock.calls.map(([call]) => call)).toStrictEqual([
      { workspaceId, connector: "github" },
      { workspaceId, connector: "linear", refresh: true },
    ]);
  });

  it("remembers every drifted connector once, sorted", async () => {
    const saved: string[][] = [];
    const dependencies: ProcessorDependencies = {
      api: workspaceApi,
      threads: {
        load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333" }),
        saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
        saveRefreshConnectors: async (_subject, connectors) => { saved.push(connectors); },
      },
      runTurn: async (input) => {
        input.recorder?.offer({ manifest: "m", tools: [], model: { provider: "p", modelId: "m" },
          connectorOf: new Map([["linear__list_issues", "linear"], ["github__list_issues", "github"], ["jira__search", "jira"]]) });
        const drifted = JSON.stringify({ status: "FAILED", reason: "schema_changed" });
        for (const [id, name, text] of [["1", "linear__list_issues", drifted], ["2", "github__list_issues", drifted], ["3", "linear__list_issues", drifted],
          ["4", "jira__search", JSON.stringify({ status: "FAILED", reason: "vendor_error" })], ["5", "agentx_submit_task", drifted]] as const) {
          input.recorder?.toolStarted({ toolCallId: id, toolName: name, args: {} });
          input.recorder?.toolEnded({ toolCallId: id, toolName: name, isError: false, result: { content: [{ type: "text", text }] } });
        }
        return "ok";
      },
      post: async () => undefined,
    };
    await processSlackRequest(base, dependencies, { finalAttempt: false });
    expect(saved).toEqual([["github", "linear"]]);
  });

  it("keeps the remembered connectors when the turn failed before discovery finished", async () => {
    const saved: string[][] = [];
    const turns: TurnInput[] = [];
    const posts: string[] = [];
    const dependencies: ProcessorDependencies = {
      api: workspaceApi,
      threads: {
        load: async () => ({ workspaceId, conversationId: "33333333-3333-4333-8333-333333333333", refreshConnectors: ["github"] }),
        saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined),
        saveRefreshConnectors: async (_subject, connectors) => { saved.push(connectors); },
      },
      runTurn: async (input) => { turns.push(input); throw new Error("model unavailable"); },
      post: async (_thread, text) => { posts.push(text); },
    };
    await processSlackRequest(base, dependencies, { finalAttempt: false });
    expect(turns[0]?.refreshConnectors).toEqual(["github"]);
    expect(posts.at(-1)).toBe("AgentX could not complete the request: model unavailable");
    expect(saved).toEqual([]);
  });
});
