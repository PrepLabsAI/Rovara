const REDACTED = "[REDACTED]";

// Each pattern matches a credential shape a member might paste or a model might echo. Whole matches
// are replaced, except where a group keeps a harmless prefix such as "Bearer ".
const TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // The lookahead needs a digit or symbol, so prose such as "a basic understanding" is kept.
  [/\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, `$1${REDACTED}@`],
  [/([?&](?:token|access_token|api_key|apikey|password|secret)=)[^&\s]+/gi, `$1${REDACTED}`],
];

const CREDENTIAL_KEY = /token|secret|password|authorization|credential|api[_-]?key|private[_-]?key/i;

export function redactText(text: string): string {
  return TEXT_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

/** A copy with credential-named values and credential-shaped strings replaced; never mutates. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, CREDENTIAL_KEY.test(key) ? REDACTED : redactSecrets(child)]));
  }
  return value;
}
