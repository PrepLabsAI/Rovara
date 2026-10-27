import { randomBytes } from "node:crypto";
import {
  E2E_MODEL_SESSION_SYNC_CALL_REFUSALS,
  E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES,
  E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES,
  E2EModelSessionSyncSchema,
  type E2EModelSessionSyncRefusalCode,
} from "@agentx/contracts";
import { e2eSecretSpellingsDetailed } from "./e2e-secret-spellings.js";

/**
 * The worker's side of the session sync (MIDSTEPCOOKIE): the sync token and the set of session values the executor has taught the proxy.
 *
 * Every accepted sync gets a fresh random token (128 bits, issued here, so no executor client keeps a counter that could collide with another client's on the same proxy). Only the newest
 * token is held. The next `/v1/generate` request of any kind spends it (`beginCall`), and the call is served only if it names exactly that token (`useForCall`). So every call is preceded by
 * a sync of its own, and a missing, unknown, older or reused token cannot cover a call, whichever executor client sent it.
 *
 * The scan work is bounded too: the run's values, their bytes, and the characters of every spelling the guard scans for (`MAX_NEEDLE_CHARS`) have caps, and a sync past one is refused.
 * The spellings of a value are computed once, here, and the guard is given them.
 */
export type SessionSyncOutcome = { ok: true; added: string[]; syncToken: string; epoch: string } | { ok: false; code: E2EModelSessionSyncRefusalCode };
export type SessionSyncCallCheck = { ok: true } | { ok: false; message: string };

/** The most characters of spellings the guard scans every prompt for, for the values of the sync. At about 14 spellings of each value this is some 70 KB of values; each prompt scan stays a few milliseconds. */
export const E2E_SESSION_SYNC_MAX_NEEDLE_CHARS = 1_000_000;

export interface E2ESessionSyncLedger {
  /** Validates a sync body (already parsed JSON) and, if it is for this run and within the caps, records it and issues the token the next call must name. A refused sync changes nothing. */
  accept(body: unknown, runId: string): SessionSyncOutcome;
  /** A `/v1/generate` request arrived: the newest token is spent now, whatever the request turns out to be. */
  beginCall(): void;
  /** Whether the call that names `token` is covered by the sync that directly preceded it. */
  useForCall(token: string | undefined): SessionSyncCallCheck;
  /** The spellings the guard scans for, for a value this ledger accepted. */
  spellingsOf(value: string): string[];
  /** How many accepted values could not be given every spelling (a lone surrogate has no percent-encoded form). Their other forms, the raw one included, are scanned. */
  readonly spellingGaps: number;
}

export function createE2ESessionSyncLedger(): E2ESessionSyncLedger {
  const epoch = randomBytes(8).toString("hex");
  let pending: string | null = null;
  let armed: string | null = null;
  const known = new Map<string, string[]>();
  let bytes = 0;
  let needleChars = 0;
  let gaps = 0;
  return {
    get spellingGaps() { return gaps; },
    accept(body, runId): SessionSyncOutcome {
      // A refused sync leaves no token that could be used: whoever sent it does not call.
      pending = null;
      const parsed = E2EModelSessionSyncSchema.safeParse(body);
      if (!parsed.success) return { ok: false, code: "invalid-sync" };
      const sync = parsed.data;
      if (sync.runId !== runId) return { ok: false, code: "other-run" };
      const fresh = [...new Set(sync.values)].filter((value) => !known.has(value));
      const detailed = fresh.map((value) => e2eSecretSpellingsDetailed(value));
      const spellings = detailed.map((item) => item.forms);
      const addedBytes = fresh.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
      const addedChars = spellings.reduce((sum, forms) => sum + forms.reduce((inner, form) => inner + form.length, 0), 0);
      if (known.size + fresh.length > E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES || bytes + addedBytes > E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES
        || needleChars + addedChars > E2E_SESSION_SYNC_MAX_NEEDLE_CHARS) return { ok: false, code: "too-many-values" };
      fresh.forEach((value, index) => known.set(value, spellings[index]!));
      bytes += addedBytes;
      needleChars += addedChars;
      gaps += detailed.filter((item) => item.skipped.length > 0).length;
      pending = randomBytes(16).toString("hex");
      return { ok: true, added: fresh, syncToken: pending, epoch };
    },
    beginCall(): void {
      armed = pending;
      pending = null;
    },
    useForCall(token): SessionSyncCallCheck {
      if (token === undefined) return { ok: false, message: E2E_MODEL_SESSION_SYNC_CALL_REFUSALS.missing };
      return armed !== null && token === armed ? { ok: true } : { ok: false, message: E2E_MODEL_SESSION_SYNC_CALL_REFUSALS.stale };
    },
    spellingsOf(value): string[] { return known.get(value) ?? e2eSecretSpellingsDetailed(value).forms; },
  };
}
