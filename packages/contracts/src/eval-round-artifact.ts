// Bound, browser-safe eval evidence. Labels are derived from comparison facts, never worker prose.
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";
import { EVAL_NOT_RUN_REASONS, EVAL_QUESTION_LIMIT, evalCheckResult, evalNotRunResult, type EvalCheckInput, type EvalCheckResult, type EvalQuestionComparison } from "./eval-check.js";
import { EVAL_ROUND_KINDS } from "./eval-hidden-set.js";

export const EVAL_ROUND_ARTIFACT = "eval-round.json";
export const EVAL_ROUND_ARTIFACT_MAX_BYTES = 1_048_576;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(320); // inert text may insert a joiner after each character
const answer = z.string().max(2_000); // at most 1,000 code points
const array = (value: unknown): boolean => Array.isArray(value);
const tuple3 = z.array(z.boolean()).length(3);
const tuple2 = z.array(z.boolean()).length(2);
const contextSchema = z.object({ aiChange: z.boolean(), discovery: z.enum(["configured", "not_configured", "unknown"]), previousPasses: z.union([z.literal(0), z.literal(1)]) }).strict();
const optionsSchema = z.object({ changedPromptCalls: integer, hiddenSetUsed: z.literal(false), subsetSupported: z.boolean(), sameJudgeFamily: z.boolean() }).strict();
const noticeSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("stage_estimate"), stage: z.enum(["first run", "re-asks", "second look"]), calls: integer, costMicros: integer }).strict(),
  z.object({ code: z.enum(["baseline_measuring", "no_eval_configured"]) }).strict(),
]);
export type EvalEvidenceNotice = z.infer<typeof noticeSchema>;
const questionShape = {
  id, category: z.enum(["ordinary", "safety", "refusal"]), edited: z.boolean(), old: tuple3, first: z.boolean(),
  freshOld: tuple3.optional(), freshNew: tuple3.optional(), moreNew: tuple2.optional(),
  answers: z.object({ old: z.array(answer).length(3), first: answer, freshOld: z.array(answer).length(3).optional(), freshNew: z.array(answer).length(3).optional(), moreNew: z.array(answer).length(2).optional() }).strict().optional(),
};
const questionSchema = z.object(questionShape).strict();
export type EvalEvidenceQuestion = z.infer<typeof questionSchema>;
const evidenceShape = {
  context: contextSchema.optional(), questions: z.array(questionSchema).max(EVAL_QUESTION_LIMIT).optional(), options: optionsSchema.optional(),
  excluded: z.array(z.object({ id, reason: z.enum(["edited", "suspect_limit"]) }).strict()).max(2 * EVAL_QUESTION_LIMIT).optional(),
  notices: z.array(noticeSchema).max(4).optional(), privatePass: z.boolean().optional(), privateSet: z.literal(true).optional(),
};
export type EvalRoundEvidence = z.infer<z.ZodObject<typeof evidenceShape>>;
export interface EvalEvidenceCaptureInput {
  readonly context: NonNullable<EvalRoundEvidence["context"]>;
  readonly comparison?: Omit<EvalCheckInput, "roundKind">;
  readonly excluded?: EvalCheckResult["excluded"];
  readonly notices?: readonly EvalEvidenceNotice[];
  readonly privatePass?: boolean;
  readonly privateSet?: boolean;
}
const changedBits = (q: Pick<EvalEvidenceQuestion, "old" | "first" | "freshOld" | "freshNew" | "moreNew">): boolean => {
  const first = q.old[0];
  return [...q.old, q.first, ...(q.freshOld ?? []), ...(q.freshNew ?? []), ...(q.moreNew ?? [])].some(bit => bit !== first);
};
/** Capture actual comparisons only. One total raw-text budget, one total answer budget, and at most
 * 20 answer-bearing questions. The other comparisons retain pass bits so the label remains derivable. */
export function captureEvalRoundEvidence(input: EvalEvidenceCaptureInput): EvalRoundEvidence {
  if (typeof input !== "object" || input === null) return {};
  if (input.privatePass !== undefined && typeof input.privatePass !== "boolean") return {};
  if (input.privatePass !== undefined) return { privatePass: input.privatePass };
  if (input.privateSet === true) return { privateSet: true };
  if (!contextSchema.safeParse(input.context).success || (input.excluded !== undefined && (!array(input.excluded) || input.excluded.length > 2 * EVAL_QUESTION_LIMIT || input.excluded.some(q => q === null || typeof q !== "object" || typeof q.id !== "string" || q.id.length > 320 || !["edited", "suspect_limit"].includes(q.reason))))) return {};
  if (input.notices !== undefined && (!array(input.notices) || input.notices.length > 4 || !input.notices.every(n => noticeSchema.safeParse(n).success))) return {};
  const base: EvalRoundEvidence = { context: input.context, excluded: (input.excluded ?? []).map(q => ({ id: inertEvidenceText(q.id, 160), reason: q.reason })), notices: [...(input.notices ?? [])] };
  const comparison = input.comparison;
  if (comparison === undefined) return base;
  if (comparison === null || comparison.questions === undefined || !array(comparison.questions) || comparison.questions.length > EVAL_QUESTION_LIMIT) return {};
  const sample = (a: unknown): boolean => typeof a === "object" && a !== null && "pass" in a && typeof a.pass === "boolean" && "answer" in a && typeof a.answer === "string";
  const samples = (a: unknown, count: number): boolean => Array.isArray(a) && a.length === count && a.every(sample);
  if (comparison.questions.some(q => q === null || typeof q !== "object" || typeof q.id !== "string" || q.id.length > 160 || !["ordinary", "safety", "refusal"].includes(q.category) || !samples(q.old, 3) || !sample(q.first) || (q.freshOld !== undefined && !samples(q.freshOld, 3)) || (q.freshNew !== undefined && !samples(q.freshNew, 3)) || (q.moreNew !== undefined && !samples(q.moreNew, 2)) || (q.edited !== undefined && typeof q.edited !== "boolean"))) return {};
  if ((comparison.changedPromptCalls !== undefined && (!Number.isSafeInteger(comparison.changedPromptCalls) || comparison.changedPromptCalls < 0)) || (comparison.subsetSupported !== undefined && typeof comparison.subsetSupported !== "boolean") || (comparison.sameJudgeFamily !== undefined && typeof comparison.sameJudgeFamily !== "boolean") || comparison.hiddenSetUsed === true) return {};
  let rawLeft = 262_144; let answerLeft = 40_000; let answered = 0;
  const text = (raw: string): string => {
    if (rawLeft <= 0 || answerLeft <= 0) return "";
    const n = Math.min(raw.length, rawLeft, 4096); rawLeft -= n;
    // Cut a possibly incomplete credential word before redaction; never keep a fragment at the cut.
    const bounded = n < raw.length ? raw.slice(0, Math.max(0, n - 256)) + " [answer truncated]" : raw;
    const value = inertEvidenceText(bounded, Math.min(1000, answerLeft)); answerLeft -= Array.from(value).length;
    return value;
  };
  const questions = comparison.questions.map(q => {
    const bits = (samples: EvalQuestionComparison["old"]): boolean[] => samples.map(a => a.pass);
    const row: EvalEvidenceQuestion = { id: inertEvidenceText(q.id, 160), category: q.category, edited: q.edited === true, old: bits(q.old), first: q.first.pass,
      ...(q.freshOld === undefined ? {} : { freshOld: bits(q.freshOld) }), ...(q.freshNew === undefined ? {} : { freshNew: bits(q.freshNew) }), ...(q.moreNew === undefined ? {} : { moreNew: bits(q.moreNew) }) };
    if (changedBits(row) && answered < 20 && answerLeft > 0 && rawLeft > 0) {
      answered++;
      row.answers = { old: q.old.map(a => text(a.answer)), first: text(q.first.answer), ...(q.freshOld === undefined ? {} : { freshOld: q.freshOld.map(a => text(a.answer)) }), ...(q.freshNew === undefined ? {} : { freshNew: q.freshNew.map(a => text(a.answer)) }), ...(q.moreNew === undefined ? {} : { moreNew: q.moreNew.map(a => text(a.answer)) }) };
    }
    return row;
  });
  return { ...base, questions, options: { changedPromptCalls: comparison.changedPromptCalls ?? 0, hiddenSetUsed: false, subsetSupported: comparison.subsetSupported !== false, sameJudgeFamily: comparison.sameJudgeFamily === true } };
}
const artifactShape = {
  schemaVersion: z.literal(1), candidateDigest: hash, roundKind: z.enum(EVAL_ROUND_KINDS), evalPass: z.union([z.literal(1), z.literal(2)]),
  outcome: z.enum(["not_run", "done"]), notRunReason: z.enum(EVAL_NOT_RUN_REASONS).optional(), ...evidenceShape,
  usage: z.object({ calls: integer, costMicros: integer.optional() }).strict().optional(), cache: z.enum(["hit", "filled", "not_filled", "not_used"]).optional(), evalConfigured: z.boolean().optional(),
  feedback: z.union([
    z.object({ notRun: z.literal(true) }).strict(),
    z.object({ pass: z.boolean() }).strict(),
    z.object({ questions: z.array(z.object({ id, change: z.enum(["broke", "newly_pass", "newly_fail", "flaky", "unchanged"]), oldAnswers: z.array(answer).max(3), newAnswers: z.array(answer).max(3) }).strict()).max(20) }).strict(),
  ]).optional(),
  fixRequested: z.boolean().optional(),
  // Log-only words. Consumers never use them to classify the result.
  label: z.string().max(200).optional(), summary: z.string().max(2000).optional(),
};
type ArtifactFields = z.infer<z.ZodObject<typeof artifactShape>>;
const consistent = (a: ArtifactFields): boolean => {
  if ((a.outcome === "not_run") !== (a.notRunReason !== undefined)) return false;
  if (a.outcome === "done" && (a.roundKind === "working" || a.evalConfigured === false || a.context?.discovery === "not_configured")) return false;
  const hidden = a.privatePass !== undefined || a.privateSet === true;
  if (hidden) return a.context === undefined && a.questions === undefined && a.options === undefined && a.excluded === undefined && a.notices === undefined && a.usage === undefined && a.cache === undefined && a.evalConfigured === undefined && a.label === undefined && a.summary === undefined && a.feedback === undefined && a.fixRequested === undefined && (a.outcome === "done" ? a.privatePass !== undefined && a.roundKind === "check_sealed" : a.privatePass === undefined);
  if (a.context === undefined || a.context.previousPasses !== a.evalPass - 1 || a.usage === undefined || a.cache === undefined || a.excluded === undefined || a.notices === undefined) return false;
  if (a.evalConfigured !== undefined && a.context.discovery !== (a.evalConfigured ? "configured" : "not_configured")) return false;
  if ((a.questions !== undefined) !== (a.options !== undefined) || (a.outcome === "done" && (a.questions?.length ?? 0) === 0)) return false;
  if (a.questions !== undefined && (new Set(a.questions.map(q => q.id)).size !== a.questions.length || a.questions.filter(q => q.answers !== undefined).length > 20 || a.questions.some(q => q.answers !== undefined && (!changedBits(q) || (q.freshOld === undefined) !== (q.answers.freshOld === undefined) || (q.freshNew === undefined) !== (q.answers.freshNew === undefined) || (q.moreNew === undefined) !== (q.answers.moreNew === undefined))))) return false;
  return true;
};
export const EvalRoundArtifactSchema = z.object(artifactShape).strict().refine(consistent, "invalid eval evidence");
export const EvalRoundArtifactReadSchema = z.object(artifactShape).refine(consistent, "invalid eval evidence");
export type EvalRoundArtifact = z.infer<typeof EvalRoundArtifactSchema>;

/** Bound work before Zod walks arrays or JSON serialization visits unknown future fields. */
function bounded(input: unknown): boolean {
  const pending: unknown[] = [input]; let nodes = 0; let chars = 0;
  while (pending.length > 0) {
    if (++nodes > 60_000) return false;
    const value = pending.pop();
    if (typeof value === "string") { chars += value.length; if (chars > EVAL_ROUND_ARTIFACT_MAX_BYTES) return false; }
    else if (value !== null && typeof value === "object") {
      const entries: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
      if (entries.length > 2 * EVAL_QUESTION_LIMIT || pending.length + entries.length > 60_000) return false;
      pending.push(...entries);
    }
  }
  return new TextEncoder().encode(JSON.stringify(input)).length <= EVAL_ROUND_ARTIFACT_MAX_BYTES;
}
export function readEvalRoundArtifact(input: unknown): EvalRoundArtifact | undefined {
  try { if (!bounded(input)) return undefined; const parsed = EvalRoundArtifactReadSchema.safeParse(input); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}
const noEvalNotice = "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.";
/** The single downstream verdict function. Unknown/inconsistent evidence is neutral, with fixed words. */
export function evalResultFromArtifact(input: unknown): EvalCheckResult {
  const invalid = (): EvalCheckResult => evalNotRunResult({ roundKind: "working", reason: "invalid_question_data" });
  const a = readEvalRoundArtifact(input);
  if (a === undefined) return invalid();
  const hidden = a.privatePass !== undefined || a.privateSet === true;
  if (a.outcome === "not_run") {
    const result = evalNotRunResult({ roundKind: a.roundKind, reason: a.notRunReason!, hiddenSetUsed: hidden });
    if (hidden) return result;
    if (a.notRunReason === "no_eval_configured") return { ...result, summary: noEvalNotice, notices: [noEvalNotice], disposition: { ...result.disposition, retry: false } };
    return addContext(result, a);
  }
  if (hidden) {
    const worse = !a.privatePass;
    return { kind: "eval", roundKind: a.roundKind, outcome: "ran", label: worse ? "Worse on eval" : "No drop found", usedHiddenSet: true, casesRun: 0, casesTotal: 0, measures: [], verdicts: [], questions: [], excluded: [], notices: [], summary: `Eval: ${worse ? "Worse on eval" : "No drop found"} on private questions.`, fixRequested: worse && a.evalPass === 1, disposition: { draft: false, check: worse ? "failure" : "success", retry: false } };
  }
  const questions: EvalQuestionComparison[] = a.questions!.map(q => {
    const samples = (bits: readonly boolean[], answers?: readonly string[]) => bits.map((pass, i) => ({ pass, answer: answers?.[i] ?? "" }));
    return { id: q.id, category: q.category, edited: q.edited, old: samples(q.old, q.answers?.old), first: { pass: q.first, answer: q.answers?.first ?? "" }, ...(q.freshOld === undefined ? {} : { freshOld: samples(q.freshOld, q.answers?.freshOld) }), ...(q.freshNew === undefined ? {} : { freshNew: samples(q.freshNew, q.answers?.freshNew) }), ...(q.moreNew === undefined ? {} : { moreNew: samples(q.moreNew, q.answers?.moreNew) }) };
  });
  const result = evalCheckResult({ roundKind: a.roundKind, ...a.options!, questions });
  if (result.outcome !== "ran") return invalid();
  return addContext({ ...result, fixRequested: result.fixRequested && a.evalPass === 1 }, a);
}
function addContext(result: EvalCheckResult, a: EvalRoundArtifact): EvalCheckResult {
  const excluded = a.excluded ?? []; const count = excluded.length;
  const notices = (a.notices ?? []).map(n => n.code === "stage_estimate" ? `Eval ${n.stage} estimate: ${n.calls} calls, ${n.costMicros} microdollars.` : n.code === "baseline_measuring" ? "baseline still being measured" : noEvalNotice);
  return { ...result, excluded: [...excluded, ...result.excluded], casesTotal: result.casesTotal + count, notices: [...result.notices, ...notices], summary: result.summary + (count === 0 ? "" : ` ${count} question${count === 1 ? "" : "s"} added, removed or edited: not compared.`) };
}
