// Port lane W0: an in-memory queue service, the fake the other lanes build against. Time comes from an injectable clock so a test
// can move it forward instead of waiting.
import { randomUUID } from "node:crypto";
import {
  QUEUE_LIMITS,
  type DeadLetter,
  type EnqueueResult,
  type Queue,
  type QueueCapabilities,
  type QueueMessageInput,
  type QueueOptions,
  type QueueService,
  type ReceiveOptions,
  type ReceivedMessage,
} from "@agentx/contracts";

interface Stored {
  messageId: string;
  body: QueueMessageInput["body"];
  attributes: Record<string, string>;
  groupId?: string;
  enqueuedAt: number;
  visibleAt: number;
  receiveCount: number;
  receipt?: string;
  sequence: number;
}

interface DeadStored extends Stored {
  reason: string;
  deadLetteredAt: number;
}

export interface MemoryQueueServiceOptions {
  /** Milliseconds since the epoch. Default: the real clock. */
  now?: () => number;
}

export class MemoryQueueService implements QueueService {
  readonly #queues = new Map<string, MemoryQueue>();
  readonly #now: () => number;

  constructor(options: MemoryQueueServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async queue(name: string, options: QueueOptions = {}): Promise<Queue> {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error("a queue name is 1 to 80 letters, digits, dots, hyphens or underscores");
    let queue = this.#queues.get(name);
    if (queue === undefined) {
      queue = new MemoryQueue(name, options, this.#now);
      this.#queues.set(name, queue);
    } else if (Object.keys(options).length > 0 && JSON.stringify(sorted(options)) !== JSON.stringify(sorted(queue.options))) {
      // Options belong to where the queue is declared, not to whoever asks first.
      throw new Error("that queue is already declared with different options");
    }
    return queue;
  }
}

const sorted = (options: QueueOptions): Record<string, unknown> => Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));

class MemoryQueue implements Queue {
  readonly capabilities: QueueCapabilities = { ordered: true, dedupe: true, maxDelaySeconds: QUEUE_LIMITS.maxSeconds, detectsStaleHandle: true, deadLettersById: true };
  readonly #messages: Stored[] = [];
  readonly #dead: DeadStored[] = [];
  readonly #dedupe = new Map<string, { messageId: string; at: number }>();
  #sequence = 0;

  constructor(
    readonly name: string,
    readonly options: QueueOptions,
    readonly now: () => number,
  ) {}

  async enqueue(input: QueueMessageInput): Promise<EnqueueResult> {
    const bytes = new TextEncoder().encode(JSON.stringify(input.body)).length;
    if (bytes > QUEUE_LIMITS.maxBodyBytes) throw new Error(`a message body is at most ${QUEUE_LIMITS.maxBodyBytes} bytes`);
    const delay = input.delaySeconds ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > this.capabilities.maxDelaySeconds) throw new Error("delaySeconds is out of range");
    const now = this.now();
    if (input.dedupeId !== undefined) {
      for (const [id, seen] of this.#dedupe) if (now - seen.at > QUEUE_LIMITS.dedupeWindowSeconds * 1_000) this.#dedupe.delete(id);
      const seen = this.#dedupe.get(input.dedupeId);
      if (seen !== undefined) return { messageId: seen.messageId, duplicate: true };
    }
    const messageId = randomUUID();
    if (input.dedupeId !== undefined) this.#dedupe.set(input.dedupeId, { messageId, at: now });
    this.#messages.push({
      messageId,
      body: structuredClone(input.body),
      attributes: { ...(input.attributes ?? {}) },
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      enqueuedAt: now,
      visibleAt: now + delay * 1_000,
      receiveCount: 0,
      sequence: this.#sequence++,
    });
    return { messageId, duplicate: false };
  }

  async receive(options: ReceiveOptions = {}): Promise<ReceivedMessage[]> {
    const max = options.maxMessages ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > QUEUE_LIMITS.maxReceive) throw new Error(`maxMessages is 1 to ${QUEUE_LIMITS.maxReceive}`);
    const hideFor = options.visibilityTimeoutSeconds ?? this.options.visibilityTimeoutSeconds ?? 30;
    if (!Number.isFinite(hideFor) || hideFor < 0 || hideFor > QUEUE_LIMITS.maxSeconds) throw new Error("visibilityTimeoutSeconds is out of range");
    const now = this.now();
    this.#sweepDead(now);
    const received: ReceivedMessage[] = [];
    const blockedGroups = new Set<string>();
    // A group with a message in flight, or an earlier message not yet visible, delivers nothing until that one is settled.
    const ordered = [...this.#messages].sort((a, b) => a.sequence - b.sequence);
    for (const message of ordered) {
      if (received.length >= max) break;
      if (this.options.ordered === true && message.groupId !== undefined) {
        if (blockedGroups.has(message.groupId)) continue;
        blockedGroups.add(message.groupId);
      }
      if (message.visibleAt > now) continue;
      message.receiveCount += 1;
      message.visibleAt = now + hideFor * 1_000;
      message.receipt = randomUUID();
      received.push({
        messageId: message.messageId,
        receiptHandle: message.receipt,
        body: structuredClone(message.body),
        attributes: { ...message.attributes },
        receiveCount: message.receiveCount,
        enqueuedAt: new Date(message.enqueuedAt).toISOString(),
        ...(message.groupId === undefined ? {} : { groupId: message.groupId }),
      });
    }
    return received;
  }

  async ack(receiptHandle: string): Promise<boolean> {
    const index = this.#messages.findIndex((message) => message.receipt === receiptHandle);
    if (index === -1) return false;
    this.#messages.splice(index, 1);
    return true;
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<boolean> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > QUEUE_LIMITS.maxSeconds) throw new Error("seconds is out of range");
    const message = this.#messages.find((candidate) => candidate.receipt === receiptHandle);
    if (message === undefined) return false;
    message.visibleAt = this.now() + seconds * 1_000;
    return true;
  }

  async deadLetter(receiptHandle: string, reason: string): Promise<boolean> {
    const index = this.#messages.findIndex((message) => message.receipt === receiptHandle);
    if (index === -1) return false;
    const [message] = this.#messages.splice(index, 1);
    this.#dead.push({ ...message!, reason, deadLetteredAt: this.now() });
    return true;
  }

  async listDeadLetters(options: { limit?: number; cursor?: string } = {}): Promise<{ items: DeadLetter[]; cursor?: string }> {
    this.#sweepDead(this.now());
    const limit = options.limit ?? 100;
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error("that cursor is not valid");
    const slice = this.#dead.slice(start, start + limit);
    const items = slice.map((message): DeadLetter => ({
      messageId: message.messageId,
      body: structuredClone(message.body),
      attributes: { ...message.attributes },
      receiveCount: message.receiveCount,
      deadLetteredAt: new Date(message.deadLetteredAt).toISOString(),
      reason: message.reason,
    }));
    return start + limit < this.#dead.length ? { items, cursor: String(start + limit) } : { items };
  }

  async redrive(messageId: string): Promise<boolean> {
    const index = this.#dead.findIndex((message) => message.messageId === messageId);
    if (index === -1) return false;
    const [dead] = this.#dead.splice(index, 1);
    const { reason: _reason, deadLetteredAt: _at, ...message } = dead!;
    void _reason;
    void _at;
    this.#messages.push({ ...message, receiveCount: 0, visibleAt: this.now(), sequence: this.#sequence++ });
    delete this.#messages[this.#messages.length - 1]!.receipt;
    return true;
  }

  async discardDeadLetter(messageId: string): Promise<boolean> {
    const index = this.#dead.findIndex((message) => message.messageId === messageId);
    if (index === -1) return false;
    this.#dead.splice(index, 1);
    return true;
  }

  /** A message that has used up its receives and is visible again goes to the dead letters instead of being delivered. */
  #sweepDead(now: number): void {
    const limit = this.options.maxReceiveCount;
    if (limit === undefined) return;
    for (let index = this.#messages.length - 1; index >= 0; index -= 1) {
      const message = this.#messages[index]!;
      if (message.receiveCount >= limit && message.visibleAt <= now) {
        this.#messages.splice(index, 1);
        this.#dead.push({ ...message, reason: "max_receives", deadLetteredAt: now });
      }
    }
  }
}
