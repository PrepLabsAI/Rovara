// tests/contract/outbox-publisher-index.test.ts
// Spec 025 A4: the outbox publisher dispatches as before and indexes after; the index never fails the batch.
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayCoreOutboxStream } from "../../packages/broker/src/aws/core-outbox-stream.js";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { INDEX_SAFETY_MARGIN_MS, createOutboxPublisherHandler, taskUsageWriter } from "../../packages/broker/src/aws/outbox-publisher.js";
import { taskSpent } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const outbox = { eventName: "INSERT", dynamodb: { NewImage: marshall({ pk: "OUTBOX#o1", sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", operationId: "op", workspaceId: "ws" }) } };

describe("the outbox publisher with the index (A4)", () => {

  it.each(["INSERT", "MODIFY"])("L9 excludes core rows on %s while legacy dispatch stays identical", async (eventName) => {
    const company = "org_staging0000000000001";
    const core = { eventSource: "aws:dynamodb", eventName, dynamodb: { SequenceNumber: "17", NewImage: marshall({ pk: `ORG#${company}#OUTBOX#o1`, sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", outboxState: `PENDING#${company}` }) } };
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const index = vi.fn(async () => undefined);
    const publisher = createOutboxPublisherHandler({ send, markQueued, index });
    expect(await publisher({ Records: [core] })).toEqual({ published: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(markQueued).not.toHaveBeenCalled();
    expect(index).toHaveBeenCalledWith([core]);
    const relay = vi.fn(async (companies: readonly string[]) => companies.map((companyId) => ({ companyId, outcome: "ran" as const })));
    expect(await relayCoreOutboxStream({ Records: [core] }, relay)).toEqual({ batchItemFailures: [] });
    expect(relay.mock.calls).toEqual([[eventName === "INSERT" ? [company] : []]]);
    expect(await publisher({ Records: [{ ...outbox, eventName }] })).toEqual({ published: 1 });
    expect(send.mock.calls).toEqual([[{ pk: "OUTBOX#o1", sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", operationId: "op", workspaceId: "ws" }]]);
    expect(markQueued.mock.calls).toEqual([["o1"]]);
  });


  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

});

