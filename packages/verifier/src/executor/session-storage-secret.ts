/**
 * Which local storage entries the session sync tells the worker about (MIDSTEPCOOKIE).
 *
 * The worker REFUSES a model call whose prompt shows a synced value (as it does for a password or a cookie). So only an entry that is a credential may be synced, not ordinary app data:
 * a draft the app autosaves ("Quarterly report for ACME"), a `returnTo` address, a search history, a feature flag cache. Those can be long and are routinely shown on the page, and refusing
 * them would fail agent steps of ordinary apps. An entry is a credential when its value has no whitespace and
 * - is a JWT (three dot-separated base64url parts), or
 * - is a single long run of base64, base64url or hex characters (32 or more, with a digit and a letter), or
 * - is kept under a key that names a credential (`token`, `auth`, `session`, `jwt`, `access`, `refresh`, `secret`, `credential`, `bearer`, `api key`) and is at least 16 characters.
 * The entry's key is read, not only its value. A value that does not qualify is still registered with the executor's redactor when a case closes (evidence scrubbing is broad); it is not sent
 * to the worker.
 *
 * Not covered here (a separate follow-up): a token INSIDE a JSON value kept under such a key, which would need its string leaves parsed out.
 */
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
const LONG_RUN = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const CREDENTIAL_KEY = /token|auth|session|jwt|access|refresh|secret|credential|bearer|api[-_ ]?key/i;
const MIN_KEYED_LENGTH = 16;

export function isSessionStorageCredential(entry: { name: string; value: string }): boolean {
  const { name, value } = entry;
  if (value.length === 0 || /\s/.test(value)) return false;
  if (JWT.test(value)) return true;
  if (LONG_RUN.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) return true;
  return value.length >= MIN_KEYED_LENGTH && CREDENTIAL_KEY.test(name);
}
