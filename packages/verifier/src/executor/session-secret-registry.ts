import type { CredentialRedactor } from "./redact.js";

/**
 * The executor's register of session values (MIDSTEPCOOKIE): what each value is told to, by whether it is a credential.
 *
 * - A CREDENTIAL (a cookie value, a token) is told to the redactor as a session secret, kept in `sessionSecrets` (what the worker is told: the begin marker and the sync), and
 *   makes any model-bound payload that shows it refused (`modelScan`).
 * - An `evidenceOnly` value (a draft, a route, a cache the app left in storage) is scrubbed from what the executor writes and refused in evidence, but it is neither told to the worker nor
 *   does it make a model-bound payload refused: the worker refuses a call that shows a value it was told, so the executor's own check must agree with it.
 */
export interface SessionSecretRegistry {
  register(value: string, options?: { evidenceOnly?: boolean }): void;
  /** What the worker is told. */
  readonly sessionSecrets: string[];
  /** The executor's check of a model-bound payload: accounts and credentials, not evidence-only values. */
  modelScan(bytes: Uint8Array): boolean;
}

export function createSessionSecretRegistry(input: { redactor: CredentialRedactor; onRegister?: (value: string) => void }): SessionSecretRegistry {
  const sessionSecrets: string[] = [];
  return {
    sessionSecrets,
    register(value, options = {}): void {
      input.redactor.addSessionSecret(value, options);
      if (options.evidenceOnly !== true && typeof value === "string" && value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value);
      input.onRegister?.(value);
    },
    modelScan: (bytes) => input.redactor.contains(bytes, "model"),
  };
}
