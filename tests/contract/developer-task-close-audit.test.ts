// Spec 025 E20 (25c's C22): a close's outcome gets its completed audit record.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiToolTurnRecordSchema, TURN_EXPORT_PARTITION } from "../../packages/contracts/src/index.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

async function readyTask() {
  const harness = await createDeveloperTaskBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { ...harness, taskId, workspaceId: task.workspaceId, active };
}
const closeRecords = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }, taskId: string) =>
  db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close");

describe("a close's completed record (E20)", () => {
  it("records a close that completes, in the close's own transaction", async () => {
    const { db, dev, finish, taskId, workspaceId } = await readyTask();
    const prepareId = String((db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await finish(workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(closeRecords(db, taskId).map((record) => [record.phase, record.outcome])).toEqual(expect.arrayContaining([["accepted", "accepted"], ["completed", "succeeded"]]));
  });

  it("records a close refused for unpublished work, naming the repositories", async () => {
    const { db, dev, finish, taskId, workspaceId, active } = await readyTask();
    // As 25b's close tests: the prepare, then the first task, end; then the close's preflight runs.
    await finish(workspaceId, active(), "SUCCEEDED");
    await finish(workspaceId, active(), "SUCCEEDED");
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    await finish(workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    const completed = closeRecords(db, taskId).find((record) => record.phase === "completed");
    expect(completed).toMatchObject({ outcome: "refused", responseText: "Not closed: unpublished work in demo (worktree_changes)" });
  });

  it("records a close that completes after its preflight", async () => {
    const { db, dev, finish, taskId, workspaceId, active } = await readyTask();
    await finish(workspaceId, active(), "SUCCEEDED");
    await finish(workspaceId, active(), "SUCCEEDED");
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    await finish(workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(closeRecords(db, taskId).filter((record) => record.phase === "completed")).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
  });

  it("lists both outcomes in the turn export, as valid AI-tool records", async () => {
    const refused = await readyTask();
    await refused.finish(refused.workspaceId, refused.active(), "SUCCEEDED");
    await refused.finish(refused.workspaceId, refused.active(), "SUCCEEDED");
    await refused.dev(MAYA, "POST", `/v1/dev/tasks/${refused.taskId}/close`, { requestId: randomUUID() });
    const preflightId = refused.active();
    await refused.finish(refused.workspaceId, preflightId, "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    const closed = await readyTask();
    await closed.finish(closed.workspaceId, closed.active(), "FAILED", { error: "npm ci exited 1" });
    await closed.dev(MAYA, "POST", `/v1/dev/tasks/${closed.taskId}/close`, { requestId: randomUUID() });
    const completed = [
      ...closeRecords(refused.db, refused.taskId).filter((record) => record.phase === "completed"),
      ...closeRecords(closed.db, closed.taskId).filter((record) => record.phase === "completed"),
    ];
    expect(completed.map((record) => record.outcome)).toEqual(["refused", "succeeded"]);
    expect(completed[0]).toMatchObject({ operationId: preflightId, turnId: preflightId });
    for (const record of completed) {
      expect(record).toMatchObject({ exportPk: TURN_EXPORT_PARTITION, origin: "ai_tool", action: "close", requestText: "close" });
      const { pk, sk, exportPk, exportSk, expiresAt, ...stored } = record;
      expect([pk, sk, exportPk, exportSk, expiresAt].every((value) => value !== undefined)).toBe(true);
      expect(AiToolTurnRecordSchema.safeParse(stored).success).toBe(true);
    }
  });
});

// Task 16 review: a preflight that did not finish, a missing task, and the close's request time.
describe("a close's completed record: the rest of its outcomes (E20)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function preflighting() {
    const harness = await readyTask();
    await harness.finish(harness.workspaceId, harness.active(), "SUCCEEDED");
    await harness.finish(harness.workspaceId, harness.active(), "SUCCEEDED");
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${harness.taskId}/close`, { requestId: randomUUID() });
    return { ...harness, preflightId: harness.active() };
  }

  it.each([["FAILED", "failed"], ["INTERRUPTED", "interrupted"], ["CANCELLED", "cancelled"]] as const)(
    "records a close whose check for unpublished work ended %s",
    async (status, outcome) => {
      const { db, finish, taskId, workspaceId, preflightId } = await preflighting();
      await finish(workspaceId, preflightId, status, { error: "the worker stopped" });
      const completed = closeRecords(db, taskId).filter((record) => record.phase === "completed");
      expect(completed).toEqual([expect.objectContaining({
        outcome, operationId: preflightId, turnId: preflightId, exportPk: TURN_EXPORT_PARTITION,
        responseText: "Not closed: the check for unpublished work did not finish",
      })]);
    },
  );

  it("logs a missing task record for a refused close instead of writing nothing silently", async () => {
    const { db, finish, taskId, workspaceId, preflightId } = await preflighting();
    db.delete(`DEVTASK#${taskId}`, "META");
    const log = vi.spyOn(console, "log");
    await finish(workspaceId, preflightId, "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    const events = log.mock.calls.map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } });
    expect(events).toContainEqual(expect.objectContaining({ event: "developer.task_record_missing", taskId, operationId: preflightId }));
    expect(closeRecords(db, taskId).filter((record) => record.phase === "completed")).toEqual([]);
  });

  it("dates a close that completes from its request, with a key fixed by the close operation", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    const { db, finish, taskId, workspaceId, preflightId } = await preflighting();
    const requested = String((db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${preflightId}`) as { createdAt: string }).createdAt);
    vi.setSystemTime(new Date("2026-09-30T10:05:00.000Z"));
    await finish(workspaceId, preflightId, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    const [completed] = closeRecords(db, taskId).filter((record) => record.phase === "completed");
    expect(completed).toMatchObject({ outcome: "succeeded", receivedAt: requested, sk: `TURN#${requested}#${preflightId}` });
    expect(Date.parse(String(completed!.finishedAt))).toBeGreaterThanOrEqual(Date.parse("2026-09-30T10:05:00.000Z"));
  });

  it("dates a never-started task's close from its request, like its accepted record", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    const { db, dev, finish, taskId, workspaceId, active, deleteEc2Session } = await readyTask();
    await finish(workspaceId, active(), "FAILED", { error: "npm ci exited 1" });
    // The compute's removal takes a minute, so the close finishes well after it was requested.
    deleteEc2Session.mockImplementationOnce(async () => { vi.setSystemTime(new Date("2026-09-30T10:01:00.000Z")); });
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    const accepted = closeRecords(db, taskId).find((record) => record.phase === "accepted");
    const completed = closeRecords(db, taskId).find((record) => record.phase === "completed");
    expect(deleteEc2Session).toHaveBeenCalled();
    expect(completed).toMatchObject({ outcome: "succeeded", receivedAt: accepted!.receivedAt });
    expect(Date.parse(String(completed!.finishedAt))).toBeGreaterThanOrEqual(Date.parse("2026-09-30T10:01:00.000Z"));
  });
});
