import { tellBrowserState, type BrowserSecretState } from "./browser-state-secrets.js";
import { tierWins, type ClassifiedValue, type CredentialTier } from "./credential-classifier.js";
import { registerOptionsFor, type SessionSecretRegisterOptions } from "./session-secret-registry.js";

/**
 * The executor's source of session values for the model channel's sync (MIDSTEPCOOKIE).
 *
 * Before EVERY model call the channel client asks `read()` for the session values the browser holds right now, and tells the worker the ones it has not been told. `read()`:
 * 1. waits for the response headers already seen to be read (so a `Set-Cookie` of an answer that has arrived is registered before the browser is asked),
 * 2. asks every attached browser context (a signed-out visitor's included, with the visitor bar: the app can issue a token to a visitor mid-step, but an id or a cart is not a secret) for its state (cookies, local storage, session storage, IndexedDB and the URLs its frames are at; it is the browser's own jar, so a cookie set
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
  /** A session's browser context, until `detach`. A signed-out visitor's context (`anonymous`) is read too, with the visitor bar: only what names or shapes a login credential counts, not an id or a cart. */
  attach(sessionRef: string, context: E2ESessionStateReader, options?: { anonymous: boolean }): void;
  detach(sessionRef: string): void;
}

export const E2E_SESSION_SYNC_PENDING_LIMIT_MS = 5_000;
/** At most this many weak values are written for the evidence scrub per process; the ones after them are held for the model's mask only (a much larger bound, in the registry), never dropped silently. */
export const E2E_SESSION_SYNC_MAX_WEAK_VALUES = 2_000;

export function createE2ESessionSyncSource(options: {
  register(value: string, options?: SessionSecretRegisterOptions): void;
  known(): readonly string[];
  pendingLimitMs?: number;
}): E2ESessionSyncSource {
  const contexts = new Map<string, { reader: E2ESessionStateReader; visitor: boolean }>();
  // A value read again on every call is registered once: registering writes to a file the parent reads. A weak value is registered again if it later turns out to be a credential.
  const seen = new Map<string, CredentialTier>();
  let evidenceRegistered = 0;
  const register = (item: ClassifiedValue): void => {
    // An overflow item has no value: one note is enough.
    const key = item.tier === "overflow" ? "" : item.value;
    const before = seen.get(key);
    if (!tierWins(item.tier, before)) return;
    let tier: CredentialTier = item.tier;
    // Weak and scrub-only values are written for the evidence scrub up to the cap. A weak value past it goes to the mask-only set (the model must still not see it); a scrub-only value past it is
    // an ordinary value the model may read, and is not held.
    if ((tier === "weak" || tier === "scrub") && before === undefined) {
      if (evidenceRegistered >= E2E_SESSION_SYNC_MAX_WEAK_VALUES) { if (tier === "scrub") return; tier = "mask"; }
    }
    // Remembered only once registered: if registering fails (the file the parent reads cannot be written), the call is refused and the value is tried again on the next one.
    const registerOptions = registerOptionsFor(tier);
    if (registerOptions === undefined) options.register(item.value); else options.register(item.value, registerOptions);
    if ((tier === "weak" || tier === "scrub") && before === undefined) evidenceRegistered += 1;
    seen.set(key, item.tier);
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
    attach(sessionRef, context, attachOptions): void { contexts.set(sessionRef, { reader: context, visitor: attachOptions?.anonymous === true }); },
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
        const state = await context.reader.storageState();
        tellBrowserState(state, register, classified, { visitor: context.visitor });
      }
      return options.known();
    },
  };
}
