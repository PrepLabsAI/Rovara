// tests/contract/developer-task-notices.test.ts
// Spec 025 C7, C8: the notices the notifier derives from committed changes.
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { noticesFromStream, noticesOf } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

async function started(body: Record<string, unknown> = { shareToChannel: true }) {
  const harness = await createDeveloperTaskBroker();
  const stream = recordStream(harness.db);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { ...harness, stream, taskId, workspaceId: task.workspaceId, prepareId, active };
}
const kinds = (records: Parameters<typeof noticesFromStream>[0]) => noticesFromStream(records).map((notice) => notice.kind);

describe("notices from the stream (C7, C8)", () => {
  it("announces a shared start, then the workspace, then the task's end", async () => {
    const { stream, finish, workspaceId, prepareId, active, taskId } = await started();
    const start = noticesFromStream(stream.take());
    expect(start).toEqual([expect.objectContaining({ id: `${taskId}:start`, kind: "start", taskId })]);
    await finish(workspaceId, prepareId, "SUCCEEDED");
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ id: `${prepareId}:ready`, kind: "ready", workspaceId, operationId: prepareId })]);
    const taskOperation = active();
    await finish(workspaceId, taskOperation, "SUCCEEDED");
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ id: `${taskOperation}:ended`, kind: "ended" })]);
  });

  it("gives a failed setup its own notice", async () => {
    const { stream, finish, workspaceId, prepareId } = await started();
    stream.take();
    await finish(workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(kinds(stream.take())).toEqual(["setup_failed"]);
  });

  it("announces a cancel before the instructions ran, a mode change and a close", async () => {
    const { stream, dev, taskId, finish, workspaceId, prepareId } = await started();
    stream.take();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(kinds(stream.take())).toEqual(["cancelled"]);
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "continue" });
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ kind: "mode", mode: "continue", taskId })]);
    await finish(workspaceId, prepareId, "FAILED", { error: "stopped" });
    stream.take();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(kinds(stream.take())).toContain("closed");
  });

  it("derives the same notices for a private task, which the notifier then drops, and none for a Slack thread", async () => {
    const { stream, finish, workspaceId, prepareId, handler } = await started({});
    expect(kinds(stream.take())).toEqual([]);
    await finish(workspaceId, prepareId, "SUCCEEDED");
    expect(kinds(stream.take())).toEqual(["ready"]);
    const thread = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`, "U0PRATIK01");
    await finish(String(thread.body.workspaceId), String(thread.body.operationId), "SUCCEEDED");
    expect(kinds(stream.take())).toEqual([]);
  });

  it("ignores a change to an operation that had already ended, and a teammate's operation", () => {
    const ended = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "task", status: "SUCCEEDED", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    expect(noticesOf({ ...ended, updatedAt: "a" }, { ...ended, updatedAt: "b" }, "2026-09-29T10:00:00.000Z", "e1")).toEqual([]);
    const teammate = { ...ended, status: "SUCCEEDED", requestedBy: { teamId: SLACK_TEAM, userId: "U0PRIYA001" } };
    expect(noticesOf({ ...teammate, status: "RUNNING" }, teammate, "2026-09-29T10:00:00.000Z", "e2")).toEqual([]);
  });

  it("links a successful publish, and reports a failed one as an ended operation", () => {
    const publish = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "publish", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    expect(noticesOf({ ...publish, status: "RUNNING" }, { ...publish, status: "SUCCEEDED" }, "t", "e3").map((notice) => notice.kind)).toEqual(["pull_request"]);
    expect(noticesOf({ ...publish, status: "RUNNING" }, { ...publish, status: "FAILED" }, "t", "e4").map((notice) => notice.kind)).toEqual(["ended"]);
  });

  it("names each mode change by its stream event, so two changes are two notices", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: randomUUID() };
    const view = { ...task, share: { mode: "view" } };
    const open = { ...task, share: { mode: "continue" } };
    const first = noticesOf(view, open, "t", "e5");
    const second = noticesOf(open, view, "t", "e6");
    expect([first[0]!.id, second[0]!.id]).toEqual([`${task.taskId}:mode:e5`, `${task.taskId}:mode:e6`]);
  });

  it("records no stream event for deleting an item that does not exist", async () => {
    const { db, stream } = await started({});
    stream.take();
    await db.send(new DeleteCommand({ TableName: "state", Key: { pk: "NOTHING#here", sk: "META" } }));
    expect(stream.take()).toEqual([]);
  });
});
