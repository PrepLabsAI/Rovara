import { SESSION_REDACTION_LABEL, type CredentialRedactor } from "./redact.js";
import { isPathLike, isSlugOrPath, type ClassifiedValue, type CredentialTier } from "./credential-classifier.js";
import { classifyStorageEntry } from "./storage-entry-classifier.js";

/**
 * The executor's register of session values (MIDSTEPCOOKIE): what each value is told to, by whether it is a credential.
 *
 * - A CREDENTIAL (a cookie value, a token) is told to the redactor as a session secret, kept in `sessionSecrets` (what the worker is told: the begin marker and the sync), and
 *   makes any model-bound payload that shows it refused (`modelScan`).
 * - An `evidenceOnly` value (a draft, a route, a cache the app left in storage) is scrubbed from what the executor writes and refused in evidence, but it is neither told to the worker nor
 *   does it make a model-bound payload refused: the worker refuses a call that shows a value it was told, so the executor's own check must agree with it. Unless it is `scrubOnly`, the model
 *   never sees it either: `maskForModel` replaces it with `<session>` in every model-bound payload (MASKMAYBE). A `scrubOnly` value is an ordinary one (a sentence, a path, a URL, an email, a
 *   date, a UUID, a slug, a word, hex) that the model must be able to read: only evidence is scrubbed of it.
 * - A `maskOnly` value is a weak one past the evidence cap: held in memory for the model's mask, written nowhere. When even that is full (`overflow`), the model's view fails closed:
 *   `maskForModel` also replaces every opaque token-shaped run of 16 characters or more. The run does not fail.
 */
export interface SessionSecretRegisterOptions {
  evidenceOnly?: boolean;
  scrubOnly?: boolean;
  maskOnly?: boolean;
  /** Some weak values could not be registered at all (the value is ignored): the model's view fails closed from now on. */
  overflow?: boolean;
}

export interface SessionSecretRegistry {
  readonly register: (value: string, options?: SessionSecretRegisterOptions) => void;
  /** What the worker is told. */
  readonly sessionSecrets: string[];
  /** The executor's check of a model-bound payload: accounts and credentials, not evidence-only values. */
  readonly modelScan: (bytes: Uint8Array) => boolean;
  /**
   * The check for what the executor WRITES (an agent trace): the same scope as the parent's final output scan, evidence-only values included. A trace that shows one is dropped here, so a value
   * that is allowed in a model prompt can never reach the out directory and end the run `credential-leak` at the final scan.
   */
  readonly evidenceScan: (bytes: Uint8Array) => boolean;
  /**
   * What the model is shown instead of an evidence-only (weak) value: the text with each such value replaced by `<session>` (the evidence scrub's placeholder). A credential is NOT replaced here;
   * it is refused by `modelScan`. A scrub-only value is not replaced. Every model-bound payload passes through this before the scans (`model-channel.ts`).
   */
  readonly maskForModel: (text: string) => string;
  /** Whether the view has failed closed (weak values were left unregistered). */
  readonly maskOverflowed: () => boolean;
}

/** The register options a classified value is registered with; `null` for a strong value (no options). */
export function registerOptionsFor(tier: CredentialTier): SessionSecretRegisterOptions | undefined {
  switch (tier) {
    case "strong": return undefined;
    case "weak": return { evidenceOnly: true };
    case "scrub": return { evidenceOnly: true, scrubOnly: true };
    case "mask": return { maskOnly: true };
    case "overflow": return { overflow: true };
  }
}

/**
 * Registers one storage entry the way sign-in and the mid-step sync classify it (`classifyStorageEntry`): a credential (key and value, JSON leaves included) is a session secret; any other long value
 * is evidence-only (and masked for the model if it is token-shaped or under a secret-sounding name); a short or common one is not registered.
 */
export function registerStorageEntry(register: SessionSecretRegistry["register"], entry: { name: string; value: string }): void {
  for (const item of classifyStorageEntry(entry)) registerItem(register, item);
}

export function registerItem(register: SessionSecretRegistry["register"], item: ClassifiedValue): void {
  const options = registerOptionsFor(item.tier);
  if (options === undefined) register(item.value); else register(item.value, options);
}

/**
 * The fail-closed view (MASKMAYBE round 2, R-5a): every run of 16 or more of letters, digits and `+ / _ = -`, of any length and whatever its letters (digits, one case, both), except a slug or a
 * path (a route the model must read to navigate).
 */
const TOKEN_RUN = /[A-Za-z0-9+/_=-]{16,}/g;
function opaqueRun(run: string): boolean {
  return !isSlugOrPath(run) && !isPathLike(run);
}
/** A text the mask could not finish reading is masked as above, and also every run of 8 to 15 that has a letter and a digit (a weak URL `code` or `state` value). */
const SHORT_TOKEN_RUN = /[A-Za-z0-9+/_=-]{8,}/g;
function shortOpaqueRun(run: string): boolean {
  return run.length >= 16 ? opaqueRun(run) : /[0-9]/.test(run) && /[A-Za-z]/.test(run);
}

export function createSessionSecretRegistry(input: { redactor: CredentialRedactor; onRegister?: (value: string, options?: SessionSecretRegisterOptions) => void }): SessionSecretRegistry {
  const sessionSecrets: string[] = [];
  let overflowed = false;
  return {
    sessionSecrets,
    register(value, options = {}): void {
      if (options.overflow === true) { overflowed = true; return; }
      if (options.maskOnly === true) {
        // Memory only: nothing is written and the worker is not told.
        if (!input.redactor.addMaskOnly(value)) overflowed = true;
        return;
      }
      input.redactor.addSessionSecret(value, options);
      if (options.evidenceOnly !== true && typeof value === "string" && value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value);
      input.onRegister?.(value, options);
    },
    modelScan: (bytes) => input.redactor.contains(bytes, "model"),
    evidenceScan: (bytes) => input.redactor.contains(bytes, "all"),
    maskForModel: (text) => {
      const { text: masked, exceeded } = input.redactor.maskEvidenceOnlyBounded(text);
      // Fail closed: the view as a whole (a value could not be registered), or this text alone (the mask hit its work bound and left the rest of the text unread).
      if (overflowed && !input.redactor.maskDegraded()) return masked.replace(TOKEN_RUN, (run) => (opaqueRun(run) ? SESSION_REDACTION_LABEL : run));
      return exceeded || input.redactor.maskDegraded() ? masked.replace(SHORT_TOKEN_RUN, (run) => (shortOpaqueRun(run) ? SESSION_REDACTION_LABEL : run)) : masked;
    },
    maskOverflowed: () => overflowed || input.redactor.maskDegraded(),
  };
}
