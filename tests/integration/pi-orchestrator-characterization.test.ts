// tests/integration/pi-orchestrator-characterization.test.ts
// Spec 050 phase 1: pins what Pi 0.85.1 does at every place the orchestrator meets Pi, so the 0.99.2
// upgrade cannot change it unnoticed. Real orchestrator factories, Pi's scripted faux model, offline.
// Characterization: every expected value below was observed on 0.85.1, then pinned exactly.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createGateSession } from "../../packages/orchestrator/src/action-gate.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime, createPiSessionRuntime, runOrchestratorTurn, type ExtensionFailure } from "../../packages/orchestrator/src/orchestrator.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const member = "U0123456789";
const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
const catalog: ConnectorCatalog = {
  connector: "tracker", skipped: [],
  tools: [
    { name: "tracker__list_items", upstreamName: "list_items", description: "List items.", access: "read", hints: { readOnlyHint: true, destructiveHint: false }, itemArguments: [],
      scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: { status: { type: "string" } }, required: [] } },
    { name: "tracker__close_item", upstreamName: "close_item", description: "Close an item.", access: "write", hints: { readOnlyHint: false, destructiveHint: true }, itemArguments: ["id"],
      scopes: [{ alias: "payments", schemaHash: "c".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ],
};
const connectors = [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }];

function api() {
  return {
    discoverConnectorTools: vi.fn(async () => catalog),
    callConnectorTool: vi.fn(async () => ({ requestId: "33333333-3333-4333-8333-333333333333", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false })),
    submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
  } satisfies OrchestrationApi;
}

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const keys = (value: unknown): string[] => Object.keys(value as object).sort();
/** A copy taken when the event fires. structuredClone keeps undefined-valued keys; JSON is the fallback for what it refuses. */
const snapshot = <T>(value: T): T => {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)) as T; }
};
/**
 * What the model is offered on one call: the system prompt, the conversation (copied) and the tool names.
 * The only code phase 2 may change: read the prompt/tools from the leading system message (pi-ai getCurrentSystemPrompt).
 */
const modelView = (modelContext: Context) => ({
  systemPrompt: modelContext.systemPrompt,
  messages: JSON.parse(JSON.stringify(modelContext.messages.filter((message) => (message as { role: string }).role !== "system"))) as Context["messages"],
  tools: (modelContext.tools ?? []).map((tool) => tool.name),
});
type Message = { role?: string; toolName?: string; isError?: boolean; stopReason?: string; content?: unknown };
const toolResults = (runtime: AgentSessionRuntime) => (runtime.session.messages as Message[]).flatMap((message) =>
  message.role === "toolResult" ? [{ tool: message.toolName, isError: message.isError, text: (message.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("") }] : []);
const lastAssistant = (runtime: AgentSessionRuntime) => (runtime.session.messages as Message[]).filter((message) => message.role === "assistant").at(-1);

/**
 * What a Pi host does with a user's `!command`, minus the UI: emit `user_bash` through the session's
 * extension runner, then either record the extension's result or run the shell. This mirrors the
 * "bash" command of Pi 0.85.1's RPC mode (dist/modes/rpc/rpc-mode.js:442-457) line for line; interactive
 * mode's handleBashCommand (dist/modes/interactive/interactive-mode.js:5453-5481) does the same with a TUI.
 * Neither can be driven in-process (runRpcMode takes over process stdout and stdin; InteractiveMode needs
 * a terminal), so the narrowest public path is `session.extensionRunner.emitUserBash`, which both use.
 */
async function hostUserBash(runtime: AgentSessionRuntime, command: string) {
  const session = runtime.session;
  const eventResult = await session.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext: false, cwd: session.sessionManager.getCwd() });
  if (eventResult?.result) {
    session.recordBashResult(command, eventResult.result, { excludeFromContext: false });
    return { handledByExtension: true, result: eventResult.result };
  }
  return { handledByExtension: false, result: await session.executeBash(command, undefined, { excludeFromContext: false }) };
}

describe("orchestrator extensions on Pi 0.85.1", () => {
  it("answers user_bash from the boundary with exit 126 and runs no shell", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (boundaryExtension); guards: user_bash fails closed (0.99)
    const { modelRuntime } = await fauxModelRuntime();
    const state = await createFixtureDirectory("agentx-char-bash-");
    const sentinel = join(state, "ran");
    const runtime = await createOrchestratorRuntime({ stateDirectory: state, projectInstructions: "Delegate.", api: api(), context, modelRuntime, model: FAUX_MODEL });
    try {
      const reply = await hostUserBash(runtime, `touch ${sentinel}`);
      expect(reply).toEqual({ handledByExtension: true, result: {
        output: "Shell execution is disabled in the orchestrator. Delegate the work to AgentX.", exitCode: 126, cancelled: false, truncated: false,
      } });
      expect(keys(reply.result)).toEqual(["cancelled", "exitCode", "output", "truncated"]);
      expect(existsSync(sentinel)).toBe(false);
      // Recorded in the session as Pi records any bash result, so the model sees the refusal next turn.
      expect(runtime.session.messages).toEqual([{
        role: "bashExecution", command: `touch ${sentinel}`, output: "Shell execution is disabled in the orchestrator. Delegate the work to AgentX.",
        exitCode: 126, cancelled: false, truncated: false, timestamp: expect.any(Number) as number, excludeFromContext: false,
      }]);
    } finally { await runtime.dispose(); }
  });

  it("control: the same host path without the boundary does run the shell, so the sentinel would catch it", async () => {
    // protects this file's user_bash probe: proves a missing boundary creates the sentinel
    const { modelRuntime } = await fauxModelRuntime();
    const state = await createFixtureDirectory("agentx-char-bash-control-");
    const sentinel = join(state, "ran");
    const runtime = await createPiSessionRuntime({ stateDirectory: state, modelRuntime, model: FAUX_MODEL, systemPrompt: "Test.", customTools: [], extensions: [] });
    try {
      const reply = await hostUserBash(runtime, `touch ${sentinel}`);
      expect(reply.handledByExtension).toBe(false);
      expect(reply.result.exitCode).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
    } finally { await runtime.dispose(); }
  });

  it("shows the model a hidden turn note as a user message and persists it as a custom_message entry", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (noteExtension, before_agent_start); guards: ExtensionEvent union changes (0.99)
    const { modelRuntime, faux } = await fauxModelRuntime();
    const note = "PINNED NOTE: the resumed task already opened PR 7.";
    const seen: unknown[] = [];
    faux.setResponses([(modelContext) => { seen.push(modelView(modelContext).messages); return fauxAssistantMessage("Ok."); }]);
    const runtime = await createOrchestratorRuntime({ stateDirectory: await createFixtureDirectory("agentx-char-note-"), projectInstructions: "Delegate.", api: api(), context, modelRuntime, model: FAUX_MODEL, turnNote: note });
    try {
      expect(await runOrchestratorTurn(runtime, "hello")).toBe("Ok.");
      // The model sees the note as a second user message, after the member's prompt.
      expect(seen).toEqual([[
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: expect.any(Number) as number },
        { role: "user", content: [{ type: "text", text: note }], timestamp: expect.any(Number) as number },
      ]]);
      // In the session it is a custom message, hidden from display.
      const custom = (runtime.session.messages as Message[]).filter((message) => message.role === "custom");
      expect(custom).toEqual([{ role: "custom", customType: "agentx-turn-note", content: note, display: false, details: undefined, timestamp: expect.any(Number) as number }]);
      expect(keys(custom[0])).toEqual(["content", "customType", "details", "display", "role", "timestamp"]);
      const lines = (await readFile(runtime.session.sessionFile!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line.type)).toEqual(["session", "model_change", "thinking_level_change", "message", "custom_message", "message"]);
      const entry = lines.find((line) => line.type === "custom_message")!;
      expect(keys(entry)).toEqual(["content", "customType", "display", "id", "parentId", "timestamp", "type"]);
      expect(entry).toMatchObject({ type: "custom_message", customType: "agentx-turn-note", content: note, display: false });
      expect(entry.parentId).toBe(lines[3]!.id);
    } finally { await runtime.dispose(); }
  });

  it("blocks every tool call once the turn is handed off, before the gate or the tool sees it", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (stopExtension, tool_call block); guards: ExtensionEvent union and tool_call result changes (0.99)
    const { modelRuntime, faux } = await fauxModelRuntime();
    const controller = new AbortController();
    controller.abort();
    const orchestration = api();
    const session = createGateSession(member);
    faux.setResponses([toolUse(fauxToolCall("tracker__list_items", {}, { id: "call-handoff-1" })), fauxAssistantMessage("Stopping.")]);
    const runtime = await createOrchestratorRuntime({ stateDirectory: await createFixtureDirectory("agentx-char-handoff-"), projectInstructions: "Delegate.", api: orchestration, context, modelRuntime,
      model: FAUX_MODEL, connectors, stopSignal: controller.signal, actionGate: { session } });
    try {
      expect(await runOrchestratorTurn(runtime, "list items")).toBe("Stopping.");
      expect(orchestration.callConnectorTool).not.toHaveBeenCalled();
      expect(toolResults(runtime)).toEqual([{ tool: "tracker__list_items", isError: true,
        text: "AgentX is restarting, so this call was not run. Do not call any more tools; the request will be picked up again." }]);
      expect(session.decisions).toEqual([]);
      // Observed on 0.85.1: the gate's "ran" counter counts this call, because the handoff extension,
      // not the gate, blocked it, and the gate counts every tool_execution_end it did not block itself.
      expect(session.ran).toBe(1);
      expect(lastAssistant(runtime)?.stopReason).toBe("stop");
    } finally { await runtime.dispose(); }
  });

  it("tells the model exactly why the gate held a destructive call, and records the gate's decision", async () => {
    // protects packages/orchestrator/src/action-gate.ts (tool_call block reason) and turn-recorder.ts (gateDecided); guards: tool_call result changes (0.99)
    const { modelRuntime, faux } = await fauxModelRuntime();
    const orchestration = api();
    const session = createGateSession(member);
    const recorder = new TurnRecorder();
    faux.setResponses([toolUse(fauxToolCall("tracker__close_item", { id: "TRK-9" }, { id: "call-close-1" })), fauxAssistantMessage("Asked.")]);
    const runtime = await createOrchestratorRuntime({ stateDirectory: await createFixtureDirectory("agentx-char-gate-"), projectInstructions: "Delegate.", api: orchestration, context, modelRuntime,
      model: FAUX_MODEL, connectors, actionGate: { session }, turnRecorder: recorder });
    try {
      expect(await runOrchestratorTurn(runtime, "close TRK-9", recorder)).toBe("Asked.");
      expect(orchestration.callConnectorTool).not.toHaveBeenCalled();
      expect(toolResults(runtime)).toEqual([{ tool: "tracker__close_item", isError: true,
        text: "Not run yet: AgentX has already posted a confirmation request for this action to the member in the Slack thread, with Approve and Cancel buttons. "
          + "Do not call this tool again or try another way in this turn. Do not restate, summarise or mention this action, its details or the confirmation in your reply: "
          + "the member already sees the request. Report only anything else you did or found in this turn." }]);
      const hash = "910e95ae829c354e31d10a62731770797d07fe79a1cdd9fc0977ea5459ba9bbd";
      const reason = "the tool's name says \"close\"; destructive actions always ask";
      expect(session.decisions).toEqual([{ toolCallId: "call-close-1", tool: "tracker__close_item", connector: "tracker", actionClass: "destructive",
        argumentsHash: hash, outcome: "ask", source: "default", kind: "destructive", reason }]);
      expect(session.asks).toEqual([{ toolCallId: "call-close-1", tool: "tracker__close_item", argumentsHash: hash, summary: "tracker__close_item: id=TRK-9", kind: "destructive" }]);
      expect(session.ran).toBe(0);
      const call = recorder.observation().calls[0]!;
      expect(call).toEqual({ name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "04c3d818753107d567b2813d3b7f63d4",
        durationMs: expect.any(Number) as number, validation: "ok", outcome: "FAILED", gate: { outcome: "ask", source: "default", kind: "destructive", reason } });
    } finally { await runtime.dispose(); }
  });

  it("blocks the call, shows the model the thrown message, and does not report it, when a tool_call handler throws", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (createPiSessionRuntime onError -> onExtensionError); guards: extension error semantics, fail closed (0.99)
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([toolUse(fauxToolCall("probe", {}, { id: "call-probe-1" })), fauxAssistantMessage("Done.")]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: undefined }));
    const probe = { name: "probe", label: "Probe", description: "Probe.", parameters: Type.Object({}), execute } as unknown as ToolDefinition;
    const failures: ExtensionFailure[] = [];
    const recorder = new TurnRecorder();
    const runtime = await createPiSessionRuntime({
      stateDirectory: await createFixtureDirectory("agentx-char-throw-"), modelRuntime, model: FAUX_MODEL, systemPrompt: "Test.", customTools: [probe],
      onExtensionError: (failure) => { failures.push(failure); }, turnRecorder: recorder,
      extensions: [{ name: "pinned-thrower", hidden: true, factory: (pi) => { pi.on("tool_call", () => { throw new Error("pinned extension failure"); }); } }],
    });
    try {
      expect(await runOrchestratorTurn(runtime, "probe")).toBe("Done.");
      expect(execute).not.toHaveBeenCalled();
      expect(toolResults(runtime)).toEqual([{ tool: "probe", isError: true, text: "pinned extension failure" }]);
      // On 0.85.1 a throwing tool_call handler is not routed to bindExtensions' onError: nothing is reported.
      expect(failures).toEqual([]);
      expect(recorder.observation().recordingErrors).toBeUndefined();
      expect(lastAssistant(runtime)?.stopReason).toBe("stop");
    } finally { await runtime.dispose(); }
  });
});

/*
 * Fields AgentX reads from these events through untyped casts, so a 0.99 rename compiles and fails at run time:
 *   turn-recorder.ts:83,90-93    toolStarted    <- tool_execution_start: toolCallId, toolName, args
 *   turn-recorder.ts:84,141-144  toolEnded      <- tool_execution_end: toolCallId, toolName, result, isError
 *   turn-recorder.ts:251,298-302 resultText     <- tool_execution_end.result.content[]: type, text
 *   turn-recorder.ts:85,147-154  agentEnded     <- agent_end.messages[]: role, stopReason, content
 *   action-gate.ts:361-362       ran counter    <- tool_execution_end: toolCallId
 *   action-gate.ts:364-374       check          <- tool_call: toolCallId, toolName, input; ctx: sessionManager.getBranch(), signal
 *   action-gate.ts:110-116       memberMessages <- getBranch() entries: type, message; message: role, content
 */
describe("orchestrator event shapes on Pi 0.85.1", () => {
  it("pins every event the orchestrator's extensions see in one turn with a tool call", async () => {
    // protects packages/orchestrator/src/turn-recorder.ts and action-gate.ts; guards: ExtensionEvent union and TurnEndEvent shape changes (0.99)
    const { modelRuntime, faux } = await fauxModelRuntime();
    const recorder = new TurnRecorder();
    const original = recorder.extension();
    if (typeof original === "function") throw new Error("expected the recorder's named extension");
    const seen: Array<{ type: string; event: Record<string, unknown> }> = [];
    let toolCallCtxKeys: string[] = [];
    let branchAtToolCall: Array<Record<string, unknown>> = [];
    let signalAtToolCall: unknown;
    const names = ["project_trust", "resources_discover", "session_start", "session_info_changed", "session_before_switch", "session_before_fork", "session_before_compact",
      "session_compact", "session_compact_failed", "session_shutdown", "session_before_tree", "session_tree", "context", "before_provider_request", "before_provider_headers",
      "after_provider_response", "before_agent_start", "agent_start", "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end", "turn_start", "turn_end",
      "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select", "thinking_level_select",
      "tool_call", "tool_result", "user_bash", "input"];
    // Rides on the real recorder extension, so it sees what the orchestrator's own extensions see, gate included.
    vi.spyOn(recorder, "extension").mockReturnValue({ ...original, factory: async (pi) => {
      await original.factory(pi);
      const on = pi.on.bind(pi) as unknown as (name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => undefined) => void;
      for (const name of names) {
        on(name, (event, ctx) => {
          seen.push({ type: name, event: snapshot(event) });
          if (name === "tool_call") {
            // Read during the call: Pi makes a captured ctx throw once its session is disposed, and its
            // functions cannot be copied, so its key set is what is kept.
            toolCallCtxKeys = keys(ctx);
            signalAtToolCall = ctx.signal;
            branchAtToolCall = (ctx.sessionManager as { getBranch(): Array<Record<string, unknown>> }).getBranch();
          }
          return undefined;
        });
      }
    } });
    const orchestration = api();
    const gateSession = createGateSession(member);
    faux.setResponses([toolUse(fauxToolCall("tracker__list_items", { status: "open" }, { id: "call-list-1" })), fauxAssistantMessage("None open.")]);
    const runtime = await createOrchestratorRuntime({ stateDirectory: await createFixtureDirectory("agentx-char-events-"), projectInstructions: "Delegate.", api: orchestration, context, modelRuntime,
      model: FAUX_MODEL, connectors, actionGate: { session: gateSession }, turnRecorder: recorder });
    try {
      expect(await runOrchestratorTurn(runtime, "list open items", recorder)).toBe("None open.");
    } finally { await runtime.dispose(); }
    expect(orchestration.callConnectorTool).toHaveBeenCalledOnce();

    // Pi's faux provider streams in randomly sized chunks, so a run of message_update events is pinned as one.
    const order = seen.map((entry) => entry.type).filter((type, index, all) => type !== "message_update" || all[index - 1] !== "message_update");
    expect(order).toEqual([
      "session_start", "resources_discover", "input", "before_agent_start", "agent_start",
      "turn_start", "message_start", "message_end", "context", "before_provider_headers", "after_provider_response",
      "message_start", "message_update", "message_end",
      "tool_execution_start", "tool_call", "tool_result", "tool_execution_end", "message_start", "message_end", "turn_end",
      "turn_start", "context", "before_provider_headers", "after_provider_response",
      "message_start", "message_update", "message_end", "turn_end",
      "agent_end", "agent_settled", "session_shutdown",
    ]);
    const updates = seen.filter((entry) => entry.type === "message_update");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.map((entry) => keys(entry.event))).toEqual(Array(updates.length).fill(["assistantMessageEvent", "message", "type"]));
    const one = (type: string) => {
      const matches = seen.filter((entry) => entry.type === type);
      expect(matches, type).toHaveLength(1);
      return matches[0]!.event;
    };
    const start = one("tool_execution_start");
    const toolCall = one("tool_call");
    const toolResult = one("tool_result");
    const end = one("tool_execution_end");
    const agentEnd = one("agent_end");
    expect(keys(start)).toEqual(["args", "toolCallId", "toolName", "type"]);
    expect(start).toEqual({ type: "tool_execution_start", toolCallId: "call-list-1", toolName: "tracker__list_items", args: { status: "open" } });
    expect(keys(toolCall)).toEqual(["input", "toolCallId", "toolName", "type"]);
    expect(toolCall).toEqual({ type: "tool_call", toolCallId: "call-list-1", toolName: "tracker__list_items", input: { status: "open" } });
    expect(toolCallCtxKeys).toEqual(["abort", "compact", "cwd", "getContextUsage", "getSystemPrompt", "hasPendingMessages", "hasUI", "isIdle", "isProjectTrusted",
      "mode", "model", "modelRegistry", "scopedModels", "sessionManager", "shutdown", "signal", "thinkingLevel", "ui"]);
    expect(signalAtToolCall).toBeInstanceOf(AbortSignal);
    expect(keys(toolResult)).toEqual(["content", "details", "input", "isError", "toolCallId", "toolName", "type", "usage"]);
    expect(keys(end)).toEqual(["isError", "result", "toolCallId", "toolName", "type"]);
    const connectorText = "{\"requestId\":\"33333333-3333-4333-8333-333333333333\",\"status\":\"SUCCEEDED\",\"text\":\"[]\",\"truncated\":false,\"replayed\":false}";
    expect(end).toEqual({ type: "tool_execution_end", toolCallId: "call-list-1", toolName: "tracker__list_items", isError: false,
      result: { content: [{ type: "text", text: connectorText }], details: {} } });
    expect(keys(end.result)).toEqual(["content", "details"]);

    const messageEnds = seen.filter((entry) => entry.type === "message_end").map((entry) => entry.event);
    expect(messageEnds.map((event) => keys(event))).toEqual([["message", "type"], ["message", "type"], ["message", "type"], ["message", "type"]]);
    expect(messageEnds.map((event) => keys(event.message))).toEqual([
      ["content", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "stopReason", "timestamp", "usage"],
      ["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName", "usage"],
      ["api", "content", "model", "provider", "role", "stopReason", "timestamp", "usage"],
    ]);
    const turnEnds = seen.filter((entry) => entry.type === "turn_end").map((entry) => entry.event);
    expect(turnEnds.map((event) => keys(event))).toEqual([["message", "toolResults", "turnIndex", "type"], ["message", "toolResults", "turnIndex", "type"]]);
    expect(turnEnds.map((event) => event.turnIndex)).toEqual([0, 1]);

    expect(keys(agentEnd)).toEqual(["messages", "type"]);
    const messages = agentEnd.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => keys(message))).toEqual([
      ["content", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "stopReason", "timestamp", "usage"],
      ["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName", "usage"],
      ["api", "content", "model", "provider", "role", "stopReason", "timestamp", "usage"],
    ]);
    expect(messages.map((message) => [message.role, message.stopReason])).toEqual([["user", undefined], ["assistant", "toolUse"], ["toolResult", undefined], ["assistant", "stop"]]);
    expect(messages.at(-1)!.content).toEqual([{ type: "text", text: "None open." }]);

    expect(branchAtToolCall.map((entry) => entry.type)).toEqual(["model_change", "thinking_level_change", "message", "message"]);
    expect(branchAtToolCall.filter((entry) => entry.type === "message").map((entry) => keys(entry))).toEqual([
      ["id", "message", "parentId", "timestamp", "type"], ["id", "message", "parentId", "timestamp", "type"],
    ]);
    expect(branchAtToolCall[2]!.message).toMatchObject({ role: "user", content: [{ type: "text", text: "list open items" }] });

    // Cross-check: every field a reader above takes is in the pinned shapes.
    expect(keys(start)).toEqual(expect.arrayContaining(["toolCallId", "toolName", "args"]));
    expect(keys(end)).toEqual(expect.arrayContaining(["toolCallId", "toolName", "result", "isError"]));
    expect((end.result as { content: Array<Record<string, unknown>> }).content.map((block) => keys(block))).toEqual([["text", "type"]]);
    for (const message of messages) expect(keys(message)).toEqual(expect.arrayContaining(["role", "content"]));
    expect(keys(messages.at(-1))).toContain("stopReason");
    expect(keys(toolCall)).toEqual(expect.arrayContaining(["toolCallId", "toolName", "input"]));
    expect(toolCallCtxKeys).toEqual(expect.arrayContaining(["sessionManager", "signal"]));
    expect(keys(branchAtToolCall[2])).toEqual(expect.arrayContaining(["type", "message"]));
    expect(keys(branchAtToolCall[2]!.message)).toEqual(expect.arrayContaining(["role", "content"]));
    // And the readers really took them: the recorder kept the call and the stop, the gate counted the run.
    expect(recorder.observation().calls.map(({ name, connector, validation, outcome }) => ({ name, connector, validation, outcome })))
      .toEqual([{ name: "tracker__list_items", connector: "tracker", validation: "ok", outcome: "SUCCEEDED" }]);
    expect(recorder.observation()).toMatchObject({ stopReason: "stop", emptyResponse: false });
    expect(gateSession.decisions.map(({ toolCallId, outcome }) => ({ toolCallId, outcome }))).toEqual([{ toolCallId: "call-list-1", outcome: "allow" }]);
    expect(gateSession.ran).toBe(1);
  });
});
