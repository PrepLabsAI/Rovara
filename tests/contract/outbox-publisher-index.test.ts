// tests/contract/outbox-publisher-index.test.ts
// Spec 025 A4: the outbox publisher dispatches as before and indexes after; the index never fails the batch.
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { INDEX_SAFETY_MARGIN_MS, createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";

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
