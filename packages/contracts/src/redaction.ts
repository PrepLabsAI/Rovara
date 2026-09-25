const REDACTED = "[REDACTED]";

// Every pattern here must run in linear time on any input: a start boundary (a lookbehind) keeps
// the engine from retrying inside a run, and every repetition has an upper bound, so a failed
// attempt costs a bounded number of steps. Never put two optional whitespace groups side by side.

/** Case-insensitive letters without the i flag, so the camelCase boundary below still works. */
function ci(term: string): string {
  return term.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

// Credential key terms. A key is credential-named when it ENDS with one of these terms, so
// PGPASSWORD, GITHUB_TOKEN, X-Api-Key and csrftoken match while author, tokenizer, tokenUsage,
// secretary, cookieConsent and token-count names (max_tokens, tokenCount) do not.
const LONG_TERMS = [
  "passwords?", "passwd", "passphrase", "secrets?", "token", "credentials?", "cookies?", "authorization", "bearer",
  "api[_-]?keys?", "access[_-]?keys?", "private[_-]?keys?", "secret[_-]?keys?",
].map(ci).join("|");
// Short terms also need a word start (start, a separator or a camelCase hump), so compass,
// bypass and oauth are not credential names but DB_PASS, dbPass and auth are.
const SHORT_TERMS = ["pass", "pwd", "auth"].map(ci).join("|");
const KEY_TERM = String.raw`(?:${LONG_TERMS}|(?:(?<![A-Za-z0-9])|(?<=[a-z])(?=[A-Z]))(?:${SHORT_TERMS}))`;

const CREDENTIAL_KEY = new RegExp(String.raw`${KEY_TERM}$`);

// "key: value" or "key=value" in free text or pasted JSON: a double-quoted value (escapes
// included), a single-quoted value, or a bare value with an optional auth scheme before it.
const AUTH_SCHEME = ["bearer", "basic", "token", "digest", "negotiate"].map(ci).join("|");
const KEY_VALUE_SECRET = new RegExp(
  String.raw`((?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?${KEY_TERM}\\?["']?[ \t]{0,8}[:=][ \t]{0,8})` +
    String.raw`(?:(")(?:[^"\\\r\n]|\\.){0,4096}"?|(')[^'\r\n]{0,4096}'?|((?:(?:${AUTH_SCHEME})[ \t]{1,8})?)[^\s&,}]{1,4096})`,
  "g",
);

// Query and fragment parameters, matched by precise name: a credential term, optionally after
// separator-delimited words (refresh_token, X-Amz-Signature), or a short name on its own
// (code, key, sig), so keyword, monkey and zip_code are kept.
const QUERY_SECRET = new RegExp(
  String.raw`([?&#;](?:(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:token|secret|password|passwd|pwd|signature|credential|apikey|(?:api|access|private|secret|subscription)[_-]?key)|code|key|sig|pass|auth)=)[^&#\s]{1,4096}`,
  "gi",
);

// Each pattern matches a credential shape a member might paste or a model might echo. Whole matches
// are replaced, except where a group keeps a harmless prefix such as "Bearer " or a scheme.
// Vendor-prefixed tokens have no left boundary: a prefix glued to another word or an underscore
// (x_ghp_..., tokenghp_...) must still be caught.
const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, REDACTED],
  [/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/glpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/xapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/ATATT[A-Za-z0-9_=-]{20,}/g, REDACTED],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  [/AIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/https?:\/\/hooks\.slack\.com\/services\/\S+/gi, REDACTED],
  // A Cookie header holds several secrets; redact the whole value to the end of the line.
  [/(?<![A-Za-z0-9_-])((?:set-)?cookie[ \t]{0,8}:[ \t]{0,8})(?!["'])[^\r\n]{1,8192}/gi, `$1${REDACTED}`],
  // Bare "bearer"/"basic" prose needs a digit or one of =+/ to look like a token, so "a basic
  // understanding" and "bearer instrumentalities" are kept.
  [new RegExp(String.raw`(?<![A-Za-z0-9])(${ci("bearer")}|${ci("basic")})[ \t]{1,8}(?=[A-Za-z0-9._~+/=-]{0,4095}[0-9=+/])[A-Za-z0-9._~+/=-]{8,4096}`, "g"), `$1 ${REDACTED}`],
  // Any scheme's user-info (postgres://, redis://, https://, ...), an empty user included, up to
  // the last @ before the host (and before any ? or #), so a password holding / or @ is removed
  // whole while an @ in the query is not. A port (host:8080/...) is not a password.
  [/(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s@/:]{0,128}:(?!\d{1,5}(?:[/?#\s]|$))[^\s?#]{0,256}@(?=[A-Za-z0-9[])/g, `$1${REDACTED}@`],
  // curl -u user:password
  [/((?<!\S)(?:-u|--user)(?:[ \t]{1,8}|=)['"]?[^\s:'"]{1,256}:)[^\s'"]{1,512}/g, `$1${REDACTED}`],
  [QUERY_SECRET, `$1${REDACTED}`],
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;

/** Private key blocks, BEGIN to END; a key with no END line (a cut-off paste) is redacted to the
 * next blank line, or to the end. A forward scan, so a run of BEGIN lines stays linear. */
function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  let noEndAfter = Number.POSITIVE_INFINITY;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    const start = begin.index;
    let stop = -1;
    if (start < noEndAfter) {
      PRIVATE_KEY_END.lastIndex = start + begin[0].length;
      const end = PRIVATE_KEY_END.exec(text);
      if (end) stop = end.index + end[0].length;
      else noEndAfter = start;
    }
    if (stop < 0) {
      BLANK_LINE.lastIndex = start + begin[0].length;
      const blank = BLANK_LINE.exec(text);
      stop = blank ? blank.index : text.length;
    }
    out += text.slice(from, start) + REDACTED;
    from = stop;
    PRIVATE_KEY_BEGIN.lastIndex = stop;
  }
  return out + text.slice(from);
}

export function redactText(text: string): string {
  const afterPatterns = TEXT_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), redactPrivateKeys(text));
  return afterPatterns.replace(
    KEY_VALUE_SECRET,
    (_match: string, prefix: string, double: string | undefined, single: string | undefined, scheme: string | undefined) =>
      double ? `${prefix}"${REDACTED}"` : single ? `${prefix}'${REDACTED}'` : `${prefix}${scheme ?? ""}${REDACTED}`,
  );
}

/** Whether an object key names a credential. Token-count names (tokenCount, max_tokens,
 * input_tokens) are excluded by name, never by the type of their value. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.length > 128 ? key.slice(-128) : key);
}

/** A copy with every value under a credential-named key (string, number, array or object)
 * replaced, and credential-shaped strings elsewhere redacted; never mutates. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, isCredentialKey(key) && child !== null && child !== undefined ? REDACTED : redactSecrets(child)]),
    );
  }
  return value;
}
