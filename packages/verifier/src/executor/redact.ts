import type { E2EExecutorAccount } from "@agentx/contracts";

/** Every spelling of a secret that an HTTP client, a JSON encoder or a URL builder could leave in an output file. */
function spellings(value: string): string[] {
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64")]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

export type CredentialRedactor = Readonly<{
  /** Replaces every credential in text with `<account:profileId>`. */
  text(value: string): string;
  /** True when the bytes contain any account email or password in any known spelling. */
  contains(bytes: Uint8Array): boolean;
}>;

/**
 * Credentials live only in the read-only plan mount. Everything the executor writes under its out directory passes
 * through this: logs and diagnostics are redacted, evidence that carries a credential is refused.
 */
export function createCredentialRedactor(accounts: readonly E2EExecutorAccount[]): CredentialRedactor {
  const rules = accounts.flatMap((account) => [account.password, account.email]
    .flatMap((secret) => spellings(secret).map((form) => ({ form, label: `<account:${account.profileId}>` }))))
    .sort((a, b) => b.form.length - a.form.length);
  return Object.freeze({
    text(value: string): string {
      let result = value;
      for (const rule of rules) result = result.split(rule.form).join(rule.label);
      return result;
    },
    contains(bytes: Uint8Array): boolean {
      if (rules.length === 0) return false;
      const haystack = Buffer.from(bytes);
      return rules.some((rule) => haystack.includes(rule.form));
    },
  });
}
