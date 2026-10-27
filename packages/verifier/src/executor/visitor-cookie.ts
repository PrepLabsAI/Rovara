import { credentialKey, isLongOpaqueRun, isOpaqueToken, isRandomLikeRun, isTokenShape, type CredentialTier } from "./credential-classifier.js";
import { isSessionCookieSecret } from "./cookie-secret.js";

/**
 * Which cookies are session secrets, by name and value (MASKMAYBE round 2 R-3, last scoped round).
 *
 * - Analytics, advertising and anti-bot cookies (`_ga`, `_hj*`, `optimizely*`, `_uet*`, `hubspotutk`, `__hs*`, `_clck`, `__stripe_mid`, `__cf_bm`, `cf_clearance`, `ajs_*`, `mp_*`, `amplitude*`...) hold ids the
 *   vendor's script makes. Their value is not a login: it is not registered, in a signed-in or a signed-out browser, unless it is itself a JWT.
 * - A SIGNED-OUT VISITOR's cookie: the application gives a visitor an id and a cart in cookies and may print them (F6); those are not secrets. A session the application issues to a visitor is: a Supabase SSR cookie
 *   (`sb-<ref>-auth-token`, `base64-eyJ...`), any cookie named like a credential, a JWT, an HttpOnly session cookie, and a cookie with an opaque value of 16+ under any other name: STRONG when the name says
 *   session or login (`PHPSESSID`, `JSESSIONID`, `.ASPXAUTH`), otherwise WEAK (masked for the model and scrubbed, never refused: it may be a tracker we do not know).
 */
const ANALYTICS_COOKIE = /^(optimizely|_hj|_uet|hubspotutk|__hs|_clck|_clsk|__stripe_(mid|sid)|__cf_bm|cf_clearance|datadome|_gcl_|_fbc|_fbp|ajs_|mp_|amplitude|_ga|_gid|_pk_|_cs_id|_ttp|_scid|_dd_s|intercom-|utm_|_shopify_)/i;
export function analyticsCookieName(name: string): boolean {
  return ANALYTICS_COOKIE.test(name);
}

const VISITOR_ID_NAME = /visitor|anon|guest|cart|basket|consent|locale|lang|theme|tracking|(^|[_-])(ga|gid|fbp|gcl)([_-]|$)/i;
const SESSION_NAME = /sess|auth|login|sso|jwt|ticket/i;

export type CookieContext = { name?: string; value: string; httpOnly: boolean };

/** The tier a cookie is registered at, or null for none. `visitor` is a signed-out visitor's browser. */
export function cookieTier(cookie: CookieContext, visitor: boolean): CredentialTier | null {
  if (isTokenShape(cookie.value)) return "strong";
  if (cookie.name !== undefined && analyticsCookieName(cookie.name)) return null;
  if (!visitor) return isSessionCookieSecret(cookie) ? "strong" : null;
  if (cookie.httpOnly && isSessionCookieSecret(cookie)) return "strong";
  if (cookie.name === undefined) return null;
  const key = credentialKey(cookie.name);
  if (key.credential) return cookie.value.length >= (key.strongest ? 8 : 16) ? "strong" : null;
  if (VISITOR_ID_NAME.test(cookie.name)) return null;
  if (cookie.value.length >= 16 && (isOpaqueToken(cookie.value) || isLongOpaqueRun(cookie.value) || isRandomLikeRun(cookie.value))) return SESSION_NAME.test(cookie.name) ? "strong" : "weak";
  return null;
}

/** A visitor's cookie that is a session secret (strong). */
export function visitorCookieSecret(cookie: CookieContext): boolean {
  return cookieTier(cookie, true) === "strong";
}
