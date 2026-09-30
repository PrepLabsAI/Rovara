import { SlackRequestMessageSchema, type SlackRequestMessage } from "@agentx/contracts";
import { HANDOFF_MILLISECONDS, TurnHandedOffError } from "./interrupted-turn.js";
import type { ServiceLog } from "./processor.js";

export interface QueueMessage {
  body: string;
  receiptHandle: string;
  groupId: string;
  receiveCount: number;
  /** How many earlier requests the ingress queued this one behind; absent from an older ingress. */
  queuedBehind?: number;
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
  /** Stops the consumer: no new receive or message starts, and running turns get until the hand-off deadline. */
  signal: AbortSignal;
  /** Issue 157: how long after the stop a running turn may finish before it is handed off. */
  handoffMilliseconds?: number;
  log?: ServiceLog;
}

export type RequestHandler = (message: SlackRequestMessage, context: {
  finalAttempt: boolean;
  queuedBehind?: number;
  redelivered?: boolean;
  /** Issue 157: aborted at the hand-off deadline after the stop. */
  handoff?: AbortSignal;
}) => Promise<void>;

type GroupOptions = Pick<ConsumerOptions, "maxReceiveCount" | "visibilitySeconds" | "heartbeatMilliseconds"> & {
  /** Once aborted, a later message of the group is released rather than started. */
  stop?: AbortSignal;
  handoff?: AbortSignal;
};

// Each Slack thread is one FIFO message group: its messages run one at a time, and different threads run in parallel.
export async function runConsumer(queue: QueueClient, handle: RequestHandler, options: ConsumerOptions): Promise<void> {
  const log: ServiceLog = options.log ?? (() => undefined);
  const active = new Set<Promise<void>>();
  // Issue 157: the hand-off deadline starts with the stop, and sits under Fargate's 120-second stopTimeout.
  const handoff = new AbortController();
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const startHandoffClock = () => {
    handoffTimer = setTimeout(() => handoff.abort(), options.handoffMilliseconds ?? HANDOFF_MILLISECONDS);
    handoffTimer.unref?.();
  };
  if (options.signal.aborted) startHandoffClock();
  else options.signal.addEventListener("abort", startHandoffClock, { once: true });
  const groupOptions: GroupOptions = { ...options, stop: options.signal, handoff: handoff.signal };
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
    // The receive is never aborted: SQS may already have taken the messages, and an aborted
    // request would leave them hidden for the whole visibility timeout. What it returns after the
    // stop is released instead.
    if (options.signal.aborted) {
      await release(queue, messages, "stopping", log);
      break;
    }
    for (const group of groupMessages(messages)) {
      const task: Promise<void> = processGroup(queue, handle, group, groupOptions, log).finally(() => active.delete(task));
      active.add(task);
    }
  }
  await Promise.allSettled(active);
  clearTimeout(handoffTimer);
  options.signal.removeEventListener("abort", startHandoffClock);
}

export async function processGroup(
  queue: QueueClient,
  handle: RequestHandler,
  group: readonly QueueMessage[],
  options: GroupOptions,
  log: ServiceLog,
): Promise<void> {
  for (const [index, entry] of group.entries()) {
    if (options.stop?.aborted === true) {
      await release(queue, group.slice(index), "stopping", log);
      return;
    }
    let beat: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      beat = queue.extendVisibility(entry.receiptHandle, options.visibilitySeconds).catch((error: unknown) => {
        log("queue.heartbeat_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      });
    }, options.heartbeatMilliseconds);
    try {
      const parsed = SlackRequestMessageSchema.safeParse(parseJson(entry.body));
      if (!parsed.success) {
        log("message.discarded", { reason: "invalid_message" });
      } else {
        await handle(parsed.data, {
          finalAttempt: entry.receiveCount >= options.maxReceiveCount,
          ...(entry.queuedBehind === undefined ? {} : { queuedBehind: entry.queuedBehind }),
          // SQS redelivers after the visibility timeout expires on an earlier, non-final attempt; the
          // member was told "Working on it now" for that attempt, so a fresh one says so again rather
          // than restarting silently.
          ...(entry.receiveCount > 1 ? { redelivered: true } : {}),
          ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
        });
      }
      await queue.delete(entry.receiptHandle);
    } catch (error) {
      if (error instanceof TurnHandedOffError) {
        // Issue 157: the new task takes this and the rest of the thread now, in order. The heartbeat
        // stops first, and one already sent lands first, so none can hide a released message again.
        clearInterval(heartbeat);
        await beat;
        await release(queue, group.slice(index), "handed_off", log);
        return;
      }
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

/** Makes the messages visible again at once, so another task receives them; one failure does not stop the rest. */
async function release(queue: QueueClient, messages: readonly QueueMessage[], reason: "stopping" | "handed_off", log: ServiceLog): Promise<void> {
  if (messages.length === 0) return;
  for (const message of messages) {
    try {
      await queue.extendVisibility(message.receiptHandle, 0);
    } catch (error) {
      log("message.release_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  log("message.released", { reason, count: messages.length });
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
