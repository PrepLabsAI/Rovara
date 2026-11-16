import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
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
  it("stamps company last and preserves the seven caller attributes", async () => {
    const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
    const queues = new MemoryQueueService(); const outbox = createTransactionalOutbox({ store, queues });
    const attrs = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`a${i}`, "value"]));
    await store.transact([outbox.stage({ companyId: A, id: "same", queue: "shared", body, attributes: attrs })]);
    expect(await outbox.relay({ companyId: A })).toMatchObject({ delivered: 1 });
    const [message] = await (await queues.queue("shared")).receive();
    expect(message?.attributes).toEqual({ ...attrs, outboxId: "same", companyId: A });
  });
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
    expect(lines).toEqual([{ companyId: A, component: "task-flow", event: "task_flow.dispatch_foreign" }]);
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
it("fails closed: unusable consumer releases even malformed messages", async () => {
  const h = createHarness(); h.deps.companyId = ""; const queue = await h.queues.queue("task-dispatch");
  await queue.enqueue({ body: null });
  expect(await runDispatchOnce(h.deps)).toMatchObject({ foreign: 1, dropped: 0 }); h.clock.advance(31);
  expect((await queue.receive())).toHaveLength(1);
});
it("unscoped keys no longer hold two companies' same raw ids", async () => {
  const store = new MemoryDocumentStore();
  for (const company of [A, B]) await store.put({ item: { ...operationKey(company, "shared-workspace", "shared-operation"), marker: company } });
  expect(store.size).toBe(2);
  for (const company of [A, B]) expect((await store.get(operationKey(company, "shared-workspace", "shared-operation")))?.marker).toBe(company);
});
it("legacy unscoped workspace rows belong to the implicit company only", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: "WORKSPACE#shared-workspace", sk: "META", companyId: A } });
  expect((await locateWorkspace({ store, companyId: A }, "shared-workspace"))?.scope).toBe("legacy");
  const get = vi.spyOn(store, "get");
  expect(await locateWorkspace({ store, companyId: B }, "shared-workspace")).toBeUndefined();
  // Its own scoped key, then the id-only discovery key (only to log a dangling pointer of its OWN company); a legacy row is never admitted for B.
  expect(get.mock.calls.map(([key]) => key.pk)).toEqual([`ORG#${B}#WORKSPACE#shared-workspace`, "WORKSPACE#shared-workspace"]);
});

it("a foreign visibility failure never logs the adapter's cause or foreign company", async () => {
  const h = createHarness(); const queue = await h.queues.queue("task-dispatch"); const lines: unknown[] = [];
  h.deps.log = (line) => { lines.push(line); };
  await queue.enqueue({ body: { ...body, companyId: B } });
  const error = new Error(`secret-${B}`); error.name = `secret-${B}`;
  vi.spyOn(queue, "changeVisibility").mockRejectedValue(error);
  h.deps.queues = { queue: async () => queue };
  expect(await runDispatchOnce(h.deps)).toMatchObject({ retried: 1, dropped: 0 });
  expect(lines).toEqual([{ companyId: A, component: "task-flow", event: "task_flow.dispatch_fault", error: "dispatch_failed" }]);
});
