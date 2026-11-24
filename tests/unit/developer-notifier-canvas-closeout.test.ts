// The internal canvas_closeout notice: a closed task that never had a Canvas finishes at once (it must not reach Slack, nor loop to the dead-letter queue); a real closeout that keeps failing is retried, then given up on with a durable record.
import { describe, expect, it, vi } from "vitest";
import { CANVAS_CLOSEOUT_RETRY_WINDOW_MS, createNotifierHandler, type NotifierDependencies } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = "66666666-6666-4666-8666-666666666666";
const CLOSED_AT = "2026-11-20T10:00:00.000Z";
const NOTICE = { id: `${TASK}:canvas_closeout:closed`, kind: "canvas_closeout", taskId: TASK, at: CLOSED_AT };
const AT = Date.parse(CLOSED_AT);
const lineage = (state: string) => ({ key: "plan-1", stage: "PLAN", workflowRevision: 2, artifactId: "a1", artifactRef: "private/x/plan.md", artifactDigest: "d".repeat(64), state, createdAt: CLOSED_AT, ...(state === "CREATED" ? { canvasId: "F0ABCDEFGHI" } : {}) });
const taskRow = (extra: Record<string, unknown> = {}) => ({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: "org_aaaaaaaaaaaaaaaaaaaa", shared: false, closedAt: CLOSED_AT, ...extra });
const SHARE = { channelId: "C0SHARED01", teamId: "T0AAAAAAA", threadTs: "1.1", sharedAt: CLOSED_AT };

function setup(row: Record<string, unknown> | undefined, closeTaskCanvases: NotifierDependencies["closeTaskCanvases"], now = AT + 60_000) {
  const db = new FakeDynamoDb();
  if (row !== undefined) db.set(row);
  const logs: Array<Record<string, unknown>> = [];
  const retryLater = vi.fn(async () => undefined);
  const deliveryFailed = vi.fn();
  const post = vi.fn(async () => ({ ts: "1.2" }));
  const clock = { now };
  const handler = createNotifierHandler({ documentClient: db, tableName: "state", enqueue: vi.fn(async () => undefined), retryLater, post,
    now: () => clock.now, log: (entry) => logs.push(entry), deliveryFailed, ...(closeTaskCanvases === undefined ? {} : { closeTaskCanvases }) });
  const deliver = (attempt = "1") => handler({ Records: [{ eventSource: "aws:sqs", messageId: "m1", receiptHandle: "r1", body: JSON.stringify(NOTICE), attributes: { ApproximateReceiveCount: attempt } }] });
  return { db, logs, retryLater, deliveryFailed, post, clock, deliver };
}
const failureRecord = (db: FakeDynamoDb) => db.get(`DEVTASK#${TASK}`, `NOTICE_FAILED#${NOTICE.id}`);

describe("canvas_closeout for a task with no Canvas", () => {
  it.each([
    ["no share and no workflow (task_unavailable before)", taskRow()],
    ["no share, a workflow with no Canvas lineage (SlackWorkspaceRefused before)", taskRow({ workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [] } })],
    ["no share, only Canvases Slack refused to create", taskRow({ workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("CREATE_FAILED")] } })],
  ])("finishes as a recorded no-op without calling the closeout or Slack: %s", async (_name, row) => {
    const close = vi.fn(async () => { throw new Error("must not run"); });
    const t = setup(row, close);
    expect(await t.deliver()).toEqual({ batchItemFailures: [] });
    expect(close).not.toHaveBeenCalled();
    expect(t.post).not.toHaveBeenCalled();
    expect(t.retryLater).not.toHaveBeenCalled();
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", kind: "canvas_closeout", outcome: "recorded" }));
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.canvas_closeout_no_canvases" }));
    expect(failureRecord(t.db)).toBeUndefined();
  });

  it("still runs the closeout for an unshared task that has a Canvas Slack created", async () => {
    const close = vi.fn(async () => ({ status: "COMPLETE" as const }));
    const t = setup(taskRow({ workflow: { revision: 1, stage: "CLOSED", state: "COMPLETE", artifacts: [], canvasLineage: [lineage("CREATED")] } }), close);
    expect(await t.deliver()).toEqual({ batchItemFailures: [] });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("canvas_closeout is never skipped when a Canvas may exist (reviewer-added)", () => {
  it.each([
    ["unshared, Canvas creation PREPARED", taskRow({ workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("PREPARED")] } })],
    ["unshared, Canvas creation outcome unknown", taskRow({ workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("CREATE_OUTCOME_UNKNOWN")] } })],
    ["unshared, one CREATE_FAILED plus one CREATED", taskRow({ workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("CREATE_FAILED"), { ...lineage("CREATED"), key: "plan-2" }] } })],
    ["shared (team known), no lineage yet", taskRow({ share: SHARE, workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [] } })],
    ["shared (team known), CREATE_FAILED only", taskRow({ share: SHARE, workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("CREATE_FAILED")] } })],
    ["share without a team id but a CREATED Canvas", taskRow({ share: { channelId: "C0SHARED01", threadTs: "1.1", sharedAt: CLOSED_AT }, workflow: { revision: 1, stage: "PLAN", state: "WAIT", artifacts: [], canvasLineage: [lineage("CREATED")] } })],
  ])("runs the closeout service: %s", async (_name, row) => {
    const close = vi.fn(async () => ({ status: "COMPLETE" as const }));
    const t = setup(row, close);
    await t.deliver();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("canvas_closeout for a task that has Canvases", () => {
  const shared = taskRow({ share: SHARE, workflow: { revision: 3, stage: "CLOSED", state: "COMPLETE", artifacts: [], canvasLineage: [lineage("CREATED")] } });

  it("archives as before and records the outcome", async () => {
    const close = vi.fn(async () => ({ status: "COMPLETE" as const }));
    const t = setup(shared, close);
    expect(await t.deliver()).toEqual({ batchItemFailures: [] });
    expect(close).toHaveBeenCalledExactlyOnceWith(TASK, undefined, undefined);
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", outcome: "recorded" }));
  });

  it("retries a closeout that keeps failing, with the pending reason, inside the bound", async () => {
    const close = vi.fn(async () => ({ status: "ARCHIVE_PENDING" as const, reason: "canvas_not_found" }));
    for (const elapsed of [60_000, CANVAS_CLOSEOUT_RETRY_WINDOW_MS - 1]) {
      const t = setup(shared, close, AT + elapsed);
      expect(await t.deliver("7")).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(t.retryLater).toHaveBeenCalledWith("r1", 900);
      expect(t.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", kind: "canvas_closeout", reason: "canvas_not_found" }));
      expect(failureRecord(t.db)).toBeUndefined();
      expect(t.deliveryFailed).not.toHaveBeenCalled();
    }
  });

  it("gives up after the bound: the message is released (no dead letter) and a durable failure record is written", async () => {
    const close = vi.fn(async () => ({ status: "ARCHIVE_PENDING" as const, reason: "canvas_not_found" }));
    const t = setup(shared, close, AT + CANVAS_CLOSEOUT_RETRY_WINDOW_MS + 1);
    expect(await t.deliver("40")).toEqual({ batchItemFailures: [] });
    expect(t.retryLater).not.toHaveBeenCalled();
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.delivery_abandoned", kind: "canvas_closeout", reason: "canvas_not_found" }));
    expect(failureRecord(t.db)).toMatchObject({ kind: "canvas_closeout", noticeId: NOTICE.id, reason: "canvas_not_found" });
    expect(failureRecord(t.db)?.abandonedAt).toBeTypeOf("string");
    expect(t.deliveryFailed).toHaveBeenCalledTimes(1);
  });

  it("the task_unavailable path (the task record is gone) retries, then stops at the bound with the record", async () => {
    const close = vi.fn(async () => ({ status: "ARCHIVE_PENDING" as const, reason: "task_unavailable" }));
    const early = setup(undefined, close);
    expect(await early.deliver()).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(early.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", reason: "Error" }));
    const late = setup(undefined, close, AT + CANVAS_CLOSEOUT_RETRY_WINDOW_MS + 1);
    expect(await late.deliver()).toEqual({ batchItemFailures: [] });
    expect(failureRecord(late.db)).toMatchObject({ kind: "canvas_closeout" });
    expect(failureRecord(late.db)?.abandonedAt).toBeTypeOf("string");

    const withWorkflow = setup(shared, close);
    expect(await withWorkflow.deliver()).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(withWorkflow.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.retry", reason: "task_unavailable" }));
  });
});
