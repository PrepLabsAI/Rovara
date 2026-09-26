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
          .strict(),
      )
      .refine(
        (templates) => new Set(templates.map((t) => `${t.region}/${t.part}`)).size === templates.length,
        "each (region, part) pair must appear exactly once in templates",
      ),
    packages: z.array(
      z
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
        .refine((pkg) => pkg.file === `packages/${pkg.assetId}.zip`, "file must equal packages/<assetId>.zip"),
    ),
    images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional() }).strict(),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
