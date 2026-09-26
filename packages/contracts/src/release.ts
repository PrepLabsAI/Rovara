import { z } from "zod";
import { STACK_PARTS } from "./environments.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** An image reference pinned to a digest (never a mutable tag). */
export const ImageDigest = z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/);

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
            file: z.string(),
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
          file: z.string(),
          sha256: Sha256,
          parts: z.array(z.string()).min(1),
          bucketParameter: z.string(),
          keyParameter: z.string(),
          hashParameter: z.string(),
          keyParameterValue: z.string(),
        })
        .strict(),
    ),
    images: z.object({ worker: ImageDigest.optional(), slack: ImageDigest.optional() }).strict(),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
