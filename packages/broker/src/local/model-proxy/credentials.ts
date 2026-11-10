// Port lane P5 (item K2): where a provider's credential comes from. A provider that signs in with a role or a refreshed token brings it itself (`credential()`); any other
// provider's is its entry in the key store. Provider `none` needs none. The credential is a `SecretValue` and is read at the moment a call is signed, never kept.
import type { ModelKeyStore, ModelProviderAdapter, SecretValue } from "@agentx/contracts";
import { environmentVariableFor } from "../../ports/model-key-stores.js";
import { needsCredential } from "./sign-in.js";
import type { ModelProviderBook } from "./types.js";

/** The credential, or undefined when there is none. A provider's own `credential()` that throws is the caller's to handle (its words may quote a setting). */
export async function credentialOf(provider: ModelProviderAdapter, keys: ModelKeyStore, companyId: string): Promise<SecretValue | undefined> {
  if (!needsCredential(provider)) return undefined;
  const own = await provider.credential?.();
  return own ?? keys.get(companyId, provider.kind);
}

/** Whether a call to the provider could be signed now (no value is read out of the secret). A credential that cannot be read counts as missing. */
export async function hasCredential(provider: ModelProviderAdapter, keys: ModelKeyStore, companyId: string): Promise<boolean> {
  if (!needsCredential(provider)) return true;
  try {
    return (await credentialOf(provider, keys, companyId)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The providers a task could call now, in the book's order: those that need no credential, those whose own `credential()` gives one, and those with an entry in the key
 * store. A key store that cannot be read throws (the caller says so); one provider's failing `credential()` only leaves that provider out.
 */
export async function readyProviders(book: ModelProviderBook, keys: ModelKeyStore, companyId: string): Promise<string[]> {
  const stored = await keys.providers(companyId);
  const ready: string[] = [];
  for (const id of book.ids()) {
    const provider = book.get(id);
    if (provider === undefined) continue;
    const own = provider.credential === undefined ? false : await provider.credential().then((value) => value !== undefined, () => false);
    if (!needsCredential(provider) || own || stored.includes(id)) ready.push(id);
  }
  return ready;
}

/** What to tell the owner to do when a provider has no credential, by sign-in kind. */
export function credentialFix(provider: ModelProviderAdapter): string {
  switch (provider.signIn.kind) {
    case "aws-sigv4": return `sign in to AWS on this computer (the ${provider.name} provider uses your AWS role), or put its credential in the key file under "${provider.kind}"`;
    case "google-oauth": return `sign in to Google Cloud on this computer, or put an access token in the key file under "${provider.kind}"`;
    case "microsoft-entra": return `sign in to Microsoft on this computer, or put an access token in the key file under "${provider.kind}"`;
    default: return `put it in ~/.rovara/keys.json or the ${environmentVariableFor(provider.kind)} variable`;
  }
}
