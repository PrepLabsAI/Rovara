// tests/contract/developer-task-notices.test.ts
// Spec 025 C7, C8: the notices the notifier derives from committed changes.
import { randomUUID } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { noticesFromStream, noticesOf, readStream, type StreamRecord } from "../../packages/broker/src/developer/notifications.js";
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
    const closing = noticesFromStream(stream.take());
    expect(closing).toEqual([{ id: `${taskId}:closed`, kind: "closed", taskId, at: closing[0]?.at }]);
    expect(Number.isNaN(Date.parse(String(closing[0]?.at)))).toBe(false);
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

  it("notifies the shared thread when an owner approves the plan or requests changes", () => {
    const taskId = randomUUID();
    const waiting = { entityType: "DEVELOPER_TASK", taskId, workflow: { revision: 2, state: "WAITING", stage: "PLAN_REVIEW" } };
    const approved = { ...waiting, workflow: { revision: 3, state: "RUNNING", stage: "IMPLEMENT" } };
    expect(noticesOf(waiting, approved, "2026-10-05T12:00:00.000Z", "approve")).toEqual([
      { id: `${taskId}:workflow:3`, kind: "workflow", taskId, at: "2026-10-05T12:00:00.000Z" },
    ]);
    expect(noticesOf(waiting, { ...waiting, workflow: { revision: 3, state: "RUNNING", stage: "PLAN" } }, "2026-10-05T12:00:00.000Z", "changes")[0]?.kind).toBe("workflow");
  });

  it("notifies the task thread for a new pending PR feedback plan", () => {
    const taskId = randomUUID();
    const feedbackId = "f".repeat(64);
    const before = { entityType: "DEVELOPER_TASK", taskId, workflow: { revision: 8, state: "WAITING", stage: "WAIT_FOR_MERGE" } };
    const after = { ...before, workflow: { revision: 9, state: "WAITING", stage: "WAIT_FOR_MERGE", feedback: { feedbackId, status: "PENDING" } } };
    expect(noticesOf(before, after, "2026-10-05T12:00:00.000Z", "feedback")).toEqual([
      { id: `${taskId}:github_feedback:${feedbackId}`, kind: "github_feedback", taskId, at: "2026-10-05T12:00:00.000Z" },
    ]);
  });

  it("records no stream event for deleting an item that does not exist", async () => {
    const { db, stream } = await started({});
    stream.take();
    await db.send(new DeleteCommand({ TableName: "state", Key: { pk: "NOTHING#here", sk: "META" } }));
    expect(stream.take()).toEqual([]);
  });

  it("skips a malformed record, keeps the good ones around it, and names what it skipped", () => {
    const task = (taskId: string) => marshall({ entityType: "DEVELOPER_TASK", taskId, share: { mode: "view" } });
    const first = randomUUID();
    const last = randomUUID();
    const records = [
      { eventID: "e1", eventName: "INSERT", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, NewImage: task(first) } },
      { eventID: "e2", eventName: "MODIFY", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, NewImage: { entityType: { S: "DEVELOPER_TASK" }, taskId: {} }, OldImage: { a: { X: "1" } } } },
      { eventID: "e3", eventName: "INSERT", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, NewImage: { a: null } } },
      { eventID: "e4", eventName: "INSERT", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, NewImage: task(last) } },
    ] as unknown as StreamRecord[];
    const read = readStream(records);
    expect(read.notices.map((notice) => notice.id)).toEqual([`${first}:start`, `${last}:start`]);
    expect(read.skipped).toEqual([{ eventID: "e2", eventName: "MODIFY" }, { eventID: "e3", eventName: "INSERT" }]);
    expect(JSON.stringify(read.skipped)).not.toMatch(/Error|expected|convert/i);
    expect(noticesFromStream(records)).toEqual(read.notices);
  });

  it("stamps the notice with the current time when the record's time is not a finite number", () => {
    const record = { eventID: "e1", eventName: "INSERT", dynamodb: { ApproximateCreationDateTime: Number.NaN, NewImage: marshall({ entityType: "DEVELOPER_TASK", taskId: "t1", share: { mode: "view" } }) } };
    const read = readStream([record]);
    expect(read.skipped).toEqual([]);
    expect(Number.isNaN(Date.parse(read.notices[0]!.at))).toBe(false);
  });

  it("stamps the notice with the new image's updatedAt, to the millisecond, else a pointer's cancelledAt, else the stream time (ruling F7)", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: "t1", share: { mode: "view" } };
    const at = (image: Record<string, unknown>) => readStream([{ eventID: "e1", eventName: "INSERT", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, NewImage: marshall(image) } }]).notices[0]?.at;
    expect(at({ ...task, updatedAt: "2026-09-29T10:00:00.123Z" })).toBe("2026-09-29T10:00:00.123Z");
    expect(at({ ...task, updatedAt: "not a time" })).toBe(new Date(1_790_000_000_000).toISOString());
    expect(at(task)).toBe(new Date(1_790_000_000_000).toISOString());
    const pointer = { entityType: "DEVELOPER_TASK_POINTER", taskId: "t1", cancelledAt: "2026-09-29T10:00:00.456Z" };
    expect(readStream([{ eventID: "e2", eventName: "MODIFY", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, OldImage: marshall({ entityType: "DEVELOPER_TASK_POINTER", taskId: "t1" }), NewImage: marshall(pointer) } }]).notices[0]?.at).toBe("2026-09-29T10:00:00.456Z");
  });

  it("gives a setup notice only for a prepare that failed, not one that was cancelled", () => {
    const prepare = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "prepare", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    const after = (status: string) => noticesOf({ ...prepare, status: "RUNNING" }, { ...prepare, status }, "t", "e1").map((notice) => notice.kind);
    expect([after("FAILED"), after("INTERRUPTED"), after("CANCELLED"), after("SUCCEEDED")]).toEqual([["setup_failed"], ["setup_failed"], [], ["ready"]]);
  });

  it("treats a stored NULL close or cancel time as unset", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: "t1" };
    expect(noticesOf({ ...task, closedAt: null }, { ...task, closedAt: "2026-09-29T10:00:00.000Z" }, "t", "e1").map((notice) => notice.kind)).toEqual(["closed"]);
    expect(noticesOf(task, { ...task, closedAt: null }, "t", "e2")).toEqual([]);
    const pointer = { entityType: "DEVELOPER_TASK_POINTER", taskId: "t1" };
    expect(noticesOf({ ...pointer, cancelledAt: null }, { ...pointer, cancelledAt: "2026-09-29T10:00:00.000Z" }, "t", "e3").map((notice) => notice.kind)).toEqual(["cancelled"]);
    expect(noticesOf(pointer, { ...pointer, cancelledAt: null }, "t", "e4")).toEqual([]);
  });

  it("gives no mode notice for a record without an event ID, so two changes cannot collapse into one", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: "t1" };
    expect(noticesOf({ ...task, share: { mode: "view" } }, { ...task, share: { mode: "continue" } }, "t", "")).toEqual([]);
    const record = { eventName: "MODIFY", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, OldImage: marshall({ ...task, share: { mode: "view" } }), NewImage: marshall({ ...task, share: { mode: "continue" } }) } };
    expect(readStream([record]).notices).toEqual([]);
  });
});
