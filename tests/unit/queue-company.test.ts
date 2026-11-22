import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, OUTBOX_PENDING_INDEX, companyScoped, type QueueService } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { pendingOutboxRow } from "../../packages/aws-adapters/src/sqs/outbox-relay.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { createHarness } from "../support/task-flow-harness.js";
import { sqsWorld } from "../support/ports/sqs-harness.js";
const A = IMPLICIT_COMPANY_ID, B = `org_${"b".repeat(20)}`;
const body = { v: 1, workspaceId: "shared-workspace", operationId: "shared-operation" };

describe("outbox company attributes", () => {
  it("refuses reserved attributes and too many before staging", () => {
    const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
    const outbox = createTransactionalOutbox({ store, queues: new MemoryQueueService() });
    for (const attributes of [{ companyId: B }, { outboxId: "canary" }, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, "canary"]))]) {
      expect(() => outbox.stage({ companyId: A, id: "same", queue: "shared", body, attributes })).toThrow("invalid outbox attributes");
    }
    expect(store.size).toBe(0);
  });
  it("the install-wide hook refuses ambiguous key/image ownership", () => {
    expect(pendingOutboxRow({ sequence: "1", cause: "write", kind: "insert", key: { pk: companyScoped(A, "OUTBOX#same"), sk: "OUTBOX" }, after: { pk: companyScoped(A, "OUTBOX#same"), sk: "OUTBOX", companyId: B, id: "same", entityType: "OUTBOX", status: "PENDING" } })).toBeUndefined();
  });
});

for (const backend of ["memory", "sqs"] as const) describe(`dispatch ownership on ${backend}`, () => {
  function world() {
    const sqs = sqsWorld({ order: "oldest-first" }); const clock = { now: 0 };
    const queues: QueueService = backend === "sqs" ? sqs.provisioning(false) : new MemoryQueueService({ now: () => clock.now });
    const h = createHarness(); h.deps.queues = queues;
    const advance = () => { clock.now += 31_000; sqs.fake.advance(31); };
    return { h, queues, advance };
  }
  it.each([B, "bad-canary", "", null, 42])("foreign/invalid body company %s never reads, acks or kills", async (companyId) => {
    const { h, queues, advance } = world(); const queue = await queues.queue("task-dispatch");
    const lines: unknown[] = []; h.deps.log = (line) => { lines.push(line); };
    const read = vi.spyOn(h.store, "get");
    await queue.enqueue({ body: { ...body, companyId } });
    expect(await runDispatchOnce(h.deps)).toMatchObject({ received: 1, foreign: 1, dropped: 0, failed: 0 });
    expect(read).not.toHaveBeenCalled(); advance();
    const [still] = await queue.receive(); expect(still?.receiveCount).toBe(2); expect(still?.body).toEqual({ ...body, companyId });
    expect(lines).toEqual([{ companyId: A, component: "task-flow", event: "task_flow.dispatch_foreign" }, { companyId: A, component: "task-flow", event: "task_flow.dispatch_delivery", operationId: null, attempt: null, stateAtReceipt: "unread", decision: "defer-foreign", messageId: still!.messageId, receiveCount: 1 }]);
  });
  it("refuses disagreeing attribute and body", async () => {
    const { h, queues } = world(); const read = vi.spyOn(h.store, "get");
    await (await queues.queue("task-dispatch")).enqueue({ body: { ...body, companyId: A }, attributes: { companyId: B } });
    expect(await runDispatchOnce(h.deps)).toMatchObject({ foreign: 1 }); expect(read).not.toHaveBeenCalled();
  });
  it.each([undefined, A])("accepts our company and old absent company %s", async (companyId) => {
    const { h, queues } = world();
    await h.store.put({ item: { pk: "WORKSPACE#shared-workspace", sk: "OPERATION#shared-operation", companyId: A, status: "SUCCEEDED" } });
    await (await queues.queue("task-dispatch")).enqueue({ body: { ...body, ...(companyId === undefined ? {} : { companyId }) } });
    expect(await runDispatchOnce(h.deps)).toMatchObject({ dropped: 1, foreign: 0 });
  });
  it("fails closed: unusable consumer company releases everything", async () => {
    for (const company of ["", "bad", undefined]) {
      const { h, queues } = world(); h.deps.companyId = company as string;
      await (await queues.queue("task-dispatch")).enqueue({ body: { ...body, companyId: A } });
      const read = vi.spyOn(h.store, "get");
      expect(await runDispatchOnce(h.deps)).toMatchObject({ foreign: 1 }); expect(read).not.toHaveBeenCalled();
    }
  });
});
it("known gap: shared queue needs one reader that serves every company", async () => {
  const sqs = sqsWorld({ order: "oldest-first" }); const queues = sqs.provisioning(false);
  const queue = await queues.queue("task-dispatch", { maxReceiveCount: 2 });
  await queue.enqueue({ body: { ...body, companyId: B } });
  const h = createHarness(); h.deps.queues = queues;
  for (let i = 0; i < 2; i++) { expect(await runDispatchOnce(h.deps)).toMatchObject({ foreign: 1 }); sqs.fake.advance(31); }
  expect((await queue.receive())).toEqual([]);
});
it("outbox relay refuses a corrupt row whose key and company disagree", async () => {
  const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] }); const queues = new MemoryQueueService();
  const outbox = createTransactionalOutbox({ store, queues });
  const staged = outbox.stage({ companyId: A, id: "same", queue: "shared", body });
  if (staged.kind !== "put") throw new Error("not put");
  await store.put({ item: { ...staged.item, companyId: B } });
  expect(await outbox.relay({ companyId: A })).toEqual({ delivered: 0, failed: 1, dead: 0 });
  expect(await (await queues.queue("shared")).receive()).toEqual([]);
});

it("a foreign visibility failure never logs the adapter's cause or foreign company", async () => {
  const h = createHarness(); const queue = await h.queues.queue("task-dispatch"); const lines: unknown[] = [];
  h.deps.log = (line) => { lines.push(line); };
  const sent = await queue.enqueue({ body: { ...body, companyId: B } });
  const error = new Error(`secret-${B}`); error.name = `secret-${B}`;
  vi.spyOn(queue, "changeVisibility").mockRejectedValue(error);
  h.deps.queues = { queue: async () => queue };
  expect(await runDispatchOnce(h.deps)).toMatchObject({ retried: 1, dropped: 0 });
  expect(lines).toEqual([{ companyId: A, component: "task-flow", event: "task_flow.dispatch_fault", error: "dispatch_failed" }, { companyId: A, component: "task-flow", event: "task_flow.dispatch_delivery", operationId: null, attempt: null, stateAtReceipt: "unread", decision: "defer-foreign", messageId: sent.messageId, receiveCount: 1 }]);
});
