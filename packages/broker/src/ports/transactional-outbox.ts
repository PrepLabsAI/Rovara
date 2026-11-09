// Port lane W0: the transactional outbox, written once over the document store and queue ports (no provider in it). It replaces
// the DynamoDB-stream publisher: the message is staged in the same transaction as the state change, then relayed.
import {
  OUTBOX_PENDING_INDEX,
  change,
  companyScoped,
  queryIndexAll,
  when,
  type DocumentStore,
  type OutboxMessage,
  type OutboxRelayReport,
  type QueueService,
  type TransactionalOutbox,
} from "@agentx/contracts";

export interface TransactionalOutboxDependencies {
  /** The store must keep `OUTBOX_PENDING_INDEX`. */
  store: Pick<DocumentStore, "update" | "queryIndex" | "get" | "indexes">;
  queues: QueueService;
  companyId: string;
  now?: () => Date;
}

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("an outbox document is malformed");
  return value;
};

const outboxKey = (companyId: string, id: string) => ({ pk: companyScoped(companyId, `OUTBOX#${id}`), sk: "OUTBOX" });

export function createTransactionalOutbox(dependencies: TransactionalOutboxDependencies): TransactionalOutbox {
  const { store, queues, companyId } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  if (!store.indexes.some((index) => index.name === OUTBOX_PENDING_INDEX.name && index.partitionAttribute === OUTBOX_PENDING_INDEX.partitionAttribute && index.sortAttribute === OUTBOX_PENDING_INDEX.sortAttribute)) {
    throw new Error(`the document store must keep the ${OUTBOX_PENDING_INDEX.name} index`);
  }

  return {
    stage(message: OutboxMessage) {
      const stagedAt = now().toISOString();
      return {
        kind: "put",
        item: {
          ...outboxKey(companyId, message.id),
          entityType: "OUTBOX",
          id: message.id,
          queue: message.queue,
          body: message.body,
          attributes: message.attributes ?? {},
          ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
          status: "PENDING",
          [OUTBOX_PENDING_INDEX.partitionAttribute]: "PENDING",
          [OUTBOX_PENDING_INDEX.sortAttribute!]: stagedAt,
        },
        // Staging one id twice is a conflict, so a retried request cannot send twice.
        condition: when.absent(),
      };
    },

    async relay(options = {}): Promise<OutboxRelayReport> {
      const report: OutboxRelayReport = { delivered: 0, failed: 0 };
      const limit = options.limit ?? 100;
      let pending = await queryIndexAll(store, { index: OUTBOX_PENDING_INDEX.name, partition: "PENDING" });
      if (options.ids !== undefined) {
        const wanted = new Set(options.ids.map((id) => outboxKey(companyId, id).pk));
        pending = pending.filter((item) => wanted.has(item.pk));
      } else {
        // The index lists every company's messages; this relay serves its own company only.
        pending = pending.filter((item) => item.pk === companyScoped(companyId, `OUTBOX#${text(item.id)}`));
      }
      for (const item of pending.slice(0, limit)) {
        try {
          const queue = await queues.queue(text(item.queue));
          const attributes = item.attributes as Record<string, string>;
          await queue.enqueue({
            body: item.body!,
            attributes,
            // The outbox id is the duplicate-suppression id, so a second hand-over after a crash is dropped by the queue.
            dedupeId: text(item.id),
            ...(typeof item.groupId === "string" ? { groupId: item.groupId } : {}),
          });
          await store.update({
            key: { pk: item.pk, sk: item.sk },
            ops: [change.set("status", "QUEUED"), change.set("queuedAt", now().toISOString()), change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)],
            condition: when.eq("status", "PENDING"),
          });
          report.delivered += 1;
        } catch {
          report.failed += 1;
        }
      }
      return report;
    },
  };
}
