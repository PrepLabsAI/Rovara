// Issue 157: a turn handed off to a new task must not go on calling tools in the old task, and the
// next turn in the thread must know what the resumed task did. Real Pi turns with the faux model.
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog } from "../../packages/contracts/src/index.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { HANDOFF_TOOL_REASON, createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
const catalog: ConnectorCatalog = {
  connector: "tracker", skipped: [],
  tools: [
    { name: "tracker__list_items", upstreamName: "list_items", description: "List items.", access: "read", hints: { readOnlyHint: true, destructiveHint: false }, itemArguments: [],
      scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: {}, required: [] } },
  ],
};
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

async function turn(options: { stopSignal?: AbortSignal; turnNote?: string; script: Parameters<Awaited<ReturnType<typeof fauxModelRuntime>>["faux"]["setResponses"]>[0]; onCall?: () => void }) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(options.script);
  const callConnectorTool = vi.fn(async () => {
    options.onCall?.();
    return { requestId: "33333333-3333-4333-8333-333333333333", status: "SUCCEEDED", text: "2 items", truncated: false, replayed: false };
  });
  const api = {
    discoverConnectorTools: vi.fn(async () => catalog), callConnectorTool,
    submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
  } satisfies OrchestrationApi;
  const runtime = await createOrchestratorRuntime({
    stateDirectory: await createFixtureDirectory("agentx-handoff-turn-"), projectInstructions: "Delegate.", api, context, modelRuntime, model: FAUX_MODEL,
    connectors: [{ name: "tracker", type: "tracker", label: "Tracker", scopes: ["payments"], connected: true }],
    ...(options.stopSignal === undefined ? {} : { stopSignal: options.stopSignal }),
    ...(options.turnNote === undefined ? {} : { turnNote: options.turnNote }),
  });
  try {
    const reply = await runOrchestratorTurn(runtime, "what is open?");
    const results = runtime.session.messages.flatMap((message) => {
      const entry = message as { role?: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
      return entry.role === "toolResult" ? [{ tool: entry.toolName, isError: entry.isError, text: (entry.content ?? []).map((block) => block.text ?? "").join("") }] : [];
    });
    return { reply, results, callConnectorTool };
  } finally { await runtime.dispose(); }
}

describe("a turn handed off to a new task", () => {
  it("runs no tool at all when it was handed off before the model's first call", async () => {
    const { results, callConnectorTool } = await turn({
      stopSignal: AbortSignal.abort(),
      script: [toolUse(fauxToolCall("tracker__list_items", {})), fauxAssistantMessage([fauxText("Stopped.")])],
    });
    expect(callConnectorTool).not.toHaveBeenCalled();
    expect(results).toEqual([{ tool: "tracker__list_items", isError: true, text: HANDOFF_TOOL_REASON }]);
  });

  it("lets the call already running finish, and runs no later call", async () => {
    const stop = new AbortController();
    const { results, callConnectorTool } = await turn({
      stopSignal: stop.signal,
      onCall: () => stop.abort(),
      script: [toolUse(fauxToolCall("tracker__list_items", {})), toolUse(fauxToolCall("tracker__list_items", {})), fauxAssistantMessage([fauxText("Stopped.")])],
    });
    expect(callConnectorTool).toHaveBeenCalledOnce();
    expect(results.map((result) => result.isError)).toEqual([false, true]);
    expect(results[1]!.text).toBe(HANDOFF_TOOL_REASON);
  });

  it("runs tools as before without a stop signal", async () => {
    const { callConnectorTool } = await turn({ script: [toolUse(fauxToolCall("tracker__list_items", {})), fauxAssistantMessage([fauxText("2 items.")])] });
    expect(callConnectorTool).toHaveBeenCalledOnce();
  });
});

describe("the note for the turn after a resume", () => {
  it("reaches the model's context for that turn", async () => {
    let seen = "";
    await turn({
      turnNote: "AgentX restarted while working on an earlier request; its task finished: Pushed the fix.",
      script: [(input: Context) => {
        seen = JSON.stringify(input.messages);
        return fauxAssistantMessage([fauxText("Opening the pull request.")]);
      }],
    });
    expect(seen).toContain("AgentX restarted while working on an earlier request; its task finished: Pushed the fix.");
  });
});

describe("the hosted Slack runtime", () => {
  it("hands the turn's signal and note to the orchestrator", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    let seen = "";
    faux.setResponses([(input: Context) => {
      seen = JSON.stringify(input.messages);
      return toolUse(fauxToolCall("agentx_task_status", { operationId: "55555555-5555-4555-8555-555555555555" }));
    }, fauxAssistantMessage([fauxText("Stopped.")])]);
    const taskStatus = vi.fn(async () => ({ status: "RUNNING" }));
    const runtime = await createHostedSlackRuntime({
      message: { version: 1, eventId: "EvNOTE000001", receivedAt: "2026-09-29T19:30:00.000Z", userId: "U0123456789", thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "continue" },
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", ...context, orchestratorInstructions: "Delegate.", computePrepared: true,
      recoverableOperations: ["55555555-5555-4555-8555-555555555555"],
      requestId: () => "44444444-4444-4444-8444-444444444444", signal: AbortSignal.abort(), turnNote: "the resumed task finished",
    }, {
      stateDirectory: await createFixtureDirectory("agentx-handoff-hosted-"), modelRuntime, model: FAUX_MODEL,
      api: { submitTask: vi.fn(), taskStatus, taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() },
    });
    try {
      await runOrchestratorTurn(runtime, "continue");
    } finally { await runtime.dispose(); }
    expect(seen).toContain("the resumed task finished");
    expect(taskStatus).not.toHaveBeenCalled();
  });
});
