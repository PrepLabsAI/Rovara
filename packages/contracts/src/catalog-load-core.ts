// Test services slice 1: the signed catalog loader over an explicit list of keys. NOT exported from the package's index: `loadSignedCatalog` (catalog-trust.ts) gives it the compiled-in keys; tests give their own through
// `@agentx/contracts/testing`.
import { CATALOG_MAX_BYTES, CATALOG_SIGNATURE_MAX_BYTES, CatalogSignatureSchema, verifyCatalogSignature, type CatalogSignature } from "./service-catalog-verify.js";
import { ServiceCatalogSchema } from "./service-catalog.js";
import type { VerifiedCatalog } from "./service-catalog-images.js";
import { registerVerifiedCatalog } from "./service-catalog-brand.js";

export type LoadedCatalog = { ok: true; catalog: VerifiedCatalog; keyId: string } | { ok: false; reason: string };

/**
 * The catalog a caller may trust: size caps, the signature over the exact bytes, then the strict schema. A signed but half-pinned file does not get through (the schema refuses it), and neither does an unsigned
 * or wrongly signed one. An empty key list is "no trusted catalog key". Returns a reason in fixed words instead of throwing.
 */
export function loadSignedCatalogWith(input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array }, trustedKeys: readonly string[]): LoadedCatalog {
  if (trustedKeys.length === 0) return { ok: false, reason: "no trusted catalog key" };
  if (input.catalogBytes.byteLength > CATALOG_MAX_BYTES || input.signatureBytes.byteLength > CATALOG_SIGNATURE_MAX_BYTES) return { ok: false, reason: "the catalog or its signature is too large" };
  let signature: CatalogSignature;
  try {
    signature = CatalogSignatureSchema.parse(JSON.parse(Buffer.from(input.signatureBytes).toString("utf8")));
  } catch {
    return { ok: false, reason: "the catalog signature file is not valid" };
  }
  const checked = verifyCatalogSignature({ catalogBytes: input.catalogBytes, signature, trustedKeys });
  if (!checked.ok) return { ok: false, reason: checked.reason };
  try {
    const catalog = ServiceCatalogSchema.parse(JSON.parse(Buffer.from(input.catalogBytes).toString("utf8")));
    // The one place a catalog is marked verified (at run time, in a private registry, and frozen): the signature held over these exact bytes and the schema parsed them.
    return { ok: true, catalog: registerVerifiedCatalog(catalog), keyId: checked.keyId };
  } catch {
    return { ok: false, reason: "the catalog is signed but does not pass the catalog schema" };
  }
}
