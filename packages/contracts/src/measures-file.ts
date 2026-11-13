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
/** The newest measures-file version this reader understands. Version 2 (TE-F3-b) adds `seed` and per-question `questions`; everything else is version 1's. */
export const MEASURES_FILE_VERSION = 2;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const QUESTION_CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,39}$/u;
export const MEASURES_FILE_QUESTIONS_MAX = 50_000;
/** One question's result in one run: `pass` (true is 1, false is 0) or a `score` from 0 to 1 (exactly one), and the run's index when the eval was run more than once. */
export const EvalQuestionRowSchema = z.object({
  id: z.string().regex(QUESTION_ID),
  category: z.string().regex(QUESTION_CATEGORY),
  pass: z.boolean().optional(),
  score: z.number().min(0).max(1).refine(notNegativeZero, "not negative zero").optional(),
  run: z.number().int().min(0).max(999).refine(notNegativeZero, "not negative zero").optional(),
}).strict().refine((row) => (row.pass === undefined) !== (row.score === undefined), "exactly one of pass and score");
export type EvalQuestionRow = z.infer<typeof EvalQuestionRowSchema>;
/** A question result in one shape: a score from 0 to 1 and a run index. */
export interface EvalQuestionResult {
  readonly id: string;
  readonly category: string;
  readonly score: number;
  readonly run: number;
}
export const EvalSeedSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u);
export const MeasuresFileSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  /** A runner reports these values; Rovara does not independently measure them. */
  source: z.literal("project_runner").default("project_runner"),
  /** SHA-256 of the eval set, when this file describes an eval. No baseline is implied. */
  eval_set_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  measures: z.array(MeasuresFileEntrySchema).min(1).max(EVIDENCE_MEASURES_MAX),
  /** Version 2: the seed the runner was given. */
  seed: EvalSeedSchema.optional(),
  /** Version 2: every question's result in every run. */
  questions: z.array(EvalQuestionRowSchema).max(MEASURES_FILE_QUESTIONS_MAX).optional(),
}).strict()
  .refine((file) => new Set(file.measures.map((measure) => measure.name)).size === file.measures.length, "duplicate measure names")
  .refine((file) => file.schemaVersion === 2 || (file.seed === undefined && file.questions === undefined), "seed and questions need version 2")
  .refine((file) => questionRowsConsistent(file.questions), "a question and run twice, or a question in two categories");
export type MeasuresFile = z.infer<typeof MeasuresFileSchema>;

/** One result per (question, run), and one category per question id. */
function questionRowsConsistent(rows: readonly EvalQuestionRow[] | undefined): boolean {
  if (rows === undefined) return true;
  const seen = new Set<string>();
  const categories = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.id}\u0000${String(row.run ?? 0)}`;
    if (seen.has(key) || (categories.get(row.id) ?? row.category) !== row.category) return false;
    seen.add(key);
    categories.set(row.id, row.category);
  }
  return true;
}
/** The file's question results as plain scores and run indexes (none for a version 1 file). */
export function normalizedQuestions(file: Pick<MeasuresFile, "questions">): EvalQuestionResult[] {
  return (file.questions ?? []).map((row) => ({ id: row.id, category: row.category, score: row.score ?? (row.pass === true ? 1 : 0), run: row.run ?? 0 }));
}
export type MeasuresFileRead = { status: "ok"; file: MeasuresFile } | { status: "newer" } | { status: "unreadable" };

/**
 * Strict for the known versions. Future versions are ignored, never interpreted as a successful measurement. `maxVersion` is the newest version the READER understands (default: this build's): a reader that only knows version 1
 * answers `newer` for a version 2 file, and A4's report reader turns that into a refusal, so an older reader never reads a v2 file as a measurement.
 */
export function readMeasuresFile(input: unknown, options: { readonly maxVersion?: number } = {}): MeasuresFileRead {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { status: "unreadable" };
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isSafeInteger(version) && version > (options.maxVersion ?? MEASURES_FILE_VERSION)) return { status: "newer" };
  const parsed = MeasuresFileSchema.safeParse(input);
  return parsed.success ? { status: "ok", file: parsed.data } : { status: "unreadable" };
}

/** Bounded UTF-8 JSON; JSON.parse creates own keys, and the strict schema never copies unknown keys to an object. */
export function readMeasuresFileText(text: string): MeasuresFileRead {
  if (text.length > MEASURES_FILE_MAX_BYTES || new TextEncoder().encode(text).length > MEASURES_FILE_MAX_BYTES) return { status: "unreadable" };
  try { return readMeasuresFile(JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown); } catch { return { status: "unreadable" }; }
}
