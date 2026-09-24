const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

export interface RemoteOperationStatus {
  id: string;
  status: string;
  result?: unknown;
  error?: string | undefined;
}

export interface RemoteEventPage {
  events: Array<{ sequence: number; type: string; timestamp: string; payload: unknown }>;
  cursor?: string;
}

export interface OperationPollingTransport {
  getOperation(operationId: string): Promise<RemoteOperationStatus>;
  getEvents(operationId: string, cursor?: string): Promise<RemoteEventPage>;
}

export async function pollOperation(
  operationId: string,
  transport: OperationPollingTransport,
  options: {
    cursor?: string;
    intervalMilliseconds?: number;
    signal?: AbortSignal;
    onEvents?: (events: RemoteEventPage["events"]) => void;
  } = {},
): Promise<{ operation: RemoteOperationStatus; cursor?: string }> {
  let cursor = options.cursor;
  const interval = options.intervalMilliseconds ?? 1_000;
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason;
    const page = await transport.getEvents(operationId, cursor);
    if (page.events.length > 0) options.onEvents?.(page.events);
    const hasAnotherPage = page.cursor !== undefined;
    cursor = page.cursor ?? cursor;
    const operation = await transport.getOperation(operationId);
    if (TERMINAL.has(operation.status) && !hasAnotherPage) {
      return { operation, ...(cursor === undefined ? {} : { cursor }) };
    }
    if (!hasAnotherPage) await abortableDelay(interval, options.signal);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("operation polling aborted"));
        },
        { once: true },
      );
    }
  });
}
