import type { DispatchSink } from "./outbox.js";
import type { OutboxRecord } from "./operations.js";

export class RetryingDispatcher implements DispatchSink {
  constructor(
    readonly sink: DispatchSink,
    readonly options: { maxAttempts: number; baseDelayMs: number },
  ) {
    if (options.maxAttempts < 1) throw new Error("maxAttempts must be positive");
  }

  async dispatch(record: OutboxRecord): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        await this.sink.dispatch(record);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxAttempts && this.options.baseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.options.baseDelayMs * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }
}
