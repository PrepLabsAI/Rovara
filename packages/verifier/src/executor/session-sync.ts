import { isSessionCookieSecret } from "./form-login.js";
import { isSessionStorageCredential } from "./session-storage-secret.js";

/**
 * The executor's source of session values for the model channel's sync (MIDSTEPCOOKIE).
 *
 * Before EVERY model call the channel client asks `read()` for the session values the browser holds right now, and tells the worker the ones it has not been told. `read()`:
 * 1. waits for the response headers already seen to be read (so a `Set-Cookie` of an answer that has arrived is registered before the browser is asked),
 * 2. asks every attached, non-anonymous browser context for its state (cookies and local storage; it is the browser's own jar, so a cookie set by a script, a redirect or a header is in it),
 *    and registers each cookie that looks like a secret (`isSessionCookieSecret`: a short or common value is not a secret) and each local storage entry that is a credential
 *    (`isSessionStorageCredential`, which reads the key as well as the value: a draft or a `returnTo` address is app data, not a credential),
 * 3. returns every session value this process knows.
 * Anything that cannot be read (a context that will not answer, a header read that does not finish) throws, and the model call is not made: the scan is never allowed to be older than the browser.
 */
export interface E2ESessionStateReader {
  storageState(): Promise<{ cookies: ReadonlyArray<{ value: string; httpOnly: boolean }>; origins: ReadonlyArray<{ localStorage: ReadonlyArray<{ name: string; value: string }> }> }>;
}

export interface E2ESessionSyncSource {
  /** Every session value the process knows, after the browser's own state has been read and registered. Rejects when the state cannot be read. */
  read(): Promise<readonly string[]>;
  /** A response-header read in progress; `read()` waits for it. */
  track(pending: Promise<unknown>): void;
  /** A session's browser context, until `detach`. An anonymous visitor's context holds no credential and is left out. */
  attach(sessionRef: string, context: E2ESessionStateReader, options: { anonymous: boolean }): void;
  detach(sessionRef: string): void;
}

export const E2E_SESSION_SYNC_PENDING_LIMIT_MS = 5_000;

export function createE2ESessionSyncSource(options: {
  register(value: string): void;
  known(): readonly string[];
  pendingLimitMs?: number;
}): E2ESessionSyncSource {
  const contexts = new Map<string, E2ESessionStateReader>();
  // A value read again on every call is registered once: registering writes to a file the parent reads.
  const seen = new Set<string>();
  const register = (value: string): void => { if (!seen.has(value)) { seen.add(value); options.register(value); } };
  const pending = new Set<Promise<unknown>>();
  return {
    track(promise: Promise<unknown>): void {
      const settled = promise.then(() => undefined, () => undefined);
      pending.add(settled);
      void settled.then(() => { pending.delete(settled); });
    },
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
        for (const cookie of state.cookies) if (isSessionCookieSecret(cookie)) register(cookie.value);
        for (const origin of state.origins) for (const entry of origin.localStorage) if (isSessionStorageCredential(entry)) register(entry.value);
      }
      return options.known();
    },
  };
}
