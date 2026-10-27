import { E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES, E2E_MODEL_SESSION_SYNC_MAX_VALUES, boundSessionValue, type E2EModelSessionSync, type E2EModelSessionSyncReply } from "@agentx/contracts";

/**
 * The client half of the session sync (MIDSTEPCOOKIE): what the executor does before each model call.
 *
 * It reads the browser's session values, sends the ones the worker has not acknowledged (in chunks the protocol allows by count and by bytes; at least one sync even when there is nothing
 * new), and returns the token of the last sync, which the call then names. The token is issued by the worker, so this client keeps no counter that another client of the same proxy
 * (another shard of the group) could collide with. A value counts as acknowledged only once the worker said so, so a sync that failed is sent again next time. If the proxy's `epoch`
 * changes (it was replaced), everything is sent again.
 *
 * A value longer than the protocol carries is sent as its head and its tail (`boundSessionValue`): the call is never stopped for it. What that covers is in the report: any prompt that
 * shows the whole value shows both ends, and is refused; a prompt that shows only the middle is not caught by the worker.
 */
export interface E2EModelSessionSource {
  /** Every session value the browser holds and the process knows. Rejects when the browser's state cannot be read. */
  read(): Promise<readonly string[]>;
}

/** More than this many unacknowledged values at once is not a real browser; the call is not made. */
const MAX_UNSENT_VALUES = 256;

export function createSessionSyncState(): { acknowledged: Set<string>; epoch: string | null } {
  return { acknowledged: new Set<string>(), epoch: null };
}
export type SessionSyncState = ReturnType<typeof createSessionSyncState>;

/** The groups of values to send: at most `E2E_MODEL_SESSION_SYNC_MAX_VALUES` per sync and `E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES` per body. A value stays with its own head and tail. */
function chunked(unsent: readonly string[]): Array<Array<{ original: string; forms: string[] }>> {
  const chunks: Array<Array<{ original: string; forms: string[] }>> = [];
  let current: Array<{ original: string; forms: string[] }> = [];
  let count = 0;
  let size = 0;
  for (const original of unsent) {
    const forms = boundSessionValue(original);
    const formBytes = forms.reduce((sum, form) => sum + Buffer.byteLength(JSON.stringify(form), "utf8") + 1, 0);
    if (current.length > 0 && (count + forms.length > E2E_MODEL_SESSION_SYNC_MAX_VALUES || size + formBytes > E2E_MODEL_SESSION_SYNC_MAX_BODY_BYTES - 1_000)) {
      chunks.push(current);
      current = [];
      count = 0;
      size = 0;
    }
    current.push({ original, forms });
    count += forms.length;
    size += formBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function syncSessionBeforeCall(
  source: E2EModelSessionSource,
  state: SessionSyncState,
  send: (sync: E2EModelSessionSync) => Promise<E2EModelSessionSyncReply | null>,
  frame: { runId: string; schemaVersion: E2EModelSessionSync["schemaVersion"] },
  failure: () => Error,
  attempt = 0,
): Promise<string> {
  let values: readonly string[];
  try { values = await source.read(); } catch { throw failure(); }
  const unsent = [...new Set(values)].filter((value) => value !== "" && !state.acknowledged.has(value));
  if (unsent.length > MAX_UNSENT_VALUES) throw failure();
  const chunks = chunked(unsent);
  if (chunks.length === 0) chunks.push([]);
  let last = "";
  for (const chunk of chunks) {
    // A transport failure keeps the client's own error (unreachable, timed out, cancelled); a sync the worker did not accept is a `session-sync` failure.
    const reply = await send({ schemaVersion: frame.schemaVersion, runId: frame.runId, values: chunk.flatMap((item) => item.forms) });
    if (reply === null) throw failure();
    if (state.epoch !== null && reply.epoch !== state.epoch) {
      // The proxy was replaced: it knows none of what was acknowledged. Start again once, with everything unacknowledged.
      state.epoch = reply.epoch;
      state.acknowledged.clear();
      if (attempt >= 1) throw failure();
      return syncSessionBeforeCall(source, state, send, frame, failure, attempt + 1);
    }
    state.epoch = reply.epoch;
    for (const item of chunk) state.acknowledged.add(item.original);
    last = reply.syncToken;
  }
  return last;
}
