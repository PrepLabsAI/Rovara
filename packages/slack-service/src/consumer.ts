import { SlackRequestMessageSchema, type SlackRequestMessage } from "@agentx/contracts";
import type { ServiceLog } from "./processor.js";

export interface QueueMessage {
  body: string;
  receiptHandle: string;
  groupId: string;
  receiveCount: number;
}

export interface QueueClient {
  receive(maximum: number): Promise<QueueMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  extendVisibility(receiptHandle: string, seconds: number): Promise<void>;
}

export interface ConsumerOptions {
  concurrency: number;
  maxReceiveCount: number;
  visibilitySeconds: number;
  heartbeatMilliseconds: number;
  signal: AbortSignal;
  log?: ServiceLog;
}

export type RequestHandler = (message: SlackRequestMessage, context: { finalAttempt: boolean }) => Promise<void>;

// Each Slack thread is one FIFO message group: its messages run one at a time, and different threads run in parallel.
export async function runConsumer(queue: QueueClient, handle: RequestHandler, options: ConsumerOptions): Promise<void> {
  const log: ServiceLog = options.log ?? (() => undefined);
  const active = new Set<Promise<void>>();
  while (!options.signal.aborted) {
    if (active.size >= options.concurrency) {
      await Promise.race(active);
      continue;
    }
    let messages: QueueMessage[];
    try {
      messages = await queue.receive(Math.min(10, options.concurrency - active.size));
    } catch (error) {
      log("queue.receive_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      await delay(5_000, options.signal);
      continue;
    }
    for (const group of groupMessages(messages)) {
      const task: Promise<void> = processGroup(queue, handle, group, options, log).finally(() => active.delete(task));
      active.add(task);
    }
  }
  await Promise.allSettled(active);
}

export async function processGroup(
  queue: QueueClient,
  handle: RequestHandler,
  group: readonly QueueMessage[],
  options: Pick<ConsumerOptions, "maxReceiveCount" | "visibilitySeconds" | "heartbeatMilliseconds">,
  log: ServiceLog,
): Promise<void> {
  for (const entry of group) {
    const heartbeat = setInterval(() => {
      queue.extendVisibility(entry.receiptHandle, options.visibilitySeconds).catch((error: unknown) => {
        log("queue.heartbeat_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      });
    }, options.heartbeatMilliseconds);
    try {
      const parsed = SlackRequestMessageSchema.safeParse(parseJson(entry.body));
      if (!parsed.success) {
        log("message.discarded", { reason: "invalid_message" });
      } else {
        await handle(parsed.data, { finalAttempt: entry.receiveCount >= options.maxReceiveCount });
      }
      await queue.delete(entry.receiptHandle);
    } catch (error) {
      // Leave this and later messages of the thread in flight; SQS redelivers them in order after the visibility timeout.
      log("message.retry_scheduled", {
        receiveCount: entry.receiveCount,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function groupMessages(messages: readonly QueueMessage[]): QueueMessage[][] {
  const groups = new Map<string, QueueMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.groupId) ?? [];
    group.push(message);
    groups.set(message.groupId, group);
  }
  return [...groups.values()];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
