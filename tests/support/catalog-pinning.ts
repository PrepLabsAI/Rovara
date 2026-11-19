// Test services: a pinned catalog and a signer for tests, built at run time (no key is kept anywhere). The digests are the SHA-256 of the entry's id, so they are stable and differ per entry.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { CATALOG_SIGNATURE_ALGORITHM, ServiceCatalogSchema, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, type ServiceCatalog, type VerifiedCatalog } from "@agentx/contracts";
import { loadSignedCatalogWith } from "../../packages/contracts/dist/catalog-load-core.js";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The catalog file exactly as it is committed and shipped (a pinned, signed revision). Tests of the shipped state read this. */
export const shippedCatalog = (): ServiceCatalog => ServiceCatalogSchema.parse(JSON.parse(readFileSync("tests/fixtures/service-catalog/catalog.json", "utf8")));
/**
 * An UNPINNED catalog, as an explicit fixture: the shipped file's entries with every pin taken off (no digest, SBOM hash or scan; `pinned` false; revision 1). A test of what happens to a catalog that pins nothing uses this, so it
 * does not change whenever an operator pins an entry in the shipped file. `revision` defaults to 1; the broker refuses a revision under its minimum before it looks at pins, so a test of the broker's "not pinned" words passes the minimum.
 */
export function unpinnedCatalog(revision = 1): ServiceCatalog {
  const raw = JSON.parse(readFileSync("tests/fixtures/service-catalog/catalog.json", "utf8")) as { pinned: boolean; revision: number; entries: Array<Record<string, unknown>> };
  raw.pinned = false;
  raw.revision = revision;
  for (const entry of raw.entries) {
    delete (entry["image"] as { digest?: string }).digest;
    delete entry["sbomRef"];
    delete entry["scan"];
  }
  return ServiceCatalogSchema.parse(raw);
}
export const digestOfId = (id: string): string => sha(`image:${id}`);

/** A pinned copy of the data file: every non-retired entry gets its digest, an SBOM hash and a clean scan. */
export function pinnedCatalog(change: (entries: Array<Record<string, unknown>>) => void = () => undefined): ServiceCatalog {
  const raw = JSON.parse(readFileSync("tests/fixtures/service-catalog/catalog.json", "utf8")) as { pinned: boolean; revision: number; entries: Array<Record<string, unknown>> };
  raw.pinned = true;
  // The revision stays the shipped file's, which the broker's minimum equals (a test keeps the two equal).
  for (const entry of raw.entries) {
    const id = entry["id"] as string;
    // a helper that runs from the worker's own image has no image to pin.
    if (entry["workerImage"] === true) continue;
    (entry["image"] as { digest?: string }).digest = digestOfId(id);
    entry["sbomRef"] = sha(`sbom:${id}`);
    entry["scan"] = { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 1 };
  }
  change(raw.entries);
  return ServiceCatalogSchema.parse(raw);
}

export interface TestSigner {
  readonly publicKeyPem: string;
  sign: (message: Buffer) => Promise<Buffer>;
}
/** An ECDSA P-256 signer with a key made now. */
export function testSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    async sign(message: Buffer) {
      return createSign("sha256").update(message).sign({ key: privateKey, dsaEncoding: "der" });
    },
  };
}

/**
 * A catalog as `resolveCatalogImage` takes it: signed with a key made now and loaded through `loadSignedCatalog`, the one function that returns a `VerifiedCatalog`. (Nothing in a test asserts the brand with a cast.)
 */
export function verifiedCatalog(catalog: ServiceCatalog): VerifiedCatalog {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2), "utf8");
  const signature = createSign("sha256").update(catalogSigningMessage(catalogBytes)).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
  const loaded = loadSignedCatalogWith({ catalogBytes, signatureBytes }, [publicKeyPem]);
  if (!loaded.ok) throw new Error(`the test catalog did not load: ${loaded.reason}`);
  return loaded.catalog;
}

/** A catalog loader that trusts exactly the keys the test names (`@agentx/contracts/testing`), for the broker's `load` port. Test code only. */
export function loaderTrusting(...trustedKeys: string[]) {
  return (input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array }) => loadSignedCatalogWith({ catalogBytes: input.catalogBytes, signatureBytes: input.signatureBytes }, trustedKeys);
}
