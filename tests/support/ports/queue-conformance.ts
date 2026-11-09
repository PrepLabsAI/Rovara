// Port lane W0: the conformance suite every queue adapter must pass (SQS, a SQLite-backed local queue, the in-memory fake).
//
// Time: visibility timeouts and delays need time to pass. The harness gives `advance(seconds)`: the fake moves its clock; an adapter
// with a real clock sleeps (use short timeouts there).
import { describe, expect, it } from "vitest";
import { QUEUE_LIMITS, type Queue, type QueueOptions, type QueueService } from "@agentx/contracts";

export interface QueueUnderTest {
  service: QueueService;
  advance(seconds: number): Promise<void>;
  dispose?: () => Promise<void>;
}
export interface QueueHarness {
  create(): Promise<QueueUnderTest>;
}

async function withQueue<T>(harness: QueueHarness, options: QueueOptions, body: (queue: Queue, under: QueueUnderTest) => Promise<T>): Promise<T> {
  const under = await harness.create();
  try {
    return await body(await under.service.queue("suite", options), under);
  } finally {
    await under.dispose?.();
  }
}

export function runQueueConformance(name: string, harness: QueueHarness): void {
  describe(`queue conformance: ${name}`, () => {
    it("delivers a message once it is enqueued, with its body, attributes and a count of 1", () => withQueue(harness, {}, async (queue) => {
      expect(await queue.receive()).toEqual([]);
      const sent = await queue.enqueue({ body: { task: "t1", nested: [1, null, "x"] }, attributes: { kind: "dispatch" } });
      expect(sent.duplicate).toBe(false);
      const [message] = await queue.receive();
      expect(message).toMatchObject({ messageId: sent.messageId, body: { task: "t1", nested: [1, null, "x"] }, attributes: { kind: "dispatch" }, receiveCount: 1 });
      expect(message!.receiptHandle).toBeTruthy();
      expect(new Date(message!.enqueuedAt).toString()).not.toBe("Invalid Date");
    }));

    it("hides a received message until its visibility timeout ends, then delivers it again with a new handle", () => withQueue(harness, { visibilityTimeoutSeconds: 30 }, async (queue, under) => {
      await queue.enqueue({ body: "a" });
      const [first] = await queue.receive();
      expect(await queue.receive()).toEqual([]);
      await under.advance(29);
      expect(await queue.receive()).toEqual([]);
      await under.advance(2);
      const [second] = await queue.receive();
      expect(second!.messageId).toBe(first!.messageId);
      expect(second!.receiveCount).toBe(2);
      expect(second!.receiptHandle).not.toBe(first!.receiptHandle);
      if (queue.capabilities.detectsStaleHandle) expect(await queue.ack(first!.receiptHandle)).toBe(false);
      expect(await queue.ack(second!.receiptHandle)).toBe(true);
    }));

    it("takes the visibility timeout from the receive call when it gives one", () => withQueue(harness, { visibilityTimeoutSeconds: 300 }, async (queue, under) => {
      await queue.enqueue({ body: "a" });
      await queue.receive({ visibilityTimeoutSeconds: 5 });
      await under.advance(6);
      expect(await queue.receive()).toHaveLength(1);
    }));

    it("removes an acknowledged message for good, and refuses a second ack", () => withQueue(harness, {}, async (queue, under) => {
      await queue.enqueue({ body: "a" });
      const [message] = await queue.receive();
      expect(await queue.ack(message!.receiptHandle)).toBe(true);
      if (queue.capabilities.detectsStaleHandle) expect(await queue.ack(message!.receiptHandle)).toBe(false);
      await under.advance(QUEUE_LIMITS.maxSeconds);
      expect(await queue.receive()).toEqual([]);
    }));

    it("receives up to the number asked for, oldest first", () => withQueue(harness, {}, async (queue) => {
      for (const body of ["1", "2", "3", "4", "5"]) await queue.enqueue({ body });
      const firstThree = await queue.receive({ maxMessages: 3 });
      expect(firstThree).toHaveLength(3);
      const rest = await queue.receive({ maxMessages: 10 });
      expect(rest).toHaveLength(2);
      // Every message comes once. Order is promised only by an ordered queue, and only within a group.
      expect([...firstThree, ...rest].map((message) => message.body).sort()).toEqual(["1", "2", "3", "4", "5"]);
      await expect(queue.receive({ maxMessages: 0 })).rejects.toThrow();
      await expect(queue.receive({ maxMessages: QUEUE_LIMITS.maxReceive + 1 })).rejects.toThrow();
    }));

    it("holds a delayed message back until the delay is over", () => withQueue(harness, {}, async (queue, under) => {
      const delay = Math.min(20, queue.capabilities.maxDelaySeconds);
      await queue.enqueue({ body: "later", delaySeconds: delay });
      expect(await queue.receive()).toEqual([]);
      await under.advance(delay + 1);
      expect(await queue.receive()).toHaveLength(1);
    }));

    it("extends or releases a delivered message with changeVisibility", () => withQueue(harness, { visibilityTimeoutSeconds: 10 }, async (queue, under) => {
      await queue.enqueue({ body: "a" });
      const [message] = await queue.receive();
      expect(await queue.changeVisibility(message!.receiptHandle, 100)).toBe(true);
      await under.advance(50);
      expect(await queue.receive()).toEqual([]);
      expect(await queue.changeVisibility(message!.receiptHandle, 0)).toBe(true);
      const [again] = await queue.receive();
      expect(again!.messageId).toBe(message!.messageId);
      if (queue.capabilities.detectsStaleHandle) expect(await queue.changeVisibility(message!.receiptHandle, 5)).toBe(false);
    }));

    it("drops a duplicate by its dedupe id and says so", () => withQueue(harness, {}, async (queue) => {
      if (!queue.capabilities.dedupe) return;
      const first = await queue.enqueue({ body: "x", dedupeId: "same" });
      const second = await queue.enqueue({ body: "x again", dedupeId: "same" });
      expect(second).toEqual({ messageId: first.messageId, duplicate: true });
      const other = await queue.enqueue({ body: "y", dedupeId: "different" });
      expect(other.duplicate).toBe(false);
      expect((await queue.receive({ maxMessages: 10 })).map((message) => message.body)).toEqual(["x", "y"]);
    }));

    it("refuses a body over the limit and a delay out of range", () => withQueue(harness, {}, async (queue) => {
      await expect(queue.enqueue({ body: "x".repeat(QUEUE_LIMITS.maxBodyBytes + 1) })).rejects.toThrow();
      await expect(queue.enqueue({ body: "x", delaySeconds: -1 })).rejects.toThrow();
      await expect(queue.enqueue({ body: "x", delaySeconds: queue.capabilities.maxDelaySeconds + 1 })).rejects.toThrow();
      expect((await queue.enqueue({ body: "x".repeat(200 * 1_024) })).duplicate).toBe(false);
    }));

    it("moves a message to the dead letters on request, lists it, and can redrive or discard it", () => withQueue(harness, {}, async (queue) => {
      if (!queue.capabilities.deadLettersById) return;
      await queue.enqueue({ body: { n: 1 }, attributes: { a: "b" } });
      await queue.enqueue({ body: { n: 2 } });
      const [one, two] = await queue.receive({ maxMessages: 2 });
      expect(await queue.deadLetter(one!.receiptHandle, "poison")).toBe(true);
      if (queue.capabilities.detectsStaleHandle) expect(await queue.deadLetter(one!.receiptHandle, "poison")).toBe(false);
      expect(await queue.deadLetter(two!.receiptHandle, "also poison")).toBe(true);
      const listed = await queue.listDeadLetters();
      expect(listed.items.map((item) => [item.messageId, item.reason, item.body])).toEqual([[one!.messageId, "poison", { n: 1 }], [two!.messageId, "also poison", { n: 2 }]]);
      expect(listed.items[0]!.attributes).toEqual({ a: "b" });
      expect(await queue.receive()).toEqual([]);

      expect(await queue.redrive(one!.messageId)).toBe(true);
      expect(await queue.redrive(one!.messageId)).toBe(false);
      const [back] = await queue.receive();
      expect(back).toMatchObject({ body: { n: 1 }, receiveCount: 1 });
      expect(await queue.discardDeadLetter(two!.messageId)).toBe(true);
      expect(await queue.discardDeadLetter(two!.messageId)).toBe(false);
      expect((await queue.listDeadLetters()).items).toEqual([]);
    }));

    it("pages the dead letters", () => withQueue(harness, {}, async (queue) => {
      if (!queue.capabilities.deadLettersById) return;
      for (let index = 0; index < 5; index += 1) await queue.enqueue({ body: index });
      for (const message of await queue.receive({ maxMessages: 5 })) await queue.deadLetter(message.receiptHandle, "r");
      const seen: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await queue.listDeadLetters(cursor === undefined ? { limit: 2 } : { limit: 2, cursor });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.body));
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
    }));

    it("dead-letters a message that was received the most times allowed and not acknowledged", () => withQueue(harness, { visibilityTimeoutSeconds: 10, maxReceiveCount: 2 }, async (queue, under) => {
      if (!queue.capabilities.deadLettersById) return;
      await queue.enqueue({ body: "poison" });
      expect(await queue.receive()).toHaveLength(1);
      await under.advance(11);
      expect(await queue.receive()).toHaveLength(1);
      await under.advance(11);
      expect(await queue.receive()).toEqual([]);
      const dead = await queue.listDeadLetters();
      expect(dead.items).toHaveLength(1);
      expect(dead.items[0]).toMatchObject({ body: "poison", receiveCount: 2, reason: "max_receives" });
    }));

    it("gives back the same queue for the same name", async () => {
      const under = await harness.create();
      try {
        const one = await under.service.queue("shared");
        const two = await under.service.queue("shared");
        await one.enqueue({ body: "via one" });
        expect((await two.receive()).map((message) => message.body)).toEqual(["via one"]);
        const other = await under.service.queue("other");
        expect(await other.receive()).toEqual([]);
      } finally {
        await under.dispose?.();
      }
    });

    it("keeps the options of the declared queue and refuses different ones", async () => {
      const under = await harness.create();
      try {
        await under.service.queue("declared", { visibilityTimeoutSeconds: 15, maxReceiveCount: 3 });
        expect(await under.service.queue("declared")).toBeDefined();
        await expect(under.service.queue("declared", { visibilityTimeoutSeconds: 99 })).rejects.toThrow();
      } finally {
        await under.dispose?.();
      }
    });

    describe("ordered queues", () => {
      it("deliver one message of a group at a time, in order, while other groups go on", () => withQueue(harness, { ordered: true, visibilityTimeoutSeconds: 30 }, async (queue) => {
        if (!queue.capabilities.ordered) return;
        await queue.enqueue({ body: "a1", groupId: "a" });
        await queue.enqueue({ body: "a2", groupId: "a" });
        await queue.enqueue({ body: "b1", groupId: "b" });
        const first = await queue.receive({ maxMessages: 10 });
        expect(first.map((message) => message.body).sort()).toEqual(["a1", "b1"]);
        expect(await queue.receive({ maxMessages: 10 })).toEqual([]);
        await queue.ack(first.find((message) => message.body === "a1")!.receiptHandle);
        const next = await queue.receive({ maxMessages: 10 });
        expect(next.map((message) => message.body)).toEqual(["a2"]);
        expect(next[0]!.groupId).toBe("a");
      }));

      it("deliver a message of a group again before any later one when it is not acknowledged", () => withQueue(harness, { ordered: true, visibilityTimeoutSeconds: 10 }, async (queue, under) => {
        if (!queue.capabilities.ordered) return;
        await queue.enqueue({ body: "a1", groupId: "a" });
        await queue.enqueue({ body: "a2", groupId: "a" });
        await queue.receive();
        await under.advance(11);
        expect((await queue.receive()).map((message) => message.body)).toEqual(["a1"]);
      }));
    });
  });
}
