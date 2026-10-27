import { isSessionCookieSecret } from "./cookie-secret.js";
import { classifyString, credentialKey, isDigitlessRandomToken, isLongOpaqueRun, isOpaqueToken, isTokenShape, MIN_CREDENTIAL_LENGTH, tierWins, type ClassifiedValue } from "./credential-classifier.js";

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
  // A list past the bound is not read to the end: the model's view fails closed instead of the rest being silently ignored.
  if (pairs.length > 200) found.set("", { value: "", tier: "overflow" });
  for (const [name, value] of pairs.slice(0, 200)) {
    if (value.length < MIN_CREDENTIAL_LENGTH) continue;
    if (value.length > 16_384) { found.set("", { value: "", tier: "overflow" }); continue; }
    // Strong parameters are the ones the key reading of `credential-classifier.ts` calls credentials (`token`, `access_token`, `id_token`, `refresh_token`, `session_id`, `api_key`, `password`, ...), the
    // one-time sign-in parameters, or whose value is token-shaped. A neutral parameter whose value looks like a token is masked (weak); other long values (a search text, a page title) are not registered.
    const normalised = name.toLowerCase().replace(NORMALISE, "");
    const weakName = WEAK_PARAMETERS.has(normalised) || (CODE_SUFFIX.test(normalised) && !ONE_TIME_PARAMETERS.has(normalised));
    const credentialNamed = credentialKey(name).credential || ONE_TIME_PARAMETERS.has(normalised) || (normalised === "t" && tokenLike(value));
    for (const item of classifyString(name, value, { keyedFloor: MIN_CREDENTIAL_LENGTH })) {
      if (!credentialNamed && !weakName && !isTokenShape(item.value)) continue;
      // A parameter named like a signature or a code is scrubbed, never refused, unless its value is itself token-shaped.
      const tier = weakName && item.tier === "strong" && item.value === value && !/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(value) ? "weak" : item.tier;
      if (tierWins(tier, found.get(item.value)?.tier)) found.set(item.value, { value: item.value, tier });
    }
    // The one-time parameters are credentials whatever their value looks like (an invite code may be words); a neutral name with a token-like value is masked.
    if (ONE_TIME_PARAMETERS.has(normalised) || (normalised === "t" && credentialNamed)) found.set(value, { value, tier: "strong" });
    else if (weakName && !found.has(value)) found.set(value, { value, tier: "weak" });
    else if (!credentialNamed && !weakName && tokenLike(value) && !found.has(value)) found.set(value, { value, tier: "weak" });
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
  // A list or a value past the bound is not read: the model's view fails closed instead of the rest being silently ignored.
  if (headers.length > 200) add({ value: "", tier: "overflow" });
  for (const header of headers.slice(0, 200)) {
    const name = header.name.toLowerCase();
    const value = header.value;
    if (value.length > 16_384) { add({ value: "", tier: "overflow" }); continue; }
    if (value.length < MIN_CREDENTIAL_LENGTH) continue;
    if (name === "cookie") {
      // A signed-out visitor's cookies are its id and cart (see `ClassifyOptions.visitor`): only a token-shaped one counts.
      if (options.visitor === true) { for (const [, cookieValue] of cookiePairs(value)) if (isTokenShape(cookieValue)) add({ value: cookieValue, tier: "strong" }); continue; }
      for (const [, cookieValue] of cookiePairs(value)) if (isSessionCookieSecret({ value: cookieValue, httpOnly: false })) add({ value: cookieValue, tier: "strong" });
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
