import type { CredentialRedactor } from "./redact.js";
import { classifyStorageEntry } from "./storage-entry-classifier.js";

/**
 * The executor's register of session values (MIDSTEPCOOKIE): what each value is told to, by whether it is a credential.
 *
 * - A CREDENTIAL (a cookie value, a token) is told to the redactor as a session secret, kept in `sessionSecrets` (what the worker is told: the begin marker and the sync), and
 *   makes any model-bound payload that shows it refused (`modelScan`).
 * - An `evidenceOnly` value (a draft, a route, a cache the app left in storage) is scrubbed from what the executor writes and refused in evidence, but it is neither told to the worker nor
 *   does it make a model-bound payload refused: the worker refuses a call that shows a value it was told, so the executor's own check must agree with it.
 */
export interface SessionSecretRegistry {
  readonly register: (value: string, options?: { evidenceOnly?: boolean }) => void;
  /** What the worker is told. */
  readonly sessionSecrets: string[];
  /** The executor's check of a model-bound payload: accounts and credentials, not evidence-only values. */
  readonly modelScan: (bytes: Uint8Array) => boolean;
  /**
   * The check for what the executor WRITES (an agent trace): the same scope as the parent's final output scan, evidence-only values included. A trace that shows one is dropped here, so a value
   * that is allowed in a model prompt can never reach the out directory and end the run `credential-leak` at the final scan.
   */
  readonly evidenceScan: (bytes: Uint8Array) => boolean;
}

/**
 * Registers one storage entry the way sign-in and the mid-step sync classify it (`classifyStorageEntry`): a credential (key and value, JSON leaves included) is a session secret; any other long value
 * is evidence-only; a short or common one is not registered.
 */
export function registerStorageEntry(register: SessionSecretRegistry["register"], entry: { name: string; value: string }): void {
  for (const item of classifyStorageEntry(entry)) { if (item.tier === "strong") register(item.value); else register(item.value, { evidenceOnly: true }); }
}

export function createSessionSecretRegistry(input: { redactor: CredentialRedactor; onRegister?: (value: string, options?: { evidenceOnly?: boolean }) => void }): SessionSecretRegistry {
  const sessionSecrets: string[] = [];
  return {
    sessionSecrets,
    register(value, options = {}): void {
      input.redactor.addSessionSecret(value, options);
      if (options.evidenceOnly !== true && typeof value === "string" && value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value);
      input.onRegister?.(value, options);
    },
    modelScan: (bytes) => input.redactor.contains(bytes, "model"),
    evidenceScan: (bytes) => input.redactor.contains(bytes, "all"),
  };
}
