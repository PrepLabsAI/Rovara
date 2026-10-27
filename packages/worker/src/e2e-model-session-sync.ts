import {
  E2E_MODEL_SESSION_SYNC_CALL_REFUSALS,
  E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES,
  E2EModelSessionSyncSchema,
  type E2EModelSessionSyncRefusalCode,
} from "@agentx/contracts";

/**
 * The worker's side of the session sync (MIDSTEPCOOKIE): the sequence rules and the set of session values the executor has taught the proxy.
 *
 * The proxy refuses a model call unless it names the NEWEST sync the executor sent and no earlier call has used that sync. So every call is preceded by its own sync, and a sync that is
 * missing, replayed, or overtaken by a newer one cannot cover a call. The values of every accepted sync are added to the credential scan before the call that names it is looked at.
 * Nothing here holds or returns a value except `accept`'s list of values that are new, which the proxy adds to its scan.
 */
export type SessionSyncOutcome = { ok: true; added: string[] } | { ok: false; code: E2EModelSessionSyncRefusalCode };
export type SessionSyncCallCheck = { ok: true } | { ok: false; message: string };

export interface E2ESessionSyncLedger {
  /** Validates a sync body (already parsed JSON) and, if it is the next in order for this run, records it. A refused sync changes nothing. */
  accept(body: unknown, runId: string): SessionSyncOutcome;
  /** Whether a call that names `syncSeq` is covered. It marks that sync used either way, so a later call needs a newer one. */
  useForCall(syncSeq: number | undefined): SessionSyncCallCheck;
  readonly latestSeq: number;
}

export function createE2ESessionSyncLedger(): E2ESessionSyncLedger {
  let latest = 0;
  let used = 0;
  const known = new Set<string>();
  return {
    get latestSeq() { return latest; },
    accept(body, runId): SessionSyncOutcome {
      const parsed = E2EModelSessionSyncSchema.safeParse(body);
      if (!parsed.success) return { ok: false, code: "invalid-sync" };
      const sync = parsed.data;
      if (sync.runId !== runId) return { ok: false, code: "other-run" };
      if (sync.syncSeq <= latest) return { ok: false, code: "stale-sync" };
      const fresh = [...new Set(sync.values)].filter((value) => !known.has(value));
      if (known.size + fresh.length > E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES) return { ok: false, code: "too-many-values" };
      for (const value of fresh) known.add(value);
      latest = sync.syncSeq;
      return { ok: true, added: fresh };
    },
    useForCall(syncSeq): SessionSyncCallCheck {
      if (syncSeq === undefined) return { ok: false, message: E2E_MODEL_SESSION_SYNC_CALL_REFUSALS.missing };
      const covered = syncSeq === latest && syncSeq > used;
      // Whatever the outcome, the newest sync is spent: the executor must sync again before its next call.
      used = Math.max(used, latest);
      return covered ? { ok: true } : { ok: false, message: E2E_MODEL_SESSION_SYNC_CALL_REFUSALS.stale };
    },
  };
}
