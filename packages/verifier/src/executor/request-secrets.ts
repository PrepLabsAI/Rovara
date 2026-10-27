import { cookieTier } from "./visitor-cookie.js";
import { classifyString, credentialKey, isDigitlessRandomToken, isLongOpaqueRun, isOpaqueToken, isRandomLikeRun, isTokenShape, MIN_CREDENTIAL_LENGTH, tierWins, type ClassifiedValue } from "./credential-classifier.js";

/**
 * Secrets in what the browser sends and visits (MIDSTEP-2): query and fragment parameters of page URLs, and the headers of the application's requests.
 * Pure functions over strings; `request-capture.ts` wires them to a browser context.
 */

/** Parameters that are probably not a login secret but are sometimes one: scrubbed, not refused (an OAuth `code`, a signature, a generic `key`). */
const WEAK_PARAMETERS = new Set(["code", "key", "sig", "signature", "xamzsignature", "xamzcredential", "xamzsecuritytoken", "state", "nonce", "codeverifier", "authcode"]);
const NORMALISE = /[^a-z0-9]/g;
/**
 * One-time sign-in parameters (MASKMAYBE F-4), by name with every separator and case removed (so `SAMLart` is one word, `samlart`, not "sam" and "lart"): a Firebase `oobCode`, an `otp`, a magic
 * link, an invite code, a SAML artifact or response, a verification or reset code. A live one signs a session in, so it is a credential: a model call that shows it is refused. A 6-digit code is
 * under the 8-character floor and is not registered. A parameter named only `t` counts when its value is an opaque token.
 */
const ONE_TIME_PARAMETERS = new Set(["oobcode", "otp", "otc", "magiclink", "magictoken", "magiccode", "invite", "invitecode", "invitetoken", "samlart", "samlresponse", "verificationcode", "verificationtoken",
  "verifycode", "verifytoken", "resetcode", "signincode", "logincode", "loginlink", "signinlink", "onetimecode", "onetimepassword", "onetimetoken", "passwordlesstoken", "emailcode"]);
/** Any other name that ends in `code` (`promoCode`, `couponCode`): scrubbed and masked, never refused. */
const CODE_SUFFIX = /code$/;
/** A value that looks like a token (opaque letters and digits, a long mixed run, random letters), not an id: pure hex and UUIDs are shown on pages. */
function tokenLike(value: string): boolean {
  if (/^(0x)?[0-9a-fA-F]+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  return (isOpaqueToken(value) && value.length >= 16) || isLongOpaqueRun(value) || isDigitlessRandomToken(value);
}
/**
 * Token shapes inside a value too large to classify (a whole app state kept in the URL, MASKMAYBE last scoped round): one linear pass over its first 1 MiB, cutting at every character a token cannot
 * contain, and keeping the pieces that are JWTs, JWEs, PASETOs or `base64-eyJ` sessions. At most 100, none longer than 64 KiB.
 */
const OVERSIZE_SCAN_CHARS = 1_048_576;
const OVERSIZE_MAX_RUN = 65_536;
const OVERSIZE_MAX_TOKENS = 100;
export function oversizedTokens(value: string): string[] {
  const out = new Set<string>();
  const text = value.length > OVERSIZE_SCAN_CHARS ? value.slice(0, OVERSIZE_SCAN_CHARS) : value;
  for (const match of text.matchAll(/[A-Za-z0-9_.-]{20,}/g)) {
    if (match[0].length <= OVERSIZE_MAX_RUN && isTokenShape(match[0])) out.add(match[0]);
    if (out.size >= OVERSIZE_MAX_TOKENS) break;
  }
  return [...out];
}

/** The value of a one-time parameter must look like a token: a state word (`required`, `accepted`, `sent-already`) is not one. A URL (a magic link) counts when a piece of it is opaque. */
function oneTimeValue(value: string): boolean {
  if (isTokenShape(value) || tokenLike(value) || isRandomLikeRun(value)) return true;
  return value.split(/[^A-Za-z0-9]+/).some((piece) => isOpaqueToken(piece));
}
/** Parameters and headers read per URL or request; the rest are not read (an app with more is not a credential store). */
const MAX_PAIRS = 5_000;
const MAX_HEADERS = 1_000;
const MAX_VALUE_CHARS = 16_384;
// A long hex or base64 run in a URL parameter or a header that is not named like a credential is NOT registered: trace ids, order ids and content hashes are shown on pages and in URLs, and
// refusing a prompt for one would fail ordinary steps. A JWT shape is registered under any name.

function decode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

function parameters(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const pair of text.split("&")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    // `+` stays a plus: a base64 token carries it, and form-style `+` for a space does not occur in a credential.
    out.push([decode(pair.slice(0, separator)), decode(pair.slice(separator + 1))]);
  }
  return out;
}

/** Secret-looking query and fragment parameters of a URL (`?token=..`, `#access_token=..`, `#/callback?id_token=..`). */
export function urlSecrets(rawUrl: string): ClassifiedValue[] {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return []; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const pairs = parameters(url.search.slice(1));
  const hash = url.hash.slice(1);
  if (hash.length > 0) {
    // Implicit-flow answers put the parameters straight in the fragment; hash routers put them after a `?`.
    pairs.push(...parameters(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash));
  }
  const found = new Map<string, ClassifiedValue>();
  for (const [name, value] of pairs.slice(0, MAX_PAIRS)) {
    if (value.length < MIN_CREDENTIAL_LENGTH) continue;
    if (value.length > MAX_VALUE_CHARS) {
      // An oversized value (a diagram or a search kept in the URL) is skipped. Only one under a credential name fails the view closed: that is a credential too large to register.
      if (credentialKey(name).credential || ONE_TIME_PARAMETERS.has(name.toLowerCase().replace(NORMALISE, ""))) found.set("", { value: "", tier: "overflow" });
      else for (const token of oversizedTokens(value)) found.set(token, { value: token, tier: "strong" });
      continue;
    }
    // Strong parameters are the ones the key reading of `credential-classifier.ts` calls credentials (`token`, `access_token`, `id_token`, `refresh_token`, `session_id`, `api_key`, `password`, ...), the
    // one-time sign-in parameters, or whose value is token-shaped. A neutral parameter whose value looks like a token is masked (weak); other long values (a search text, a page title) are not registered.
    const normalised = name.toLowerCase().replace(NORMALISE, "");
    const weakName = WEAK_PARAMETERS.has(normalised) || (CODE_SUFFIX.test(normalised) && !ONE_TIME_PARAMETERS.has(normalised));
    const oneTime = ONE_TIME_PARAMETERS.has(normalised) && oneTimeValue(value);
    const credentialNamed = credentialKey(name).credential || oneTime || (normalised === "t" && tokenLike(value));
    for (const item of classifyString(name, value, { keyedFloor: MIN_CREDENTIAL_LENGTH })) {
      if (!credentialNamed && !weakName && !isTokenShape(item.value)) continue;
      // A parameter named like a signature or a code is scrubbed, never refused, unless its value is itself token-shaped.
      const tier = weakName && item.tier === "strong" && item.value === value && !/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(value) ? "weak" : item.tier;
      if (tierWins(tier, found.get(item.value)?.tier)) found.set(item.value, { value: item.value, tier });
    }
    // The one-time parameters are credentials whatever their value looks like (an invite code may be words); a neutral name with a token-like value is masked.
    if (oneTime || (normalised === "t" && credentialNamed)) found.set(value, { value, tier: "strong" });
    else if (weakName && !found.has(value)) found.set(value, { value, tier: "weak" });
    else if (!credentialNamed && !weakName && !ONE_TIME_PARAMETERS.has(normalised) && tokenLike(value) && !found.has(value)) found.set(value, { value, tier: "weak" });
  }
  return [...found.values()];
}

/** Header names that carry a credential whatever the key reading says, and the ones that carry a request forgery token (scrubbed, not refused). */
const CSRF_HEADER = /csrf|xsrf/i;

/** `name=value` pairs of a `Cookie` header. */
function cookiePairs(header: string): Array<[string, string]> {
  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator < 1 ? [] : [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as [string, string]];
  });
}

/** Credential-bearing headers of one request: `Authorization` (`Bearer x`, `Basic x`), `Proxy-Authorization`, `Cookie`, and headers named like a key or a token (`X-API-Key`, `X-Auth-Token`). */
export function headerSecrets(headers: ReadonlyArray<{ name: string; value: string }>, options: { visitor?: boolean } = {}): ClassifiedValue[] {
  const found = new Map<string, ClassifiedValue>();
  const add = (item: ClassifiedValue): void => { if (tierWins(item.tier, found.get(item.value)?.tier)) found.set(item.value, item); };
  for (const header of headers.slice(0, MAX_HEADERS)) {
    const name = header.name.toLowerCase();
    const value = header.value;
    if (value.length > MAX_VALUE_CHARS) {
      // An oversized header (a long Referer, a big cookie jar of ordinary cookies) is skipped. Only one that carries a credential fails the view closed.
      if (name === "authorization" || name === "proxy-authorization" || credentialKey(name).credential) add({ value: "", tier: "overflow" });
      else for (const token of oversizedTokens(value)) add({ value: token, tier: "strong" });
      continue;
    }
    if (value.length < MIN_CREDENTIAL_LENGTH) continue;
    if (name === "cookie") {
      // A signed-out visitor's cookies are judged by name and value (`visitorCookieSecret`): its id and cart are not secrets, a session is.
      for (const [cookieName, cookieValue] of cookiePairs(value)) { const tier = cookieTier({ name: cookieName, value: cookieValue, httpOnly: false }, options.visitor === true); if (tier !== null) add({ value: cookieValue, tier }); }
      continue;
    }
    if (name === "authorization" || name === "proxy-authorization") {
      // A scheme and a token, or a bare token. Every value after the scheme is the credential.
      const parts = value.trim().split(/\s+/);
      const secret = parts.length > 1 ? parts.slice(1).join(" ") : parts[0]!;
      if (secret.length >= MIN_CREDENTIAL_LENGTH) add({ value: secret, tier: "strong" });
      continue;
    }
    if (CSRF_HEADER.test(name)) {
      for (const item of classifyString(name, value, { keyedFloor: MIN_CREDENTIAL_LENGTH })) add({ value: item.value, tier: "weak" });
      continue;
    }
    // Only a header whose NAME says credential, or whose value is token-shaped, is registered (a `User-Agent` is neither).
    const credentialNamed = credentialKey(name).credential;
    for (const item of classifyString(name, value, { keyedFloor: MIN_CREDENTIAL_LENGTH })) if (credentialNamed || isTokenShape(item.value)) add(item);
  }
  return [...found.values()];
}
