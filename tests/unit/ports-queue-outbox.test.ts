// Port lane W0: the in-memory queue passes the queue conformance suite, and the generic outbox passes the outbox suite over the
// in-memory store and queue.
import { OUTBOX_PENDING_INDEX } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
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
    return { store, queues, outbox: createTransactionalOutbox({ store, queues, companyId: "org_aaaaaaaaaaaaaaaaaaaa" }) };
  },
});
