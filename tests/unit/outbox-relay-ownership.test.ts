import { describe, expect, it, vi } from "vitest";
import { CORE_BROKER_TIMEOUT_SECONDS, OUTBOX_RELAY_OWNERSHIP_MS, change, OUTBOX_PENDING_INDEX, type QueueService } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { CORE_DISPATCH_VISIBILITY_TIMEOUT } from "../../infra/lib/core-engine.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
const key = { pk: `ORG#${companyId}#OUTBOX#m1`, sk: "OUTBOX" };
function barrier() { let release!: () => void; const wait = new Promise<void>((r) => { release = r; }); return { wait, release }; }
async function setup() {
  let time = Date.parse("2026-11-22T10:00:00Z");
  const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
  const memory = new MemoryQueueService();
  const queue = await memory.queue("dispatch");
  const enqueue = queue.enqueue.bind(queue);
  // Standard SQS ignores dedupeId: count actual messages, not a fake's duplicate suppression.
  queue.enqueue = (message) => { const copy = { ...message }; delete copy.dedupeId; return enqueue(copy); };
  const queues: QueueService = { queue: async () => queue };
  const make = () => createTransactionalOutbox({ store, queues, now: () => new Date(time) });
  const outbox = make();
  await store.transact([outbox.stage({ companyId, id: "m1", queue: "dispatch", body: { v: 1, operationId: "m1" } })]);
  return { store, queue, outbox, make, advance: (seconds: number) => { time += seconds * 1000; } };
}

describe("outbox row ownership", () => {
  it("gives concurrent claims on different pending rows distinct opaque hex owner tokens", async () => {
    const h = await setup();
    const secondKey = { ...key, pk: `ORG#${companyId}#OUTBOX#m2` };
    await h.store.transact([h.outbox.stage({ companyId, id: "m2", queue: "dispatch", body: { v: 1, operationId: "m2" } })]);
    const entered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    let enqueues = 0;
    h.queue.enqueue = async (input) => {
      if (++enqueues === 2) entered.release();
      await finish.wait;
      return enqueue(input);
    };
    const claims = Promise.all([
      h.outbox.relay({ companyId, ids: ["m1"] }),
      h.make().relay({ companyId, ids: ["m2"] }),
    ]);
    try {
      await entered.wait;
      const first = (await h.store.get(key))!;
      const second = (await h.store.get(secondKey))!;
      expect(first.status).toBe("PENDING");
      expect(second.status).toBe("PENDING");
      expect(first.relayOwner).toMatch(/^[0-9a-f]{32}$/);
      expect(second.relayOwner).toMatch(/^[0-9a-f]{32}$/);
      expect(first.relayOwner).not.toBe(second.relayOwner);
    } finally {
      finish.release();
      await claims;
    }
    expect(await claims).toEqual([
      { delivered: 1, failed: 0, dead: 0 },
      { delivered: 1, failed: 0, dead: 0 },
    ]);
  });

  it("gives successive claims on the same row distinct opaque hex owner tokens after expiry", async () => {
    const h = await setup();
    const firstEntered = barrier(), secondEntered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    let enqueues = 0;
    h.queue.enqueue = async (input) => {
      if (++enqueues === 1) firstEntered.release();
      else secondEntered.release();
      await finish.wait;
      return enqueue(input);
    };
    const first = h.outbox.relay({ companyId, ids: ["m1"] });
    let second: ReturnType<typeof h.outbox.relay> | undefined;
    try {
      await firstEntered.wait;
      const before = (await h.store.get(key))!;
      expect(before.status).toBe("PENDING");
      expect(before.relayOwner).toMatch(/^[0-9a-f]{32}$/);
      h.advance(OUTBOX_RELAY_OWNERSHIP_MS / 1_000);
      second = h.make().relay({ companyId, ids: ["m1"] });
      await secondEntered.wait;
      const after = (await h.store.get(key))!;
      expect(after.status).toBe("PENDING");
      expect(after.relayOwner).toMatch(/^[0-9a-f]{32}$/);
      expect(after.relayOwner).not.toBe(before.relayOwner);
    } finally {
      finish.release();
      await Promise.all([first, second]);
    }
  });

  it("refuses a consistently foreign row misindexed into this company's pending partition before logging its identity", async () => {
    const h = await setup();
    const other = "org_bbbbbbbbbbbbbbbbbbbb";
    const foreign = { ...(await h.store.get(key))!, pk: `ORG#${other}#OUTBOX#m1`, companyId: other, [OUTBOX_PENDING_INDEX.partitionAttribute]: `PENDING#${companyId}` };
    await h.store.delete({ key });
    await h.store.put({ item: foreign });
    const enqueue = vi.spyOn(h.queue, "enqueue");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await h.outbox.relay({ companyId })).toEqual({ delivered: 0, failed: 1, dead: 0 });
      expect(enqueue).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(await h.store.get(foreign)).toEqual(foreign);
    } finally { warn.mockRestore(); }
  });

  it.each([undefined, "private-invalid-expiry", 0])("logs and retains an owner with invalid expiry %s without queue access", async (expiry) => {
    const h = await setup();
    await h.store.update({ key, ops: [change.set("relayOwner", "crashed-owner"), ...(expiry === undefined ? [] : [change.set("relayExpiresAt", expiry)])] });
    const before = await h.store.get(key);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueue = vi.spyOn(h.queue, "enqueue");
    try {
      expect(await h.outbox.relay({ companyId })).toEqual({ delivered: 0, failed: 1, dead: 0 });
      expect(await h.store.get(key)).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>)).toEqual([{ event: "outbox.relay_owner_invalid", companyId, outboxId: "m1" }]);
    } finally { warn.mockRestore(); }
  });

  it("two independent overlapping relays enqueue just once without queue deduplication", async () => {
    const h = await setup();
    const entered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    h.queue.enqueue = async (input) => { entered.release(); await finish.wait; return enqueue(input); };
    const first = h.outbox.relay({ companyId });
    await entered.wait;
    const second = h.make().relay({ companyId, ids: ["m1"] });
    // Release before awaiting so the pre-fix implementation also terminates.
    finish.release();
    const reports = await Promise.all([first, second]);
    expect(reports.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect(await h.queue.receive({ maxMessages: 10 })).toHaveLength(1);
  });

  it("absorbs a resend after enqueue succeeds but the relay crashes before mark-sent", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const queue = await h.queues.queue("task-dispatch");
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (message) => { const copy = { ...message }; delete copy.dedupeId; return enqueue(copy); };
    const update = h.store.update.bind(h.store);
    let crashed = false;
    h.store.update = async (request) => {
      if (!crashed && request.key.sk === "OUTBOX" && request.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "QUEUED")) {
        crashed = true;
        throw new Error("crash after enqueue before receipt");
      }
      return update(request);
    };
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "one run" });
    h.store.update = update;
    expect(crashed).toBe(true);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1, failed: 0 });
    const view = await h.flow.get(h.owner, started.task.taskId);
    const operation = view.operations[0]!;
    const key = operationKey(COMPANY, started.task.workspaceId, operation.id);
    const before = await h.store.get(key);
    const pending = (await h.store.queryIndex({ index: OUTBOX_PENDING_INDEX.name, partition: `PENDING#${COMPANY}` })).items;
    expect(pending).toHaveLength(1);
    const expires = Date.parse(pending[0]!.relayExpiresAt as string);
    // Ownership must expire while the first dispatch is still fresh. This catches
    // a lease copied from the stale-dispatch literal instead of the enqueue bound.
    expect(expires - h.clock.now).toBeLessThan(CORE_DISPATCH_VISIBILITY_TIMEOUT.toMilliseconds());
    h.clock.advance((expires - h.clock.now) / 1_000);
    expect(await h.deps.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect(await h.flow.dispatchOnce()).toMatchObject({ received: 1, delivered: 0, failed: 0, retried: 1 });
    expect(await h.store.get(key)).toEqual(before);
    expect(h.grants).toHaveLength(1);
    // Once the worker's existing RUNNING callback arrives, even the retained
    // delayed recovery message cannot send another invocation.
    await h.store.update({ key, ops: [change.set("status", "RUNNING")] });
    h.clock.advance(200);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 0, failed: 0, dropped: 1 });
    expect(h.grants).toHaveLength(1);
    const workspace = (await h.store.get(workspaceKey(COMPANY, started.task.workspaceId)))!;
    expect(h.machines.delivered((workspace.machine as { machineId: string }).machineId)).toHaveLength(1);
    expect((await h.store.get(key))!.status).toBe("RUNNING");
    expect((await h.store.queryIndex({ index: OUTBOX_PENDING_INDEX.name, partition: `PENDING#${COMPANY}` })).items).toHaveLength(0);
  });

  it("recovers a relay crash after claiming only after ownership expires", async () => {
    const h = await setup();
    const entered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    h.queue.enqueue = async (input) => { entered.release(); await finish.wait; return enqueue(input); };
    const crashed = h.outbox.relay({ companyId });
    await entered.wait;
    h.queue.enqueue = enqueue;
    try {
      expect(await h.make().relay({ companyId })).toEqual({ delivered: 0, failed: 0, dead: 0 });
      expect(await h.queue.receive()).toHaveLength(0);
      h.advance(CORE_BROKER_TIMEOUT_SECONDS);
      expect(await h.make().relay({ companyId })).toEqual({ delivered: 0, failed: 0, dead: 0 });
      h.advance(OUTBOX_RELAY_OWNERSHIP_MS / 1_000 - CORE_BROKER_TIMEOUT_SECONDS - 0.001);
      expect(await h.make().relay({ companyId })).toEqual({ delivered: 0, failed: 0, dead: 0 });
      h.advance(0.001);
      h.queue.enqueue = enqueue;
      expect(await h.make().relay({ companyId })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      const receipt = await h.store.get(key);
      // A late old owner cannot change the new owner's receipt.
      finish.release(); await crashed;
      expect(await h.store.get(key)).toEqual(receipt);
    } finally { finish.release(); await crashed; }
  });

  it.each([false, true])("an expired owner's enqueue failure cannot change its successor (queued=%s)", async (queued) => {
    const h = await setup();
    const entered = barrier(), finish = barrier();
    h.queue.enqueue = async () => { entered.release(); await finish.wait; throw new Error("enqueue failed"); };
    const old = h.outbox.relay({ companyId });
    await entered.wait;
    const newer = { owner: "successor", expiresAt: "2026-11-22T10:10:00.000Z" };
    await h.store.update({ key, ops: [change.set("relayOwner", newer.owner), change.set("relayExpiresAt", newer.expiresAt), ...(queued ? [change.set("status", "QUEUED")] : [])] });
    const before = await h.store.get(key);
    finish.release(); await old;
    expect(await h.store.get(key)).toEqual(before);
  });

  it("a late receipt cannot release a successor's still-pending ownership", async () => {
    const h = await setup(); const entered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    h.queue.enqueue = async (input) => { entered.release(); await finish.wait; return enqueue(input); };
    const pending = h.outbox.relay({ companyId }); await entered.wait;
    await h.store.update({ key, ops: [change.set("relayOwner", "successor")] });
    const before = await h.store.get(key);
    finish.release();
    expect(await pending).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(await h.store.get(key)).toEqual(before);
  });

  it("a receipt cannot change a row whose status moved on under the same owner", async () => {
    const h = await setup(); const entered = barrier(), finish = barrier();
    const enqueue = h.queue.enqueue.bind(h.queue);
    h.queue.enqueue = async (input) => { entered.release(); await finish.wait; return enqueue(input); };
    const pending = h.outbox.relay({ companyId }); await entered.wait;
    await h.store.update({ key, ops: [change.set("status", "DEAD")] });
    const before = await h.store.get(key);
    finish.release();
    expect(await pending).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(await h.store.get(key)).toEqual(before);
  });

  it("a non-numeric legacy attempt count starts the failure count at one", async () => {
    const h = await setup();
    await h.store.update({ key, ops: [change.set("attempts", "2")] });
    h.queue.enqueue = async () => { throw new Error("enqueue failed"); };
    expect(await h.outbox.relay({ companyId })).toEqual({ delivered: 0, failed: 1, dead: 0 });
    expect(await h.store.get(key)).toMatchObject({ status: "PENDING", attempts: 1 });
  });

  it("a stale index row already QUEUED cannot be claimed or enqueued", async () => {
    const h = await setup();
    await h.store.update({ key, ops: [change.set("status", "QUEUED")] });
    expect(await h.outbox.relay({ companyId })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(await h.queue.receive()).toHaveLength(0);
  });
});
