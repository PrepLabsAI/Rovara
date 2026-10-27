import { e2eScannableEmailLocalPart, type E2EExecutorAccount } from "@agentx/contracts";

/**
 * Pieces of the base64 (and base64url) text of `value` that stay the same wherever the value sits in a longer encoded string. Base64 groups three bytes into four
 * characters, so a secret inside a longer string is spelled differently for each of the three alignments, and only its inner characters are the same whatever bytes
 * come before and after it. Without the shifted forms, a credential in a `Basic` header or a JWT payload is missed two times in three.
 */
function base64Fragments(value: string): string[] {
  const data = Buffer.from(value, "utf8");
  const forms = new Set<string>();
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift), data]).toString("base64").replace(/=+$/, "");
    // The characters the unknown bytes before the value touch, and the one the unknown bytes after it may touch, are left out.
    const head = Math.ceil((shift * 8) / 6);
    const tail = (shift + data.byteLength) % 3 === 0 ? 0 : 1;
    const core = encoded.slice(head, encoded.length - tail);
    if (core.length >= 6) { forms.add(core); forms.add(core.replace(/\+/g, "-").replace(/\//g, "_")); }
  }
  return [...forms];
}

/** Every spelling of a secret that an HTTP client, a JSON encoder, a URL builder or a base64 or base64url field could leave in an output file. */
function spellings(value: string): string[] {
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"), ...base64Fragments(value)]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

const WRAP_GAP = /(?<=[A-Za-z0-9+/_=-])[\r\n\t ]+(?=[A-Za-z0-9+/_=-])/g;
/** The bytes with whitespace between two base64 characters removed, or null when there is none. Bytes are kept one for one (latin1), so nothing else changes. */
function unwrapBase64Lines(bytes: Buffer): Buffer | null {
  const text = bytes.toString("latin1");
  const unwrapped = text.replace(WRAP_GAP, "");
  return unwrapped.length === text.length ? null : Buffer.from(unwrapped, "latin1");
}

/** What replaces a session secret in text. */
export const SESSION_REDACTION_LABEL = "<session>";
/**
 * A session secret shorter than this is ignored altogether: not looked for in bytes, where a handful of characters would match almost anything, and not replaced in text, where a
 * value like `1`, `true` or `accepted` would rewrite numbers, booleans and words in a report and corrupt it.
 */
const MIN_SESSION_SECRET_LENGTH = 8;

/** `model` is false for a value registered evidence-only: it is scrubbed from text and refused in evidence, but a prompt that shows it is not refused (a draft or a route is app data, not a credential). */
type Rule = { form: string; label: string; bytes: boolean; session: boolean; model: boolean };

export type CredentialRedactor = Readonly<{
  /** Replaces every credential in text with `<account:profileId>` (an account) or `<session>` (a registered session secret). */
  text(value: string): string;
  /**
   * True when the bytes contain an account email or password, or a registered session secret, in any known spelling, including base64 and base64url at any alignment.
   * `scope` "accounts" leaves the session secrets out; "model" is what a model-bound payload is checked with: accounts and the session secrets that are credentials, not the ones
   * registered evidence-only.
   */
  contains(bytes: Uint8Array, scope?: "accounts" | "all" | "model"): boolean;
  /** Registers a secret the run created (the session cookie) so `text` redacts it and `contains` finds it. It never throws: a short or odd value is still redacted. */
  addSessionSecret(value: string, options?: { evidenceOnly?: boolean }): void;
}>;

/**
 * Credentials live only in the read-only plan mount. Everything the executor writes under its out directory passes
 * through this: logs and diagnostics are redacted, evidence that carries a credential is refused.
 */
export function createCredentialRedactor(accounts: readonly E2EExecutorAccount[]): CredentialRedactor {
  // The part of an email before the `@` is a credential too: an app that shows only that part must not leak it either. Which local parts are looked for on their own is the
  // contracts' one rule (`e2eScannableEmailLocalPart`), shared with the worker's model-channel credential scan; a short one would be redacted from everything.
  const rules: Rule[] = accounts.flatMap((account) => [account.password, account.email, e2eScannableEmailLocalPart(account.email)]
    .flatMap((secret) => (secret === null ? [] : [secret]))
    .flatMap((secret) => spellings(secret).map((form) => ({ form, label: `<account:${account.profileId}>`, bytes: true, session: false, model: true }))));
  rules.sort((a, b) => b.form.length - a.form.length);
  return Object.freeze({
    text(value: string): string {
      let result = value;
      for (const rule of rules) result = result.split(rule.form).join(rule.label);
      return result;
    },
    contains(bytes: Uint8Array, scope: "accounts" | "all" | "model" = "all"): boolean {
      const haystack = Buffer.from(bytes);
      const active = rules.filter((rule) => rule.bytes && (scope === "all" ? true : scope === "model" ? rule.model : !rule.session));
      if (active.some((rule) => haystack.includes(rule.form))) return true;
      // Base64 is often wrapped into lines (MIME, PEM-style bodies, a 20, 64 or 76 column wrap), which cuts a credential's spelling in two. The same bytes with the
      // whitespace between two base64 characters removed are looked at too.
      const unwrapped = unwrapBase64Lines(haystack);
      return unwrapped !== null && active.some((rule) => unwrapped.includes(rule.form));
    },
    addSessionSecret(value: string, options: { evidenceOnly?: boolean } = {}): void {
      if (typeof value !== "string" || value.length < MIN_SESSION_SECRET_LENGTH) return;
      const model = options.evidenceOnly !== true;
      for (const form of spellings(value)) {
        const existing = rules.find((rule) => rule.form === form);
        // A value first registered evidence-only becomes a credential if it is registered as one later; the other way round it stays one.
        if (existing === undefined) rules.push({ form, label: SESSION_REDACTION_LABEL, bytes: true, session: true, model });
        else if (model) existing.model = true;
      }
      rules.sort((a, b) => b.form.length - a.form.length);
    },
  });
}
