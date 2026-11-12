// Decision 147: once AgentX answered a person in a Slack thread, that person's plain replies there (for 24 hours after
// AgentX's last answer) count as addressed to it. The Slack service records whom it answered, after it handled their
// request; the Slack ingress reads it (threadContinuationOf). Decision 148: an answer from the chat assistant also marks
// the thread as the assistant's, so a continued request there goes to the assistant. Best effort: a lost record only
// means the person mentions AgentX again.
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { threadContinuationPersonItem, threadContinuationThreadUpdate, type ContinuationThread } from "@agentx/contracts";
import type { ServiceLog } from "./processor.js";

export function createContinuationRecorder(deps: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  log: ServiceLog;
  now?: () => number;
}): (thread: ContinuationThread, userId: string, options?: { assistant?: boolean }) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (thread, userId, options = {}) => {
    try {
      const at = now();
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, ...threadContinuationThreadUpdate(thread, at, options.assistant === true) }));
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: threadContinuationPersonItem(thread, userId, at) }));
    } catch (error) {
      deps.log("thread_continuation.record_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  };
}
