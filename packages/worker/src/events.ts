export interface WorkerEvent {
  type: "progress" | "tool_start" | "tool_end" | "result" | "error" | "lifecycle" | "usage";
  timestamp: string;
  payload: unknown;
}

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
    this.pending.push({ type, payload: redactCredentials(payload), timestamp: new Date().toISOString() });
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
