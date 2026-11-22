import { describe, expect, it } from "vitest";
import { aiToolTurn, deriveTaskStatus, failureCategory, recentTaskEvents, taskEvent, type OperationFacts, type StoredEvent } from "../../packages/broker/src/developer/task-records.js";

const developerId = "d".repeat(64);
const taskId = "44444444-4444-4444-8444-444444444444";
const op = (kind: string, status: string, createdAt: string, error?: string): OperationFacts => ({
  id: `${kind}-${createdAt}`, kind, status, createdAt, ...(error === undefined ? {} : { error }),
});
const PLANTED = "xoxb-1111111111-planted-secret";

describe("task status (R4, FR-025)", () => {

  it.each(["ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"])("keeps a PLAN_CRITIQUE %s advisory to the last task result", (status) => {
    const plan = { ...op("task", "SUCCEEDED", "t1"), workflowMode: "PLAN" };
    const critique = { ...op("task", status, "t2", "plan check failed"), workflowMode: "PLAN_CRITIQUE" };
    expect(deriveTaskStatus({ workspaceStatus: "READY", operations: [critique, plan] })).toEqual({ status: "SUCCEEDED", closing: false, current: plan });
  });

  it.each(["ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED"])("uses the build's %s status after an advisory failure", (status) => {
    const build = { ...op("task", status, "t3"), workflowMode: "IMPLEMENT" };
    const derived = deriveTaskStatus({ workspaceStatus: "READY", operations: [build, { ...op("task", "FAILED", "t2"), workflowMode: "PLAN_CRITIQUE" }] });
    expect(derived.status).toBe(status === "ACCEPTED" ? "RUNNING" : status);
    expect(derived.current).toEqual(build);
  });

  it.each([undefined, "IMPLEMENT", "PLAN", "REVIEW", "PLAN_CRITIQUE_UNKNOWN"])("keeps a real failure with mode %s, regardless of free text", (workflowMode) => {
    const failed = { ...op("task", "FAILED", "t2", "advisory PLAN_CRITIQUE plan check failed"), workflowMode };
    expect(deriveTaskStatus({ workspaceStatus: "READY", operations: [op("task", "SUCCEEDED", "t1"), failed] })).toMatchObject({ status: "FAILED", current: failed, failure: { category: "task_failed" } });
  });

  it.each(["ACCEPTED", "SUCCEEDED", "FAILED"])("keeps publish %s status and failure category unchanged", (status) => {
    const publish = op("publish", status, "t2", "push rejected");
    const derived = deriveTaskStatus({ workspaceStatus: "READY", operations: [publish, op("task", "SUCCEEDED", "t1"), { ...op("task", "FAILED", "t3"), workflowMode: "PLAN_CRITIQUE" }] });
    expect(derived.status).toBe(status === "ACCEPTED" ? "RUNNING" : status);
    expect(derived.current).toEqual(publish);
    expect(derived.failure?.category).toBe(status === "FAILED" ? "publication_failed" : undefined);
  });

  it("keeps an advisory-only task starting and preserves close precedence", () => {
    const operations = [{ ...op("task", "FAILED", "t1"), workflowMode: "PLAN_CRITIQUE" }];
    expect(deriveTaskStatus({ workspaceStatus: "READY", operations })).toEqual({ status: "STARTING", closing: false });
    expect(deriveTaskStatus({ workspaceStatus: "CLOSED", operations })).toEqual({ status: "CLOSED", closing: false });
  });

  it("keeps compute lost during setup worker_unavailable, and says to start a new task, not to retry (#154)", () => {
    const derived = deriveTaskStatus({
      workspaceStatus: "PREPARATION_FAILED", pointer: {},
      operations: [op("prepare", "FAILED", "t1", "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request")],
    });
    expect(derived.failure).toEqual({
      category: "worker_unavailable", stage: "setup",
      message: "workspace compute was lost during setup; close this task and start a new one",
    });
  });

});

describe("failure categories (R5)", () => {
  it.each([
    ["publish", "FAILED", "push rejected", "publication_failed"],
    ["task", "FAILED", "the task timed out after 30 minutes", "timed_out"],
  ] as const)("%s %s %s is %s", (kind, status, error, category) => {
    expect(failureCategory(kind, status, error)).toBe(category);
  });
});

describe("task events", () => {
  const event = (sequence: number, type: string, payload: unknown): StoredEvent => ({ sequence, type, timestamp: `2026-09-27T12:00:${String(sequence).padStart(2, "0")}.000Z`, payload });

  it("keeps status, progress, tools, assistant messages and errors, oldest first, and skips streaming noise", () => {
    const newestFirst = [
      event(6, "error", { message: `failed with ${PLANTED}` }),
      event(5, "progress", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass." }] } }),
      event(4, "progress", { type: "message_update", delta: "Te" }),
      event(3, "tool_end", { type: "tool_execution_end", toolName: "bash", isError: false }),
      event(2, "tool_start", { type: "tool_execution_start", toolName: "bash" }),
      event(1, "lifecycle", { status: "RUNNING" }),
    ];
    const events = recentTaskEvents(newestFirst, 10);
    expect(events.map((entry) => [entry.kind, entry.text])).toEqual([
      ["status", "Worker status: RUNNING"],
      ["tool", "Started bash"],
      ["tool", "Finished bash"],
      ["message", "Tests pass."],
      ["error", "failed with [REDACTED]"],
    ]);
  });

  it("caps event text without splitting a surrogate pair (emoji) at the boundary (fix round 1)", () => {
    // An emoji (a surrogate pair) straddles DEVELOPER_EVENT_TEXT_MAX (300): a plain .slice(0, 300)
    // would keep only the lone high surrogate at the end, an invalid string.
    const long = `${"x".repeat(299)}\u{1F600}${"y".repeat(50)}`;
    const readable = taskEvent(event(1, "progress", { message: long }));
    expect(readable?.text.length).toBe(299);
    expect(/[\uD800-\uDFFF]/.test(readable?.text ?? "")).toBe(false);
  });
});

describe("AI-tool turn records (R12)", () => {
  const party = { taskId, developerId, provider: "slack" as const, developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", workspaceId: "22222222-2222-4222-8222-222222222222" };

  it("caps long instructions and says the text was cut", () => {
    const record = aiToolTurn({
      party, turnId: "55555555-5555-4555-8555-555555555556", action: "start", phase: "accepted", outcome: "accepted",
      receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.000Z", request: "run the tests. ".repeat(4_000), response: "STARTING",
    });
    expect(record.requestText.length).toBe(40_000);
    expect(record.textTruncated).toBe(true);
  });

});

