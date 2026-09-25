import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TurnObservationSchema, UNRECORDABLE_ARGUMENTS, redactArguments } from "../../packages/contracts/src/turns.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";

const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
const operation = "0f0e0d0c-0b0a-4908-8706-050403020100";

function recorder() {
  let clock = 1_000;
  const turn = new TurnRecorder(() => (clock += 10));
  turn.offer({
    manifest: "What this channel can do:",
    tools: [{ name: "agentx_submit_task", description: "Run work." }, { name: "github__list_issues", description: "List issues." }],
    connectorOf: new Map([["github__list_issues", "github"]]),
    model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
  });
  return turn;
}

describe("turn recorder", () => {
  it("records what was offered as hashes, never the text", () => {
    const observation = recorder().observation();
    expect(observation.model).toEqual({ provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" });
    expect(observation.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.offeredTools.map((tool) => tool.name)).toEqual(["agentx_submit_task", "github__list_issues"]);
    expect(JSON.stringify(observation)).not.toContain("List issues.");
  });

  it("classifies unknown names, schema errors, policy denials and connector results", () => {
    const turn = recorder();
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_update_pull_request", args: { repository: "api" } });
    turn.toolEnded({ toolCallId: "1", toolName: "agentx_update_pull_request", isError: true, result: text("Tool agentx_update_pull_request not found") });
    turn.toolStarted({ toolCallId: "2", toolName: "agentx_submit_task", args: {} });
    turn.toolEnded({ toolCallId: "2", toolName: "agentx_submit_task", isError: true, result: text("Validation failed for tool \"agentx_submit_task\":\n  - prompt: required") });
    turn.toolStarted({ toolCallId: "3", toolName: "github__list_issues", args: { state: "OPEN" } });
    turn.connectorFailed("3", "FORBIDDEN");
    turn.toolEnded({ toolCallId: "3", toolName: "github__list_issues", isError: true, result: text("GitHub MCP tool is not approved for this project") });
    turn.toolStarted({ toolCallId: "4", toolName: "github__list_issues", args: { state: "OPEN" } });
    turn.toolEnded({ toolCallId: "4", toolName: "github__list_issues", isError: false,
      result: text({ requestId: "11111111-1111-4111-8111-111111111111", status: "FAILED", reason: "schema_changed", text: "changed", truncated: false, replayed: false }) });
    const calls = turn.observation().calls;
    expect(calls.map(({ name, validation, outcome, reason, connector }) => ({ name, validation, outcome, reason, connector }))).toEqual([
      { name: "agentx_update_pull_request", validation: "unknown_tool", outcome: "FAILED", reason: undefined, connector: undefined },
      { name: "agentx_submit_task", validation: "schema_error", outcome: "FAILED", reason: undefined, connector: undefined },
      { name: "github__list_issues", validation: "policy_denied", outcome: "FAILED", reason: "FORBIDDEN", connector: "github" },
      { name: "github__list_issues", validation: "ok", outcome: "FAILED", reason: "schema_changed", connector: "github" },
    ]);
    expect(calls[3]?.requestId).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls.every((call) => call.durationMs === 10)).toBe(true);
  });

  it("maps operation statuses and collects the worker operations the turn started", () => {
    const turn = recorder();
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: { prompt: "list files" } });
    turn.toolEnded({ toolCallId: "1", toolName: "agentx_submit_task", isError: false, result: text({ operationId: operation, status: "INTERRUPTED" }) });
    turn.toolStarted({ toolCallId: "2", toolName: "agentx_follow_up", args: { prompt: "and tests" } });
    const observation = turn.observation();
    expect(observation.calls.map((call) => [call.outcome, call.operationId])).toEqual([["FAILED", operation], ["IN_PROGRESS", undefined]]);
    expect(observation.workerOperations).toEqual([operation]);
  });

  it("redacts and caps arguments, and fingerprints the redacted form", () => {
    const turn = recorder();
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: { apiKey: "k", prompt: `use ${token} ${"x".repeat(5_000)}` } });
    turn.toolEnded({ toolCallId: "1", toolName: "agentx_submit_task", isError: false, result: text({ status: "SUCCEEDED" }) });
    const [call] = turn.observation().calls;
    expect(call?.arguments).not.toContain(token);
    expect(call?.arguments).toContain("\"apiKey\":\"[REDACTED]\"");
    expect(call?.arguments.length).toBe(2_048);
    expect(call?.argumentsFingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(turn.firstToolCall()?.arguments).toMatchObject({ apiKey: "k" });
  });

  it("reads a status named like an Object property as an unrecognized status", () => {
    const turn = recorder();
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: {} });
    turn.toolEnded({ toolCallId: "1", toolName: "agentx_submit_task", isError: false, result: text({ status: "constructor" }) });
    expect(TurnObservationSchema.parse(turn.observation()).calls[0]?.outcome).toBe("FAILED");
  });

  it("keeps at most 50 calls and says so", () => {
    const turn = recorder();
    for (let index = 0; index < 55; index += 1) {
      turn.toolStarted({ toolCallId: String(index), toolName: "agentx_submit_task", args: { prompt: "p" } });
      turn.toolEnded({ toolCallId: String(index), toolName: "agentx_submit_task", isError: false, result: text({ status: "SUCCEEDED" }) });
    }
    const observation = turn.observation();
    expect(observation.calls).toHaveLength(50);
    expect(observation.callsTruncated).toBe(true);
  });

  it("reads the stop reason and flags a final assistant message without text", () => {
    const turn = recorder();
    turn.agentEnded([
      { role: "assistant", content: [{ type: "text", text: "Checking." }], stopReason: "toolUse" },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [{ type: "text", text: "<thinking>hmm</thinking>  " }], stopReason: "stop" },
    ]);
    expect(turn.observation()).toMatchObject({ stopReason: "stop", emptyResponse: true });
    const errored = recorder();
    errored.agentEnded([{ role: "assistant", content: [], stopReason: "error" }]);
    expect(errored.observation()).toMatchObject({ stopReason: "error", emptyResponse: false });
  });

  it("measures the turn's own usage as the difference of session totals", () => {
    const turn = recorder();
    const before = { tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 }, cost: 1 };
    const after = { tokens: { input: 150, output: 25, cacheRead: 5, cacheWrite: 0, total: 180 }, cost: 1.5 };
    turn.measure(before, after, "SUCCEEDED");
    expect(turn.observation().usage).toMatchObject({ outcome: "SUCCEEDED", tokens: { input: 50, output: 15, cacheRead: 5, cacheWrite: 0, total: 70 }, costUsd: 0.5 });
  });

  it("reports unusable usage instead of throwing", () => {
    const turn = recorder();
    const stats = { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: Number.NaN };
    turn.measure(stats, stats, "FAILED");
    expect(turn.observation().usage).toBeUndefined();
    expect(turn.observation().usageError).toBe("session cost must be a non-negative finite number");
  });

  it("reports usage it cannot attribute to a model instead of dropping it", () => {
    const turn = new TurnRecorder(() => 0);
    const stats = { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 };
    turn.measure(stats, stats, "SUCCEEDED");
    expect(turn.observation()).toMatchObject({ usageError: "model was not offered" });
    expect(turn.observation().usage).toBeUndefined();
  });

  it("produces an observation the contract accepts", () => {
    const turn = recorder();
    turn.toolStarted({ toolCallId: "1", toolName: "github__list_issues", args: {} });
    turn.toolEnded({ toolCallId: "1", toolName: "github__list_issues", isError: false, result: text("not json") });
    expect(TurnObservationSchema.parse(turn.observation()).calls[0]).toMatchObject({ outcome: "SUCCEEDED", validation: "ok" });
  });

  it("subscribes the three Pi events from a hidden extension", () => {
    const events: string[] = [];
    const extension = recorder().extension();
    expect(extension).toMatchObject({ name: "agentx-turn-recorder", hidden: true });
    const factory = extension.factory as (pi: { on: (event: string) => void }) => unknown;
    void factory({ on: (event: string) => { events.push(event); } });
    expect(events).toEqual(["tool_execution_start", "tool_execution_end", "agent_end"]);
  });
  it("routes arguments through redactArguments and never records request or response text", () => {
    const turn = recorder();
    const key = "sk_live_0123456789abcdefABCDEF";
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: { prompt: "log in with password=hunter2abc", apiKey: key } });
    turn.toolEnded({ toolCallId: "1", toolName: "agentx_submit_task", isError: false, result: text({ status: "SUCCEEDED", echo: "password=hunter2abc" }) });
    turn.agentEnded([
      { role: "user", content: [{ type: "text", text: "please use password=hunter2abc" }] },
      { role: "assistant", content: [{ type: "text", text: `done with ${key}` }], stopReason: "stop" },
    ]);
    const observation = turn.observation();
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("hunter2abc");
    expect(serialized).not.toContain(key);
    expect(observation.calls[0]?.arguments).toBe(redactArguments({ prompt: "log in with password=hunter2abc", apiKey: key }));
    expect(observation.calls[0]?.argumentsFingerprint).toBe(
      createHash("sha256").update(redactArguments({ prompt: "log in with password=hunter2abc", apiKey: key }, Number.POSITIVE_INFINITY)).digest("hex").slice(0, 32),
    );
  });

  it("records unrecordable arguments instead of throwing", () => {
    const turn = recorder();
    const circular: Record<string, unknown> = { prompt: "p" };
    circular.self = circular;
    turn.toolStarted({ toolCallId: "1", toolName: "agentx_submit_task", args: circular });
    const observation = turn.observation();
    expect(observation.calls[0]?.arguments).toBe(UNRECORDABLE_ARGUMENTS);
    expect(TurnObservationSchema.parse(observation).calls).toHaveLength(1);
  });
});
