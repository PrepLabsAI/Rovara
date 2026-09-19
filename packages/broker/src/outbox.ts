import type { OperationStore, OutboxRecord } from "./operations.js";

export interface DispatchSink {
  dispatch(record: OutboxRecord): Promise<void>;
}

export class OutboxConsumer {
  constructor(
    readonly operations: OperationStore,
    readonly dispatcher: DispatchSink,
  ) {}

  async drain(): Promise<void> {
    for (const record of this.operations.pendingOutbox()) {
      this.operations.recordOutboxAttempt(record.id);
      await this.dispatcher.dispatch(record);
      this.operations.markOutboxDelivered(record.id);
    }
  }
}
