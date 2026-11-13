// Port lane W0: the in-memory queue passes the queue conformance suite, and the generic outbox passes the outbox suite over the
// in-memory store and queue.
import { describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, type QueueService } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/core/src/ports/memory-queue.js";
import { createTransactionalOutbox } from "../../packages/core/src/ports/transactional-outbox.js";
import { runOutboxConformance } from "../support/ports/outbox-conformance.js";
import { runQueueConformance } from "../support/ports/queue-conformance.js";

runQueueConformance("in-memory fake", {
  async create() {
    let now = Date.parse("2026-11-09T10:00:00.000Z");
    return { service: new MemoryQueueService({ now: () => now }), advance: async (seconds) => void (now += seconds * 1_000) };
  },
});

runOutboxConformance("generic outbox over the in-memory fakes", {
  async create() {
    const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
    const queues = new MemoryQueueService();
    return { store, queues, outbox: createTransactionalOutbox({ store, queues }) };
  },
});

describe("outbox failures", () => {
  const setup = (queues: QueueService, maxAttempts = 3) => {
    const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
    return { store, outbox: createTransactionalOutbox({ store, queues, maxAttempts }) };
  };
  const broken: QueueService = { queue: async () => { throw new Error("queue unreachable"); } };
  const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";

  it("keeps a message pending when its queue cannot be reached, counts the failure, and sets it aside after the limit", async () => {
    const { store, outbox } = setup(broken);
    await store.transact([outbox.stage({ companyId: COMPANY, id: "m1", queue: "dispatch", body: 1 })]);
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 1, dead: 0 });
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 1, dead: 0 });
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 1 });
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    const row = (await store.query({ pk: `ORG#${COMPANY}#OUTBOX#m1` })).items[0]!;
    expect(row).toMatchObject({ status: "DEAD", attempts: 3 });
    expect(row.outboxState).toBeUndefined();
  });

  it("reads only its own company's pending partition", async () => {
    const queues = new MemoryQueueService();
    const { store, outbox } = setup(queues);
    await store.transact([outbox.stage({ companyId: "org_bbbbbbbbbbbbbbbbbbbb", id: "other", queue: "dispatch", body: "x" })]);
    expect(await outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(await (await queues.queue("dispatch")).receive()).toEqual([]);
  });

  it("declares a queue's options once", async () => {
    const queues = new MemoryQueueService();
    await queues.queue("dispatch", { ordered: true });
    await expect(queues.queue("dispatch", { ordered: false })).rejects.toThrow(/different options/);
    expect(await queues.queue("dispatch")).toBeDefined();
  });
});
