// A runner's head-side measurements. Comparison and baseline selection belong to the evidence producer, not to this file.
import { z } from "zod";
import { EVIDENCE_MEASURES_MAX, EvidenceMeasureSchema } from "./evidence.js";

export const MEASURES_FILE_MAX_BYTES = 8 * 1024 * 1024;
const notNegativeZero = (value: number | undefined): boolean => !Object.is(value, -0);
export const MeasuresFileEntrySchema = EvidenceMeasureSchema.pick({ name: true, unit: true, direction: true }).extend({
  value: EvidenceMeasureSchema.shape.head.refine(notNegativeZero, "not negative zero"),
  spread: EvidenceMeasureSchema.shape.spread.refine(notNegativeZero, "not negative zero"),
  count: z.number().int().min(0).max(100_000_000).refine(notNegativeZero, "not negative zero").optional(),
}).strict();
export const MeasuresFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** A runner reports these values; Rovara does not independently measure them. */
  source: z.literal("project_runner").default("project_runner"),
  /** SHA-256 of the eval set, when this file describes an eval. No baseline is implied. */
  eval_set_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  measures: z.array(MeasuresFileEntrySchema).min(1).max(EVIDENCE_MEASURES_MAX),
}).strict().refine((file) => new Set(file.measures.map((measure) => measure.name)).size === file.measures.length, "duplicate measure names");
export type MeasuresFile = z.infer<typeof MeasuresFileSchema>;
export type MeasuresFileRead = { status: "ok"; file: MeasuresFile } | { status: "newer" } | { status: "unreadable" };

/** Strict for the known version. Future versions are ignored, never interpreted as a successful measurement. */
export function readMeasuresFile(input: unknown): MeasuresFileRead {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { status: "unreadable" };
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isSafeInteger(version) && version > 1) return { status: "newer" };
  const parsed = MeasuresFileSchema.safeParse(input);
  return parsed.success ? { status: "ok", file: parsed.data } : { status: "unreadable" };
}

/** Bounded UTF-8 JSON; JSON.parse creates own keys, and the strict schema never copies unknown keys to an object. */
export function readMeasuresFileText(text: string): MeasuresFileRead {
  if (text.length > MEASURES_FILE_MAX_BYTES || new TextEncoder().encode(text).length > MEASURES_FILE_MAX_BYTES) return { status: "unreadable" };
  try { return readMeasuresFile(JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown); } catch { return { status: "unreadable" }; }
}
