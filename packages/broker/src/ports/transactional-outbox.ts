// Port lane W0: the transactional outbox, written once over the document store and queue ports (no provider in it). It replaces
// the DynamoDB-stream publisher: the message is staged in the same transaction as the state change, then relayed.
import { randomBytes } from "node:crypto";
import {
  OUTBOX_PENDING_INDEX,
  OUTBOX_RELAY_OWNERSHIP_MS,
  change,
  companyScoped,
  companyOfChange,
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

const releaseOwner = [change.remove("relayOwner"), change.remove("relayExpiresAt")];

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("an outbox document is malformed");
  return value;
};

const outboxKey = (companyId: string, id: string) => ({ pk: companyScoped(companyId, `OUTBOX#${id}`), sk: "OUTBOX" });
const pendingPartition = (companyId: string) => `PENDING#${companyId}`;

/** Approved internal broker resume payload: the timed relay remains its backstop even after queue redrive/expiry. */
function durableCloseResume(item: StoredDocument): boolean {
  const body = item["body"] as Record<string, unknown> | null | undefined;
  return body?.["v"] === 1 && body["resumeClose"] === true && body["companyId"] === item["companyId"] && body["operationId"] === item["id"];
}

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
      const attributes = message.attributes ?? {};
      if (typeof attributes !== "object" || Array.isArray(attributes) || Object.hasOwn(attributes, "companyId") || Object.hasOwn(attributes, "outboxId") || Object.keys(attributes).length > 7 || Object.values(attributes).some((value) => typeof value !== "string")) throw new Error("invalid outbox attributes");
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
        const closeResume = durableCloseResume(item);
        const key = { pk: item.pk, sk: item.sk };
        if (invalidRelayRow(item, options.companyId)) { report.failed += 1; continue; }
        const owner = randomBytes(16).toString("hex");
        const owned = when.and(when.eq("status", "PENDING"), when.eq("relayOwner", owner));
        const at = now();
        const claim = await store.update({
          key,
          ops: [change.set("relayOwner", owner), change.set("relayExpiresAt", new Date(at.getTime() + OUTBOX_RELAY_OWNERSHIP_MS).toISOString())],
          condition: when.and(when.eq("status", "PENDING"), when.or(when.notExists("relayOwner"), when.lte("relayExpiresAt", at.toISOString()))),
        });
        if (!claim.applied) continue;
        let handedOver = false;
        try {
          const queue = await queues.queue(text(item.queue));
          await queue.enqueue({
            body: item.body!,
            // The outbox id travels with the message: a queue without duplicate suppression may deliver twice, and the consumer drops the repeat by it.
            attributes: { ...(item.attributes as Record<string, string>), outboxId: text(item.id), companyId: options.companyId },
            // Scoped by company: two companies may stage the same id.
            dedupeId: companyScoped(options.companyId, `OUTBOX#${text(item.id)}`),
            ...(typeof item.groupId === "string" ? { groupId: item.groupId } : {}),
          });
          handedOver = true;
          const marked = await store.update({
            key,
            ops: [...queuedReceipt(closeResume, store.ttlAttribute, now(), retainSeconds, leaveIndex), ...releaseOwner],
            condition: owned,
          });
          // A late owner cannot overwrite its successor's receipt. Enqueue/receipt crashes still require an idempotent consumer.
          if (marked.applied) report.delivered += 1;
        } catch (error) {
          // Error names identify the failed boundary without logging payloads, URLs or raw provider messages.
          console.warn(JSON.stringify({ event: "outbox.relay_failed", companyId: options.companyId, outboxId: item.id, queue: item.queue,
            attempt: nextRelayAttempt(item), retryable: (error as { retryable?: unknown } | null)?.retryable !== false,
            operation: handedOver ? "mark_queued" : "enqueue", error: error instanceof Error ? error.name : "unknown",
            ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.name } : {}),
          }));
          if (handedOver) {
            // The message is on its queue; only the mark failed. It stays owned until expiry, then is handed over again (and dropped as a repeat); it is not a failed delivery.
            report.failed += 1;
            continue;
          }
          const attempts = nextRelayAttempt(item);
          const dead = exhaustedRelay(closeResume, attempts, maxAttempts);
          const recorded = await recordRelayFailure(store, {
            key,
            ops: [...releaseOwner, change.set("attempts", attempts), ...(dead ? [change.set("status", "DEAD"), change.set(store.ttlAttribute ?? "expiresAt", Math.floor(now().getTime() / 1_000) + retainSeconds), ...leaveIndex] : [])],
            condition: owned,
          });
          if (dead && recorded) report.dead += 1;
          else report.failed += 1;
        }
      }
      return report;
    },
  };
}

function nextRelayAttempt(item: StoredDocument): number { return (typeof item.attempts === "number" ? item.attempts : 0) + 1; }
function exhaustedRelay(closeResume: boolean, attempts: number, maxAttempts: number): boolean { return !closeResume && attempts >= maxAttempts; }
function queuedReceipt(closeResume: boolean, ttlAttribute: string | undefined, at: Date, retainSeconds: number, leaveIndex: ReturnType<typeof change.remove>[]) {
  const queuedAt = change.set("queuedAt", at.toISOString());
  return closeResume ? [queuedAt, change.set(OUTBOX_PENDING_INDEX.sortAttribute!, at.toISOString())] : [change.set("status", "QUEUED"), queuedAt, change.set(ttlAttribute ?? "expiresAt", Math.floor(at.getTime() / 1000) + retainSeconds), ...leaveIndex];
}

/** Only a committed, owner-fenced write is a DEAD transition. Store failures leave the lease to expire. */
async function recordRelayFailure(store: TransactionalOutboxDependencies["store"], request: Parameters<DocumentStore["update"]>[0]): Promise<boolean> {
  try { return (await store.update(request)).applied; }
  catch { return false; }
}

/** Validate before claiming or logging any row identity. Corrupt ownership stays pending. */
function invalidRelayRow(item: StoredDocument, companyId: string): boolean {
  if (companyOfChange({ key: item, after: item, kind: "insert", cause: "write", sequence: "" }) !== companyId) return true;
  if (item.relayOwner !== undefined && (typeof item.relayExpiresAt !== "string" || !Number.isFinite(Date.parse(item.relayExpiresAt)))) {
    console.warn(JSON.stringify({ event: "outbox.relay_owner_invalid", companyId, outboxId: item.id }));
    return true;
  }
  return false;
}
