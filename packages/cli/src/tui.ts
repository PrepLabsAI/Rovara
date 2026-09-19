import { formatSuccess } from "./output.js";
import { pollOperation, type OperationPollingTransport, type RemoteEventPage } from "./event-client.js";

export function renderProgressEvent(event: RemoteEventPage["events"][number]): string {
  const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  return `[${event.sequence}] ${event.type}: ${payload}`;
}

export async function runSinglePromptJson(input: {
  prompt: string;
  submit: (prompt: string) => Promise<{ operationId: string }>;
  transport: OperationPollingTransport;
  intervalMilliseconds?: number;
}): Promise<string> {
  const accepted = await input.submit(input.prompt);
  const result = await pollOperation(accepted.operationId, input.transport, {
    ...(input.intervalMilliseconds === undefined ? {} : { intervalMilliseconds: input.intervalMilliseconds }),
  });
  return formatSuccess({ operation: result.operation, cursor: result.cursor ?? null }, true);
}
