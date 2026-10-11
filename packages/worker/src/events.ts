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

export class EventBatcher {
  private pending: WorkerEvent[] = [];

  constructor(
    private readonly sink: EventBatchSink,
    private readonly maximumBatchSize = 25,
  ) {
    if (!Number.isInteger(maximumBatchSize) || maximumBatchSize < 1 || maximumBatchSize > 500) {
      throw new Error("event batch size must be between 1 and 500");
    }
  }

  async append(type: WorkerEvent["type"], payload: unknown): Promise<void> {
    this.pending.push({ type, payload: boundedPayload(redactCredentials(payload)), timestamp: new Date().toISOString() });
    if (this.pending.length >= this.maximumBatchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      await this.sink(batch);
    } catch (error) {
      this.pending = [...batch, ...this.pending];
      throw error;
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
