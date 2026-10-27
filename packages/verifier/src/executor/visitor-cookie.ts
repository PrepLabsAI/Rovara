import { credentialKey, isLongOpaqueRun, isOpaqueToken, isRandomLikeRun, isTokenShape } from "./credential-classifier.js";
import { isSessionCookieSecret } from "./cookie-secret.js";

/**
 * Whether a cookie of a SIGNED-OUT VISITOR's browser is a session secret (MASKMAYBE round 2, R-3). The application gives a visitor an id and a cart in cookies and may print them (F6): those are not
 * secrets. A session the application issues to a visitor is: a Supabase SSR cookie (`sb-<ref>-auth-token`, `base64-` and JSON), any cookie named like a credential (`session`, `auth`, `token`, `sid`...),
 * a JWT or other token shape, an HttpOnly session cookie, and a cookie with an opaque value of 16 or more characters under a name that is not plainly a visitor id, a cart or a setting.
 */
const VISITOR_ID_NAME = /visitor|anon|guest|cart|basket|consent|locale|lang|theme|tracking|(^|[_-])(ga|gid|fbp|gcl)([_-]|$)/i;

export function visitorCookieSecret(cookie: { name?: string; value: string; httpOnly: boolean }): boolean {
  if (isTokenShape(cookie.value)) return true;
  if (cookie.httpOnly && isSessionCookieSecret(cookie)) return true;
  if (cookie.name === undefined) return false;
  const key = credentialKey(cookie.name);
  if (key.credential) return cookie.value.length >= (key.strongest ? 8 : 16);
  if (VISITOR_ID_NAME.test(cookie.name)) return false;
  return cookie.value.length >= 16 && (isOpaqueToken(cookie.value) || isLongOpaqueRun(cookie.value) || isRandomLikeRun(cookie.value));
}
