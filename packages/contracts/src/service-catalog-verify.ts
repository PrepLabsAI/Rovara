// Test services, TS19: the checks on a pinned catalog that need Node's crypto (so they are not in `service-catalog-images.ts`, which is pure).
//
//   - The catalog is SIGNED as a file: `catalog.sig.json` holds an ECDSA P-256 signature over the exact bytes of `catalog.json`, behind a fixed prefix (a catalog signature can never be a bundle signature). The
//     keys are the same public keys installers already pin for release bundles (`parseBundlePublicKey`). `loadSignedCatalog` is the one way a caller gets a catalog it may trust: the signature, then the strict schema
//     (a half-pinned file does not parse). It returns a `VerifiedCatalog`, the only type `resolveCatalogImage` accepts.
//   - Each image has a signed STATEMENT (id, repository, the index digest, and for EVERY platform its child manifest digest, SBOM hash and scan time): the evidence the build keeps beside the catalog. A statement for one
//     image or one digest verifies for no other, and one that leaves a platform out is not the statement the build signed.
//   - The company-registry check (owner Q9, company installs): a customer's internal registry must serve the exact digest. The manifest is fetched BY DIGEST and its bytes are hashed here, so a registry that answers with
//     other bytes (a tag followed, a rebuilt image, a proxy) is a mismatch that stops that image only.
import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { parseBundlePublicKey } from "./signing-key.js";
import { CATALOG_PLATFORMS, type ServiceCatalog } from "./service-catalog.js";
import { catalogPins, type CatalogEdition, type MirrorCheck } from "./service-catalog-images.js";
import { registerMirrorCheck } from "./service-catalog-brand.js";
import { catalogIdName, CatalogIdSchema } from "./test-env-dependency.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const sha256HexOf = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export const CATALOG_FILE = "catalog.json";
export const CATALOG_SIGNATURE_FILE = "catalog.sig.json";
export const CATALOG_SIGNATURE_ALGORITHM = "ecdsa-p256-sha256";
export const CATALOG_SIGNATURE_MAX_BYTES = 64 * 1024;
export const CATALOG_MAX_BYTES = 1024 * 1024;
const CATALOG_DOMAIN = "rovara-service-catalog/v1\n";
const IMAGE_DOMAIN = "rovara-catalog-image/v2\n";

export const CatalogSignatureSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal(CATALOG_SIGNATURE_ALGORITHM),
    /** SHA-256 (hex) of the signing key's SubjectPublicKeyInfo DER, as a bundle signature names it. */
    keyId: Sha256Schema,
    /** SHA-256 (hex) of catalog.json: informational; the verifier recomputes it. */
    catalogSha256: Sha256Schema,
    signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256),
  })
  .strict();
export type CatalogSignature = z.infer<typeof CatalogSignatureSchema>;

/** The exact bytes a catalog signature covers: the domain prefix, then the file's bytes. */
export const catalogSigningMessage = (catalogBytes: Uint8Array): Buffer => Buffer.concat([Buffer.from(CATALOG_DOMAIN, "utf8"), Buffer.from(catalogBytes)]);

function verifyOver(message: Buffer, keyId: string, signatureBase64: string, trustedKeys: readonly string[]): { ok: true; keyId: string } | { ok: false; reason: string } {
  try {
    const candidates = trustedKeys.flatMap((pem) => {
      try {
        const parsed = parseBundlePublicKey(pem);
        return parsed.keyId === keyId ? [parsed] : [];
      } catch {
        return [];
      }
    });
    if (candidates.length === 0) return { ok: false, reason: `signed by a key this installation does not trust (${keyId.slice(0, 16)})` };
    const bytes = Buffer.from(signatureBase64, "base64");
    for (const candidate of candidates) if (verify("sha256", message, { key: candidate.key, dsaEncoding: "der" }, bytes)) return { ok: true, keyId: candidate.keyId };
    return { ok: false, reason: "the signature does not match" };
  } catch {
    return { ok: false, reason: "the signature could not be checked" };
  }
}

export type CatalogSignatureCheck = { ok: true; keyId: string; catalogSha256: string } | { ok: false; reason: string };

/** Checks `signature` against the exact `catalogBytes`. Fails closed and never throws. */
export function verifyCatalogSignature(input: { catalogBytes: Uint8Array; signature: CatalogSignature; trustedKeys: readonly string[] }): CatalogSignatureCheck {
  const catalogSha256 = sha256HexOf(input.catalogBytes);
  if (input.signature.catalogSha256 !== catalogSha256) return { ok: false, reason: "the signature file names a different catalog.json" };
  const checked = verifyOver(catalogSigningMessage(input.catalogBytes), input.signature.keyId, input.signature.signature, input.trustedKeys);
  return checked.ok ? { ok: true, keyId: checked.keyId, catalogSha256 } : checked;
}

// ---- one image's signed statement

/** One platform of an image: the child manifest digest of the index, and the SBOM hash and scan time recorded for exactly that manifest. */
export const ImageChildStatementSchema = z.object({ platform: z.enum(CATALOG_PLATFORMS), digest: Sha256Schema, sbomRef: Sha256Schema, scannedAt: z.string().datetime() }).strict();
export type ImageChildStatement = z.infer<typeof ImageChildStatementSchema>;

const byPlatform = (a: ImageChildStatement, b: ImageChildStatement): number => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0);

/** The one SBOM hash an entry carries in the catalog when it has several platforms: the SHA-256 of `<platform>=<sbom hash>` lines in platform order. The per-platform hashes are in the evidence and the statement. */
export function combinedSbomRef(children: ReadonlyArray<{ platform: string; sbomRef: string }>): string {
  return createHash("sha256").update([...children].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0)).map((child) => `${child.platform}=${child.sbomRef}\n`).join(""), "utf8").digest("hex");
}

export const ImageStatementSchema = z
  .object({
    id: CatalogIdSchema,
    repository: z.string().regex(/^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u),
    /** The digest the catalog pins: the INDEX (manifest list) digest. */
    digest: Sha256Schema,
    /** The combined SBOM hash the catalog carries (`combinedSbomRef` of the children). */
    sbomRef: Sha256Schema,
    /** The oldest scan time of the children. */
    scannedAt: z.string().datetime(),
    /** Every platform, with its child manifest digest and its own SBOM hash and scan time. */
    children: z.array(ImageChildStatementSchema).min(1).max(CATALOG_PLATFORMS.length),
    /**
     * A Rovara-built image (the emulator) has Java libraries compiled into its native binary, which an image scan cannot see; its build also scans the dependency list. The SHA-256 of that scan result (kept in the evidence
     * folder) and its finding counts. Absent for every image that has none, so those statements and their signatures are exactly what they were.
     */
    javaScan: z.object({ sha256: Sha256Schema, /** The SHA-256 of the CycloneDX dependency list the scan was bound to (every finding names a component of it). */ sbomSha256: Sha256Schema, criticalOpen: z.literal(0), highOpen: z.number().int().min(0).max(100_000) }).strict().optional(),
  })
  .strict()
  .superRefine((statement, context) => {
    if (new Set(statement.children.map((child) => child.platform)).size !== statement.children.length) context.addIssue({ code: "custom", path: ["children"], message: "a platform is listed once" });
    if (new Set(statement.children.map((child) => child.digest)).size !== statement.children.length) context.addIssue({ code: "custom", path: ["children"], message: "a child digest is listed once" });
    if (statement.sbomRef !== combinedSbomRef(statement.children)) context.addIssue({ code: "custom", path: ["sbomRef"], message: "the SBOM hash is the combined hash of the children" });
    const oldest = [...statement.children.map((child) => child.scannedAt)].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (Date.parse(statement.scannedAt) !== Date.parse(oldest ?? "")) context.addIssue({ code: "custom", path: ["scannedAt"], message: "the scan time is the oldest of the children" });
  });
export type ImageStatement = z.infer<typeof ImageStatementSchema>;

/** The text an image signature covers (domain prefix, then one field per line, in this order; the children by platform, four lines each). */
export function imageStatementMessage(statement: ImageStatement): Buffer {
  const checked = ImageStatementSchema.parse(statement);
  const children = [...checked.children].sort(byPlatform).map((child) => `${child.platform}\n${child.digest}\n${child.sbomRef}\n${child.scannedAt}\n`).join("");
  const javaScan = checked.javaScan === undefined ? "" : `javaScan\n${checked.javaScan.sha256}\n${checked.javaScan.sbomSha256}\n${String(checked.javaScan.highOpen)}\n`;
  return Buffer.from(`${IMAGE_DOMAIN}${checked.id}\n${checked.repository}\n${checked.digest}\n${checked.sbomRef}\n${checked.scannedAt}\n${String(checked.children.length)}\n${children}${javaScan}`, "utf8");
}

export const SignedImageStatementSchema = z.object({ statement: ImageStatementSchema, keyId: Sha256Schema, signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256) }).strict();
export type SignedImageStatement = z.infer<typeof SignedImageStatementSchema>;

export function verifyImageStatement(input: { signed: SignedImageStatement; trustedKeys: readonly string[] }): { ok: true; keyId: string } | { ok: false; reason: string } {
  const parsed = SignedImageStatementSchema.safeParse(input.signed);
  if (!parsed.success) return { ok: false, reason: "the image statement is not valid" };
  return verifyOver(imageStatementMessage(parsed.data.statement), parsed.data.keyId, parsed.data.signature, input.trustedKeys);
}

// ---- the company registry serves the exact digest (owner Q9)

export const MIRROR_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** Fetches the manifest a registry serves for `repositoryName@sha256:<digest>`; nothing when the registry does not have it. The registry is asked BY DIGEST. */
export interface RegistryManifestPort {
  manifestBytes(repositoryName: string, digest: string): Promise<Uint8Array | undefined>;
}

const MIRROR_MESSAGES = {
  missing: (service: string) => `${service} image: the company registry does not hold the catalog's digest`,
  digest_mismatch: (service: string) => `${service} image: the company registry serves other bytes than the catalog's digest`,
  unreachable: (service: string) => `${service} image: the company registry could not be checked`,
} as const;

/** One image: the registry must hold the manifest of exactly `digest`. The bytes are hashed here; the registry's word is not taken. */
export async function checkMirrorServesDigest(port: RegistryManifestPort, input: { id: string; repositoryName: string; digest: string }): Promise<MirrorCheck> {
  const service = catalogIdName(input.id);
  const fail = (code: keyof typeof MIRROR_MESSAGES): MirrorCheck => registerMirrorCheck({ id: input.id, ok: false, code, message: MIRROR_MESSAGES[code](service) });
  try {
    if (!Sha256Schema.safeParse(input.digest).success) return fail("digest_mismatch");
    const bytes = await port.manifestBytes(input.repositoryName, input.digest);
    if (bytes === undefined) return fail("missing");
    if (bytes.byteLength === 0 || bytes.byteLength > MIRROR_MANIFEST_MAX_BYTES) return fail("digest_mismatch");
    return sha256HexOf(bytes) === input.digest ? registerMirrorCheck({ id: input.id, ok: true, digest: input.digest }) : fail("digest_mismatch");
  } catch {
    return fail("unreachable");
  }
}

/**
 * Every pinned entry of an edition against the company's registry. Each image is checked on its own: a mismatch or an outage for one never stops another (the result lists them all).
 * `repositoryNameFor` is the company's own repository path for a catalog repository.
 */
export async function checkCatalogMirror(input: { catalog: ServiceCatalog; edition?: CatalogEdition; port: RegistryManifestPort; repositoryNameFor: (catalogRepository: string) => string }): Promise<MirrorCheck[]> {
  return Promise.all(
    catalogPins(input.catalog, input.edition ?? "enterprise").map(async (pin): Promise<MirrorCheck> => {
      // The company's own naming function is called inside the per-image try: one that throws for one repository is that image's failure to check, not the whole run's.
      let repositoryName: string;
      try {
        repositoryName = input.repositoryNameFor(pin.repository);
      } catch {
        return registerMirrorCheck({ id: pin.id, ok: false, code: "unreachable", message: MIRROR_MESSAGES.unreachable(catalogIdName(pin.id)) });
      }
      return checkMirrorServesDigest(input.port, { id: pin.id, repositoryName, digest: pin.digest });
    }),
  );
}
