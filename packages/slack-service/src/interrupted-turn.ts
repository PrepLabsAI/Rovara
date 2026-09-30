/**
 * Issue 157: a deploy stops the Slack service while a turn waits on the worker. The old task hands
 * the turn off before ECS kills it, and the redelivered message re-attaches to the worker operation
 * the thread remembered, posting its result instead of running the model (and any approved call)
 * again.
 */

/** The worker operation a turn was waiting on, kept on the thread's META row until the turn ends. */
export interface ActiveTurn {
  eventId: string;
  workspaceId: string;
  operationId: string;
}

/**
 * How long after SIGTERM a turn may still finish on its own before it is handed off. Fargate's
 * stopTimeout is 120 seconds (its maximum), so this leaves time to post the notice and release
 * the message before SIGKILL.
 */
export const HANDOFF_MILLISECONDS = 90_000;

export const HANDOFF_TASK_TEXT = "AgentX restarted while working on this. The task is still running; I'll post its result here.";
export const HANDOFF_TEXT = "AgentX restarted while working on this. I'll pick this request up again in a moment.";
export const HANDOFF_FINAL_TEXT = "AgentX restarted while working on this and has already retried it too many times, so I stopped. Ask me to check on it, or ask again.";
export const CONTINUE_TEXT = "Ask me to continue for any step after this one (for example the pull request).";

/** Thrown by a turn handed off at the deadline; the consumer releases its message at once. */
export class TurnHandedOffError extends Error {
  override readonly name = "TurnHandedOffError";

  constructor() {
    super("the turn was handed off to a new task");
  }
}

/** The resumed turn's reply: the operation's result or failure reason, then how to go on. */
export function resumedResultText(result: { status: string; response?: string | undefined; error?: string | undefined }): string {
  const head = result.status === "SUCCEEDED"
    ? result.response === undefined || result.response.trim().length === 0
      ? "The task that was running when AgentX restarted has finished, without a final message."
      : `The task that was running when AgentX restarted has finished:\n${result.response}`
    : `The task that was running when AgentX restarted ended as ${result.status.toLowerCase()}${result.error ? `: ${result.error}` : "."}`;
  return `${head}\n\n${CONTINUE_TEXT}`;
}

/** The META row's activeTurn, or undefined when it is missing or unreadable. */
export function activeTurnFromItem(value: unknown): ActiveTurn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { eventId, workspaceId, operationId } = value as Record<string, unknown>;
  return typeof eventId === "string" && typeof workspaceId === "string" && typeof operationId === "string"
    && eventId.length > 0 && workspaceId.length > 0 && operationId.length > 0
    ? { eventId, workspaceId, operationId }
    : undefined;
}
