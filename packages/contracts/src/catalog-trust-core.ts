// Test services slice 1: which catalog keys a verifier trusts, as pure functions of the lists it is GIVEN. NOT exported from the package's index: production code reaches it only through `catalog-trust.ts`, which gives
// it the compiled-in list and nothing else. (Cloud's staging-only key, its build flavor and its testing seam are Cloud's and are not carried here.)
import { parseBundlePublicKey } from "./signing-key.js";

export interface CatalogSigningKey {
  /** SHA-256 (hex) of the key's SubjectPublicKeyInfo DER, as `parseBundlePublicKey` computes it. A key whose id does not match its PEM is dropped. */
  readonly keyId: string;
  /** The public key as a PEM PUBLIC KEY (SPKI), ECDSA P-256. */
  readonly publicKey: string;
  readonly algorithm: "ECDSA_SHA_256";
}

export interface CatalogTrustContext {
  /** The AWS account the process is running in, from its own identity, or undefined. Code trusts the same keys in every account; an install that adds an account-bound key list (Cloud's staging) does it outside this package. */
  readonly runningAccountId: string | undefined;
}

export interface CatalogTrustLists {
  readonly real: readonly CatalogSigningKey[];
}

function pemsOf(keys: readonly CatalogSigningKey[]): string[] {
  return keys.flatMap((key) => {
    try {
      return key.algorithm === "ECDSA_SHA_256" && parseBundlePublicKey(key.publicKey).keyId === key.keyId ? [key.publicKey] : [];
    } catch {
      return [];
    }
  });
}

/** The PEM keys that count: the real ones. */
export function trustedKeyPemsOf(_context: CatalogTrustContext, lists: CatalogTrustLists): string[] {
  return pemsOf(lists.real);
}
