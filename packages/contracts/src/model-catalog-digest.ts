// TE-F0a: the stable digest of a model-catalog row set, and the UNSIGNED parse of its bytes.
//
// SIGNING IS NOT DONE HERE, on purpose. The service catalog's verifier (`service-catalog-verify.ts`) signs a domain-prefixed message ("rovara-service-catalog/v1\n") and its `verifyOver` is private; the model rows need their own
// domain prefix ("rovara-model-catalog/v1\n") and a build key, which is a key ceremony: it needs a Rovara-held signing key, a new `CATALOG_TRUSTED_SIGNING_KEYS`-style compiled-in list, and one exported helper in
// service-catalog-verify.ts. None of that is built, no key is shipped, and no new trust scheme is invented. Until then a caller gets the strict parse plus a digest that does not depend on key order, and `signed: false`.
// The digest is what a later signature (or a release note) pins: change any row and it changes.
import { canonicalJson } from "./canonical-json.js";
import { ModelCatalogSchema, type ModelCatalog } from "./model-catalog.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const MODEL_CATALOG_MAX_BYTES = 1024 * 1024;
const MODEL_CATALOG_DIGEST_DOMAIN = "rovara-model-catalog/v1\n";

/** SHA-256 (hex) over a fixed domain prefix and the canonical JSON of the catalog (keys in alphabetical order, no whitespace): the same row set always gives the same digest. */
export function modelCatalogDigest(catalog: ModelCatalog): string {
  return sha256HexOf(new TextEncoder().encode(`${MODEL_CATALOG_DIGEST_DOMAIN}${canonicalJson(ModelCatalogSchema.parse(catalog))}`));
}

export type ParsedModelCatalog = { ok: true; catalog: ModelCatalog; digest: string; signed: false } | { ok: false; reason: string };

/** The strict parse of a catalog file's bytes: size cap, JSON, then the schema. Fixed words on failure; never throws. `signed` is false until the key ceremony above exists. */
export function parseModelCatalogBytes(bytes: Uint8Array): ParsedModelCatalog {
  if (bytes.byteLength > MODEL_CATALOG_MAX_BYTES) return { ok: false, reason: "the model catalog is too large" };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "the model catalog is not valid JSON" };
  }
  const parsed = ModelCatalogSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "the model catalog does not pass the row schema" };
  return { ok: true, catalog: parsed.data, digest: modelCatalogDigest(parsed.data), signed: false };
}
