// Port lane P5 (item K2): where a provider's credential comes from, and in what order. The credential is a `SecretValue`, read at the moment a call is signed and never kept here.
//
// Precedence, for every provider (tested):
//   1. Provider sign-in `none`: no credential.
//   2. The key store's entry for the provider (the environment variable, then `keys.json`): what the owner wrote down on purpose always wins, so a least-privilege key in `keys.json` is
//      never replaced by a broad session the shell happens to have.
//   3. The provider's own `credential()` (a role, a refreshed token): used only when the key store has no entry.
import type { ModelKeyStore, ModelProviderAdapter, SecretValue } from "@agentx/contracts";
import { modelKeyVariable } from "../../ports/model-key-stores.js";
import { needsCredential } from "./sign-in.js";
import type { ModelProviderBook } from "./types.js";

/** The credential, or undefined when there is none. A provider's own `credential()` that throws is the caller's to handle (its words may quote a setting). */
export async function credentialOf(provider: ModelProviderAdapter, keys: ModelKeyStore, companyId: string): Promise<SecretValue | undefined> {
  if (!needsCredential(provider)) return undefined;
  const stored = await keys.get(companyId, provider.kind);
  if (stored !== undefined) return stored;
  return provider.credential?.();
}

/**
 * Whether a call to the provider could be signed now (no value is read out of the secret). A key store that cannot be read THROWS (the caller names the source, never the error's words);
 * a provider's own `credential()` that fails only counts as "no credential".
 */
export async function hasCredential(provider: ModelProviderAdapter, keys: ModelKeyStore, companyId: string): Promise<boolean> {
  if (!needsCredential(provider)) return true;
  if ((await keys.get(companyId, provider.kind)) !== undefined) return true;
  if (provider.credential === undefined) return false;
  return provider.credential().then((value) => value !== undefined, () => false);
}

/**
 * The providers a task could call now, in the book's order: those that need no credential, those with an entry in the key store, and those whose own `credential()` gives one. `only` limits the
 * check to the providers that could be chosen (the setting's provider, or the default order): another provider's `credential()` is never run on a model choice. A key store that cannot be read
 * throws (the caller says so); one provider's failing `credential()` only leaves that provider out.
 */
export async function readyProviders(book: ModelProviderBook, keys: ModelKeyStore, companyId: string, only?: readonly string[]): Promise<string[]> {
  const stored = await keys.providers(companyId);
  const ready: string[] = [];
  for (const id of book.ids()) {
    if (only !== undefined && !only.includes(id)) continue;
    const provider = book.get(id);
    if (provider === undefined) continue;
    if (!needsCredential(provider) || stored.includes(id)) {
      ready.push(id);
    } else if (provider.credential !== undefined && await provider.credential().then((value) => value !== undefined, () => false)) {
      ready.push(id);
    }
  }
  return ready;
}

/** What to tell the owner to do when a provider has no credential, by sign-in kind. A provider's own fixed sentence about why (a missing module, a profile) comes first. */
export function credentialFix(provider: ModelProviderAdapter): string {
  const why = provider.credentialProblem?.();
  const prefix = why === undefined ? "" : `${why}; `;
  switch (provider.signIn.kind) {
    case "aws-sigv4": return `${prefix}check the AWS profile or role set for ${provider.name} in your config, or put its credential in the key file under "${provider.kind}"`;
    case "google-oauth": return `${prefix}sign in to Google Cloud on this computer, or put an access token in the key file under "${provider.kind}"`;
    case "microsoft-entra": return `${prefix}sign in to Microsoft on this computer, or put an access token in the key file under "${provider.kind}"`;
    default: return `put it in ~/.rovara/keys.json or the ${modelKeyVariable(provider.kind)} variable`;
  }
}
