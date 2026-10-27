import type { E2EModelSessionSync } from "@agentx/contracts";

/**
 * The client half of the session sync (MIDSTEPCOOKIE): what the executor does before each model call.
 *
 * It reads the browser's session values, sends the ones the worker has not acknowledged (in chunks the protocol allows, at least one sync even when there is nothing new), each with the next
 * sequence number, and returns the last sequence, which the call then names. A value counts as acknowledged only once the worker said so, so a sync that failed is sent again next time.
 * Sequence numbers are never reused, even after a failure, so a sync whose answer was lost cannot make the next one look stale.
 */
export interface E2EModelSessionSource {
  /** Every session value the browser holds and the process knows. Rejects when the browser's state cannot be read. */
  read(): Promise<readonly string[]>;
}

const MAX_VALUE_CHARS = 4_096;
/** More than this many unacknowledged values at once is not a real browser; the call is not made. */
const MAX_UNSENT_VALUES = 256;

export function createSessionSyncState(): { next(): number; acknowledged: Set<string> } {
  let seq = 0;
  return { next: () => (seq += 1), acknowledged: new Set<string>() };
}

export type SessionSyncState = ReturnType<typeof createSessionSyncState>;

export async function syncSessionBeforeCall(
  source: E2EModelSessionSource,
  state: SessionSyncState,
  send: (sync: E2EModelSessionSync) => Promise<boolean>,
  frame: { runId: string; maxValues: number; schemaVersion: E2EModelSessionSync["schemaVersion"] },
  failure: () => Error,
): Promise<number> {
  let values: readonly string[];
  try { values = await source.read(); } catch { throw failure(); }
  const unsent = [...new Set(values)].filter((value) => value !== "" && !state.acknowledged.has(value));
  if (unsent.length > MAX_UNSENT_VALUES || unsent.some((value) => value.length > MAX_VALUE_CHARS)) throw failure();
  const chunks: string[][] = [];
  for (let at = 0; at < unsent.length; at += frame.maxValues) chunks.push(unsent.slice(at, at + frame.maxValues));
  if (chunks.length === 0) chunks.push([]);
  let last = 0;
  for (const chunk of chunks) {
    const syncSeq = state.next();
    // A transport failure keeps the client's own error (unreachable, timed out, cancelled); a sync the worker did not accept is a `session-sync` failure.
    const accepted = await send({ schemaVersion: frame.schemaVersion, runId: frame.runId, syncSeq, values: chunk });
    if (!accepted) throw failure();
    for (const value of chunk) state.acknowledged.add(value);
    last = syncSeq;
  }
  return last;
}
