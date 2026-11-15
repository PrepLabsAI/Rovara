// TE-F1a: the frame: one model call as the helper hands it to the bridge, and the bridge to the adapter. Strict zod: an unknown key is refused (a `__proto__` key is an unknown key and never reaches an object), headers are a list of
// pairs (so a duplicate is visible and no header name can become a property), and the body is bytes.
//
// The frame NEVER names a company, a project or a source: the scope is opaque and comes from the adapter's own capability (design 4.2). A frame that carries such a field is refused like any other unknown key.
import { z } from "zod";
import type { ModelEgressRefusal } from "./refusals.js";

/** The catalog's row-id shape (F0a keeps it private; `model-catalog.ts` `RowId`). */
const ModelEgressRowIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u);

export const MODEL_EGRESS_BODY_MAX_BYTES = 5 * 1024 * 1024;
/** The longest path or query the schema will hold; `families.ts` refuses anything over its own, smaller limits (`too_large`). */
export const MODEL_EGRESS_PATH_PARSE_MAX = 4096;
export const MODEL_EGRESS_HEADERS_MAX = 64;
export const MODEL_EGRESS_HEADER_NAME_PARSE_MAX = 256;
export const MODEL_EGRESS_HEADER_VALUE_PARSE_MAX = 8192;

export const ModelEgressFrameSchema = z
  .object({
    /** The catalog row this call is for: the helper takes it from the path prefix `/p/<row>`. */
    row: ModelEgressRowIdSchema,
    /** Any method token: `CONNECT` and the rest parse, and are refused by name (`not_allowed`), not as a parse error. */
    method: z.string().min(1).max(16),
    /** The path after the row's prefix, with no query. */
    path: z.string().min(1).max(MODEL_EGRESS_PATH_PARSE_MAX),
    /** The query string without its `?`; empty for none. */
    query: z.string().max(MODEL_EGRESS_PATH_PARSE_MAX),
    /** Every header the client sent, as pairs: the core drops what it must and keeps only an allow list. */
    headers: z.array(z.tuple([z.string().max(MODEL_EGRESS_HEADER_NAME_PARSE_MAX), z.string().max(MODEL_EGRESS_HEADER_VALUE_PARSE_MAX)])).max(MODEL_EGRESS_HEADERS_MAX),
    body: z.instanceof(Uint8Array).refine((body) => body.byteLength <= MODEL_EGRESS_BODY_MAX_BYTES, "a body of at most 5 MB"),
  })
  .strict();
export type ModelEgressFrame = z.infer<typeof ModelEgressFrameSchema>;

export type ModelEgressFrameParse = { readonly ok: true; readonly frame: ModelEgressFrame } | { readonly ok: false; readonly refusal: Extract<ModelEgressRefusal, "bad_request" | "too_large"> };

/** A frame, or the refusal word for why not: `too_large` for a body, path or query over its bound, `bad_request` for everything else. Never throws and never echoes the input. */
export function parseModelEgressFrame(input: unknown): ModelEgressFrameParse {
  const parsed = ModelEgressFrameSchema.safeParse(input);
  if (parsed.success) return { ok: true, frame: parsed.data };
  const tooLarge = parsed.error.issues.some((issue) => (issue.code === "too_big" && ["path", "query"].includes(String(issue.path[0]))) || (issue.path[0] === "body" && issue.code === "custom" && issue.message.includes("5 MB")));
  return { ok: false, refusal: tooLarge ? "too_large" : "bad_request" };
}
