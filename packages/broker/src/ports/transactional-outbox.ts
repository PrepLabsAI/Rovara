// Port lane W0: the transactional outbox, written once over the document store and queue ports (no provider in it). It replaces
// the DynamoDB-stream publisher: the message is staged in the same transaction as the state change, then relayed.
import {
  OUTBOX_PENDING_INDEX,
  change,
  companyScoped,
  when,
  type DocumentStore,
  type OutboxMessage,
  type OutboxRelayReport,
  type QueueService,
  type StoredDocument,
  type TransactionalOutbox,
} from "@agentx/contracts";

export interface TransactionalOutboxDependencies {
  /** The store must keep `OUTBOX_PENDING_INDEX`. */
  store: Pick<DocumentStore, "update" | "queryIndex" | "get" | "indexes" | "ttlAttribute">;
  queues: QueueService;
  now?: () => Date;
  /** After this many failed hand-overs a message is set aside as DEAD. Default 10. */
  maxAttempts?: number;
  /** How long a handed-over row stays before a store with a time-to-live attribute may remove it, in seconds. Default 7 days. */
  retainSeconds?: number;
}

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("an outbox document is malformed");
  return value;
};

const outboxKey = (companyId: string, id: string) => ({ pk: companyScoped(companyId, `OUTBOX#${id}`), sk: "OUTBOX" });
const pendingPartition = (companyId: string) => `PENDING#${companyId}`;

export function createTransactionalOutbox(dependencies: TransactionalOutboxDependencies): TransactionalOutbox {
  const { store, queues } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const maxAttempts = dependencies.maxAttempts ?? 10;
  const retainSeconds = dependencies.retainSeconds ?? 7 * 24 * 3_600;
  const index = store.indexes.find((candidate) => candidate.name === OUTBOX_PENDING_INDEX.name);
  if (index === undefined || index.partitionAttribute !== OUTBOX_PENDING_INDEX.partitionAttribute || index.sortAttribute !== OUTBOX_PENDING_INDEX.sortAttribute) {
    throw new Error(`the document store must keep the ${OUTBOX_PENDING_INDEX.name} index`);
  }
  const leaveIndex = [change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)];

  return {
    stage(message: OutboxMessage) {
      const stagedAt = now().toISOString();
      return {
        kind: "put",
        item: {
          ...outboxKey(message.companyId, message.id),
          entityType: "OUTBOX",
          companyId: message.companyId,
          id: message.id,
          queue: message.queue,
          body: message.body,
          attributes: message.attributes ?? {},
          ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
          status: "PENDING",
          attempts: 0,
          [OUTBOX_PENDING_INDEX.partitionAttribute]: pendingPartition(message.companyId),
          [OUTBOX_PENDING_INDEX.sortAttribute!]: stagedAt,
        },
        // Staging one id twice is a conflict, so a retried request cannot send twice.
        condition: when.absent(),
      };
    },

    async relay(options): Promise<OutboxRelayReport> {
      const report: OutboxRelayReport = { delivered: 0, failed: 0, dead: 0 };
      const limit = options.limit ?? 100;
      let pending: StoredDocument[];
      if (options.ids !== undefined) {
        const found = await Promise.all(options.ids.map((id) => store.get(outboxKey(options.companyId, id))));
        pending = found.filter((item): item is StoredDocument => item !== undefined && item.status === "PENDING");
      } else {
        pending = (await store.queryIndex({ index: OUTBOX_PENDING_INDEX.name, partition: pendingPartition(options.companyId), limit: Math.min(limit, 1_000) })).items;
      }
      for (const item of pending.slice(0, limit)) {
        const key = { pk: item.pk, sk: item.sk };
        let handedOver = false;
        try {
          const queue = await queues.queue(text(item.queue));
          await queue.enqueue({
            body: item.body!,
            // The outbox id travels with the message: a queue without duplicate suppression may deliver twice, and the consumer drops the repeat by it.
            attributes: { ...(item.attributes as Record<string, string>), outboxId: text(item.id) },
            // Scoped by company: two companies may stage the same id.
            dedupeId: companyScoped(options.companyId, `OUTBOX#${text(item.id)}`),
            ...(typeof item.groupId === "string" ? { groupId: item.groupId } : {}),
          });
          handedOver = true;
          const marked = await store.update({
            key,
            ops: [change.set("status", "QUEUED"), change.set("queuedAt", now().toISOString()), change.set(store.ttlAttribute ?? "expiresAt", Math.floor(now().getTime() / 1_000) + retainSeconds), ...leaveIndex],
            condition: when.eq("status", "PENDING"),
          });
          // Another relay may have marked it first: then the copy this call sent was a duplicate the queue or the consumer drops.
          if (marked.applied) report.delivered += 1;
        } catch {
          if (handedOver) {
            // The message is on its queue; only the mark failed. It stays pending and is handed over again (and dropped as a repeat); it is not a failed delivery.
            report.failed += 1;
            continue;
          }
          const attempts = (typeof item.attempts === "number" ? item.attempts : 0) + 1;
          const dead = attempts >= maxAttempts;
          try {
            await store.update({
              key,
              ops: [change.set("attempts", attempts), ...(dead ? [change.set("status", "DEAD"), change.set(store.ttlAttribute ?? "expiresAt", Math.floor(now().getTime() / 1_000) + retainSeconds), ...leaveIndex] : [])],
              condition: when.eq("status", "PENDING"),
            });
          } catch {
            // The failure is reported below; the count is retried by the next run.
          }
          if (dead) report.dead += 1;
          else report.failed += 1;
        }
      }
      return report;
    },
  };
}
