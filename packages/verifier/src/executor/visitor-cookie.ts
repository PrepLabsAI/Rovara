import { credentialKey, isLongOpaqueRun, isOpaqueToken, isRandomLikeRun, isTokenShape, type CredentialTier } from "./credential-classifier.js";
import { isSessionCookieSecret } from "./cookie-secret.js";

/**
 * Which cookies are session secrets, by name and value (MASKMAYBE round 2 R-3, last scoped round).
 *
 * - Analytics, advertising and anti-bot cookies (`_ga`, `_hj*`, `optimizely*`, `_uet*`, `hubspotutk`, `__hs*`, `_clck`, `__stripe_mid`, `__cf_bm`, `cf_clearance`, `ajs_*`, `mp_*`, `amplitude*`...) hold ids the
 *   vendor's script makes. Their value is not a login: never strong, in a signed-in or a signed-out browser, unless it is itself a JWT; an opaque value is weak (masked and scrubbed), a plain one is not registered. The names are whole names or a stem with a delimited suffix (`_ga`, `_ga_XXXX`, never `_gateway_session`).
 * - A SIGNED-OUT VISITOR's cookie: the application gives a visitor an id and a cart in cookies and may print them (F6); those are not secrets. A session the application issues to a visitor is: a Supabase SSR cookie
 *   (`sb-<ref>-auth-token`, `base64-eyJ...`), any cookie named like a credential, a JWT, an HttpOnly session cookie, and a cookie with an opaque value of 16+ under any other name: STRONG when the name says
 *   session or login (`PHPSESSID`, `JSESSIONID`, `.ASPXAUTH`), otherwise WEAK (masked for the model and scrubbed, never refused: it may be a tracker we do not know).
 */
const ANALYTICS_COOKIE = new RegExp([
  // Whole names, or a known stem and a delimited suffix: `_ga` and `_ga_ABC123`, never `_gateway_session` or `_gallery_session` (a Rails app's session cookie is `_<app>_session`).
  "^_ga(_[A-Za-z0-9]+)?$", "^_gat(_[A-Za-z0-9_]+)?$", "^_gac_[A-Za-z0-9_-]+$", "^_gid$", "^_gcl_[a-z]+$", "^_fbp$", "^_fbc$", "^_dd_s$", "^_ttp$", "^_scid$", "^_cs_(id|s)(\\.[A-Za-z0-9_-]+)?$",
  "^_pk_(id|ses|ref|cvar|hsr)\\.[A-Za-z0-9._-]+$", "^_hj[A-Za-z]*(_[A-Za-z0-9]+)?$", "^_uet(sid|vid)$", "^hubspotutk$", "^__hs(tc|sc|srt|fp)$", "^_clck$", "^_clsk$", "^__stripe_(mid|sid)$",
  "^__cf_bm$", "^cf_clearance$", "^datadome$", "^ajs_(user_id|anonymous_id|group_id)$", "^mp_[A-Za-z0-9]+_mixpanel$", "^amplitude_id(_[A-Za-z0-9]+)?$", "^AMP_(MKTG_)?[A-Za-z0-9]+$",
  "^optimizely(EndUserId|Segments|Buckets|PendingLogEvents|Data[A-Za-z0-9_$%-]*)$", "^intercom-(id|session|device-id)-[A-Za-z0-9]+$", "^utm_(source|medium|campaign|term|content)(_cookie)?$",
  "^_shopify_(y|s|fs|ga|d|m|u|evids|tm|tw|sa_p|sa_t|uniq|visit)$",
].join("|"));
export function analyticsCookieName(name: string): boolean {
  return ANALYTICS_COOKIE.test(name);
}

const VISITOR_ID_NAME = /visitor|anon|guest|cart|basket|consent|locale|lang|theme|tracking|(^|[_-])(ga|gid|fbp|gcl)([_-]|$)/i;
const SESSION_NAME = /sess|auth|login|sso|jwt|ticket/i;

export type CookieContext = { name?: string; value: string; httpOnly: boolean };

/** The tier a cookie is registered at, or null for none. `visitor` is a signed-out visitor's browser. */
export function cookieTier(cookie: CookieContext, visitor: boolean): CredentialTier | null {
  if (isTokenShape(cookie.value)) return "strong";
  // A vendor's id is not a login: not refused, but an opaque value is masked and scrubbed (weak) rather than left readable; a short or plain one is not registered.
  if (cookie.name !== undefined && analyticsCookieName(cookie.name)) return cookie.value.length >= 16 && (isOpaqueToken(cookie.value) || isLongOpaqueRun(cookie.value) || isRandomLikeRun(cookie.value)) ? "weak" : null;
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
