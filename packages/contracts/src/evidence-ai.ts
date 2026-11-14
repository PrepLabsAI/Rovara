// AI evidence is a projection of the bound eval artifact, never another verdict rule.
import { z } from "zod";
import { EVAL_NOT_RUN_REASONS } from "./eval-check.js";
import { evalResultFromArtifact, readEvalRoundArtifact } from "./eval-round-artifact.js";
import { inertEvidenceText } from "./evidence-inert.js";

const count = z.number().int().min(0).max(100_000);
const percentage = z.number().min(0).max(100);
export const RealModelRunSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ran"), passed: count, total: count.min(1), rerunFailures: count, trust: z.literal("real") }).strict().refine(r => r.passed <= r.total && r.rerunFailures <= r.total),
  z.object({ status: z.literal("not_run"), reason: z.enum(["not_available", "invalid_result", "no_product_key", "not_connected", "stopped", "provider_error"]) }).strict(),
]);
export type RealModelRunSummary = z.infer<typeof RealModelRunSummarySchema>;
const excerpt = (max: number) => z.string().max(max * 2).refine(s => Array.from(s).length <= max);
const countsSchema = z.object({ questions: count, broke: count, newlyFail: count, newlyPass: count, flaky: count, unchanged: count, excluded: count }).strict();
const summaryShape = {
  label: z.enum(["Worse on eval", "No drop found", "Improved on eval", "Not run"]),
  notRunReason: z.enum(EVAL_NOT_RUN_REASONS).optional(),
  privateSet: z.boolean(), counts: countsSchema.optional(),
};
const questionSchema = z.object({ id: excerpt(160), change: z.enum(["broke", "newly_fail", "newly_pass", "flaky"]), category: z.enum(["ordinary", "safety", "refusal"]).optional(), old: z.array(excerpt(300)).max(3), new: z.array(excerpt(300)).max(3) }).strict();
export const EvidenceAiSchema = z.object({
  eval: z.object({ ...summaryShape, catchableDrop: percentage.optional(), fixRound: z.union([z.literal(0), z.literal(1)]).optional(), notices: z.array(z.enum(["details_withheld", "baseline_measuring", "subset_unsupported", "same_judge_family"])).max(4), questions: z.array(questionSchema).max(10) }).strict(),
  realModelRun: RealModelRunSummarySchema,
  promptWithoutEval: z.boolean(), oldNewLines: z.array(excerpt(300)).max(10).optional(),
}).strict().refine(a => {
  const e = a.eval;
  if ((e.label === "Not run") !== (e.notRunReason !== undefined)) return false;
  if (a.promptWithoutEval && (e.label !== "Not run" || e.notRunReason !== "no_eval_configured" || e.privateSet)) return false;
  if (e.privateSet) return e.counts === undefined && e.questions.length === 0 && e.fixRound === undefined && e.catchableDrop === undefined && e.notices.length === 0 && a.oldNewLines === undefined && a.realModelRun.status === "not_run";
  const c = e.counts;
  return c !== undefined && c.broke + c.newlyFail + c.newlyPass + c.flaky + c.unchanged <= c.questions && e.questions.length <= c.broke + c.newlyFail + c.newlyPass + c.flaky;
});
export type EvidenceAi = z.infer<typeof EvidenceAiSchema>;

/** Total work bound before a schema walks arrays. Cycles, exotic objects and excess input refuse whole. */
function bounded(input: unknown, maxChars = 65_536): boolean {
  const pending = [input]; let nodes = 0; let chars = 0;
  while (pending.length > 0) {
    if (++nodes > 2000) return false;
    const value = pending.pop();
    if (typeof value === "string") { chars += value.length; if (chars > maxChars) return false; }
    else if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) { if (value.length > 100 || pending.length + value.length > 2000) return false; pending.push(...(value as unknown[])); }
      else {
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
        let keys = 0;
        for (const key in value) {
          if (!Object.hasOwn(value, key) || ++keys > 30 || pending.length >= 2000) return false;
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (property === undefined || !("value" in property)) return false;
          pending.push(property.value);
        }
      }
    }
  }
  return true;
}
export function readEvidenceAi(input: unknown): EvidenceAi | undefined {
  try { if (!bounded(input)) return undefined; const parsed = EvidenceAiSchema.safeParse(input); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
export interface EvidenceAiInputs {
  realModelRun?: unknown;
  oldNewLines?: unknown;
  /** F3d health sensitivity's smallestDropPoints, when recorded. Never inferred. */
  catchableDrop?: unknown;
}
/** Inject the artifact already loaded under eval-wire's timeout and total read budget. No new I/O. */
export function evidenceAiFromArtifact(input: unknown, candidateDigest: string, extras: EvidenceAiInputs = {}): EvidenceAi | undefined {
  const artifact = readEvalRoundArtifact(input);
  if (artifact === undefined || artifact.candidateDigest !== candidateDigest) return undefined;
  const result = evalResultFromArtifact(artifact);
  const hidden = result.usedHiddenSet;
  const counts = { questions: result.casesTotal, broke: 0, newlyFail: 0, newlyPass: 0, flaky: 0, unchanged: result.casesRun - result.questions.length, excluded: result.excluded.length };
  const category = new Map((artifact.questions ?? []).map(q => [inertEvidenceText(q.id, 160), q.category]));
  const priority: typeof result.questions[number][] = []; const other: typeof result.questions[number][] = [];
  for (const q of result.questions) {
    if (q.change === "broke") counts.broke++;
    else if (q.change === "newly_fail") counts.newlyFail++;
    else if (q.change === "newly_pass") counts.newlyPass++;
    else if (q.change === "flaky") counts.flaky++;
    if (q.change !== "unchanged") (q.change === "broke" && ["safety", "refusal"].includes(category.get(q.id) ?? "") ? priority : other).push(q);
  }
  const questions: EvidenceAi["eval"]["questions"] = [...priority, ...other].slice(0, 10).map(q => ({
    id: inertEvidenceText(q.id, 160), change: q.change as EvidenceAi["eval"]["questions"][number]["change"],
    ...(category.get(q.id) === undefined ? {} : { category: category.get(q.id)! }),
    old: q.oldAnswers.map(a => inertEvidenceText(a, 300)), new: q.newAnswers.map(a => inertEvidenceText(a, 300)),
  }));
  const safeExtras = extras !== null && typeof extras === "object" ? extras : {};
  const real = bounded(safeExtras.realModelRun) ? RealModelRunSummarySchema.safeParse(safeExtras.realModelRun) : undefined;
  const realModelRun: RealModelRunSummary = hidden || safeExtras.realModelRun === undefined ? { status: "not_run", reason: "not_available" } : real?.success ? real.data : { status: "not_run", reason: "invalid_result" };
  const promptWithoutEval = !hidden && artifact.context?.aiChange === true && artifact.context.discovery === "not_configured" && result.notRun?.reason === "no_eval_configured";
  const rawLines = safeExtras.oldNewLines;
  // F10's rendered lines have one total input budget; invalid or excess input is never partly shown.
  const oldNewLines = !hidden && promptWithoutEval && Array.isArray(rawLines) && rawLines.length <= 10 && rawLines.every((s: unknown) => typeof s === "string" && s.length <= 2000) && rawLines.reduce((n: number, s: string) => n + s.length, 0) <= 10_000
    ? rawLines.map((s: string) => inertEvidenceText(s, 300)) : undefined;
  const sensitivity = percentage.safeParse(safeExtras.catchableDrop);
  const notices: EvidenceAi["eval"]["notices"] = [];
  if (!hidden) {
    if (artifact.notices?.some(n => n.code === "baseline_measuring")) notices.push("baseline_measuring");
    if (artifact.options?.subsetSupported === false) notices.push("subset_unsupported");
    if (artifact.options?.sameJudgeFamily === true) notices.push("same_judge_family");
  }
  return {
    eval: { label: result.label, ...(result.notRun === undefined ? {} : { notRunReason: result.notRun.reason }), privateSet: hidden,
      ...(!hidden ? { counts, fixRound: artifact.evalPass === 2 ? 1 as const : 0 as const, ...(sensitivity.success ? { catchableDrop: sensitivity.data } : {}) } : {}), notices, questions: hidden ? [] : questions },
    realModelRun, promptWithoutEval, ...(oldNewLines === undefined ? {} : { oldNewLines }),
  };
}

/** No free text survives the public allow-list, including question IDs and F10 lines. */
export function publicEvidenceAi(input: unknown) {
  const ai = readEvidenceAi(input);
  if (ai === undefined) return undefined;
  return { eval: { label: ai.eval.label, privateSet: ai.eval.privateSet, ...(ai.eval.notRunReason === undefined ? {} : { notRunReason: ai.eval.notRunReason }), ...(ai.eval.counts === undefined ? {} : { counts: ai.eval.counts }) }, realModelRun: ai.realModelRun, promptWithoutEval: ai.promptWithoutEval };
}
export type PublicEvidenceAi = NonNullable<ReturnType<typeof publicEvidenceAi>>;
