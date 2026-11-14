// Shared with F9 (the producer owns this contract). A final result, bound to the checked candidate.
import { z } from "zod";
import { TEST_ID_MAX } from "./test-id.js";

export const REAL_MODEL_CHECK_ARTIFACT = "real-model-check.json";
const itemShape = {
  checkId: z.string().min(1).max(64),
  /** Absent means the WHOLE check ran. Test results never substitute for a whole-check result. */
  test: z.string().min(1).max(TEST_ID_MAX).optional(),
  result: z.enum(["passed", "passed_on_rerun", "failed", "not_run"]),
};
const shape = { schemaVersion: z.literal(1), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u) };
// Refuse the total before traversing any items. Known fields total at most 200 * (64 + 500) characters.
const boundedItems = z.unknown().refine((items) => Array.isArray(items) && items.length <= 200, "unsupported");
const unique = (items: { checkId: string; test?: string | undefined }[]) => new Set(items.map((item) => JSON.stringify([item.checkId, item.test]))).size === items.length;
export const RealModelCheckWriteSchema = z.object({ ...shape, items: boundedItems.pipe(z.array(z.object(itemShape).strict()).refine(unique, "unsupported")) }).strict();
/** Unknown fields are stripped; an invalid item invalidates the entire run. */
export const RealModelCheckSchema = z.object({ ...shape, items: boundedItems.pipe(z.array(z.object(itemShape)).refine(unique, "unsupported")) });
export type RealModelCheck = z.infer<typeof RealModelCheckSchema>;

/** Exact check/test match only. Candidate binding is the caller's responsibility. Invalid input is never an agreement. */
export function realModelPassed(result: unknown, checkId: string, testId?: string): boolean {
  const parsed = RealModelCheckSchema.safeParse(result);
  if (!parsed.success) return false;
  const item = parsed.data.items.find((entry) => entry.checkId === checkId && entry.test === testId);
  return item?.result === "passed" || item?.result === "passed_on_rerun";
}
