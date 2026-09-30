// Issue 157: when the service stops, the consumer gives running turns until the hand-off deadline,
// starts nothing new, and releases every message it will not finish (visibility 0) so the new task
// picks it up within seconds, not after the 15-minute visibility timeout.
import { describe, expect, it } from "vitest";
import type { SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { processGroup, runConsumer, type QueueClient, type QueueMessage } from "../../packages/slack-service/src/consumer.js";
import { TurnHandedOffError } from "../../packages/slack-service/src/interrupted-turn.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };

function queueMessage(eventId: string, groupId: string, receiveCount = 1): QueueMessage {
  const message: SlackRequestMessage = { version: 1, eventId, thread, userId: "U0123456789", text: "fix it", receivedAt: "2026-09-29T19:30:00.000Z" };
  return { body: JSON.stringify(message), receiptHandle: `receipt-${eventId}`, groupId, receiveCount };
}

function fakeQueue(receive: () => Promise<QueueMessage[]>) {
  const deleted: string[] = [];
  const visibility: Array<[string, number]> = [];
  let receives = 0;
  const queue: QueueClient = {
    receive: async () => {
      receives += 1;
      return receive();
    },
    delete: async (receipt) => {
      deleted.push(receipt);
    },
    extendVisibility: async (receipt, seconds) => {
      visibility.push([receipt, seconds]);
    },
  };
  return { queue, deleted, visibility, receives: () => receives };
}

const groupOptions = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("stopping the consumer", () => {
  it("aborts each turn's hand-off signal only when the deadline after the stop passes", async () => {
    let batches = [[queueMessage("Ev000000A1", "thread-a")]];
    const { queue, deleted } = fakeQueue(async () => batches.shift() ?? (await pause(2), []));
    const controller = new AbortController();
    const seen: boolean[] = [];
    await runConsumer(queue, async (_message, context) => {
      controller.abort();
      seen.push(context.handoff!.aborted);
      await pause(10);
      seen.push(context.handoff!.aborted);
      await new Promise((resolve) => context.handoff!.addEventListener("abort", resolve, { once: true }));
      seen.push(context.handoff!.aborted);
    }, { ...groupOptions, concurrency: 4, signal: controller.signal, handoffMilliseconds: 40 });
    batches = [];
    expect(seen).toEqual([false, false, true]);
    expect(deleted).toEqual(["receipt-Ev000000A1"]);
  });

  it("releases a handed-off message and the rest of its thread at once, and deletes none of them", async () => {
    const { queue, deleted, visibility } = fakeQueue(async () => []);
    const logs: Array<[string, unknown]> = [];
    const handled: string[] = [];
    await processGroup(queue, async (message) => {
      handled.push(message.eventId);
      throw new TurnHandedOffError();
    }, [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000A2", "thread-a")], groupOptions, (event, fields) => logs.push([event, fields]));
    expect(handled).toEqual(["Ev000000A1"]);
    expect(deleted).toEqual([]);
    expect(visibility).toEqual([["receipt-Ev000000A1", 0], ["receipt-Ev000000A2", 0]]);
    expect(logs).toContainEqual(["message.released", { reason: "handed_off", count: 2 }]);
    expect(logs.map(([event]) => event)).not.toContain("message.retry_scheduled");
  });

  it("keeps an ordinary failure for redelivery after the visibility timeout, as before", async () => {
    const { queue, deleted, visibility } = fakeQueue(async () => []);
    await processGroup(queue, async () => {
      throw new Error("control plane unavailable");
    }, [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000A2", "thread-a")], groupOptions, () => undefined);
    expect(deleted).toEqual([]);
    expect(visibility).toEqual([]);
  });

  it("starts no later message of a thread once stopped, and releases it", async () => {
    const { queue, deleted, visibility } = fakeQueue(async () => []);
    const stop = new AbortController();
    const handled: string[] = [];
    await processGroup(queue, async (message) => {
      handled.push(message.eventId);
      stop.abort();
    }, [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000A2", "thread-a")], { ...groupOptions, stop: stop.signal }, () => undefined);
    expect(handled).toEqual(["Ev000000A1"]);
    expect(deleted).toEqual(["receipt-Ev000000A1"]);
    expect(visibility).toEqual([["receipt-Ev000000A2", 0]]);
  });

  it("receives nothing after the stop, and releases what a receive already in progress returns", async () => {
    const controller = new AbortController();
    const { queue, deleted, visibility, receives } = fakeQueue(async () => {
      // The stop arrives while the long poll is waiting; SQS still hands back these messages.
      controller.abort();
      return [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000B1", "thread-b")];
    });
    const handled: string[] = [];
    await runConsumer(queue, async (message) => {
      handled.push(message.eventId);
    }, { ...groupOptions, concurrency: 4, signal: controller.signal });
    expect(receives()).toBe(1);
    expect(handled).toEqual([]);
    expect(deleted).toEqual([]);
    expect(visibility).toEqual([["receipt-Ev000000A1", 0], ["receipt-Ev000000B1", 0]]);
  });

  it("stops the heartbeat before the release, so no late heartbeat hides the message again", async () => {
    const { queue, visibility } = fakeQueue(async () => []);
    await processGroup(queue, async () => {
      await pause(35);
      throw new TurnHandedOffError();
    }, [queueMessage("Ev000000A1", "thread-a")], { ...groupOptions, heartbeatMilliseconds: 10 }, () => undefined);
    await pause(30);
    expect(visibility.length).toBeGreaterThanOrEqual(2);
    expect(visibility.at(-1)).toEqual(["receipt-Ev000000A1", 0]);
    expect(visibility.filter(([, seconds]) => seconds === 0)).toHaveLength(1);
  });

  it("logs a release that fails, and goes on to release the rest", async () => {
    const { queue, visibility } = fakeQueue(async () => []);
    const extend = queue.extendVisibility.bind(queue);
    queue.extendVisibility = async (receipt, seconds) => {
      if (receipt === "receipt-Ev000000A1") throw Object.assign(new Error("expired receipt"), { name: "ReceiptHandleIsInvalid" });
      return extend(receipt, seconds);
    };
    const logs: Array<[string, unknown]> = [];
    await processGroup(queue, async () => {
      throw new TurnHandedOffError();
    }, [queueMessage("Ev000000A1", "thread-a"), queueMessage("Ev000000A2", "thread-a")], groupOptions, (event, fields) => logs.push([event, fields]));
    expect(visibility).toEqual([["receipt-Ev000000A2", 0]]);
    expect(logs).toContainEqual(["message.release_failed", { errorName: "ReceiptHandleIsInvalid" }]);
  });
});
