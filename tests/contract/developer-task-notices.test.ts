// tests/contract/developer-task-notices.test.ts
// Spec 025 C7, C8: the notices the notifier derives from committed changes.
import { randomUUID } from "node:crypto";
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
    expect(closing).toEqual([
      { id: `${taskId}:closed`, kind: "closed", taskId, at: closing[0]?.at },
      { id: `${taskId}:canvas_closeout:closed`, kind: "canvas_closeout", taskId, at: closing[1]?.at },
    ]);
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

  it("announces a failed PR feedback review once, by its report, so the owner can retry it", () => {
    const taskId = randomUUID();
    const at = "2026-10-10T12:00:00.000Z";
    const digest = "9".repeat(64);
    const running = { entityType: "DEVELOPER_TASK", taskId, workflow: { revision: 4, stage: "WAIT_FOR_MERGE", state: "RUNNING", feedbackReview: { status: "COLLECTING", bundleRefs: [] } } };
    const failed = { ...running, workflow: { revision: 5, stage: "WAIT_FOR_MERGE", state: "WAITING",
      feedbackReview: { status: "PENDING", bundleRefs: [], reviewRef: { status: "FAILED", sha256: digest, blockReason: "reviewer output: not valid JSON" } } } };
    expect(noticesOf(running, failed, at, "e1")).toEqual([{ id: `${taskId}:feedback_review:${digest}:5`, kind: "github_feedback", taskId, at, feedbackReviewDigest: digest }]);
    // A later change that keeps the same failed report is an ordinary step change, not the failure said again.
    expect(noticesOf(failed, { ...failed, workflow: { ...failed.workflow, revision: 6 } }, at, "e2").map((notice) => notice.kind)).toEqual(["workflow"]);
  });

  it("creates closeout work only when a task reaches a terminal workflow or explicit close", () => {
    const taskId = randomUUID();
    const waiting = { entityType: "DEVELOPER_TASK", taskId, workflow: { revision: 2, stage: "WAIT_FOR_MERGE", state: "WAITING" } };
    const merged = { ...waiting, workflow: { revision: 3, stage: "MERGED", state: "COMPLETE", outcome: "MERGED" } };
    expect(noticesOf(waiting, merged, "2026-10-05T12:00:00.000Z", "merge")).toContainEqual({
      id: `${taskId}:canvas_closeout:3`, kind: "canvas_closeout", taskId, at: "2026-10-05T12:00:00.000Z",
    });
    expect(noticesOf(waiting, waiting, "2026-10-05T12:00:00.000Z", "retry")).not.toContainEqual(expect.objectContaining({ kind: "canvas_closeout" }));
    expect(noticesOf({ ...waiting, closedAt: null }, { ...waiting, closedAt: "2026-10-05T12:01:00.000Z" }, "2026-10-05T12:01:00.000Z", "close"))
      .toContainEqual(expect.objectContaining({ id: `${taskId}:canvas_closeout:closed`, kind: "canvas_closeout", taskId }));
  });

  it("re-emits owner closeout retries even when the request ID is reused", () => {
    const taskId = randomUUID();
    const before = { entityType: "DEVELOPER_TASK", taskId,
      canvasCloseoutRetry: { requestId: "same-request", workflowRevision: 4, manifestDigest: "a".repeat(64), dispatchAttempt: 1 } };
    const after = { ...before, canvasCloseoutRetry: { ...before.canvasCloseoutRetry, dispatchAttempt: 2 } };
    expect(noticesOf(before, after, "2026-10-05T12:02:00.000Z", "retry-again")).toEqual([{
      id: `${taskId}:canvas_closeout_retry:same-request:2`, kind: "canvas_closeout", taskId, at: "2026-10-05T12:02:00.000Z",
      expectedWorkflowRevision: 4,
      manifestDigest: "a".repeat(64),
    }]);
  });

  it("dispatches a preparation retry with its workflow revision before a manifest exists", () => {
    const taskId = randomUUID();
    const before = { entityType: "DEVELOPER_TASK", taskId };
    const after = { ...before, canvasCloseoutRetry: { requestId: "prepare-retry", workflowRevision: 9, actorId: "owner",
      requestedAt: "2026-10-05T12:03:00.000Z", dispatchAttempt: 1 } };
    expect(noticesOf(before, after, "2026-10-05T12:03:00.000Z", "retry")).toEqual([{
      id: `${taskId}:canvas_closeout_retry:prepare-retry:1`, kind: "canvas_closeout", taskId, at: "2026-10-05T12:03:00.000Z",
      expectedWorkflowRevision: 9,
    }]);
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

  it("gives a setup notice only for a prepare that failed, not one that was cancelled", () => {
    const prepare = { entityType: "OPERATION", id: randomUUID(), workspaceId: randomUUID(), kind: "prepare", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } };
    const after = (status: string) => noticesOf({ ...prepare, status: "RUNNING" }, { ...prepare, status }, "t", "e1").map((notice) => notice.kind);
    expect([after("FAILED"), after("INTERRUPTED"), after("CANCELLED"), after("SUCCEEDED")]).toEqual([["setup_failed"], ["setup_failed"], [], ["ready"]]);
  });

  it("gives no mode notice for a record without an event ID, so two changes cannot collapse into one", () => {
    const task = { entityType: "DEVELOPER_TASK", taskId: "t1" };
    expect(noticesOf({ ...task, share: { mode: "view" } }, { ...task, share: { mode: "continue" } }, "t", "")).toEqual([]);
    const record = { eventName: "MODIFY", dynamodb: { ApproximateCreationDateTime: 1_790_000_000, OldImage: marshall({ ...task, share: { mode: "view" } }), NewImage: marshall({ ...task, share: { mode: "continue" } }) } };
    expect(readStream([record]).notices).toEqual([]);
  });

  it("a new nudge window makes one notice; the same window makes none", () => {
    const at = "2026-10-11T10:00:00.000Z";
    const window = { pk: "DEVTASK#t1", sk: "NUDGE#lee", entityType: "TASK_COMMENT_NUDGE", taskId: "t1", developerId: "lee", name: "Lee", windowStart: at, nudgeId: "c1", dueAt: "2026-10-11T10:10:00.000Z" };
    expect(noticesOf(undefined, window, at, "e1")).toEqual([{ id: "t1:nudge:c1", kind: "comment_nudge", taskId: "t1", at, notBefore: "2026-10-11T10:10:00.000Z" }]);
    // The same window written again (a later comment inside it is not a write, but a repeat could be) says nothing.
    expect(noticesOf(window, { ...window }, at, "e2")).toEqual([]);
    const next = { ...window, windowStart: "2026-10-11T10:20:00.000Z", nudgeId: "c9", dueAt: "2026-10-11T10:30:00.000Z" };
    // Stamped with the window's start.
    expect(noticesOf(window, next, "2026-10-11T10:21:00.000Z", "e3").map((notice) => [notice.id, notice.at])).toEqual([["t1:nudge:c9", "2026-10-11T10:20:00.000Z"]]);
    // A window with no task or due time is not a notice.
    expect(noticesOf(undefined, { ...window, dueAt: undefined }, at, "e4")).toEqual([]);
  });
});
