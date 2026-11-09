// Port lane W0: the conformance suite for a transactional outbox over any document store and queue service. It checks the promise
// the port makes: a message exists if and only if the state change committed, and it reaches its queue at least once and, with the
// queue's duplicate suppression, once.
import { describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, change, companyScoped, when, type DocumentStore, type QueueService, type TransactionalOutbox } from "@agentx/contracts";

export interface OutboxUnderTest {
  store: DocumentStore;
  queues: QueueService;
  outbox: TransactionalOutbox;
  settleIndexes?: () => Promise<void>;
  dispose?: () => Promise<void>;
}
export interface OutboxHarness {
  /** A store that keeps `OUTBOX_PENDING_INDEX`, a queue service, and an outbox over them. */
  create(): Promise<OutboxUnderTest>;
}

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const TASK = companyScoped(COMPANY, "TASK#1");

export function runOutboxConformance(name: string, harness: OutboxHarness): void {
  async function withOutbox<T>(body: (under: OutboxUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try {
      expect(under.store.indexes.map((index) => index.name)).toContain(OUTBOX_PENDING_INDEX.name);
      return await body(under);
    } finally {
      await under.dispose?.();
    }
  }
  const drain = async (under: OutboxUnderTest, queueName: string) => {
    const queue = await under.queues.queue(queueName);
    const bodies: unknown[] = [];
    for (;;) {
      const batch = await queue.receive({ maxMessages: 10 });
      if (batch.length === 0) return bodies;
      for (const message of batch) {
        bodies.push(message.body);
        await queue.ack(message.receiptHandle);
      }
    }
  };

  describe(`transactional outbox conformance: ${name}`, () => {
    it("commits the message with the state change and relays it to its queue", () => withOutbox(async (under) => {
      const result = await under.store.transact([
        { kind: "put", item: { pk: TASK, sk: "META", status: "ACCEPTED" }, condition: when.absent() },
        under.outbox.stage({ companyId: COMPANY, id: "op-1", queue: "dispatch", body: { operationId: "op-1" }, attributes: { kind: "task" } }),
      ]);
      expect(result).toEqual({ applied: true });
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      expect(await drain(under, "dispatch")).toEqual([{ operationId: "op-1" }]);
    }));

    it("leaves no message when the state change is refused", () => withOutbox(async (under) => {
      await under.store.put({ item: { pk: TASK, sk: "META", status: "ACCEPTED" } });
      const result = await under.store.transact([
        { kind: "put", item: { pk: TASK, sk: "META", status: "AGAIN" }, condition: when.absent() },
        under.outbox.stage({ companyId: COMPANY, id: "op-2", queue: "dispatch", body: { operationId: "op-2" } }),
      ]);
      expect(result.applied).toBe(false);
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 0 });
      expect(await drain(under, "dispatch")).toEqual([]);
    }));

    it("relays a message once however often, or however many times at once, the relay runs", () => withOutbox(async (under) => {
      await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-3", queue: "dispatch", body: "three" })]);
      await under.settleIndexes?.();
      await Promise.all([under.outbox.relay({ companyId: COMPANY }), under.outbox.relay({ companyId: COMPANY }), under.outbox.relay({ companyId: COMPANY })]);
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 0 });
      expect(await drain(under, "dispatch")).toEqual(["three"]);
    }));

    it("refuses to stage the same id twice", () => withOutbox(async (under) => {
      expect(await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-4", queue: "dispatch", body: 1 })])).toEqual({ applied: true });
      const again = await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-4", queue: "dispatch", body: 2 })]);
      expect(again.applied).toBe(false);
      await under.settleIndexes?.();
      await under.outbox.relay({ companyId: COMPANY });
      expect(await drain(under, "dispatch")).toEqual([1]);
    }));

    it("sends each message to the queue it names, oldest first, and can be limited to some ids", () => withOutbox(async (under) => {
      for (const [id, queue] of [["m1", "alpha"], ["m2", "beta"], ["m3", "alpha"]] as const) {
        await under.store.transact([under.outbox.stage({ companyId: COMPANY, id, queue, body: id })]);
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY, ids: ["m2"] })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      expect(await drain(under, "beta")).toEqual(["m2"]);
      expect(await drain(under, "alpha")).toEqual([]);
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 2, failed: 0, dead: 0 });
      expect(await drain(under, "alpha")).toEqual(["m1", "m3"]);
    }));

    it("hands a message over again, without a second copy, if it was handed over but not marked", () => withOutbox(async (under) => {
      await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-5", queue: "dispatch", body: "five" })]);
      await under.settleIndexes?.();
      // The crash the port is built for: the queue has the message, the outbox still lists it pending.
      const queue = await under.queues.queue("dispatch");
      await queue.enqueue({ body: "five", dedupeId: companyScoped(COMPANY, "OUTBOX#op-5") });
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      // A queue that suppresses duplicates holds one copy; one that does not holds two, and the consumer drops the repeat by `outboxId`.
      expect(await drain(under, "dispatch")).toEqual(queue.capabilities.dedupe ? ["five"] : ["five", "five"]);
    }));

    it("keeps two companies' messages with the same id apart", () => withOutbox(async (under) => {
      await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-1", queue: "dispatch", body: "first company" })]);
      await under.store.transact([under.outbox.stage({ companyId: OTHER, id: "op-1", queue: "dispatch", body: "second company" })]);
      await under.settleIndexes?.();
      expect(await under.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      expect(await under.outbox.relay({ companyId: OTHER })).toEqual({ delivered: 1, failed: 0, dead: 0 });
      expect((await drain(under, "dispatch")).sort()).toEqual(["first company", "second company"]);
    }));

    it("tells the consumer which outbox message it is, so a consumer can drop a repeat", () => withOutbox(async (under) => {
      await under.store.transact([under.outbox.stage({ companyId: COMPANY, id: "op-7", queue: "dispatch", body: "seven", attributes: { kind: "task" } })]);
      await under.settleIndexes?.();
      await under.outbox.relay({ companyId: COMPANY });
      const [message] = await (await under.queues.queue("dispatch")).receive();
      expect(message!.attributes).toEqual({ kind: "task", outboxId: "op-7" });
    }));

    it("keeps the state change and the message for the same task together in one commit", () => withOutbox(async (under) => {
      await under.store.put({ item: { pk: TASK, sk: "META", revision: 1 } });
      const result = await under.store.transact([
        { kind: "update", key: { pk: TASK, sk: "META" }, ops: [change.add("revision", 1)], condition: when.eq("revision", 1) },
        under.outbox.stage({ companyId: COMPANY, id: "op-6", queue: "dispatch", body: "six" }),
      ]);
      expect(result.applied).toBe(true);
      expect((await under.store.get({ pk: TASK, sk: "META" }))!.revision).toBe(2);
      expect((await under.store.get({ pk: companyScoped(COMPANY, "OUTBOX#op-6"), sk: "OUTBOX" }))).toBeDefined();
    }));
  });
}
