import { z } from "zod";
import { STACK_PARTS } from "./environments.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** An image reference pinned to a digest (never a mutable tag). */
export const ImageDigest = z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/);

// Both patterns are anchored and admit no "/" inside a segment and no ".." or leading "/", so a
// file recorded in release.json can never name a path outside the release directory by
// construction: there is no character class or literal in either pattern that a traversal or an
// absolute path could match. packages/cli/src/deploy/release.ts still re-checks containment at
// load time (defense in depth), but the schema is the first and strongest line of defense because
// whoever can edit release.json also controls its recorded sha256, so a checksum match alone
// proves nothing about where the path points.
const TEMPLATE_FILE_PATTERN = /^templates\/[a-z0-9-]+\/[a-z-]+\.template\.json$/;
const PACKAGE_FILE_PATTERN = /^packages\/[a-f0-9]{64}\.zip$/;
const LEGAL_FILE_PATTERN = /^legal\/(LICENSE|LICENSE-APACHE|RELICENSED\.md)$/;

const ReleasePackageSchema = z
  .object({
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    file: z.string().regex(PACKAGE_FILE_PATTERN),
    sha256: Sha256,
    parts: z.array(z.string()).min(1),
    bucketParameter: z.string(),
    keyParameter: z.string(),
    hashParameter: z.string(),
    keyParameterValue: z.string(),
  })
  .strict()
  .refine((pkg) => pkg.file === `packages/${pkg.assetId}.zip`, "file must equal packages/<assetId>.zip");

export const ReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    environmentPlaceholder: z.literal("qqenv-placeholderqq"),
    templates: z
      .array(
        z
          .object({
            region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
            part: z.enum(STACK_PARTS),
            file: z.string().regex(TEMPLATE_FILE_PATTERN),
            sha256: Sha256,
          })
          .strict()
          .refine((t) => t.file === `templates/${t.region}/${t.part}.template.json`, "file must equal templates/<region>/<part>.template.json"),
      )
      .refine(
        (templates) => new Set(templates.map((t) => `${t.region}/${t.part}`)).size === templates.length,
        "each (region, part) pair must appear exactly once in templates",
      ),
    packages: z.array(ReleasePackageSchema),
    // Code packages only an Enterprise install's stacks use (for example the operator-access stack's deployer function). A Public install ignores this list (nothing deploys these
    // files there), a bundle signs them like every other package, and a build made at approval may use no package that neither list names. Absent from releases before the synthesis kit.
    enterprisePackages: z.array(ReleasePackageSchema).optional(),
    // Optional for compatibility with release manifests created before license documents were
    // checksummed. New release builders include the current license, retained Apache license,
    // and the grant-history notice.
    legalDocuments: z
      .array(z.object({ file: z.string().regex(LEGAL_FILE_PATTERN), sha256: Sha256 }).strict())
      .optional()
      .refine((documents) => documents === undefined || new Set(documents.map((document) => document.file)).size === documents.length,
        "legal document files must be unique"),
    // `embedder`: the self-hosted embedder's Lambda image (environments/embedder), used where the Team record is built. Absent from releases before it.
    images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional(), executor: ImageDigest.optional(), embedder: ImageDigest.optional() }).strict(),
    // Task 10: the SHA-256 of packages/worker/ec2/boot-stage2.sh in this release's source, which is the stage 2 boot script the worker image
    // carries. A deploy writes it as the BootStage2Sha256 setting beside the worker image. Absent from releases before the boot split.
    bootStage2Sha256: Sha256.optional(),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: unknown, keys: readonly string[]): unknown => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) : value);

/**
 * For a reader that only deploys what it checks (the in-account bundle deployer): the release manifest with fields this version does not know DROPPED, every field it does know checked
 * exactly as `ReleaseManifestSchema` checks it. A later release that adds an optional field therefore cannot stop an installed deployer from reading it (the deployer is upgraded by a bundle,
 * so a deployer that refused every newer release could not be upgraded). A change that must stop older readers bumps `schemaVersion`, which stays a literal here. Unknown fields are never read.
 */
export function parseReleaseManifestIgnoringUnknownFields(json: unknown): ReleaseManifest {
  if (!isRecord(json)) return ReleaseManifestSchema.parse(json);
  const shape = ReleaseManifestSchema.shape;
  const known = {
    ...(only(json, Object.keys(shape)) as Record<string, unknown>),
  };
  const entryKeys = {
    templates: Object.keys(shape.templates.element.shape),
    packages: Object.keys(shape.packages.element.shape),
    enterprisePackages: Object.keys(shape.enterprisePackages.unwrap().element.shape),
    legalDocuments: Object.keys(shape.legalDocuments.unwrap().element.shape),
  } as const;
  for (const [name, keys] of Object.entries(entryKeys)) {
    const list = known[name];
    if (Array.isArray(list)) known[name] = list.map((entry) => only(entry, keys));
  }
  if (isRecord(known.images)) known.images = only(known.images, Object.keys(shape.images.shape));
  return ReleaseManifestSchema.parse(known);
}
