// Spec 025 E20 (25c's C22): a close's outcome gets its completed audit record.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
