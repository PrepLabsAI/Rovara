// tests/contract/outbox-publisher-index.test.ts
// Spec 025 A4: the outbox publisher dispatches as before and indexes after; the index never fails the batch.
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { INDEX_SAFETY_MARGIN_MS, createOutboxPublisherHandler, taskUsageWriter } from "../../packages/broker/src/aws/outbox-publisher.js";
import { taskSpent } from "../../packages/broker/src/developer/task-records.js";
import { backfillTaskSpend } from "../../scripts/backfill-task-spend.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const outbox = { eventName: "INSERT", dynamodb: { NewImage: marshall({ pk: "OUTBOX#o1", sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", operationId: "op", workspaceId: "ws" }) } };

describe("the outbox publisher with the index (A4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hands every record of the batch to the index after dispatching", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const index = vi.fn(async () => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued, index });
    expect(await handler({ Records: [outbox] })).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenCalledWith([outbox]);
  });

  it("dispatches the batch even when the index write throws", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued, index: async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); } });
    expect(await handler({ Records: [outbox] })).toEqual({ published: 1 });
    expect(markQueued).toHaveBeenCalledWith("o1");
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: "ThrottlingException" }));
    log.mockRestore();
  });

  it("gives the index a deadline from the Lambda's remaining time, less a safety margin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-30T08:00:00.000Z"));
    const index = vi.fn(async () => undefined);
    const handler = createOutboxPublisherHandler({ send: vi.fn(async () => undefined), markQueued: vi.fn(async () => undefined), index });
    await handler({ Records: [outbox] }, { getRemainingTimeInMillis: () => 20_000 });
    expect(index).toHaveBeenCalledWith([outbox], { deadline: Date.parse("2026-09-30T08:00:15.000Z") });
  });

  // A4, D29: a hung store call must not run the publisher past its timeout, or Lambda retries the
  // batch and its PENDING outbox images are dispatched again.
  it("returns before its timeout, having dispatched once, when an index store call never answers", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const failed = { eventName: "MODIFY", dynamodb: {
      OldImage: marshall({ pk: "WORKSPACE#ws", sk: "OPERATION#op", entityType: "OPERATION", id: "op", workspaceId: "ws", kind: "task", status: "RUNNING" }),
      NewImage: marshall({ pk: "WORKSPACE#ws", sk: "OPERATION#op", entityType: "OPERATION", id: "op", workspaceId: "ws", kind: "task", status: "FAILED", updatedAt: "2026-09-30T08:00:00.000Z" }),
    } };
    const hung = { get: () => new Promise<undefined>(() => undefined), put: () => new Promise<void>(() => undefined) };
    const handler = createOutboxPublisherHandler({ send, markQueued, index: (records, options) => indexActivity(records, hung, () => undefined, options?.deadline) });
    expect(await handler({ Records: [outbox, failed] }, { getRemainingTimeInMillis: () => INDEX_SAFETY_MARGIN_MS + 50 })).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(markQueued).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("returns by the deadline even when the index itself never settles", async () => {
    const send = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued: vi.fn(async () => undefined), index: () => new Promise(() => undefined) });
    expect(await handler({ Records: [outbox] }, { getRemainingTimeInMillis: () => INDEX_SAFETY_MARGIN_MS + 50 })).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: "TimeoutError" }));
  }, 2_000);
});

describe("a task's spend from its usage records (#651)", () => {
  const TASK = "33333333-3333-4333-8333-333333333333";
  const write = (db: FakeDynamoDb) => taskUsageWriter(db as never, () => "state");

  it("counts each usage record on its task once: a replay counts nothing, an unpriced one counts as unpriced, a missing task gets nothing", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK });
    const add = write(db);
    await add(TASK, "1794704400000_op-1", { at: "2026-11-15T01:10:00.000Z", usd: 1.25, inputTokens: 1_000, outputTokens: 100 });
    await add(TASK, "1794704400000_op-1", { at: "2026-11-15T01:10:00.000Z", usd: 1.25, inputTokens: 1_000, outputTokens: 100 });
    await add(TASK, "1794704520000_op-1", { at: "2026-11-15T01:12:00.000Z", usd: null, inputTokens: 500, outputTokens: 50 });
    await add(TASK, "1794704580000_op-2", { at: "2026-11-15T01:13:00.000Z", usd: 0.5, inputTokens: 2_000, outputTokens: 10 });
    const stored = db.get(`DEVTASK#${TASK}`, "META") as Record<string, never>;
    expect(taskSpent(stored)).toEqual({ usd: 1.75, inputTokens: 3_500, outputTokens: 160, runs: 3, unpricedRuns: 1, updatedAt: "2026-11-15T01:13:00.000Z" });
    expect(db.get(`TASKSPEND#${TASK}`, "1794704400000_op-1")).toMatchObject({ entityType: "TASK_SPEND", taskId: TASK, usd: 1.25 });
    await add("44444444-4444-4444-8444-444444444444", "1794704400000_op-9", { at: "2026-11-15T01:10:00.000Z", usd: 1, inputTokens: 1, outputTokens: 1 });
    expect(db.get("DEVTASK#44444444-4444-4444-8444-444444444444", "META")).toBeUndefined();
    expect(db.get("TASKSPEND#44444444-4444-4444-8444-444444444444", "1794704400000_op-9")).toBeUndefined();
  });

  it("has no spend before the first record, and rounds the dollars once", () => {
    expect(taskSpent({})).toBeUndefined();
    expect(taskSpent({ spentRuns: 0 })).toBeUndefined();
    expect(taskSpent({ spentRuns: 10, spentUsd: 0.1 + 0.2 + 0.7000000000000001, spentInputTokens: 10, spentOutputTokens: 1, spentUpdatedAt: "2026-11-15T01:00:00.000Z" })).toEqual({ usd: 1, inputTokens: 10, outputTokens: 1, runs: 10, unpricedRuns: 0, updatedAt: "2026-11-15T01:00:00.000Z" });
  });
});

describe("the task spend backfill (#651)", () => {
  it("counts the usage index's records on their tasks, skips records without a task, and changes nothing when run again", async () => {
    const TASK = "33333333-3333-4333-8333-333333333333";
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK });
    db.set({ pk: "USAGE#2026-11-15", sk: "2026-11-15T01:10:00.000Z#op-1", taskId: TASK, operationId: "op-1", at: "2026-11-15T01:10:00.000Z", costUsd: 2, inputTokens: 100, outputTokens: 10 });
    db.set({ pk: "USAGE#2026-11-14", sk: "2026-11-14T22:00:00.000Z#op-2", taskId: TASK, operationId: "op-2", at: "2026-11-14T22:00:00.000Z", costUsd: null, inputTokens: 50, outputTokens: 5 });
    db.set({ pk: "USAGE#2026-11-14", sk: "2026-11-14T22:05:00.000Z#op-3", operationId: "op-3", at: "2026-11-14T22:05:00.000Z", costUsd: 1, inputTokens: 1, outputTokens: 1 });
    const now = Date.parse("2026-11-15T02:00:00.000Z");
    expect(await backfillTaskSpend(db as never, "state", { days: 2, now })).toEqual({ records: 3, counted: 2, skipped: 1 });
    await backfillTaskSpend(db as never, "state", { days: 2, now });
    expect(taskSpent(db.get(`DEVTASK#${TASK}`, "META") as Record<string, never>)).toEqual({ usd: 2, inputTokens: 150, outputTokens: 15, runs: 2, unpricedRuns: 1, updatedAt: "2026-11-15T01:10:00.000Z" });
  });
});

