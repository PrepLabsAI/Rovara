// Question-level eval rule (DEC 194). No noise estimates, normal approximation or minimum set size.
import { inertEvidenceText } from "./evidence-inert.js";
import { HIDDEN_EVAL_NEEDS_SEALED_SENTENCE, type EvalRoundKind } from "./eval-hidden-set.js";
import { EVAL_NOT_RUN_CLASSES, type EvalRoundFacts } from "./eval-pacing.js";
import { NOT_RUN_SENTENCES, capSentence } from "./model-egress/classify.js";
import type { EvalBaseRecord } from "./eval-base-cache.js";
import type { MeasuresFile } from "./measures-file.js";

export const EVAL_NOT_RUN_REASONS = [
  ...EVAL_NOT_RUN_CLASSES, "too_many_not_run", "too_few_questions", "hidden_set_needs_sealed_round", "hidden_set_unavailable", "no_base_score", "partial_run", "unreadable_score", "no_measures_file", "eval_set_changed", "eval_set_unknown", "base_round_unattested", "question_data_missing", "no_changed_prompt_call", "judge_changed", "round_limit", "invalid_question_data", "no_product_key", "no_eval_configured",
] as const;
export type EvalNotRunReason = (typeof EVAL_NOT_RUN_REASONS)[number];

/** Why an eval (or one measure of it) was not run, in fixed words. The class reasons are F1-a's own sentences (the cap one without an amount: `evalNotRunResult` adds the amount when it has one). */
export const EVAL_NOT_RUN_SENTENCES: Readonly<Record<EvalNotRunReason, string>> = {
  no_eval_configured: "not run: no eval is configured",
  no_product_key: "not run: no product AI key is connected",
  question_data_missing: "not run: three saved old answers and complete question results are required",
  no_changed_prompt_call: "not run: no eval call exercised the changed prompt",
  judge_changed: "not run: the judge or scoring pin changed",
  round_limit: "not run: two eval passes have already run for this task",
  invalid_question_data: "not run: question results are incomplete or invalid",
  rate_limit: NOT_RUN_SENTENCES.rate_limit,
  quota: NOT_RUN_SENTENCES.quota,
  overloaded: NOT_RUN_SENTENCES.overloaded,
  key_refused: NOT_RUN_SENTENCES.key_refused,
  cap: capSentence(),
  provider_error: "not run: provider error",
  refused: "not run: the model call was refused",
  too_many_not_run: "not run: too many cases hit a limit",
  too_few_questions: "not run: too few eval questions to detect a change",
  base_round_unattested: "not run: the base round was not attested as run in a Rovara-only checkout",
  hidden_set_needs_sealed_round: HIDDEN_EVAL_NEEDS_SEALED_SENTENCE,
  hidden_set_unavailable: "not run: the hidden eval set could not be opened",
  no_base_score: "not run: no saved three-run question result is available",
  partial_run: "not run: some cases were not run, so the score is not compared",
  unreadable_score: "not run: a score could not be read",
  no_measures_file: "not run: the eval wrote no readable rovara-measures.json",
  eval_set_changed: "not run: the eval set changed, so main's score is not comparable",
  eval_set_unknown: "not run: the eval did not say which eval set it ran",
};


export const EVAL_QUESTION_LIMIT = 1_000;
export interface EvalAnswer { readonly pass: boolean; readonly answer: string }
export interface EvalQuestionComparison {
  readonly id: string;
  readonly category: "ordinary" | "safety" | "refusal";
  readonly old: readonly EvalAnswer[];
  readonly first: EvalAnswer;
  readonly freshOld?: readonly EvalAnswer[] | undefined;
  readonly freshNew?: readonly EvalAnswer[] | undefined;
  readonly moreNew?: readonly EvalAnswer[] | undefined;
  readonly edited?: boolean;
}
export interface EvalQuestionResult {
  readonly id: string;
  readonly change: "broke" | "newly_pass" | "newly_fail" | "flaky" | "unchanged";
  readonly oldAnswers: readonly string[];
  readonly newAnswers: readonly string[];
}
export type EvalLabel = "Worse on eval" | "No drop found" | "Improved on eval" | "Not run";
export interface EvalCheckResult {
  readonly kind: "eval";
  readonly roundKind: EvalRoundKind;
  readonly outcome: "ran" | "not_run";
  readonly label: EvalLabel;
  readonly notRun?: { readonly reason: EvalNotRunReason; readonly sentence: string };
  readonly usedHiddenSet: boolean;
  readonly casesRun: number;
  readonly casesTotal: number;
  readonly measures: readonly never[];
  readonly verdicts: readonly never[];
  readonly questions: readonly EvalQuestionResult[];
  readonly excluded: ReadonlyArray<{ readonly id: string; readonly reason: "edited" | "suspect_limit" }>;
  readonly notices: readonly string[];
  readonly summary: string;
  readonly fixRequested: boolean;
  readonly disposition: { readonly draft: boolean; readonly check: "failure" | "success" | "neutral"; readonly retry: boolean };
}
export interface EvalCheckInput {
  readonly roundKind: EvalRoundKind;
  readonly questions?: readonly EvalQuestionComparison[];
  readonly changedPromptCalls?: number;
  readonly subsetSupported?: boolean;
  readonly hiddenSetUsed?: boolean;
  readonly judgePinned?: boolean;
  readonly sameJudgeFamily?: boolean;
  // Old callers remain readable, but aggregate scores are never converted to question evidence.
  readonly head?: MeasuresFile;
  readonly base?: EvalBaseRecord | undefined;
  readonly facts?: EvalRoundFacts;
  readonly minQuestions?: number;
  readonly capMicros?: number;
}
const bits = (answers: readonly EvalAnswer[]): number[] => answers.map(a => Number(a.pass));
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const passes = (answers: readonly EvalAnswer[]): number => sum(bits(answers));
const validAnswer = (a: EvalAnswer | undefined): boolean => a !== undefined && typeof a.pass === "boolean" && typeof a.answer === "string";
const validSamples = (a: readonly EvalAnswer[] | undefined, n: number): boolean => Array.isArray(a) && a.length === n && a.every(validAnswer);
const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i += 1) value = value * (n - i + 1) / i;
  return value;
};
/** Exact stratified permutation tail. Each question conditions on its total passes.
 * Matches evalsim2's convolution of hypergeometric distributions. */
export function exactEvalTail(old: readonly (readonly number[])[], newer: readonly (readonly number[])[]): number {
  if (old.length !== newer.length || old.length === 0 || old.length > EVAL_QUESTION_LIMIT) throw new RangeError("invalid eval samples");
  let distribution = [1];
  let observed = 0;
  let offset = 0;
  for (let i = 0; i < old.length; i += 1) {
    const a = old[i]!; const b = newer[i]!;
    if (a.length !== 3 || ![1, 3].includes(b.length) || [...a, ...b].some(v => v !== 0 && v !== 1)) throw new RangeError("invalid eval samples");
    const total = sum(a) + sum(b); const n = a.length + b.length;
    observed += sum(b);
    const low = Math.max(0, b.length - (n - total)); const high = Math.min(b.length, total);
    offset += low;
    if (low === high) continue;
    const next = Array.from({ length: distribution.length + high - low }, () => 0);
    for (let k = low; k <= high; k += 1) {
      const probability = choose(total, k) * choose(n - total, b.length - k) / choose(n, b.length);
      for (let j = 0; j < distribution.length; j += 1) next[j + k - low]! += distribution[j]! * probability;
    }
    distribution = next;
  }
  return Math.min(1, distribution.slice(0, Math.max(0, observed - offset + 1)).reduce((a, b) => a + b, 0));
}
export function evalSuspects(questions: readonly EvalQuestionComparison[]): { down: string[]; up: string[]; omitted: string[] } {
  const down: string[] = []; const up: string[] = []; const omitted: string[] = [];
  for (const q of questions) {
    if (q.edited) continue;
    const target = passes(q.old) >= 2 && !q.first.pass ? down : passes(q.old) <= 1 && q.first.pass ? up : undefined;
    if (target === undefined) continue;
    if (target.length < 10) target.push(q.id); else omitted.push(q.id);
  }
  return { down, up, omitted };
}
export function evalNotRunResult(args: { readonly roundKind: EvalRoundKind; readonly reason: EvalNotRunReason; readonly facts?: EvalRoundFacts; readonly capMicros?: number; readonly hiddenSetUsed?: boolean }): EvalCheckResult {
  const sentence = args.reason === "cap" ? capSentence(args.capMicros) : EVAL_NOT_RUN_SENTENCES[args.reason];
  return { kind: "eval", roundKind: args.roundKind, outcome: "not_run", label: "Not run", notRun: { reason: args.reason, sentence }, usedHiddenSet: args.hiddenSetUsed === true,
    casesRun: 0, casesTotal: 0, measures: [], verdicts: [], questions: [], excluded: [], notices: [], fixRequested: false,
    summary: `Eval: Not run — ${sentence.replace(/^not run: /u, "")}. Retry.`, disposition: { draft: false, check: "neutral", retry: true } };
}
/** First-look p in [.01,.2) justifies exactly two more new runs; mirror upward. */
export function evalNeedsSecondLook(questions: readonly EvalQuestionComparison[]): boolean {
  const qs = questions.filter(q => !q.edited);
  if (qs.length === 0) return false;
  const old = qs.map(q => bits(q.old)); const first = qs.map(q => [Number(q.first.pass)]);
  const down = exactEvalTail(old, first); const up = exactEvalTail(old.map(a => a.map(v => 1 - v)), first.map(a => a.map(v => 1 - v)));
  return (down >= .01 && down < .2) || (up >= .01 && up < .2);
}
export function evalCheckResult(input: EvalCheckInput): EvalCheckResult {
  const hidden = input.hiddenSetUsed === true;
  const refuse = (reason: EvalNotRunReason): EvalCheckResult => evalNotRunResult({ roundKind: input.roundKind, reason, hiddenSetUsed: hidden });
  if (hidden && input.roundKind !== "check_sealed") return refuse("hidden_set_needs_sealed_round");
  const all = input.questions;
  if (all === undefined || all.length === 0) return refuse("question_data_missing");
  if (all.length > EVAL_QUESTION_LIMIT || new Set(all.map(q => q.id)).size !== all.length || all.some(q => typeof q.id !== "string" || !validSamples(q.old, 3) || !validAnswer(q.first))) return refuse("invalid_question_data");
  const excluded: Array<{ id: string; reason: "edited" | "suspect_limit" }> = all.filter(q => q.edited).map(q => ({ id: inertEvidenceText(q.id, 160), reason: "edited" }));
  const qs = all.filter(q => !q.edited);
  const unavailable = (reason: EvalNotRunReason): EvalCheckResult => ({ ...refuse(reason), excluded: hidden ? [] : excluded });
  if (qs.length === 0) return unavailable("question_data_missing");
  if (input.judgePinned === false) return unavailable("judge_changed");
  if (!Number.isSafeInteger(input.changedPromptCalls) || input.changedPromptCalls! < 1) return unavailable("no_changed_prompt_call");
  const suspects = evalSuspects(qs);
  excluded.push(...suspects.omitted.map(id => ({ id: inertEvidenceText(id, 160), reason: "suspect_limit" as const })));
  const subset = input.subsetSupported !== false;
  const chosen = new Set(subset ? [...suspects.down, ...suspects.up] : []);
  const fresh = qs.filter(q => chosen.has(q.id));
  const completeFresh = fresh.every(q => validSamples(q.freshOld, 3) && validSamples(q.freshNew, 3));
  const firstOld = qs.map(q => bits(q.old)); const firstNew = qs.map(q => [Number(q.first.pass)]);
  const tail = (a: number[][], b: number[][], up: boolean): number => exactEvalTail(up ? a.map(v => v.map(x => 1 - x)) : a, up ? b.map(v => v.map(x => 1 - x)) : b);
  const whole = (up: boolean): boolean => {
    const p = tail(firstOld, firstNew, up);
    if (p < .01) return true;
    if (p >= .2 || !qs.every(q => validSamples(q.moreNew, 2))) return false;
    return tail(firstOld, qs.map(q => [Number(q.first.pass), ...bits(q.moreNew!)]), up) < .01;
  };
  const targeted = (ids: readonly string[], up: boolean): boolean => {
    const group = fresh.filter(q => ids.includes(q.id));
    return group.length > 0 && group.every(q => validSamples(q.freshOld, 3) && validSamples(q.freshNew, 3)) && tail(group.map(q => bits(q.freshOld!)), group.map(q => bits(q.freshNew!)), up) < .01;
  };
  const broke = (q: EvalQuestionComparison): boolean => chosen.has(q.id) && validSamples(q.freshOld, 3) && validSamples(q.freshNew, 3) && passes(q.freshOld!) === 3 && passes(q.freshNew!) === 0;
  const worse = whole(false) || targeted(suspects.down, false) || qs.some(q => (q.category === "safety" || q.category === "refusal") && broke(q));
  // Incomplete later work must never erase already-established failure.
  if (!worse && !completeFresh) return unavailable("partial_run");
  const improved = !worse && (whole(true) || targeted(suspects.up, true));
  if (!worse && !improved && evalNeedsSecondLook(qs) && !qs.every(q => validSamples(q.moreNew, 2))) return unavailable("partial_run");
  const questions: EvalQuestionResult[] = qs.map(q => {
    const a = chosen.has(q.id) && validSamples(q.freshOld, 3) ? q.freshOld! : q.old;
    const b = chosen.has(q.id) && validSamples(q.freshNew, 3) ? q.freshNew! : [q.first];
    const mixed = (x: readonly EvalAnswer[]): boolean => passes(x) > 0 && passes(x) < x.length;
    const change = broke(q) ? "broke" : passes(a) === 0 && passes(b) === b.length ? "newly_pass" : mixed(a) || mixed(b) ? "flaky" : passes(q.old) >= 2 && !q.first.pass ? "newly_fail" : "unchanged";
    return { id: inertEvidenceText(q.id, 160), change, oldAnswers: a.map(x => inertEvidenceText(x.answer, 1_000)), newAnswers: b.map(x => inertEvidenceText(x.answer, 1_000)) };
  });
  const label: EvalLabel = worse ? "Worse on eval" : improved ? "Improved on eval" : "No drop found";
  const notices = [...(subset ? [] : ["Question re-asks skipped: the runner cannot run a subset."]), ...(input.sameJudgeFamily === true ? ["The judge and product use the same model family."] : [])];
  const brokenCount = questions.filter(q => q.change === "broke").length;
  const scope = "on questions the agent could read";
  const summary = hidden ? `Eval: ${worse ? "Worse on eval" : "No drop found"} on private questions.` : `Eval: ${label} — ${qs.length} questions · ${brokenCount} broke · ${questions.filter(q => q.change === "newly_pass").length} newly pass · ${questions.filter(q => q.change === "flaky").length} flaky · ${scope}; on the evaluated areas. Small or noisy sets can miss changes.`;
  return { kind: "eval", roundKind: input.roundKind, outcome: "ran", label: hidden && improved ? "No drop found" : label, usedHiddenSet: hidden, casesRun: hidden ? 0 : qs.length, casesTotal: hidden ? 0 : all.length,
    measures: [], verdicts: [], questions: hidden ? [] : questions, excluded: hidden ? [] : excluded, notices: hidden ? [] : notices, summary, fixRequested: worse || (!hidden && brokenCount > 0),
    disposition: { draft: false, check: worse ? "failure" : "success", retry: false } };
}
