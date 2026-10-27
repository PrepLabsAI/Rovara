import { e2eScannableEmailLocalPart, e2eSecretSpellings, type E2EExecutorAccount } from "@agentx/contracts";

/**
 * Every spelling of a secret that an HTTP client, a JSON encoder, a URL builder or a base64, base64url or hex field could leave in an output file or a model prompt. It is the contracts'
 * one builder, the same the worker's model-channel scan uses (raw, JSON-escaped, percent-encoded once and twice, base64 and base64url at any alignment, hex), so the executor's scan and the
 * worker's cannot disagree about what a spelling of a secret is (MIDSTEP-2). Longest first, so a text replacement takes the longest form.
 */
function spellings(value: string): string[] {
  return e2eSecretSpellings(value).sort((a, b) => b.length - a.length);
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
  // Registration is O(1) per form (a Map index; the longest-first order is rebuilt on the first read after a change), because the mid-step sync feeds this thousands of values.
  const byForm = new Map<string, Rule>(rules.map((rule) => [rule.form, rule]));
  let sorted = true;
  const ordered = (): Rule[] => { if (!sorted) { rules.sort((a, b) => b.form.length - a.form.length); sorted = true; } return rules; };
  return Object.freeze({
    text(value: string): string {
      let result = value;
      for (const rule of ordered()) result = result.split(rule.form).join(rule.label);
      return result;
    },
    contains(bytes: Uint8Array, scope: "accounts" | "all" | "model" = "all"): boolean {
      const haystack = Buffer.from(bytes);
      const active = ordered().filter((rule) => rule.bytes && (scope === "all" ? true : scope === "model" ? rule.model : !rule.session));
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
        const existing = byForm.get(form);
        // A value first registered evidence-only becomes a credential if it is registered as one later; the other way round it stays one.
        if (existing === undefined) {
          const rule: Rule = { form, label: SESSION_REDACTION_LABEL, bytes: true, session: true, model };
          rules.push(rule);
          byForm.set(form, rule);
          sorted = false;
        } else if (model) existing.model = true;
      }
    },
  });
}
