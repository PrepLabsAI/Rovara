// Port lane L3: the SQLite queue passes the shared queue conformance suite, the generic outbox passes the outbox suite over the SQLite
// store and queue, and what is specific to a file on disk and to polling.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_PENDING_INDEX, companyScoped, type QueueService } from "@agentx/contracts";
import { SqliteDatabase, SqliteDocumentStore, SqliteQueueService, QueueStorageError } from "../../packages/local-adapters/src/index.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { runOutboxConformance } from "../support/ports/outbox-conformance.js";
import { runQueueConformance } from "../support/ports/queue-conformance.js";

async function withFolder<T>(body: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "local-queue-"));
  try {
    return await body(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

runQueueConformance("sqlite", {
  async create() {
    const folder = await mkdtemp(join(tmpdir(), "local-queue-"));
    let now = Date.parse("2026-11-09T10:00:00.000Z");
    const service = SqliteQueueService.open({ path: join(folder, "queue.db"), now: () => now, busyTimeoutMs: 2_000 });
    return {
      service,
      advance: async (seconds) => void (now += seconds * 1_000),
      dispose: async () => {
        await service.close();
        await rm(folder, { recursive: true, force: true });
      },
    };
  },
});

// The store and the queue share one file through two connections, as the local runtime will configure them.
runOutboxConformance("generic outbox over the SQLite store and queue (one file)", {
  async create() {
    const folder = await mkdtemp(join(tmpdir(), "local-outbox-"));
    const path = join(folder, "state.db");
    const store = SqliteDocumentStore.open({ path, indexes: [OUTBOX_PENDING_INDEX], ttlAttribute: "expiresAt", sweepIntervalMs: 0, changeFeed: false, busyTimeoutMs: 2_000 });
    const queues = SqliteQueueService.open({ path, busyTimeoutMs: 2_000 });
    return {
      store,
      queues,
      outbox: createTransactionalOutbox({ store, queues }),
      dispose: async () => {
        await store.close();
        await queues.close();
        await rm(folder, { recursive: true, force: true });
      },
    };
  },
});

const services: SqliteQueueService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
function open(path: string, now: () => number = Date.now, extra: { busyTimeoutMs?: number; pollMs?: number } = {}): SqliteQueueService {
  const service = SqliteQueueService.open({ path, now, busyTimeoutMs: 200, ...extra });
  services.push(service);
  return service;
}

describe("the SQLite queue: messages that outlive the process", () => {
  it("keeps queued, delayed, in-flight and dead messages across a restart", () => withFolder(async (folder) => {
    const path = join(folder, "q.db");
    let now = Date.parse("2026-11-09T10:00:00.000Z");
    const first = open(path, () => now);
    const queue = await first.queue("jobs", { visibilityTimeoutSeconds: 60, maxReceiveCount: 2 });
    await queue.enqueue({ body: "queued", attributes: { a: "b" } });
    await queue.enqueue({ body: "delayed", delaySeconds: 300 });
    await queue.enqueue({ body: "poison" });
    const [inflight] = await queue.receive({ maxMessages: 1 });
    expect(inflight!.body).toBe("queued");
    const [poison] = await queue.receive({ maxMessages: 1 });
    await queue.deadLetter(poison!.receiptHandle, "bad");
    await first.close();

    const second = open(path, () => now);
    const again = await second.queue("jobs", { visibilityTimeoutSeconds: 60, maxReceiveCount: 2 });
    // The in-flight message is still hidden, and its old handle still works for an ack until it is delivered again.
    expect(await again.receive({ maxMessages: 10 })).toEqual([]);
    now += 61_000;
    const [redelivered] = await again.receive({ maxMessages: 10 });
    expect(redelivered).toMatchObject({ messageId: inflight!.messageId, receiveCount: 2, attributes: { a: "b" } });
    expect(await again.ack(inflight!.receiptHandle)).toBe(false);
    now += 61_000;
    // Received twice and never acknowledged: the third look dead-letters it.
    expect(await again.receive({ maxMessages: 10 })).toEqual([]);
    const dead = await again.listDeadLetters();
    expect(dead.items.map((item) => [item.body, item.reason])).toEqual([["poison", "bad"], ["queued", "max_receives"]]);
    now += 200_000;
    expect((await again.receive()).map((message) => message.body)).toEqual(["delayed"]);
    expect(await again.redrive(poison!.messageId)).toBe(true);
    expect((await again.receive()).map((message) => message.body)).toEqual(["poison"]);
  }));

  it("keeps the duplicate-suppression window across a restart", () => withFolder(async (folder) => {
    const path = join(folder, "q.db");
    let now = Date.parse("2026-11-09T10:00:00.000Z");
    const first = open(path, () => now);
    const sent = await (await first.queue("jobs")).enqueue({ body: 1, dedupeId: "same" });
    await first.close();
    const second = await open(path, () => now).queue("jobs");
    expect(await second.enqueue({ body: 2, dedupeId: "same" })).toEqual({ messageId: sent.messageId, duplicate: true });
    now += 5 * 60_000 + 1;
    expect((await second.enqueue({ body: 3, dedupeId: "same" })).duplicate).toBe(false);
  }));

  it("keeps each queue name to itself, even in one file", () => withFolder(async (folder) => {
    const service = open(join(folder, "q.db"));
    const one = await service.queue("one");
    const two = await service.queue("two");
    await one.enqueue({ body: "1" });
    expect(await two.receive()).toEqual([]);
    const [message] = await one.receive();
    // A handle is good only on the queue that gave it.
    expect(await two.ack(message!.receiptHandle)).toBe(false);
    expect(await one.ack(message!.receiptHandle)).toBe(true);
  }));
});

describe("the SQLite queue: polling and limits", () => {
  it("waits for a message with waitSeconds, and a local enqueue wakes the wait at once", () => withFolder(async (folder) => {
    const service = open(join(folder, "q.db"), Date.now, { pollMs: 5_000 });
    const queue = await service.queue("jobs");
    const started = Date.now();
    const waiting = queue.receive({ waitSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await queue.enqueue({ body: "hello" });
    expect((await waiting).map((message) => message.body)).toEqual(["hello"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    const empty = Date.now();
    expect(await queue.receive({ waitSeconds: 0.05 })).toEqual([]);
    expect(Date.now() - empty).toBeLessThan(1_000);
  }));

  it("sees a message another connection enqueued while it waits", () => withFolder(async (folder) => {
    const path = join(folder, "q.db");
    const consumer = await open(path, Date.now, { pollMs: 10 }).queue("jobs");
    const producer = await open(path).queue("jobs");
    const waiting = consumer.receive({ waitSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await producer.enqueue({ body: "from elsewhere" });
    expect((await waiting).map((message) => message.body)).toEqual(["from elsewhere"]);
  }));

  it("hands a message to exactly one of two consumers on two connections", () => withFolder(async (folder) => {
    const path = join(folder, "q.db");
    const one = await open(path).queue("jobs");
    const two = await open(path).queue("jobs");
    for (let index = 0; index < 30; index += 1) await one.enqueue({ body: index });
    const taken = (await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? one : two).receive({ maxMessages: 2 })))).flat();
    expect(taken.map((message) => message.body).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 30 }, (_, index) => index));
  }));

  it("reports a database that stays locked as a retryable storage error", () => withFolder(async (folder) => {
    const path = join(folder, "q.db");
    const queue = await open(path, Date.now, { busyTimeoutMs: 30 }).queue("jobs");
    const holder = new SqliteDatabase({ path });
    holder.exec("BEGIN IMMEDIATE");
    try {
      await expect(queue.enqueue({ body: 1 })).rejects.toSatisfy((error: unknown) => error instanceof QueueStorageError && error.retryable);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect((await queue.enqueue({ body: 1 })).duplicate).toBe(false);
  }));

  it("refuses text SQLite would change, and bad arguments", () => withFolder(async (folder) => {
    const queue = await open(join(folder, "q.db")).queue("jobs");
    await expect(queue.enqueue({ body: 1, groupId: "a\u0000b" })).rejects.toThrow();
    await expect(queue.enqueue({ body: 1, dedupeId: "\ud800" })).rejects.toThrow();
    await expect(queue.enqueue({ body: undefined as never })).rejects.toThrow();
    await expect(queue.enqueue({ body: 1, attributes: { a: 1 as never } })).rejects.toThrow();
    await expect(queue.listDeadLetters({ cursor: "-1" })).rejects.toThrow();
    await expect(queue.listDeadLetters({ limit: 0 })).rejects.toThrow();
    await expect(queue.changeVisibility("x", -1)).rejects.toThrow();
    // A body with those characters inside is fine: it is stored as JSON text.
    await queue.enqueue({ body: { text: "a\u0000b\ud800" } });
    expect((await queue.receive())[0]!.body).toEqual({ text: "a\u0000b\ud800" });
  }));

  it("refuses a name that is not a queue name, and different options for a declared queue", () => withFolder(async (folder) => {
    const service: QueueService = open(join(folder, "q.db"));
    await expect(service.queue("bad name")).rejects.toThrow();
    await service.queue("declared", { ordered: true, maxReceiveCount: 3 });
    await expect(service.queue("declared", { ordered: false })).rejects.toThrow(/different options/);
    await expect(service.queue("other", { maxReceiveCount: 0 })).rejects.toThrow();
    expect(await service.queue("declared")).toBeDefined();
    void companyScoped;
  }));

  it("moves a redriven ordered message to the back of its group", () => withFolder(async (folder) => {
    const queue = await open(join(folder, "q.db")).queue("jobs", { ordered: true, visibilityTimeoutSeconds: 30 });
    await queue.enqueue({ body: "a1", groupId: "g" });
    await queue.enqueue({ body: "a2", groupId: "g" });
    const [first] = await queue.receive();
    await queue.deadLetter(first!.receiptHandle, "x");
    expect((await queue.receive())[0]!.body).toBe("a2");
    await queue.redrive(first!.messageId);
    expect(await queue.receive()).toEqual([]);
  }));
});
