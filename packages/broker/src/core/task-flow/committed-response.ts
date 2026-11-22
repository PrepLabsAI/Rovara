import { COMMITTED_REFRESH_NEEDED_MESSAGE, agentXError, type AgentXError } from "@agentx/contracts";

/** Only after a confirmed commit or matching replay: a failed response read must never look like a refused write. */
export async function committedResponse<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    // Keep access checks in the read; disclose neither task data nor the failed projection's internal words.
    throw agentXError("COMMITTED_REFRESH_NEEDED", COMMITTED_REFRESH_NEEDED_MESSAGE);
  }
}

/** A failed move with a competing request is key reuse; a task that merely moved on is stale. */
export function ownerMoveConflict(conflictingRequest: boolean, staleMessage: string): AgentXError {
  return agentXError(conflictingRequest ? "IDEMPOTENCY_CONFLICT" : "CHANGE_STALE", conflictingRequest
    ? "this request ID was already used for another decision on this task; use a new one"
    : staleMessage);
}
