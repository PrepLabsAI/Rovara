// #1548: the items `rovara session watch` and the web app show for a task's saved events. The pi events are typed with pi's own event type, so a change to pi's shapes fails the type check here.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  SESSION_ACTIVITY_TEXT_MAX, SessionActivityPageSchema, clipActivityText, sessionActivityView, type SessionActivityEvent, type SessionActivityOperation,
} from "@agentx/contracts";

const PLAN = "op-plan";
const CODE = "op-code";
const operations: SessionActivityOperation[] = [
  { operationId: PLAN, kind: "agent_step", step: "plan", status: "SUCCEEDED", createdAt: "2026-11-26T10:00:00.000Z" },
  { operationId: CODE, kind: "agent_step", step: "code", status: "RUNNING", createdAt: "2026-11-26T10:05:00.000Z" },
];

let sequence = 0;
/** A saved event as the worker stored it. */
function saved(operationId: string, type: string, payload: unknown): SessionActivityEvent {
  sequence += 1;
  return { operationId, sequence, type, timestamp: `2026-11-26T10:00:${String(sequence).padStart(2, "0")}.000Z`, payload };
}
/** A pi event, under the worker's type for it (worker session-events.ts `eventType`). Typed as pi's own event, so a change to pi's shapes fails here. */
function pi(operationId: string, event: AgentSessionEvent): SessionActivityEvent {
  return saved(operationId, event.type === "tool_execution_start" ? "tool_start" : event.type === "tool_execution_end" ? "tool_end" : "progress", event);
}

function assistant(content: AssistantMessage["content"]): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant", content, api: "bedrock-converse-stream", provider: "amazon-bedrock", model: "test-model", stopReason: "stop", timestamp: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}

describe("sessionActivityView", () => {
  it("shows each step, the agent's messages and its tool calls from start to end", () => {
    const events = [
      saved(PLAN, "lifecycle", { status: "RUNNING" }),
      pi(PLAN, { type: "agent_start" }),
      pi(PLAN, { type: "message_end", message: { role: "user", content: "Fix the login bug", timestamp: 0 } }),
      pi(PLAN, assistant([{ type: "thinking", thinking: "Look at auth first." }, { type: "text", text: "Reading the auth module." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth.ts" } }])),
      pi(PLAN, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/auth.ts" } }),
      pi(PLAN, { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "export function login() {}" }], details: undefined }, isError: false, durationMs: 12 }),
      saved(CODE, "progress", { message: "Installing dependencies" }),
      pi(CODE, { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command: "npm test" } }),
    ];
    const items = sessionActivityView(events, operations);
    expect(items.map((item) => item.kind)).toEqual(["step", "status", "message", "message", "tool", "step", "note", "tool"]);
    expect(items[0]).toMatchObject({ kind: "step", label: "plan", status: "SUCCEEDED", operationId: PLAN });
    expect(items[1]).toMatchObject({ kind: "status", text: "Step running." });
    expect(items[2]).toMatchObject({ kind: "message", role: "user", text: "Fix the login bug" });
    expect(items[3]).toMatchObject({ kind: "message", role: "assistant", text: "Reading the auth module.", thinking: "Look at auth first.", model: "test-model" });
    expect(items[4]).toMatchObject({ kind: "tool", toolCallId: "call-1", name: "read", args: "{\"path\":\"src/auth.ts\"}", status: "done", result: "export function login() {}", durationMs: 12 });
    expect(items[5]).toMatchObject({ kind: "step", label: "code", status: "RUNNING" });
    expect(items[6]).toMatchObject({ kind: "note", text: "Installing dependencies" });
    expect(items[7]).toMatchObject({ kind: "tool", name: "bash", status: "running" });
    expect(items[7]).not.toHaveProperty("result");
  });

  it("marks a failed tool, and keeps an end whose start it never saw", () => {
    const items = sessionActivityView([
      pi(CODE, { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "false" } }),
      pi(CODE, { type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "exit 1" }], details: undefined }, isError: true }),
      pi(CODE, { type: "tool_execution_end", toolCallId: "b", toolName: "edit", result: "ok", isError: false }),
    ], operations);
    expect(items.slice(1)).toMatchObject([
      { kind: "tool", toolCallId: "a", status: "failed", result: "exit 1" },
      { kind: "tool", toolCallId: "b", name: "edit", args: "", status: "done", result: "ok" },
    ]);
  });

  it("shows retries, compaction and errors, and leaves out bookkeeping", () => {
    const items = sessionActivityView([
      pi(CODE, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "throttled" }),
      pi(CODE, { type: "auto_retry_end", success: false, attempt: 3 }),
      pi(CODE, { type: "compaction_start", reason: "threshold" }),
      pi(CODE, { type: "turn_start" }),
      saved(CODE, "usage", { inputTokens: 10 }),
      saved(CODE, "result", { status: "SUCCEEDED" }),
      saved(CODE, "error", { message: "The step timed out." }),
    ], operations);
    expect(items.slice(1).map((item) => ("text" in item ? item.text : item.kind))).toEqual([
      "The model call failed; retrying (attempt 1 of 3): throttled",
      "The model call kept failing; the retries ran out.",
      "Compacting the conversation (threshold).",
      "The step timed out.",
    ]);
  });

  it("leaves out a message with nothing to read and skips events it does not know or the worker cut", () => {
    const items = sessionActivityView([
      pi(CODE, assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }])),
      saved(CODE, "progress", { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "hidden" }] } }),
      saved(CODE, "progress", { type: "something_new", value: 1 }),
      saved(CODE, "tool_start", { type: "tool_execution_start" }),
      { operationId: CODE, sequence: 99, type: "progress", timestamp: "2026-11-26T10:59:00.000Z", payload: "not an object" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "step", operationId: CODE, sequence: 0, label: "Step" });
    expect(items[0]).not.toHaveProperty("status");
  });

  it("cuts long text to the limit", () => {
    const long = "x".repeat(SESSION_ACTIVITY_TEXT_MAX + 50);
    const [, message] = sessionActivityView([pi(CODE, assistant([{ type: "text", text: long }]))], operations);
    expect(message).toMatchObject({ kind: "message" });
    expect((message as { text: string }).text).toHaveLength(SESSION_ACTIVITY_TEXT_MAX);
    expect((message as { text: string }).text.endsWith("…")).toBe(true);
    expect(clipActivityText("short", 10)).toBe("short");
  });
});

describe("SessionActivityPageSchema", () => {
  it("accepts a page and refuses unknown keys", () => {
    const page = { operations, events: [saved(CODE, "progress", { message: "hi" })], cursor: "abc", active: true };
    expect(SessionActivityPageSchema.parse(page)).toEqual(page);
    expect(SessionActivityPageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
  });
});
