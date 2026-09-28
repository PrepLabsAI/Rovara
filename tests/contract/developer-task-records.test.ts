import { describe, expect, it } from "vitest";
import { AiToolTurnRecordSchema } from "../../packages/contracts/src/index.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  aiToolTurn,
  deriveTaskStatus,
  developerFooter,
  failureCategory,
  partyOfTask,
  recentTaskEvents,
  taskOwnerKey,
  type DeveloperTaskRecord,
  type OperationFacts,
  type StoredEvent,
} from "../../packages/broker/src/developer/task-records.js";

const developerId = "d".repeat(64);
const taskId = "44444444-4444-4444-8444-444444444444";
const op = (kind: string, status: string, createdAt: string, error?: string): OperationFacts => ({
  id: `${kind}-${createdAt}`, kind, status, createdAt, ...(error === undefined ? {} : { error }),
});
const PLANTED = "xoxb-1111111111-planted-secret";

describe("the task's owner key (FR-017)", () => {
  it("is ownerKeyForSubject over agentx-developer-task and developer/task", () => {
    expect(taskOwnerKey(developerId, taskId)).toBe(ownerKeyForSubject("agentx-developer-task", `${developerId}/${taskId}`));
    expect(taskOwnerKey(developerId, taskId)).not.toBe(taskOwnerKey(developerId, "55555555-5555-4555-8555-555555555555"));
  });
});

describe("task status (R4, FR-025)", () => {
  it.each([
    ["the instructions are waiting", { workspaceStatus: "PREPARING", pointer: { pendingPrompt: "x" }, operations: [op("prepare", "RUNNING", "t1")] }, "STARTING"],
    ["cancelled before it ran", { workspaceStatus: "PREPARING", pointer: { cancelledAt: "t2" }, operations: [op("prepare", "RUNNING", "t1")] }, "CANCELLED"],
    ["a running task", { workspaceStatus: "BUSY", pointer: {}, operations: [op("prepare", "SUCCEEDED", "t1"), op("task", "RUNNING", "t2")] }, "RUNNING"],
    ["a finished task", { workspaceStatus: "READY", pointer: {}, operations: [op("prepare", "SUCCEEDED", "t1"), op("task", "SUCCEEDED", "t2")] }, "SUCCEEDED"],
    ["a publish after it", { workspaceStatus: "BUSY", pointer: {}, operations: [op("task", "SUCCEEDED", "t2"), op("publish", "DISPATCHING", "t3")] }, "RUNNING"],
    ["a cancel operation does not count", { workspaceStatus: "READY", pointer: {}, operations: [op("task", "CANCELLED", "t2"), op("cancel", "SUCCEEDED", "t3")] }, "CANCELLED"],
    ["closed", { closedAt: "t9", workspaceStatus: "CLOSED", pointer: {}, operations: [op("task", "SUCCEEDED", "t2")] }, "CLOSED"],
  ] as const)("%s", (_name, input, status) => {
    expect(deriveTaskStatus(input).status).toBe(status);
  });

  it("gives a failed prepare setup_failed, with the redacted, capped error", () => {
    const derived = deriveTaskStatus({ workspaceStatus: "PREPARATION_FAILED", pointer: { pendingPrompt: "x" }, operations: [op("prepare", "FAILED", "t1", `clone failed ${PLANTED} ${"e".repeat(2_000)}`)] });
    expect(derived.status).toBe("FAILED");
    expect(derived.failure?.category).toBe("setup_failed");
    expect(derived.failure?.message).not.toContain(PLANTED);
    expect(derived.failure?.message.length).toBeLessThanOrEqual(1_000);
  });

  it("marks a close in progress without changing the status", () => {
    const derived = deriveTaskStatus({ workspaceStatus: "CLOSING", pointer: {}, operations: [op("task", "SUCCEEDED", "t2"), op("close", "RUNNING", "t3")] });
    expect(derived).toMatchObject({ status: "SUCCEEDED", closing: true });
  });
});

describe("failure categories (R5)", () => {
  it.each([
    ["task", "INTERRUPTED", undefined, "interrupted"],
    ["prepare", "FAILED", "RUNTIME_UNAVAILABLE: worker dispatch failed after 5 attempts (Error)", "worker_unavailable"],
    ["task", "FAILED", "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request", "worker_unavailable"],
    ["prepare", "FAILED", "npm ci exited 1", "setup_failed"],
    ["publish", "FAILED", "push rejected", "publication_failed"],
    ["task", "FAILED", "the task timed out after 30 minutes", "timed_out"],
    // F18: the worker's devcontainer writes this exact form (packages/worker/src/devcontainer.ts).
    ["task", "FAILED", "timeout:1800000", "timed_out"],
    ["task", "FAILED", "the model call failed: overloaded", "task_failed"],
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

  it("returns the newest ones when there are more than asked for, and caps each at 300 characters", () => {
    const newestFirst = Array.from({ length: 30 }, (_, index) => event(30 - index, "progress", { message: `step ${30 - index} ${"x".repeat(400)}` }));
    const events = recentTaskEvents(newestFirst, 3);
    expect(events.map((entry) => entry.text.split(" ").slice(0, 2).join(" "))).toEqual(["step 28", "step 29", "step 30"]);
    expect(events.every((entry) => entry.text.length <= 300)).toBe(true);
  });
});

describe("AI-tool turn records (R12)", () => {
  const party = { taskId, developerId, provider: "slack" as const, developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code", workspaceId: "22222222-2222-4222-8222-222222222222" };

  it("builds a valid record with its keys, redacting the request", () => {
    const record = aiToolTurn({
      party, turnId: "55555555-5555-4555-8555-555555555555", action: "start", phase: "accepted", outcome: "accepted",
      receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.250Z", request: `use ${PLANTED}`, response: "STARTING",
    });
    expect(record).toMatchObject({ pk: `TASK#${taskId}`, exportPk: "TURNS", durationMs: 250 });
    expect(JSON.stringify(record)).not.toContain(PLANTED);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the storage keys are dropped to check the stored fields
    const { pk, sk, exportPk, exportSk, expiresAt, ...stored } = record;
    expect(AiToolTurnRecordSchema.safeParse(stored).success).toBe(true);
  });

  it("caps long instructions and says the text was cut", () => {
    const record = aiToolTurn({
      party, turnId: "55555555-5555-4555-8555-555555555556", action: "start", phase: "accepted", outcome: "accepted",
      receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.000Z", request: "run the tests. ".repeat(4_000), response: "STARTING",
    });
    expect(record.requestText.length).toBe(40_000);
    expect(record.textTruncated).toBe(true);
  });

  it("never collides the accepted, completed and refused records of one action (carried-forward review requirement)", () => {
    const base = { party, action: "start" as const, receivedAt: "2026-09-27T12:00:00.000Z", finishedAt: "2026-09-27T12:00:00.100Z", request: "do it", response: "ok" };
    const accepted = aiToolTurn({ ...base, turnId: "66666666-6666-4666-8666-666666666601", phase: "accepted", outcome: "accepted" });
    const completed = aiToolTurn({ ...base, turnId: "66666666-6666-4666-8666-666666666602", phase: "completed", outcome: "succeeded" });
    const refused = aiToolTurn({ ...base, turnId: "66666666-6666-4666-8666-666666666603", phase: "refused", outcome: "refused" });
    const keys = [accepted, completed, refused].map((record) => `${String(record.pk)}/${String(record.sk)}`);
    expect(new Set(keys).size).toBe(3);
    expect(accepted.pk).toBe(completed.pk);
    expect(accepted.pk).toBe(refused.pk);
  });
});

describe("the turn record's party, from a task record (F8)", () => {
  it("carries every field a turn record needs, so Task 11 does not repeat the literal", () => {
    const task: DeveloperTaskRecord = {
      pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId,
      provider: "slack", developerName: "Maya Chen", slackUserId: "U0MAYA001", client: "Claude Code",
      project: "payments", title: "Fix the flaky retry test", workspaceId: "22222222-2222-4222-8222-222222222222",
      ownerKey: taskOwnerKey(developerId, taskId), conversationId: "33333333-3333-4333-8333-333333333333",
      startingRevision: 3, charge: { member: { pk: "a", sk: "b" }, organization: { pk: "c", sk: "d" } },
      shared: false, createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z",
    };
    expect(partyOfTask(task)).toEqual({
      taskId, developerId, provider: "slack", developerName: "Maya Chen", slackUserId: "U0MAYA001",
      client: "Claude Code", workspaceId: "22222222-2222-4222-8222-222222222222", settingsRevision: 3,
    });
  });
});

describe("the PR footer (FR-023, R14)", () => {
  it("names the developer inertly and the client", () => {
    expect(developerFooter("Maya @here Chen", "Claude Code")).toBe("Requested by `Maya @here Chen` via AgentX, started from Claude Code");
  });
});
