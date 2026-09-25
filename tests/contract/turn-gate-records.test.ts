import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { TurnCallSchema, TurnRecordSchema, type ConnectorCatalog, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { createGateSession } from "../../packages/orchestrator/src/action-gate.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import { buildTurnRecord } from "../../packages/slack-service/src/turn-records.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const call = { name: "tracker__close_item", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "a".repeat(32), validation: "ok", outcome: "FAILED", durationMs: 3 } as const;
const DESTRUCTIVE = "the tool's name says \"close\"; destructive actions always ask";

describe("gate decisions in turn records (spec 014 FR-021)", () => {
  it("keeps parsing a call recorded before the gate, and parses one with a decision", () => {
    expect(TurnCallSchema.safeParse(call).success).toBe(true);
    expect(TurnCallSchema.safeParse({ ...call, gate: { outcome: "ask", source: "default", kind: "destructive", reason: DESTRUCTIVE } }).success).toBe(true);
    expect(TurnCallSchema.safeParse({ ...call, gate: { outcome: "deny", source: "rule", kind: "admin", rule: "2", reason: "Closing is frozen." } }).success).toBe(true);
  });

  it("refuses a decision with other fields, an unknown outcome or source, a numeric rule or a long reason", () => {
    for (const gate of [
      { outcome: "ask", source: "default", reason: "x", arguments: "{}" },
      { outcome: "maybe", source: "default", reason: "x" },
      { outcome: "ask", source: "model", reason: "x" },
      { outcome: "ask", source: "rule", rule: 2, reason: "x" },
      { outcome: "ask", source: "classifier", reason: "r".repeat(201) },
    ]) expect(TurnCallSchema.safeParse({ ...call, gate }).success, JSON.stringify(gate)).toBe(false);
  });

  it("records each decision on its call, the rule as text, and no argument value in a classifier's reason", () => {
    const recorder = new TurnRecorder(() => 0);
    recorder.toolStarted({ toolCallId: "c1", toolName: "tracker__save_item", args: { id: "TRK-5", title: "Secret launch plan", priority: 2 } });
    recorder.toolStarted({ toolCallId: "c2", toolName: "tracker__close_item", args: { id: "TRK-9" } });
    recorder.gateDecided({ toolCallId: "c1", outcome: "ask", source: "classifier", kind: "classifier", reason: "Nobody asked to rename trk-5 to Secret launch plan at priority 2." });
    recorder.gateDecided({ toolCallId: "c2", outcome: "deny", source: "rule", kind: "admin", rule: 3, reason: "Closing is frozen for the audit" });
    recorder.gateDecided({ toolCallId: "never-started", outcome: "allow", source: "default", kind: "read", reason: "reads run without asking" });
    const { calls } = recorder.observation();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.gate).toEqual({ outcome: "ask", source: "classifier", kind: "classifier", reason: "Nobody asked to rename [argument] to [argument] at priority [argument]." });
    expect(calls[1]!.gate).toEqual({ outcome: "deny", source: "rule", kind: "admin", rule: "3", reason: "Closing is frozen for the audit" });
  });

  it("redacts and caps a reason, and names a decision it cannot keep instead of throwing", () => {
    const recorder = new TurnRecorder(() => 0);
    recorder.toolStarted({ toolCallId: "c1", toolName: "tracker__save_item", args: {} });
    recorder.gateDecided({ toolCallId: "c1", outcome: "ask", source: "classifier_unavailable", kind: "classifier", reason: `the classifier could not decide: ghp_0123456789abcdefghijABCDEFGHIJ012345 ${"x".repeat(300)}` });
    recorder.toolStarted({ toolCallId: "c2", toolName: "tracker__save_item", args: {} });
    recorder.gateDecided({ toolCallId: "c2", outcome: "later", source: "default", reason: "x" });
    const observation = recorder.observation();
    expect(observation.calls[0]!.gate!.reason).not.toContain("ghp_0123456789");
    expect(observation.calls[0]!.gate!.reason.length).toBeLessThanOrEqual(200);
    expect(observation.calls[1]).not.toHaveProperty("gate");
    expect(observation.recordingErrors).toEqual(["gate_invalid"]);
  });

  it("records the gate's decision on every call of a real turn, blocked calls included, keeps the host's log line, and carries it into the record", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tracker__list_items", {}), fauxToolCall("tracker__close_item", { id: "TRK-9" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Waiting for your confirmation."),
    ]);
    const catalog: ConnectorCatalog = { connector: "tracker", skipped: [], tools: [
      { name: "tracker__list_items", upstreamName: "list_items", description: "List items.", access: "read", itemArguments: [],
        scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "tracker__close_item", upstreamName: "close_item", description: "Close an item.", access: "write", itemArguments: ["id"],
        scopes: [{ alias: "payments", schemaHash: "c".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    ] };
    const callConnectorTool = vi.fn(async () => ({ requestId: "r1", status: "SUCCEEDED", text: "[]", truncated: false, replayed: false }));
    const api = { discoverConnectorTools: vi.fn(async () => catalog), callConnectorTool, submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(),
      followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } satisfies OrchestrationApi;
    const recorder = new TurnRecorder();
    const logged: string[] = [];
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-gate-record-"), projectInstructions: "Delegate.", api, model: FAUX_MODEL, modelRuntime,
      context: { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" },
      connectors: [{ name: "tracker", type: "tracker", label: "Tracker issues", scopes: ["payments"], connected: true }],
      turnRecorder: recorder,
      actionGate: { session: createGateSession("U0123456789"), onDecision: (decision) => { logged.push(`${decision.tool}:${decision.outcome}`); } },
    });
    try {
      await runOrchestratorTurn(runtime, "close TRK-9", recorder);
    } finally { await runtime.dispose(); }
    expect(callConnectorTool).toHaveBeenCalledOnce();
    expect(logged).toEqual(["tracker__list_items:allow", "tracker__close_item:ask"]);
    const observation = recorder.observation();
    expect(observation.calls.map((entry) => [entry.name, entry.outcome, entry.gate])).toEqual([
      ["tracker__list_items", "SUCCEEDED", { outcome: "allow", source: "default", kind: "read", reason: "reads run without asking" }],
      ["tracker__close_item", "FAILED", { outcome: "ask", source: "default", kind: "destructive", reason: DESTRUCTIVE }],
    ]);
    const message: SlackRequestMessage = {
      version: 1, eventId: "EvGATEREC001", receivedAt: "2026-09-25T10:00:00.000Z", userId: "U0123456789",
      thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "close TRK-9",
    };
    const record = buildTurnRecord({
      message, subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", startedAt: new Date(0), finishedAt: new Date(1),
      draft: { disposition: "answered", responseText: "Waiting for your confirmation." }, observation, lastPosted: "",
    });
    expect(TurnRecordSchema.parse(record).calls[1]!.gate).toEqual({ outcome: "ask", source: "default", kind: "destructive", reason: DESTRUCTIVE });
  }, 30_000);
});
