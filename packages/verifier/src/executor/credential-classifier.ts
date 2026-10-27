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
/**
 * - `strong`: a credential (told to the worker, refused in a model prompt).
 * - `weak`: probably app data but token-shaped or under a secret-sounding name: scrubbed from evidence AND masked for the model (`<session>`).
 * - `scrub`: an ordinary value (a sentence, a path, a URL, a host, an email, a date, a UUID, a slug, a word, hex) kept at the top level of storage: scrubbed from evidence only, never masked
 *   for the model (masking an app's own base URL or a draft title would break the steps that read them).
 * - `mask` and `overflow` are made by the registration caps, not by the classifier: `mask` is a weak value past the evidence cap (masked for the model, not written anywhere), `overflow` says
 *   "some weak values could not be registered at all" (its `value` is empty); the model's view then fails closed.
 */
export type CredentialTier = "strong" | "weak" | "scrub" | "mask" | "overflow";
export interface ClassifiedValue { value: string; tier: CredentialTier }
const TIER_RANK: Record<CredentialTier, number> = { strong: 4, weak: 3, scrub: 2, mask: 1, overflow: 0 };
/** Whether `next` replaces `before` as the tier of a value (the stronger tier wins; the same tier is not a change). */
export function tierWins(next: CredentialTier, before: CredentialTier | undefined): boolean {
  return before === undefined || TIER_RANK[next] > TIER_RANK[before];
}

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
  // In a mixed-case value a `/` is not a slug separator: such a value is a base64 token or a path with ids, and `isPathLike` tells which (random base64 pieces between slashes are sometimes word-like).
  const separators = value.includes("/") && /[a-z]/.test(value) && /[A-Z]/.test(value) ? /[-_]/ : /[-_/]/;
  const parts = value.split(separators).filter((part) => part.length > 0);
  if (parts.length < 2) return false;
  const words = parts.filter((part) => WORD_SEGMENT.test(part) && /[aeiouy]/i.test(part)).length;
  return words / parts.length >= 0.6;
}

/**
 * A segment that says "this is a path" (MIDSTEP-2 fix round 4): a real word of 3 letters or more in any case (`orders`, `userProfiles`, `OrderItems`; every camel part has 3+ letters and a vowel,
 * with a short number after it allowed), a digit id of 3 digits or more, a hex id of 8 characters or more, or a version (`v2`). A short piece (`Ko`, `7`, `dl`) says nothing.
 */
const CAMEL_WORD = /^[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*\d{0,4}$/;
function isPathSegment(segment: string): boolean {
  return /^\d{3,}$/.test(segment) || /^[0-9a-fA-F]{8,}$/.test(segment) || /^v\d{1,2}$/.test(segment)
    || (CAMEL_WORD.test(segment) && (segment.match(/[A-Z]?[a-z]{2,}/g) ?? []).every((part) => /[aeiouy]/i.test(part)));
}
/**
 * A value with `/` in it whose segments are recognisably ids and words (`/api/userProfiles/8423/orderItems/12345`, `/Users/8423/Orders/12345`, `/files/<upper-case hex>`): a path, however its case
 * is mixed. A random standard-base64 token has a few random characters between its slashes; they are almost never a word, a digit id or a hex id. One short piece never decides: with two segments
 * both must say "path"; with more, at least three and half of them.
 */
function isPathLike(value: string): boolean {
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return false;
  const meaningful = segments.filter(isPathSegment).length;
  return segments.length === 2 ? meaningful === 2 : meaningful >= 3 && meaningful / segments.length >= 0.5;
}

/** A single long base64, base64url or hex run with a letter and a digit that is not a UUID, a path or a slug. */
export function isLongOpaqueRun(value: string): boolean {
  if (!LONG_RUN.test(value) || !/[0-9]/.test(value) || !/[A-Za-z]/.test(value) || UUID.test(value) || isSlugOrPath(value)) return false;
  // A `/` in it is either a standard-base64 character or a path separator. A random base64 token of 32+ characters has both cases and segments that are not ids or words; a REST path
  // with numeric or hex ids (`/users/8423/orders/12345/items/99882211`, `/files/9f8a7b6c...`, `/api/userProfiles/8423/orderItems/12345`) does not.
  return !value.includes("/") || (/[a-z]/.test(value) && /[A-Z]/.test(value) && !isPathLike(value));
}

/** A host name (`login.example.com`, `auth.internal:8443`): never a credential, but shown on pages. */
const HOST_LIKE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?$/i;

/** The share of the letters of a random-looking token that sit in a word-sized piece: 3 or more lower-case letters (with at most one capital before them) or a run of capitals. */
function wordLetterShare(value: string): number {
  const letters = value.replace(/[^A-Za-z]/g, "").length;
  if (letters === 0) return 0;
  const inWords = (value.match(/[A-Z]?[a-z]{3,}|[A-Z]{3,}(?![a-z])/g) ?? []).reduce((total, piece) => total + piece.length, 0);
  return inWords / letters;
}
/** Words in a camel-case or title-case identifier are most of its letters; in random letters about 40% are (95% of them below 0.73). Between the two lies this line (measured in the tests). */
const RANDOM_WORD_SHARE_BELOW = 0.72;
/** English is about 38% vowels; random base64 letters are 19% (10 of 52), most 24-byte samples are below this line. */
const RANDOM_VOWEL_SHARE_BELOW = 0.34;
/**
 * A random-looking token with no digit in it (MIDSTEP-2 MASKMAYBE, R4-3): 20 characters or more of letters in both cases, with at most `+ / - _ =` between them. A letter-and-digit run is an
 * opaque token and is judged elsewhere; this is the digit-less rest (about 0.5% of 24-byte base64 tokens, 0.07% of 32-byte ones). It is never an ordinary word, a slug, a path, a URL, a host or an
 * email (the last three never match the character set): those are not weak (that was B-1: ordinary values must not corrupt reports or fail runs).
 */
export function isDigitlessRandomToken(value: string): boolean {
  if (value.length < 20 || value.length > 4_096 || !/^[A-Za-z+/_=-]+$/.test(value) || !/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  // The character set above already leaves out URLs (`:`), hosts (`.`) and emails (`@`); a slug of word-like parts and a path of recognisable segments are left out here.
  if (isSlugOrPath(value) || isPathLike(value)) return false;
  const letters = value.replace(/[^A-Za-z]/g, "");
  return wordLetterShare(value) < RANDOM_WORD_SHARE_BELOW && letters.replace(/[^aeiouAEIOU]/g, "").length / letters.length < RANDOM_VOWEL_SHARE_BELOW;
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
  "error", "message", "label", "title", "text", "hint", "domain", "scope", "scopes", "policy", "config", "settings", "consent", "preference", "preferences", "prefs", "banner", "notice", "dismissed", "start", "started", "end", "ended", "created", "updated", "modified",
  // Where a thing lives or when it happened, not the thing (`tokenEndpoint`, `authHost`, `authIssuer`, `sessionLastActive`, `tokenIssued`): MIDSTEP-2 MASKMAYBE.
  "endpoint", "endpoints", "host", "hostname", "issuer", "issued", "server", "page", "link", "region", "seen", "active", "opened", "closed", "last", "origin", "referrer", "referer", "next"]);
/** Anywhere in the key, these say the value is a route (`redirectAfterAuth`, `returnTo`, `next`). */
const ROUTE_WORDS = new Set(["redirect", "return", "returnto", "callback", "next", "referrer", "referer", "origin"]);

/** The lower-case words of a key: split at camelCase, digits-to-letters and every non-alphanumeric character. `firebase:authUser:KEY` is firebase, auth, user, key. */
export function keyWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

/**
 * Whether a key names a credential: `strongest` when its word is one a short value can sit under. `loose` is a key that only SOUNDS secret: a credential word followed by a metadata word
 * (`tokenEndpoint`, `authHost`, `sessionLastActive`, `tokenIssued`, `sessionExpiresAt`). It is not a credential, but a date, URL, path, host or email under it is registered weak (masked from the model).
 * A clear secret word (token, secret, password, jwt, api key, bearer, ...) always wins over a route word (`callbackToken`, `nextToken`, `next-auth.session-token`); a route word beats only the looser words
 * (`redirectAfterAuth`, `returnTo`).
 */
export function credentialKey(name: string): { credential: boolean; strongest: boolean; loose: boolean } {
  const words = keyWords(name);
  let credential = false;
  let strongest = false;
  let loose = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    // "api key" and "access key" are two words.
    const bigram = (word === "api" || word === "access" || word === "private" || word === "secret") && words[index + 1] === "key";
    if (!CREDENTIAL_WORDS.has(word) && !bigram) continue;
    if (words.slice(index + 1).some((later) => METADATA_WORDS.has(later))) { loose = true; continue; }
    credential = true;
    if (STRONGEST_WORDS.has(word) || bigram) strongest = true;
  }
  if (!strongest && words.some((word) => ROUTE_WORDS.has(word))) return { credential: false, strongest: false, loose: false };
  return { credential, strongest, loose: loose && !credential };
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
  /**
   * The value is read from a signed-out visitor's browser (MASKMAYBE F-3). The application gives a visitor an id, a cart, a banner state; that is not a credential, and a page may print it. So only
   * what names or shapes a login credential counts: a value under a credential key, a JWT, JWE or PASETO, a dotted or piped token, a value after a `Bearer`-style scheme. A long opaque run under
   * an ordinary key (`visitor_id`) is not registered.
   */
  visitor?: boolean;
}

/**
 * Classifies one string by its key name and its value; also the value after a scheme (`Bearer x`, `Basic x`), and the opaque part of a dotted or piped token. Returns each string worth
 * registering with its tier (a value under two reasons gets the stronger tier).
 */
export function classifyString(name: string, value: string, options: ClassifyOptions = {}): ClassifiedValue[] {
  const items = classifyStringAll(name, value, options);
  if (options.visitor !== true) return items;
  const keyed = credentialKey(name).credential || SCHEME.test(value.trim());
  return items.filter((item) => keyed || isTokenShape(item.value) || hasOpaquePart(item.value) !== null);
}

function classifyStringAll(name: string, value: string, options: ClassifyOptions): ClassifiedValue[] {
  const found = new Map<string, CredentialTier>();
  const add = (candidate: string, tier: CredentialTier): void => {
    if (candidate.length < MIN_CREDENTIAL_LENGTH || COMMON.test(candidate)) return;
    if (tierWins(tier, found.get(candidate))) found.set(candidate, tier);
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
    // A credential key wins over every path or shape heuristic (a token that starts with `/` is a token); the key reading already took out the keys about a route or a date.
    if (key.credential) {
      const floor = key.strongest ? MIN_STRONG_KEYED_LENGTH : (options.keyedFloor ?? MIN_WEAK_LENGTH);
      if (trimmed.length >= floor) add(trimmed, "strong");
    }
  }
  // A name that only sounds secret (`tokenEndpoint`, `sessionLastActive`) holding a date, URL, path, host or email: weak, whatever the position (it is shown on pages, so never refused; masked from the model).
  const shapedUnderLooseKey = key.loose && noSpace && trimmed.length >= MIN_WEAK_LENGTH && (isRouteOrDate(trimmed) || HOST_LIKE.test(trimmed));
  // Everything else that is long enough, or short under a credential key, is app data that may be secret. It is MASKED for the model (weak) only when it is what a JSON leaf would be registered for:
  // a value under a credential-sounding name, a date/URL/host under a name that only sounds secret, a random-looking run, an opaque letters-and-digits token. Any other value is app data the
  // model must be able to read (a path, a URL, an email, a date, a UUID, a slug, a sentence, a word, hex): scrubbed from evidence at the top level, and not registered at all as a leaf.
  const maskable = key.credential || shapedUnderLooseKey || (noSpace && isDigitlessRandomToken(trimmed))
    || (isOpaqueToken(trimmed) && trimmed.length >= MIN_WEAK_LENGTH && !PURE_HEX.test(trimmed) && !UUID.test(trimmed));
  const weakAllowed = options.leaf !== true || maskable;
  const tier: CredentialTier = maskable ? "weak" : "scrub";
  if (weakAllowed && !found.has(trimmed) && (trimmed.length >= MIN_WEAK_LENGTH || (key.credential && trimmed.length >= MIN_CREDENTIAL_LENGTH))) add(trimmed, tier);
  if (weakAllowed && trimmed !== value && !found.has(value) && value.length >= MIN_WEAK_LENGTH) add(value, tier);
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
