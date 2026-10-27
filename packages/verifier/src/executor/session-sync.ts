import { tellBrowserState, type BrowserSecretState } from "./browser-state-secrets.js";
import type { ClassifiedValue, CredentialTier } from "./credential-classifier.js";

/**
 * The executor's source of session values for the model channel's sync (MIDSTEPCOOKIE).
 *
 * Before EVERY model call the channel client asks `read()` for the session values the browser holds right now, and tells the worker the ones it has not been told. `read()`:
 * 1. waits for the response headers already seen to be read (so a `Set-Cookie` of an answer that has arrived is registered before the browser is asked),
 * 2. asks every attached, non-anonymous browser context for its state (cookies, local storage, session storage, IndexedDB and the URLs its frames are at; it is the browser's own jar, so a cookie set
 *    by a script, a redirect or a header is in it) and classifies every value in it (`tellBrowserState`): a cookie that looks like a secret, a storage value or a JSON leaf of one that is a credential
 *    (strong: refused if a prompt shows it) or probably app data that may be secret (weak: scrubbed only), a secret-looking URL parameter,
 * 3. returns every session value this process knows. Values the request capture learned (`learn`: headers, URLs) are among them.
 * Anything that cannot be read (a context that will not answer, a header read that does not finish) throws, and the model call is not made: the scan is never allowed to be older than the browser.
 */
export interface E2ESessionStateReader {
  storageState(): Promise<BrowserSecretState>;
}

export interface E2ESessionSyncSource {
  /** Every session value the process knows, after the browser's own state has been read and registered. Rejects when the state cannot be read. */
  read(): Promise<readonly string[]>;
  /** A response-header or request-header read in progress; `read()` waits for it. */
  track(pending: Promise<unknown>): void;
  /** Values the request capture saw (a header, a URL parameter), with their tier. Each value is registered once; a weak one is registered again if it later turns out strong. */
  learn(items: readonly ClassifiedValue[]): void;
  /** A session's browser context, until `detach`. An anonymous visitor's context holds no credential and is left out. */
  attach(sessionRef: string, context: E2ESessionStateReader, options: { anonymous: boolean }): void;
  detach(sessionRef: string): void;
}

export const E2E_SESSION_SYNC_PENDING_LIMIT_MS = 5_000;
/** At most this many evidence-only values are registered per process. */
export const E2E_SESSION_SYNC_MAX_WEAK_VALUES = 2_000;

export function createE2ESessionSyncSource(options: {
  register(value: string, options?: { evidenceOnly?: boolean }): void;
  known(): readonly string[];
  pendingLimitMs?: number;
}): E2ESessionSyncSource {
  const contexts = new Map<string, E2ESessionStateReader>();
  // A value read again on every call is registered once: registering writes to a file the parent reads. A weak value is registered again if it later turns out to be a credential.
  const seen = new Map<string, CredentialTier>();
  let weakRegistered = 0;
  const register = (item: ClassifiedValue): void => {
    const before = seen.get(item.value);
    if (before === "strong" || (before === "weak" && item.tier === "weak")) return;
    // Weak values are only scrubbed, never refused: past the cap no more are added (the cost of registering one is paid by every later scan).
    if (item.tier === "weak" && before === undefined) { if (weakRegistered >= E2E_SESSION_SYNC_MAX_WEAK_VALUES) return; }
    // Remembered only once registered: if registering fails (the file the parent reads cannot be written), the call is refused and the value is tried again on the next one.
    if (item.tier === "weak") options.register(item.value, { evidenceOnly: true });
    else options.register(item.value);
    if (item.tier === "weak" && before === undefined) weakRegistered += 1;
    seen.set(item.value, item.tier);
  };
  // What the browser state held that was classified already: the whole browser is read before every model call.
  const classified = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  return {
    track(promise: Promise<unknown>): void {
      const settled = promise.then(() => undefined, () => undefined);
      pending.add(settled);
      void settled.then(() => { pending.delete(settled); });
    },
    learn(items): void { for (const item of items) register(item); },
    attach(sessionRef, context, attachOptions): void {
      if (!attachOptions.anonymous) contexts.set(sessionRef, context);
    },
    detach(sessionRef): void { contexts.delete(sessionRef); },
    async read(): Promise<readonly string[]> {
      if (pending.size > 0) {
        let limit: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          Promise.all([...pending]).then(() => false),
          new Promise<boolean>((resolve) => { limit = setTimeout(() => resolve(true), options.pendingLimitMs ?? E2E_SESSION_SYNC_PENDING_LIMIT_MS); }),
        ]).finally(() => clearTimeout(limit));
        if (timedOut) throw new Error("response headers were not read in time");
      }
      for (const context of [...contexts.values()]) {
        const state = await context.storageState();
        tellBrowserState(state, register, classified);
      }
      return options.known();
    },
  };
}
