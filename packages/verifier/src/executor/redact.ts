import type { E2EExecutorAccount } from "@agentx/contracts";
import { looksLikeZip, readZip, writeZip } from "./zip.js";

/** Every spelling of a secret that an HTTP client, a JSON encoder or a URL builder could leave in an output file. */
function spellings(value: string): string[] {
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64")]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

/** What replaces a session secret that was scrubbed out of a capture. */
export const SESSION_SCRUB_LABEL = "<session>";

type Rule = { form: string; label: string };

export type CredentialRedactor = Readonly<{
  /** Replaces every credential in text with `<account:profileId>` (an account) or `<session>` (a registered session secret). */
  text(value: string): string;
  /** True when the bytes contain any account email or password, or registered session secret, in any known spelling. */
  contains(bytes: Uint8Array): boolean;
  /**
   * Like `contains`, but also looks inside a ZIP archive's entries: a browser trace is deflated, so a credential in it cannot be seen in the archive's own bytes.
   * An archive that cannot be opened in full counts as a match, because it cannot be shown clean. `scope` "accounts" leaves the session secrets out, to ask whether
   * an archive carries an account credential before its session secrets are scrubbed.
   */
  containsDeep(bytes: Uint8Array, scope?: "accounts" | "all"): boolean;
  /** Registers a secret the run created (the session cookie) so `text`, `contains` and `scrubSession` know it. */
  addSessionSecret(value: string): void;
  /**
   * The bytes with every registered session secret replaced by `<session>`, entry by entry for a ZIP archive (rewritten, so it stays a readable archive). The same
   * bytes when there is nothing to replace; an archive that cannot be opened is returned as it came, for `containsDeep` to refuse.
   */
  scrubSession(bytes: Uint8Array): Uint8Array;
}>;

function replaceAll(haystack: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  if (needle.byteLength === 0 || haystack.indexOf(needle) < 0) return haystack;
  const parts: Buffer[] = [];
  let from = 0;
  for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, from)) {
    parts.push(haystack.subarray(from, at), replacement);
    from = at + needle.byteLength;
  }
  parts.push(haystack.subarray(from));
  return Buffer.concat(parts);
}

/**
 * Credentials live only in the read-only plan mount. Everything the executor writes under its out directory passes
 * through this: logs and diagnostics are redacted, evidence that carries a credential is refused.
 */
export function createCredentialRedactor(accounts: readonly E2EExecutorAccount[]): CredentialRedactor {
  const accountRules: Rule[] = accounts.flatMap((account) => [account.password, account.email]
    .flatMap((secret) => spellings(secret).map((form) => ({ form, label: `<account:${account.profileId}>` }))))
    .sort((a, b) => b.form.length - a.form.length);
  const sessionRules: Rule[] = [];
  const allRules = (): Rule[] => [...accountRules, ...sessionRules].sort((a, b) => b.form.length - a.form.length);
  const found = (rules: readonly Rule[], bytes: Uint8Array): boolean => {
    const haystack = Buffer.from(bytes);
    return rules.some((rule) => haystack.includes(rule.form));
  };
  return Object.freeze({
    text(value: string): string {
      let result = value;
      for (const rule of allRules()) result = result.split(rule.form).join(rule.label);
      return result;
    },
    contains(bytes: Uint8Array): boolean {
      return found(allRules(), bytes);
    },
    containsDeep(bytes: Uint8Array, scope: "accounts" | "all" = "all"): boolean {
      const rules = scope === "accounts" ? accountRules : allRules();
      if (rules.length === 0) return false;
      if (found(rules, bytes)) return true;
      if (!looksLikeZip(bytes)) return false;
      const entries = readZip(bytes);
      if (entries === null) return true;
      return entries.some((entry) => found(rules, entry.data) || found(rules, Buffer.from(entry.name, "utf8")));
    },
    addSessionSecret(value: string): void {
      if (typeof value !== "string" || value.length < 8) throw new Error("a session secret must be a long value that cannot be mistaken for ordinary text");
      for (const form of spellings(value)) if (!sessionRules.some((rule) => rule.form === form)) sessionRules.push({ form, label: SESSION_SCRUB_LABEL });
    },
    scrubSession(bytes: Uint8Array): Uint8Array {
      if (sessionRules.length === 0) return bytes;
      const scrub = (data: Uint8Array): Uint8Array => {
        let result: Buffer = Buffer.from(data);
        for (const rule of [...sessionRules].sort((a, b) => b.form.length - a.form.length)) result = replaceAll(result, Buffer.from(rule.form, "utf8"), Buffer.from(rule.label, "utf8"));
        return result;
      };
      if (!looksLikeZip(bytes)) return scrub(bytes);
      const entries = readZip(bytes);
      if (entries === null) return bytes;
      return writeZip(entries.map((entry) => ({ name: entry.name, data: scrub(entry.data) })));
    },
  });
}
