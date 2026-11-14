// F9 owns the artifact consumed by 192a. Informational evidence, never a check or change proof.
import { z } from "zod";
import { TEST_ID_MAX } from "./test-id.js";
import { inertEvidenceText } from "./evidence-inert.js";
import { NOT_RUN_SENTENCES, capSentence } from "./model-egress/classify.js";
import { formatUsdMicros } from "./model-egress/cost.js";

export const REAL_MODEL_CHECK_ARTIFACT = "real-model-check.json";
export const REAL_MODEL_CHECK_ITEMS_MAX = 200;
export const REAL_MODEL_NOT_RUN = {
  invalid_input: "not run: real model inputs could not be read",
  input_limit: "not run: real model inputs exceed the size limit",
  attribution_unknown: "not run: Rovara couldn't tell which tests use the model",
  call_count_unknown: "not run: call count unknown",
  too_many_tests: "not run: too many changed AI tests",
  ports_missing: "not run: product key approval and monthly meter are not connected",
  round_kind: "not run: real model tests need a check round",
  approval_missing: "not run: product key approval is unavailable",
  approval_invalid: "not run: product key approval does not cover these tests",
  no_product_key: "not run: no product AI key is connected",
  grant_cap: "not run: the approved call or cost ceiling cannot fit these tests",
  task_cap: capSentence(2_000_000),
  monthly_cap: "not run: the monthly cap cannot fit these tests",
  rate_limit: NOT_RUN_SENTENCES.rate_limit,
  quota: NOT_RUN_SENTENCES.quota,
  overloaded: NOT_RUN_SENTENCES.overloaded,
  key_refused: NOT_RUN_SENTENCES.key_refused,
  cap: capSentence(2_000_000),
  provider_error: "not run: the model provider did not complete the call",
  refused: "not run: the model call was refused",
  invalid_usage: "not run: model usage could not be read",
  invalid_results: "not run: real model results could not be read",
  timed_out: "not run: the real model check reached its time limit",
  run_unavailable: "not run: the real model test run could not complete",
  close_unavailable: "not run: the monthly reservation could not be closed",
} as const;
export type RealModelNotRunReason = keyof typeof REAL_MODEL_NOT_RUN;
const reasonSchema = z.enum(Object.keys(REAL_MODEL_NOT_RUN) as [RealModelNotRunReason, ...RealModelNotRunReason[]]);
const whole = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const itemShape = {
  checkId: z.string().min(1).max(64),
  test: z.string().min(1).max(TEST_ID_MAX).optional(),
  result: z.enum(["passed", "passed_on_rerun", "failed", "not_run"]),
  /** On a failed item this explains why its re-run did not run; the first failure survives. */
  reason: reasonSchema.optional(),
};
const totalsShape = { selected: whole, passed: whole, passedOnRerun: whole, failed: whole, notRun: whole };
const shape = {
  schemaVersion: z.literal(1),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["skipped", "completed", "partly_run", "not_run"]),
  calls: whole,
  costMicros: whole,
  model: z.string().min(1).max(160).nullable(),
  reason: reasonSchema.optional(),
  /** Exact selected count when the 50-test execution limit refused the entire selection. */
  tooManyCount: whole.optional(),
};
const reader = z.object({ ...shape, items: z.array(z.object(itemShape)).max(REAL_MODEL_CHECK_ITEMS_MAX), totals: z.object(totalsShape) });
type Result = z.infer<typeof reader>;
function consistent(r: Result): boolean {
  const counts = { selected: r.items.length, passed: 0, passedOnRerun: 0, failed: 0, notRun: 0 };
  const seen = new Set<string>();
  for (const item of r.items) {
    const key = JSON.stringify([item.checkId, item.test]);
    if (seen.has(key)) return false;
    seen.add(key);
    counts[item.result === "passed_on_rerun" ? "passedOnRerun" : item.result === "not_run" ? "notRun" : item.result] += 1;
    if (item.result === "not_run" && item.reason === undefined) return false;
    if ((item.result === "passed" || item.result === "passed_on_rerun") && item.reason !== undefined) return false;
  }
  if ((Object.keys(counts) as Array<keyof typeof counts>).some(key => r.totals[key] !== counts[key])) return false;
  const ran = counts.selected - counts.notRun;
  if (ran > 0 && (r.model === null || r.calls < ran)) return false;
  if (r.status === "skipped") return counts.selected === 0 && r.calls === 0 && r.costMicros === 0 && r.model === null && r.reason === undefined;
  if (r.status === "not_run") return ran === 0 && r.reason !== undefined;
  if (ran === 0) return false;
  const partial = counts.notRun > 0 || r.reason !== undefined || r.items.some(i => i.result === "failed" && i.reason !== undefined);
  return r.status === (partial ? "partly_run" : "completed");
}
/** Strict worker writer; tolerant readers strip additional fields, never discard malformed items. */
export const RealModelCheckWriteSchema = z.object({ ...shape, items: z.array(z.object(itemShape).strict()).max(REAL_MODEL_CHECK_ITEMS_MAX), totals: z.object(totalsShape).strict() }).strict().refine(consistent);
// TE-192a reads minimal evidence and re-wraps single items with the original run's accounting.
// Accounting remains validated when present, but is not needed to confirm an exact result.
export const RealModelCheckSchema = reader.partial({ status: true, calls: true, costMicros: true, model: true, totals: true })
  .refine(r => new Set(r.items.map(item => JSON.stringify([item.checkId, item.test]))).size === r.items.length);
const summaryReader = reader.refine(consistent);
export type RealModelCheck = z.infer<typeof RealModelCheckSchema>;

/** Exact check/test match only; neither level implies the other. Callers also match candidateDigest. */
export function realModelPassed(raw: unknown, checkId: string, testId?: string): boolean {
  const parsed = RealModelCheckSchema.safeParse(raw);
  if (!parsed.success) return false;
  const matches = parsed.data.items.filter(item => item.checkId === checkId && item.test === testId);
  return matches.length === 1 && (matches[0]!.result === "passed" || matches[0]!.result === "passed_on_rerun");
}

export function realModelCheckLine(raw: unknown): string | undefined {
  const parsed = summaryReader.safeParse(raw);
  if (!parsed.success) return `Real model check: ${REAL_MODEL_NOT_RUN.invalid_results}.`;
  const r = parsed.data;
  if (r.status === "skipped") return undefined;
  if (r.status === "not_run") return `Real model check: ${REAL_MODEL_NOT_RUN[r.reason!]}${r.reason === "too_many_tests" && r.tooManyCount !== undefined ? ` (${r.tooManyCount})` : ""}.`;
  const names = (items: Result["items"]): string => items.slice(0, 10).map(i => inertEvidenceText(i.test ?? i.checkId, TEST_ID_MAX)).join(", ") + (items.length > 10 ? `; ${items.length - 10} more` : "");
  const t = r.totals;
  let text = r.status === "partly_run" ? "partly run: " : "";
  if (t.passed === t.selected) text += `${t.passed} of ${t.selected} changed AI tests passed on the real model (${inertEvidenceText(r.model!, 160)}).`;
  else {
    const parts: string[] = [];
    if (t.passed > 0 || t.passedOnRerun > 0) parts.push(`${t.passed} of ${t.selected} passed`);
    if (t.passedOnRerun > 0) parts.push(`${t.passedOnRerun} passed only on re-run (flaky on the real model): ${names(r.items.filter(i => i.result === "passed_on_rerun"))}`);
    const twice = r.items.filter(i => i.result === "failed" && i.reason === undefined);
    if (twice.length > 0) parts.push(`${twice.length} of ${t.selected} failed on the real model twice: ${names(twice)}`);
    for (const reason of Object.keys(REAL_MODEL_NOT_RUN) as RealModelNotRunReason[]) {
      const failures = r.items.filter(i => i.result === "failed" && i.reason === reason);
      if (failures.length > 0) parts.push(`${failures.length} failed on the first run; re-run ${REAL_MODEL_NOT_RUN[reason]}: ${names(failures)}`);
      const absent = r.items.filter(i => i.result === "not_run" && i.reason === reason);
      if (absent.length > 0) parts.push(`${absent.length} ${REAL_MODEL_NOT_RUN[reason]}`);
    }
    text += `${parts.join("; ")}.`;
  }
  if (r.reason !== undefined) text += ` ${REAL_MODEL_NOT_RUN[r.reason]}.`;
  return `Real model check: ${text} ${r.calls} calls, ${formatUsdMicros(r.costMicros)}, paid with your product key.`;
}
