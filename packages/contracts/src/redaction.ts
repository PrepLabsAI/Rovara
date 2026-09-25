const REDACTED = "[REDACTED]";

// Terms that name a credential, reused by the object-key matcher (CREDENTIAL_KEY) and by the
// free-text key/value pattern (KEY_VALUE_SECRET) below, so the two lists never drift apart. The
// token alternative excludes plural and count forms (tokenCount, max_tokens, input_tokens) so
// usage telemetry is never mistaken for a secret.
const CREDENTIAL_KEY_TERM = String.raw`(?:passphrase|password|pwd|cookie|auth(?:orization)?|credential|secret|api[_-]?key|private[_-]?key|access[_-]?key|token(?!s)(?!_?count))`;

// Each pattern matches a credential shape a member might paste or a model might echo. Whole matches
// are replaced, except where a group keeps a harmless prefix such as "Bearer " or a scheme and host.
// Vendor-prefixed tokens have no leading \b: a prefix glued to another word or an underscore
// (x_ghp_..., tokenghp_...) must still be caught.
const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // A key with no END line (paste got cut off): redact to the next blank line, or to the end.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/xapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/ATATT[A-Za-z0-9_=-]{20,}/g, REDACTED],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  [/sk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/https?:\/\/hooks\.slack\.com\/services\/\S+/gi, REDACTED],
  // An Authorization header is always sensitive after the colon, even when the value is all letters.
  [/(authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)\S{8,}/gi, `$1${REDACTED}`],
  // Bare "bearer"/"basic" prose needs a digit or one of =+/ to look like a token, unless it is long
  // enough on its own (16+ chars) that it is unlikely to be an ordinary word (so "Basic
  // auth-examples" is left alone, but a 20-character bearer value is still caught).
  [/\b(bearer|basic)\s+(?:(?=[A-Za-z0-9._~+/=-]*[0-9=+/])[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{16,})/gi, `$1 ${REDACTED}`],
  // Any scheme's user-info (postgres://, redis://, amqp://, https://, ...), not just HTTP(S).
  [/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, `$1${REDACTED}@`],
  // Any query parameter whose name contains a credential-shaped term, not just a fixed list.
  [/([?&][\w-]*(?:token|secret|password|signature|key)[\w-]*=)[^&\s]+/gi, `$1${REDACTED}`],
];

const CREDENTIAL_KEY = new RegExp(CREDENTIAL_KEY_TERM, "i");

// "key: value" or "key=value" in free text or pasted JSON (quoted or bare), reusing the same
// credential terms as CREDENTIAL_KEY so the two never drift apart.
const KEY_VALUE_SECRET = new RegExp(String.raw`("?\b\w*${CREDENTIAL_KEY_TERM}\w*"?\s*[:=]\s*)(?:"([^"]*)"|([^\s&,}]+))`, "gi");

export function redactText(text: string): string {
  const afterPatterns = TEXT_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
  return afterPatterns.replace(
    KEY_VALUE_SECRET,
    (_match: string, prefix: string, quoted: string | undefined) => (quoted !== undefined ? `${prefix}"${REDACTED}"` : `${prefix}${REDACTED}`),
  );
}

/** A copy with credential-named values and credential-shaped strings replaced; never mutates. Only
 * string values are redacted by key name, so numeric fields such as tokenCount or max_tokens are
 * left untouched even though their name contains "token". */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, CREDENTIAL_KEY.test(key) && typeof child === "string" ? REDACTED : redactSecrets(child)]),
    );
  }
  return value;
}
