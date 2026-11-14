// TE-F2 part B (M2, release 0.5.19; DECISIONS 158, 161): the two files the worker writes for the helper into the per-run directory that F1-b's launch mounts read-only (the sandbox cannot see it): `rows.json` (the rows the
// helper serves, only what routing needs) and `replies.json` (the RESOLVED reply sets, one per family, each reply already stamped with the provenance the WORKER decided). The helper parses both strictly, and serves a bundle
// only when its bytes hash to the digest in its arguments (`--digest`): a file that is not the one the worker pinned is refused and nothing listens. PURE apart from `node:crypto` (through `sha256HexOf`).
import { z } from "zod";
import { MODEL_FAMILIES, ModelReplySetSchema, SERVED_MODEL_FAMILIES, canonicalJson, sha256HexOf, type ModelReplySet, type ServableRow, type ServedModelFamily } from "@agentx/contracts/model-helper";

export const MODEL_REPLY_BUNDLE_VERSION = 1;
export const MODEL_REPLY_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;
export const MODEL_ROWS_FILE_MAX_BYTES = 256 * 1024;
const BUNDLE_DOMAIN = "rovara-model-reply-bundle/v1\n";

const RowSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
    family: z.enum(MODEL_FAMILIES),
    pathPrefix: z.string().max(120).regex(/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+){0,7}$/u).optional(),
    routesTo: z.literal("local_aws_front").optional(),
  })
  .strict();
export const ModelHelperRowsSchema = z
  .array(RowSchema)
  .max(128)
  .superRefine((rows, context) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) context.addIssue({ code: "custom", message: "a row id is listed once" });
  });

export const ModelReplyBundleSchema = z
  .object({ version: z.literal(MODEL_REPLY_BUNDLE_VERSION), sets: z.array(ModelReplySetSchema).max(SERVED_MODEL_FAMILIES.length) })
  .strict()
  .superRefine((bundle, context) => {
    const families = bundle.sets.map((set) => set.family);
    if (new Set(families).size !== families.length) context.addIssue({ code: "custom", path: ["sets"], message: "a family has one reply set" });
  });
export type ModelReplyBundle = z.infer<typeof ModelReplyBundleSchema>;

/** The bundle for a list of resolved sets: one per family, in the fixed family order, so the same sets always give the same bytes and digest. */
export function buildModelReplyBundle(sets: readonly ModelReplySet[]): ModelReplyBundle {
  const order = new Map(SERVED_MODEL_FAMILIES.map((family, index) => [family, index] as const));
  return { version: MODEL_REPLY_BUNDLE_VERSION, sets: [...sets].sort((left, right) => (order.get(left.family) ?? 0) - (order.get(right.family) ?? 0)) };
}
export const modelReplyBundleBytes = (bundle: ModelReplyBundle): Uint8Array => {
  if (bundle.sets.some((set) => set.replies.some((reply) => reply.provenance === "independent"))) throw new RangeError("replies.json cannot carry an independent reply yet (the reply store, R1, defines that delivery)");
  return new TextEncoder().encode(JSON.stringify(bundle));
};
/** The digest the helper's `--digest` pins: SHA-256 over a fixed domain prefix and the canonical JSON of the bundle. */
export const modelReplyBundleDigest = (bundle: ModelReplyBundle): string => sha256HexOf(new TextEncoder().encode(`${BUNDLE_DOMAIN}${canonicalJson(bundle)}`));

export type ParsedReplyBundle = { ok: true; bundle: ModelReplyBundle; digest: string; byFamily: Map<ServedModelFamily, ModelReplySet> } | { ok: false };

/** Strict parse of the bundle file; `expectedDigest` (when given) must equal the bundle's digest. Fixed result, never the text. */
export function parseModelReplyBundleBytes(bytes: Uint8Array, expectedDigest?: string): ParsedReplyBundle {
  try {
    if (bytes.byteLength > MODEL_REPLY_BUNDLE_MAX_BYTES) return { ok: false };
    const parsed = ModelReplyBundleSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    if (!parsed.success) return { ok: false };
    // Bytes can carry any provenance: `independent` is accepted only from Rovara's own channel (`createRovaraIndependentDecision`), never from replies.json (the contracts' `parseModelReplySetBytes` refuses it too).
    if (parsed.data.sets.some((set) => set.replies.some((reply) => reply.provenance === "independent"))) return { ok: false };
    const digest = modelReplyBundleDigest(parsed.data);
    if (expectedDigest !== undefined && digest !== expectedDigest) return { ok: false };
    return { ok: true, bundle: parsed.data, digest, byFamily: new Map(parsed.data.sets.map((set) => [set.family, set] as const)) };
  } catch {
    return { ok: false };
  }
}

export function parseModelHelperRowsBytes(bytes: Uint8Array): ServableRow[] | undefined {
  try {
    if (bytes.byteLength > MODEL_ROWS_FILE_MAX_BYTES) return undefined;
    const parsed = ModelHelperRowsSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    return parsed.success ? parsed.data.map((row) => ({ id: row.id, family: row.family, ...(row.pathPrefix === undefined ? {} : { pathPrefix: row.pathPrefix }), ...(row.routesTo === undefined ? {} : { routesTo: row.routesTo }) })) : undefined;
  } catch {
    return undefined;
  }
}
