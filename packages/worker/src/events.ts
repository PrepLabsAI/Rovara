export interface WorkerEvent {
  type: "progress" | "tool_start" | "tool_end" | "result" | "error" | "lifecycle" | "usage";
  timestamp: string;
  payload: unknown;
}

/**
 * The most an event's payload may hold, as JSON: the control plane stores each event as one table item (400 KB at most),
 * and a model's message or a tool call can carry a whole file. A larger payload has its long strings cut, and failing that
 * its details dropped.
 */
export const WORKER_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
/** A string in an over-large payload keeps at most this many characters. */
const EVENT_STRING_MAX_CHARS = 8_192;

export type EventBatchSink = (events: readonly WorkerEvent[]) => Promise<void>;

/** Pending events wait at most this long before the batcher sends them (PLANINC-3a). Without it a sparse run held its events until the 25th. */
export const EVENT_BATCH_MAX_DELAY_MS = 5_000;

export interface EventAppendOptions {
  /** Send everything pending at once, not at the next full batch or timer tick. */
  urgent?: boolean;
}

export interface EventBatcherOptions {
  /** The longest an event waits in memory. Whole milliseconds from 10 to 60,000; `false` turns the timer off. */
  maxDelayMs?: number | false;
}

/** The Pi session event types that carry a model failure or a retry: a person reading the task needs them now, not at the next batch. */
const URGENT_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(["auto_retry_start", "auto_retry_end"]);

/**
 * Whether an event must leave the worker at once: a lifecycle change, an error, a sanitized model-call or deadline note, a Pi retry or a failed model message.
 * The first event of a run is urgent as well (the control plane moves the operation to RUNNING when it receives it); the batcher decides that itself.
 */
export function isUrgentWorkerEvent(type: WorkerEvent["type"], payload: unknown): boolean {
  if (type === "lifecycle" || type === "error") return true;
  if (payload === null || typeof payload !== "object") return false;
  const record = payload as { type?: unknown; modelCall?: unknown; message?: unknown };
  if (record.modelCall !== undefined) return true;
  if (typeof record.type === "string" && URGENT_SESSION_EVENT_TYPES.has(record.type)) return true;
  if (record.type === "message_end" && record.message !== null && typeof record.message === "object") {
    const stopReason = (record.message as { stopReason?: unknown }).stopReason;
    return stopReason === "error" || stopReason === "aborted";
  }
  return false;
}

export class EventBatcher {
  private pending: WorkerEvent[] = [];
  private appended = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Every send runs after the one before it, so batches reach the sink in the order the events were appended. */
  private sending: Promise<void> = Promise.resolve();
  private readonly maxDelayMs: number | undefined;

  constructor(
    private readonly sink: EventBatchSink,
    private readonly maximumBatchSize = 25,
    options: EventBatcherOptions = {},
  ) {
    if (!Number.isInteger(maximumBatchSize) || maximumBatchSize < 1 || maximumBatchSize > 500) {
      throw new Error("event batch size must be between 1 and 500");
    }
    const delay = options.maxDelayMs ?? EVENT_BATCH_MAX_DELAY_MS;
    if (delay !== false && (!Number.isInteger(delay) || delay < 10 || delay > 60_000)) {
      throw new Error("event batch delay must be between 10 and 60000 milliseconds");
    }
    this.maxDelayMs = delay === false ? undefined : delay;
  }

  async append(type: WorkerEvent["type"], payload: unknown, options: EventAppendOptions = {}): Promise<void> {
    const first = this.appended === 0;
    this.appended += 1;
    this.pending.push({ type, payload: boundedPayload(redactCredentials(payload)), timestamp: new Date().toISOString() });
    if (this.pending.length >= this.maximumBatchSize || first || options.urgent === true || isUrgentWorkerEvent(type, payload)) {
      await this.flush();
    } else {
      this.arm();
    }
  }

  /** Sends everything pending, after any send already under way. A refused batch stays pending, in order, and the error comes back to the caller. */
  flush(): Promise<void> {
    const run = this.sending.then(() => this.sendPending());
    this.sending = run.catch(() => undefined);
    return run;
  }

  /** Stops the timer. Pending events stay pending: flush them first if they matter. */
  close(): void {
    this.closed = true;
    this.disarm();
  }

  private arm(): void {
    if (this.maxDelayMs === undefined || this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A refused timer flush leaves the events pending for the next flush, which reports the error; it is not retried on a loop.
      void this.flush().catch(() => undefined);
    }, this.maxDelayMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async sendPending(): Promise<void> {
    this.disarm();
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, this.maximumBatchSize);
      this.pending = this.pending.slice(batch.length);
      try {
        await this.sink(batch);
      } catch (error) {
        this.pending = [...batch, ...this.pending];
        throw error;
      }
    }
  }
}

const payloadBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** `payload`, kept within WORKER_EVENT_PAYLOAD_MAX_BYTES. */
function boundedPayload(payload: unknown): unknown {
  if (payloadBytes(payload) <= WORKER_EVENT_PAYLOAD_MAX_BYTES) return payload;
  const cut = cutLongStrings(payload);
  if (payloadBytes(cut) <= WORKER_EVENT_PAYLOAD_MAX_BYTES) return cut;
  const type = payload !== null && typeof payload === "object" && typeof (payload as { type?: unknown }).type === "string" ? (payload as { type: string }).type.slice(0, 80) : undefined;
  return { ...(type === undefined ? {} : { type }), truncated: true, note: "This event was too large to keep, so AgentX dropped its details." };
}

function cutLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= EVENT_STRING_MAX_CHARS) return value;
    // Never split a surrogate pair.
    const end = /[\uD800-\uDBFF]/.test(value.charAt(EVENT_STRING_MAX_CHARS - 1)) ? EVENT_STRING_MAX_CHARS - 1 : EVENT_STRING_MAX_CHARS;
    return `${value.slice(0, end)}… [AgentX cut ${value.length - end} more characters]`;
  }
  if (Array.isArray(value)) return value.map(cutLongStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cutLongStrings(child)]));
  return value;
}

export function redactCredentials(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/https:\/\/[^/@\s]+:[^/@\s]+@/gi, "https://[REDACTED]@");
  }
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isCredentialKey(key, child) ? "[REDACTED]" : redactCredentials(child),
      ]),
    );
  }
  return value;
}

function isCredentialKey(key: string, value: unknown): boolean {
  // `tokens` is safe only for the numeric usage shape; singular and qualified token keys remain secrets.
  if (
    key.toLowerCase() === "tokens" && value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) return false;
  return /token|secret|password|authorization|credential/i.test(key);
}
