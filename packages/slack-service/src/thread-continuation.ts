// Decision 147: once AgentX answered a person in a Slack thread, that person's plain replies there (for 24 hours after
// AgentX's last answer) count as addressed to it. The Slack service records whom it answered, after it handled their
// request; the Slack ingress reads it (isThreadContinuation). Best effort: a lost record only means the person mentions
// AgentX again.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { threadContinuationItems, type ContinuationThread } from "@agentx/contracts";
import type { ServiceLog } from "./processor.js";

export function createContinuationRecorder(deps: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  log: ServiceLog;
  now?: () => number;
}): (thread: ContinuationThread, userId: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (thread, userId) => {
    try {
      for (const item of threadContinuationItems(thread, userId, now())) {
        await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: item }));
      }
    } catch (error) {
      deps.log("thread_continuation.record_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  };
}
