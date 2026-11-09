// Test services slice 1: the ONLY source of trusted keys for the signed service catalog (`loadSignedCatalog`). Nothing here reads an environment variable, an SSM parameter, a setting or a file at run time: the keys are
// compiled in. There is NO parameter that adds a key. Cloud's staging-only key, its build flavor and its testing seam belong to Cloud's own build and are not carried into Code; a catalog is verified with
// CATALOG_TRUSTED_SIGNING_KEYS only. Possibly empty, and then nothing verifies.
//
import { loadSignedCatalogWith, type LoadedCatalog } from "./catalog-load-core.js";
import { trustedKeyPemsOf, type CatalogSigningKey, type CatalogTrustContext } from "./catalog-trust-core.js";

export type { CatalogSigningKey, CatalogTrustContext };

export const CATALOG_TRUSTED_SIGNING_KEYS: readonly CatalogSigningKey[] = [];

/** The account id in an ARN (`arn:aws:lambda:us-west-2:123456789012:function:...`), or nothing. */
export function accountIdOfArn(arn: string | undefined): string | undefined {
  const match = typeof arn === "string" ? /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:([0-9]{12}):/u.exec(arn) : null;
  return match?.[1];
}

/** The PEM keys a verifier may trust right now. Possibly empty, and then nothing verifies (`loadSignedCatalog`: "no trusted catalog key"). Takes no list: only the compiled-in one. */
export function catalogTrustedKeyPems(context: CatalogTrustContext): string[] {
  return trustedKeyPemsOf(context, { real: CATALOG_TRUSTED_SIGNING_KEYS });
}

/** The signed catalog, verified with the compiled-in keys. `trust` carries the running account (from the process's own identity). Nothing else widens or narrows the keys. */
export function loadSignedCatalog(input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array; trust?: CatalogTrustContext }): LoadedCatalog {
  return loadSignedCatalogWith(input, catalogTrustedKeyPems(input.trust ?? { runningAccountId: undefined }));
}
