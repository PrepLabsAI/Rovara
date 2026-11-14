// TE-F3 (part A): what an eval check says. From the runner's head scores (`rovara-measures.json`), the base scores Rovara measured and the facts of the round, it builds the v2 evidence `measure` entries and one verdict per
// measure, in fixed words. Pure: no clock, no randomness, no outside call.
//
// THE RULE (the plan block TE-F3, DECISIONS 162 layer 4): the band is base +/- k x spread, k = 2 (`EVAL_NOISE_K`, a data constant). A measure is `better` or `worse` ONLY when the head is strictly OUTSIDE the band, in the measure's
// `direction`. Inside it, or on its edge, nothing changed ("no detectable change"). With no spread at all (the runner gave none and the base round had none, or both are zero) there is no noise estimate, and the difference is
// not judged ("difference not judged: no noise estimate"): nothing but a measured difference outside a measured band ever reads as a change. The spread is the one MAIN's runner reported in the base round's measures file (cached with the base score); the head runner's own spread is ignored (it is the thing under test). Rovara-measured paired repeats are F3-b's.
//
// This layer assigns NO label. DECISIONS 170 has three: "Proven", "No regression measured (eval)" and "Improved on eval"; the last two need more than a measure outside a band (a pre-fixed minimum detectable drop, paired per-question noise, a rotating
// holdout, coverage, categories). That is the next lane (F3-b). A `better` here is a measure beyond the band, never "Improved on eval", and nothing here is "Proven".
//
// Words from the runner (measure names, units) reach every printed sentence only through `inertEvidenceText`. In a round that used a hidden eval set NO runner value reaches the result: only measures Rovara's own base round knows are kept (the
// rest are dropped entirely), their labels come from the base record, no head or base value is kept (so none reaches the summary or the v2 measures), and each measure is pass or fail (eval-hidden-set.ts rules 2 and 3).
import type { z } from "zod";
import { EVIDENCE_MEASURES_MAX, EvidenceMeasureSchema } from "./evidence.js";
import { inertEvidenceText } from "./evidence-inert.js";
import type { EvalBaseRecord } from "./eval-base-cache.js";
import { HIDDEN_EVAL_NEEDS_SEALED_SENTENCE, type EvalRoundKind } from "./eval-hidden-set.js";
import { EVAL_NOT_RUN_CLASSES, EVAL_NOT_RUN_FRACTION_MAX, type EvalNotRunClass, type EvalRoundFacts } from "./eval-pacing.js";
import type { MeasuresFile } from "./measures-file.js";
import { NOT_RUN_SENTENCES, capSentence } from "./model-egress/classify.js";

/** k in "base +/- k x spread". */
export const EVAL_NOISE_K = 2;
/** Fewer cases than this run: the eval cannot detect a change (DECISIONS 170: "too few questions gives not run"). A data default for the owner to confirm. */
export const EVAL_MIN_QUESTIONS = 20;
/** The largest magnitude a printed or stored score may have (the evidence measure's own bound). */
const SCORE_LIMIT = 1e12;
/** The most measures one summary line lists; the rest are counted. */
const SUMMARY_MEASURES_LISTED = 5;

export const EVAL_VERDICTS = ["no_detectable_change", "better", "worse", "not_run", "no_noise_estimate"] as const;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

/** The words of a verdict that ran. A `not_run` verdict uses the sentence of its reason instead. */
export const EVAL_VERDICT_WORDS: Readonly<Record<Exclude<EvalVerdict, "not_run">, string>> = {
  no_detectable_change: "no detectable change",
  better: "better than main beyond the noise band",
  worse: "worse than main beyond the noise band",
  no_noise_estimate: "difference not judged: no noise estimate",
};

export const EVAL_NOT_RUN_REASONS = [
  ...EVAL_NOT_RUN_CLASSES, "too_many_not_run", "too_few_questions", "hidden_set_needs_sealed_round", "hidden_set_unavailable", "no_base_score", "partial_run", "unreadable_score", "no_measures_file", "eval_set_changed", "eval_set_unknown", "base_round_unattested",
] as const;
export type EvalNotRunReason = (typeof EVAL_NOT_RUN_REASONS)[number];

/** Why an eval (or one measure of it) was not run, in fixed words. The class reasons are F1-a's own sentences (the cap one without an amount: `evalNotRunResult` adds the amount when it has one). */
export const EVAL_NOT_RUN_SENTENCES: Readonly<Record<EvalNotRunReason, string>> = {
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
  no_base_score: "not run: no base score for this commit",
  partial_run: "not run: some cases were not run, so the score is not compared",
  unreadable_score: "not run: a score could not be read",
  no_measures_file: "not run: the eval wrote no readable rovara-measures.json",
  eval_set_changed: "not run: the eval set changed, so main's score is not comparable",
  eval_set_unknown: "not run: the eval did not say which eval set it ran",
};

export interface EvalVerdictInput {
  readonly direction: "up_good" | "down_good";
  readonly base: number;
  readonly head: number;
  /**
   * The noise estimate: the spread main's runner reported in the base round (not a Rovara-measured repeat: F3-b owns those). The runner's own spread for the head scores is never an input (a runner could report any spread, and a wide one would hide a real drop).
   */
  readonly spread?: number;
}
export interface EvalVerdictOutput {
  readonly verdict: EvalVerdict;
  /** Set for `not_run`. */
  readonly reason?: "unreadable_score";
  /** base +/- k x spread, when a noise estimate exists. */
  readonly band?: { readonly low: number; readonly high: number };
  /** The spread the band was made from. */
  readonly spread?: number;
}

/** Twelve significant digits: the same edge in two float spellings (0.7 + 2 x 0.1 is 0.8999999999999999) is one edge. */
const norm = (value: number): number => Number(value.toPrecision(12));
const readable = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= SCORE_LIMIT;
const readableSpread = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= SCORE_LIMIT;
/** Words for a measure of a hidden-set round: pass or fail only. A score beyond the band reads as a pass (the hidden set gives no direction beyond "no drop"). */
const HIDDEN_VERDICT_WORDS = { no_detectable_change: "no detectable drop on the hidden set", worse: "worse than main beyond the noise band on the hidden set" } as const;
const clamp = (value: number): number => Math.max(-SCORE_LIMIT, Math.min(SCORE_LIMIT, value));

/** One measure's verdict. Never throws; a number it cannot read (NaN, infinity, out of range, a negative spread) is `not_run`, never a change. */
export function evalVerdictFor(input: EvalVerdictInput): EvalVerdictOutput {
  const { base, head } = input;
  if (!readable(base) || !readable(head) || (input.spread !== undefined && !readableSpread(input.spread))) return { verdict: "not_run", reason: "unreadable_score" };
  const spread = input.spread ?? 0;
  if (!(spread > 0)) return { verdict: "no_noise_estimate" };
  const half = EVAL_NOISE_K * spread;
  const band = { low: clamp(norm(base - half)), high: clamp(norm(base + half)) };
  const value = norm(head);
  const above = value > band.high;
  const below = value < band.low;
  if (!above && !below) return { verdict: "no_detectable_change", band, spread };
  const better = input.direction === "up_good" ? above : below;
  return { verdict: better ? "better" : "worse", band, spread };
}

export type EvalEvidenceMeasure = z.infer<typeof EvidenceMeasureSchema>;

export interface EvalMeasureResult {
  /** The measure's position: in the runner's file, or (hidden round) in Rovara's base record. */
  readonly index: number;
  /** Inert, bounded text: the runner's name, the base record's name, or "eval measure N" (a hidden-set round never shows the runner's own). */
  readonly label: string;
  /** Inert, bounded text, chosen like the label. */
  readonly unit: string;
  readonly verdict: EvalVerdict;
  readonly reason?: EvalNotRunReason;
  /** The fixed words for the verdict. */
  readonly sentence: string;
  /** The head score, when it may be shown (never for a measure whose score may include cases that did not run). */
  readonly head?: number;
  readonly base?: number;
  /** The cases behind the score: always the number that RAN, from Rovara's own facts (never a number the runner wrote). */
  readonly count: number;
}

export interface EvalCheckResult {
  readonly kind: "eval";
  readonly roundKind: EvalRoundKind;
  /** `ran`: the eval ran and at least one measure was judged. `not_run`: it did not, or no measure could be compared. A neutral word: never `passed` (a verdict is not a pass) and never `failed` (a difference is a measure). */
  readonly outcome: "ran" | "not_run";
  /** Set when the whole eval was not run. */
  readonly notRun?: { readonly reason: EvalNotRunReason; readonly sentence: string };
  readonly casesRun: number;
  readonly casesTotal: number;
  readonly usedHiddenSet: boolean;
  /** The v2 evidence `measure` entries (each passes `EvidenceMeasureSchema`): only measures that have a base. */
  /** Empty for a hidden-set round: no hidden-round value reaches the evidence. */
  readonly measures: readonly EvalEvidenceMeasure[];
  readonly verdicts: readonly EvalMeasureResult[];
  /** "Eval (your runner): accuracy 0.82 fraction (main 0.8 fraction) · no detectable change". One line, inert. */
  readonly summary: string;
}

export interface EvalCheckInput {
  readonly roundKind: EvalRoundKind;
  /** The runner's head-side measures file. */
  readonly head: MeasuresFile;
  /** Rovara's own base round's scores; undefined when there is none. */
  readonly base: EvalBaseRecord | undefined;
  readonly facts: EvalRoundFacts;
  /** The round used the hidden eval set. */
  readonly hiddenSetUsed?: boolean;
  /** The task's cap in micro-dollars, for the cap sentence. */
  readonly capMicros?: number;
  /** The fewest cases that must stand behind a score: applied to the cases that ran, to the runner's count for each measure, and to the base round's count (default `EVAL_MIN_QUESTIONS`). */
  readonly minQuestions?: number;
}

const SUMMARY_PREFIX = "Eval (your runner): ";
const CLASS_ORDER: readonly EvalNotRunClass[] = ["cap", "key_refused", "rate_limit", "quota", "overloaded", "provider_error", "refused"];
const round2 = (value: number): string => String(Number(value.toFixed(2)));
const inert = (text: string, max: number): string => inertEvidenceText(typeof text === "string" ? text : "", max);

/** The sentence for a not-run class, with the cap amount when there is one. */
function classSentence(word: EvalNotRunClass, capMicros: number | undefined): string {
  return word === "cap" ? capSentence(capMicros) : word === "provider_error" || word === "refused" ? EVAL_NOT_RUN_SENTENCES[word] : NOT_RUN_SENTENCES[word];
}
/** The class that stopped the most cases (ties: the order cap, key refused, rate limit, quota, overloaded). */
function dominantClass(facts: EvalRoundFacts): EvalNotRunClass | undefined {
  let best: EvalNotRunClass | undefined;
  for (const word of CLASS_ORDER) if ((facts.byClass[word] ?? 0) > (best === undefined ? 0 : (facts.byClass[best] ?? 0))) best = word;
  return best;
}

/** An eval that was not run: no measure, the fixed sentence, `not_run`. */
export function evalNotRunResult(args: { readonly roundKind: EvalRoundKind; readonly reason: EvalNotRunReason; readonly sentence?: string; readonly facts?: EvalRoundFacts; readonly capMicros?: number; readonly hiddenSetUsed?: boolean }): EvalCheckResult {
  const sentence = args.sentence ?? (args.reason === "cap" ? capSentence(args.capMicros) : EVAL_NOT_RUN_SENTENCES[args.reason]);
  return {
    kind: "eval", roundKind: args.roundKind, outcome: "not_run", notRun: { reason: args.reason, sentence },
    casesRun: args.facts?.run ?? 0, casesTotal: args.facts?.total ?? 0, usedHiddenSet: args.hiddenSetUsed === true, measures: [], verdicts: [], summary: `${SUMMARY_PREFIX}${sentence}`,
  };
}

/**
 * The eval check from the runner's head measures, the base record and the round's facts. Above the not-run fraction (20% of cases) the whole eval is `not_run` with the sentence of the class that stopped most cases. Otherwise every
 * measure gets its own verdict. A measure with no matching base score (same name, unit and direction) is `not_run` and is left out of the v2 measures, which need a base. When some cases did not run, a score is compared only if
 * the runner's own count is the number of cases that ran (a score that may include unrun cases is never compared, so it can never read as a lower score), and the line says "n of N run".
 */
export function evalCheckResult(input: EvalCheckInput): EvalCheckResult {
  const { facts, roundKind } = input;
  const hidden = input.hiddenSetUsed === true;
  const minQuestions = input.minQuestions ?? EVAL_MIN_QUESTIONS;
  if (facts.total > 0 && facts.notRun / facts.total > EVAL_NOT_RUN_FRACTION_MAX) {
    const word = dominantClass(facts);
    return evalNotRunResult({ roundKind, reason: "too_many_not_run", sentence: word === undefined ? EVAL_NOT_RUN_SENTENCES.too_many_not_run : classSentence(word, input.capMicros), facts, ...(hidden ? { hiddenSetUsed: true } : {}) });
  }
  // Too few cases ran for the eval to detect a change: not run, never a pass.
  if (facts.run < minQuestions) return evalNotRunResult({ roundKind, reason: "too_few_questions", facts, ...(hidden ? { hiddenSetUsed: true } : {}) });
  const verdicts: EvalMeasureResult[] = [];
  const measures: EvalEvidenceMeasure[] = [];
  input.head.measures.forEach((entry, index) => {
    const match = input.base?.measures.find((candidate) => candidate.name === entry.name && candidate.unit === entry.unit && candidate.direction === entry.direction);
    // A hidden-set round reports ONLY measures Rovara's own base round knows: a measure it does not know is dropped entirely (its name, unit and value never reach the result).
    if (hidden && match === undefined) return;
    // The position a measure is reported at: in a hidden round it is the measure's place in Rovara's BASE record, never its place in the runner's list (the runner would otherwise choose the position, and with it ~5 bits per measure).
    const slot = hidden && match !== undefined && input.base !== undefined ? input.base.measures.indexOf(match) : index;
    const label = inert(hidden ? (match?.name ?? "") : entry.name, 40);
    const unit = inert(hidden ? (match?.unit ?? "") : entry.unit, 10);
    // The cases behind a score are the cases that ran, from Rovara's facts: the runner's own count is only read to decide whether the score may be compared.
    const count = facts.run;
    const refuse = (reason: EvalNotRunReason, showHead: boolean): void => {
      verdicts.push({ index: slot, label, unit, verdict: "not_run", reason, sentence: EVAL_NOT_RUN_SENTENCES[reason], ...(showHead && !hidden && readable(entry.value) ? { head: clamp(entry.value) } : {}), count });
    };
    if (entry.count !== undefined && entry.count < minQuestions) return refuse("too_few_questions", false);
    if (facts.notRun > 0 && entry.count !== facts.run) return refuse("partial_run", false);
    if (match === undefined) return refuse("no_base_score", true);
    if ((match.count ?? input.base?.caseCount ?? 0) < minQuestions) return refuse("too_few_questions", false);
    const judged = evalVerdictFor({ direction: entry.direction, base: match.value, head: entry.value, ...(match.spread === undefined ? {} : { spread: match.spread }) });
    if (judged.verdict === "not_run") return refuse("unreadable_score", false);
    if (hidden) {
      // Pass or fail only: a score beyond the band reads as no drop, and no value is kept.
      const verdict = judged.verdict === "worse" ? "worse" : judged.verdict === "no_noise_estimate" ? "no_noise_estimate" : "no_detectable_change";
      verdicts.push({ index: slot, label, unit, verdict, sentence: verdict === "no_noise_estimate" ? EVAL_VERDICT_WORDS.no_noise_estimate : HIDDEN_VERDICT_WORDS[verdict], count });
      return;
    }
    verdicts.push({ index, label, unit, verdict: judged.verdict, sentence: EVAL_VERDICT_WORDS[judged.verdict], head: clamp(entry.value), base: match.value, count });
    const candidate = {
      name: entry.name, unit: match.unit, base: match.value, head: entry.value, direction: entry.direction,
      ...(judged.spread === undefined ? {} : { spread: judged.spread }), ...(judged.band === undefined ? {} : { band: judged.band }),
    };
    const checked = EvidenceMeasureSchema.safeParse(candidate);
    if (checked.success && measures.length < EVIDENCE_MEASURES_MAX) measures.push(checked.data);
  });
  // A hidden round lists its measures in the BASE record's order, whatever order the runner wrote them in.
  if (hidden) verdicts.sort((left, right) => left.index - right.index);
  if (hidden && verdicts.length === 0) return evalNotRunResult({ roundKind, reason: "no_base_score", facts, hiddenSetUsed: true });
  const lines = verdicts.slice(0, SUMMARY_MEASURES_LISTED).map((verdict) => {
    if (verdict.base === undefined || verdict.head === undefined) return `${verdict.label}: ${verdict.sentence}`;
    return `${verdict.label} ${round2(verdict.head)} ${verdict.unit} (main ${round2(verdict.base)} ${verdict.unit}) \u00b7 ${verdict.sentence}`;
  });
  if (verdicts.length > SUMMARY_MEASURES_LISTED) lines.push(`and ${String(verdicts.length - SUMMARY_MEASURES_LISTED)} more measures`);
  const partial = facts.notRun > 0 ? ` (${String(facts.run)} of ${String(facts.total)} run)` : "";
  return {
    kind: "eval", roundKind, outcome: verdicts.some((verdict) => verdict.verdict !== "not_run") ? "ran" : "not_run",
    casesRun: facts.run, casesTotal: facts.total, usedHiddenSet: hidden, measures, verdicts, summary: `${SUMMARY_PREFIX}${lines.join("; ")}${partial}`,
  };
}
