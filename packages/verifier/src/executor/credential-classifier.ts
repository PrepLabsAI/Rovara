/**
 * The executor's tiered credential classifier (MIDSTEP-2).
 *
 * Every string the browser keeps (a cookie-like storage value, a leaf of a JSON value, a URL parameter, a header) is classified on its own, by its key name and its value:
 * - STRONG: a credential. It is told to the worker, and a model prompt that shows it is refused. Signals: a JWT shape, a long base64 or hex run, or a value under a key that names a credential
 *   (`token`, `auth`, `session`, `secret`, `bearer`, `password`, `api_key`, ...).
 * - WEAK: probably app data (a draft, a route, a slug, a UUID, a cache), possibly a secret. It is registered evidence-only: scrubbed from what the executor writes, never told to the worker, and
 *   a model prompt that shows it is not refused.
 * - none: short or common (`1`, `true`, `en-US`, `dark`): never registered, because redacting one would rewrite words and numbers in a report.
 *
 * A pure module: no I/O, no browser.
 */
export type CredentialTier = "strong" | "weak";
export interface ClassifiedValue { value: string; tier: CredentialTier }

/** Below this a value is never registered, whatever its key says: the redactor ignores anything shorter, and a handful of characters would match almost anything. */
export const MIN_CREDENTIAL_LENGTH = 8;
/** A weak value (no key says it is a credential) must be at least this long, as the cookie fix's evidence-only rule always required. */
const MIN_WEAK_LENGTH = 16;
/** Under a key that names a credential, a value counts from this length (a password or a token can be short); under a looser credential word it counts from MIN_WEAK_LENGTH. */
const MIN_STRONG_KEYED_LENGTH = 8;

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
/** A JWE (five dot parts) or a PASETO (`v2.local.<payload>`): dotted tokens that are not a JWT but are as secret. */
const JWE = /^[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*){4}$/;
const PASETO = /^v[1-4]\.(local|public)\.[A-Za-z0-9_-]{16,}/;
const LONG_RUN = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME = /^(bearer|basic|token|apikey|api-key|jwt|negotiate|digest)\s+(\S+)$/i;
const COMMON = /^(true|false|null|undefined|none|nan|anonymous|guest|string|object|loading|expired|invalid|logged[-_ ]?(in|out)|signed[-_ ]?(in|out)|bearer)$/i;
const WORD_SEGMENT = /^[A-Za-z]?[a-z]{2,19}\d{0,4}$/;

/** True for the value of a path, a URL, a date, an email: shapes that are never a credential on their own, whatever the key. */
function isRouteOrDate(value: string): boolean {
  // A standard-base64 token can start with `/`: a leading slash makes a path only when the value is not an opaque run (a credential key must win over the path shape).
  // Standard base64 has no `-` or `_`; a value that has them (`/orders/3f25-...`) is a path.
  const path = (value.startsWith("/") || value.startsWith("./")) && !(isLongOpaqueRun(value) && !/[-_]/.test(value));
  return path || URL_LIKE.test(value) || ISO_DATE.test(value) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

/** A pure hex run (`0x` allowed): a git sha, a content hash, a dashless UUID, an address. Shown on pages and in URLs. */
const PURE_HEX = /^(0x)?[0-9a-fA-F]+$/;
/** One opaque piece: letters and digits (with a letter and a digit), no separator, no whitespace. */
export function isOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9]{8,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * A slug or a path: separated by `-`, `_` or `/` into word-like parts ("projects/alpha/settings/notifications2", "my-quarterly-report-2024-final"). A random token has parts of mixed case and
 * digits that are not words. Two parts or more, and at least 60% of them words.
 */
function isSlugOrPath(value: string): boolean {
  const parts = value.split(/[-_/]/).filter((part) => part.length > 0);
  if (parts.length < 2) return false;
  const words = parts.filter((part) => WORD_SEGMENT.test(part) && /[aeiouy]/i.test(part)).length;
  return words / parts.length >= 0.6;
}

/** One segment of a REST-style path: digits (an id), a long hex id, a word in any case (`orders`, `userProfiles`, `OrderItems`, with a short number after it), or a version (`v2`). */
const CAMEL_WORD = /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)*\d{0,4}$/;
function isPathSegment(segment: string): boolean {
  return /^\d+$/.test(segment) || /^[0-9a-fA-F]{8,}$/.test(segment) || /^[a-z]\d{1,3}$/.test(segment) || (CAMEL_WORD.test(segment) && /[aeiouy]/i.test(segment));
}
/**
 * A value with `/` in it whose segments are mostly ids and words in any case (`/api/userProfiles/8423/orderItems/12345`, `/Users/8423/Orders/12345`, `/files/<upper-case hex>`): a path, however
 * its case is mixed. A random standard-base64 token has a few random characters between its slashes; they are almost never digits only, hex only or a camelCase word.
 */
function isPathLike(value: string): boolean {
  const segments = value.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments.filter(isPathSegment).length / segments.length >= 0.5;
}

/** A single long base64, base64url or hex run with a letter and a digit that is not a UUID, a path or a slug. */
function isLongOpaqueRun(value: string): boolean {
  if (!LONG_RUN.test(value) || !/[0-9]/.test(value) || !/[A-Za-z]/.test(value) || UUID.test(value) || isSlugOrPath(value)) return false;
  // A `/` in it is either a standard-base64 character or a path separator. A random base64 token of 32+ characters has both cases and segments that are not ids or words; a REST path
  // with numeric or hex ids (`/users/8423/orders/12345/items/99882211`, `/files/9f8a7b6c...`, `/api/userProfiles/8423/orderItems/12345`) does not.
  return !value.includes("/") || (/[a-z]/.test(value) && /[A-Z]/.test(value) && !isPathLike(value));
}

/** A token with dots, pipes or colons in it (a Sanctum `12|abcd...`, a JWE, a PASETO) whose parts include a long opaque run. */
function hasOpaquePart(value: string): string | null {
  if (!/[.|:]/.test(value)) return null;
  for (const part of value.split(/[.|:]/)) if (isLongOpaqueRun(part)) return part;
  return null;
}

/** A JWT, a JWE or a PASETO. */
export function isTokenShape(value: string): boolean {
  return JWT.test(value) || JWE.test(value) || PASETO.test(value);
}

const CREDENTIAL_WORDS = new Set(["token", "tokens", "jwt", "secret", "secrets", "password", "passwords", "passwd", "pwd", "passcode", "credential", "credentials", "cred", "creds",
  "bearer", "session", "sessions", "sid", "sso", "saml", "auth", "authorization", "authentication", "authn", "apikey", "ticket", "refresh", "cookie", "remember", "pin"]);
/** Words that make the key a credential even for a short value (8 characters or more). */
const STRONGEST_WORDS = new Set(["token", "tokens", "jwt", "secret", "secrets", "password", "passwords", "passwd", "pwd", "passcode", "credential", "credentials", "cred", "creds", "bearer", "apikey"]);
/** After a credential word, these say the value is about the credential, not the credential itself (`tokenType`, `authUser`, `sessionExpiresAt`). */
const METADATA_WORDS = new Set(["user", "username", "email", "name", "at", "time", "timestamp", "date", "expires", "expiry", "expiration", "expired", "exp", "ttl", "timeout", "url", "uri", "path",
  "redirect", "return", "route", "callback", "enabled", "disabled", "type", "status", "provider", "method", "count", "length", "version", "mode", "flag", "flags", "kind", "required", "valid",
  "error", "message", "label", "title", "text", "hint", "domain", "scope", "scopes", "policy", "config", "settings", "consent", "preference", "preferences", "prefs", "banner", "notice", "dismissed"]);
/** Anywhere in the key, these say the value is a route (`redirectAfterAuth`, `returnTo`, `next`). */
const ROUTE_WORDS = new Set(["redirect", "return", "returnto", "callback", "next", "referrer", "referer", "origin"]);

/** The lower-case words of a key: split at camelCase, digits-to-letters and every non-alphanumeric character. `firebase:authUser:KEY` is firebase, auth, user, key. */
export function keyWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

/** Whether a key names a credential: `strongest` when its word is one a short value can sit under. */
export function credentialKey(name: string): { credential: boolean; strongest: boolean } {
  const words = keyWords(name);
  if (words.some((word) => ROUTE_WORDS.has(word))) return { credential: false, strongest: false };
  let credential = false;
  let strongest = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    // "api key" and "access key" are two words.
    const bigram = (word === "api" || word === "access" || word === "private" || word === "secret") && words[index + 1] === "key";
    if (!CREDENTIAL_WORDS.has(word) && !bigram) continue;
    if (words.slice(index + 1).some((later) => METADATA_WORDS.has(later))) continue;
    credential = true;
    if (STRONGEST_WORDS.has(word) || bigram) strongest = true;
  }
  return { credential, strongest };
}

export interface ClassifyOptions {
  /** The shortest value that counts as a credential under any credential key (the URL and header paths take 8 for every one). */
  keyedFloor?: number;
  /**
   * The value is a leaf of JSON or an IndexedDB record, not a whole stored value. Under a key that does not name a credential, such a leaf is strong only with a base64 character mix
   * (a pure hex run, a `0x` address, a dashless UUID is an id the page shows, so it is not registered at all), and is weak only when it is an opaque token (a route, URL, date, email, UUID
   * or slug is never registered: a cache of ordinary ids and paths must not be rewritten in reports or end a run at the final output scan).
   */
  leaf?: boolean;
}

/**
 * Classifies one string by its key name and its value; also the value after a scheme (`Bearer x`, `Basic x`), and the opaque part of a dotted or piped token. Returns each string worth
 * registering with its tier (a value under two reasons gets the stronger tier).
 */
export function classifyString(name: string, value: string, options: ClassifyOptions = {}): ClassifiedValue[] {
  const found = new Map<string, CredentialTier>();
  const add = (candidate: string, tier: CredentialTier): void => {
    if (candidate.length < MIN_CREDENTIAL_LENGTH || COMMON.test(candidate)) return;
    if (found.get(candidate) !== "strong") found.set(candidate, tier);
  };
  const key = credentialKey(name);
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const scheme = SCHEME.exec(trimmed);
  if (scheme !== null) {
    // `Bearer <token>` and the like: the token after the scheme is the credential, wherever the header is kept.
    add(scheme[2]!, "strong");
    add(trimmed, "weak");
    return [...found].map(([text, tier]) => ({ value: text, tier }));
  }
  const noSpace = !/\s/.test(trimmed);
  if (noSpace) {
    const exclusion = isRouteOrDate(trimmed);
    if (isTokenShape(trimmed)) add(trimmed, "strong");
    else if (!exclusion) {
      const part = hasOpaquePart(trimmed);
      if (part !== null) { add(trimmed, "strong"); add(part, "strong"); }
      else if (isLongOpaqueRun(trimmed)) {
        const mixed = /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) || /[+=]/.test(trimmed);
        if (!options.leaf || key.credential || (mixed && !PURE_HEX.test(trimmed))) add(trimmed, "strong");
      }
    }
    if (!exclusion && key.credential) {
      const floor = key.strongest ? MIN_STRONG_KEYED_LENGTH : (options.keyedFloor ?? MIN_WEAK_LENGTH);
      if (trimmed.length >= floor) add(trimmed, "strong");
    }
  }
  // Everything else that is long enough, or short under a credential key, is app data that may be secret: scrubbed, not refused.
  const weakAllowed = options.leaf !== true || (key.credential && !isRouteOrDate(trimmed))
    || (isOpaqueToken(trimmed) && trimmed.length >= MIN_WEAK_LENGTH && !PURE_HEX.test(trimmed) && !UUID.test(trimmed));
  if (weakAllowed && !found.has(trimmed) && (trimmed.length >= MIN_WEAK_LENGTH || (key.credential && trimmed.length >= MIN_CREDENTIAL_LENGTH))) add(trimmed, "weak");
  if (weakAllowed && trimmed !== value && !found.has(value) && value.length >= MIN_WEAK_LENGTH) add(value, "weak");
  return [...found].map(([text, tier]) => ({ value: text, tier }));
}

/** Token-shaped substrings of a text (JWTs and long opaque runs), for a value too large or too tangled to parse. At most 500. */
export function tokenShapedSubstrings(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
    const candidate = match[0];
    if (isTokenShape(candidate) || isLongOpaqueRun(candidate)) out.add(candidate);
    if (out.size >= 500) break;
  }
  return [...out];
}
