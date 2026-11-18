// The task log's "something was added" hook. The code that records an entry in its own transaction (an answer, a question asked, an approval) calls `changed(taskId)` once the change is committed, and each surface that
// draws the log (the ticket renderer today) is told, so it can bring its own place up to date. A subscriber that throws is logged and never fails the change: the log is already written, and the surface catches up at
// the next one (or the next milestone).
export interface TaskLogHooks {
  /** A surface that draws the log. Returns the function that removes it. */
  subscribe(handler: (taskId: string) => Promise<void>): () => void;
  /** The log of this task gained entries (committed). Never throws. */
  changed(taskId: string): Promise<void>;
}

export function createTaskLogHooks(log?: (event: string, fields: Record<string, unknown>) => void): TaskLogHooks {
  const subscribers: Array<(taskId: string) => Promise<void>> = [];
  return {
    subscribe(handler) {
      subscribers.push(handler);
      return () => {
        const at = subscribers.indexOf(handler);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
    async changed(taskId) {
      for (const handler of [...subscribers]) {
        try {
          await handler(taskId);
        } catch (error) {
          log?.("task_log.subscriber_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
    },
  };
}
