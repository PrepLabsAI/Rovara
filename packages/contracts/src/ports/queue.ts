// Port lane W0, port 2: the queue and the transactional outbox.
//
// A queue is at-least-once: a received message stays invisible for a time, and comes back unless it is acknowledged. That is what
// SQS does today for task dispatch, and what a table polled by the local process can do. The outbox is the way a state change and
// the message it implies commit together: the message is written in the same document-store transaction as the change, and a
// relay moves it to its queue afterwards. It replaces the DynamoDB-stream publisher (the stream's other readers use
// `DocumentChangeFeed`).
import type { JsonValue } from "./json.js";
import type { IndexDefinition, TransactItem } from "./document-store.js";

export const QUEUE_LIMITS = {
  /** Largest message body, as compact JSON, in UTF-8 bytes. */
  maxBodyBytes: 256 * 1_024,
  /** Most messages one `receive` returns. */
  maxReceive: 10,
  /** Longest visibility timeout or delay, in seconds. */
  maxSeconds: 12 * 60 * 60,
  /** An adapter keeps duplicate-suppression ids for at least this long. */
  dedupeWindowSeconds: 5 * 60,
} as const;

export interface QueueMessageInput {
  body: JsonValue;
  /** Short text labels that travel with the message (not interpreted). */
  attributes?: Record<string, string>;
  /** Hide the message for this many seconds first. */
  delaySeconds?: number;
  /**
   * A second message with the same id inside the dedupe window is accepted but not stored again (`duplicate: true`). Delivery of the
   * first copy is unchanged.
   */
  dedupeId?: string;
  /** On an `ordered` queue: messages of one group are delivered one at a time, in the order they were enqueued. Ignored elsewhere. */
  groupId?: string;
}

export interface EnqueueResult {
  messageId: string;
  duplicate: boolean;
}

export interface ReceivedMessage {
  messageId: string;
  /** Proves this delivery. A later delivery of the same message has a different handle, and the earlier one stops working. */
  receiptHandle: string;
  body: JsonValue;
  attributes: Record<string, string>;
  /** 1 on the first delivery. */
  receiveCount: number;
  enqueuedAt: string;
  groupId?: string;
}

export interface ReceiveOptions {
  /** 1 to `QUEUE_LIMITS.maxReceive`; default 1. */
  maxMessages?: number;
  /** How long the received messages stay hidden; default is the queue's. */
  visibilityTimeoutSeconds?: number;
  /** Wait up to this long for a message to arrive (long poll); default 0 returns at once. */
  waitSeconds?: number;
}

export interface DeadLetter {
  messageId: string;
  body: JsonValue;
  attributes: Record<string, string>;
  receiveCount: number;
  deadLetteredAt: string;
  /** Why: the caller's reason, or `max_receives`. */
  reason: string;
}

export interface QueueOptions {
  /** Default 30. */
  visibilityTimeoutSeconds?: number;
  /** A message received this many times and not acknowledged goes to the dead letters instead of being delivered again. Default: never. */
  maxReceiveCount?: number;
  /** Keep order within a group (see `QueueMessageInput.groupId`). Default false. */
  ordered?: boolean;
}

export interface Queue {
  readonly name: string;
  enqueue(message: QueueMessageInput): Promise<EnqueueResult>;
  /** Up to `maxMessages` messages that are visible now, each hidden from other receivers until its visibility timeout ends. May return none. */
  receive(options?: ReceiveOptions): Promise<ReceivedMessage[]>;
  /** Removes a delivered message for good. False when the handle is stale (the message came back and was delivered again, or was already removed). */
  ack(receiptHandle: string): Promise<boolean>;
  /** Hides (or, with 0, releases) a delivered message for this many seconds from now. False when the handle is stale. Used to back off a retry. */
  changeVisibility(receiptHandle: string, seconds: number): Promise<boolean>;
  /** Moves a delivered message to the dead letters now. False when the handle is stale. */
  deadLetter(receiptHandle: string, reason: string): Promise<boolean>;
  listDeadLetters(options?: { limit?: number; cursor?: string }): Promise<{ items: DeadLetter[]; cursor?: string }>;
  /** Puts a dead letter back on the queue as a new message with its count reset. False when there is no such dead letter. */
  redrive(messageId: string): Promise<boolean>;
  /** Drops a dead letter. False when there is no such dead letter. */
  discardDeadLetter(messageId: string): Promise<boolean>;
}

/** The place queues come from: one named queue per use (dispatch, audit, lessons). Asking again for a name returns the same queue. */
export interface QueueService {
  queue(name: string, options?: QueueOptions): Promise<Queue>;
}

// ---- The transactional outbox ----

/** The index an outbox needs from its document store: a sparse index of the messages not yet relayed. */
export const OUTBOX_PENDING_INDEX: IndexDefinition = { name: "outbox-pending", partitionAttribute: "outboxState", sortAttribute: "outboxStagedAt" };

export interface OutboxMessage {
  /** Names the message for good: staging the same id twice in one company is a conflict, so a retried request cannot send twice. */
  id: string;
  queue: string;
  body: JsonValue;
  attributes?: Record<string, string>;
  groupId?: string;
}

export interface OutboxRelayReport {
  /** Messages handed to their queues in this call. */
  delivered: number;
  /** Messages that could not be handed over this time and stay pending. */
  failed: number;
}

export interface TransactionalOutbox {
  /**
   * The step to add to the caller's `DocumentStore.transact` call, so the message exists if and only if the state change commits.
   * Pure: it writes nothing itself.
   */
  stage(message: OutboxMessage): Extract<TransactItem, { kind: "put" }>;
  /**
   * Hands pending messages to their queues, oldest first, then marks them handed over. At least once: a crash between the two steps
   * means the next call hands the message over again, and the queue's `dedupeId` (the outbox id) drops the copy. Safe to call from
   * a timer, from a change-feed consumer, or in a loop; calls may overlap. `ids` limits the call to those messages.
   */
  relay(options?: { limit?: number; ids?: readonly string[] }): Promise<OutboxRelayReport>;
}
