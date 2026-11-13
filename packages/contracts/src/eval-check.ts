// TE-F3 (part A): what an eval check says. From the runner's head scores (`rovara-measures.json`), the base scores Rovara measured and the facts of the round, it builds the v2 evidence `measure` entries and one verdict per
// measure, in fixed words. Pure: no clock, no randomness, no outside call.
//
// THE RULE (the plan block TE-F3, DECISIONS 162 layer 4): the band is base +/- k x spread, k = 2 (`EVAL_NOISE_K`, a data constant). A measure is `better` or `worse` ONLY when the head is strictly OUTSIDE the band, in the measure's
// `direction`. Inside it, or on its edge, nothing changed ("no detectable change"). With no spread at all (the runner gave none and the base round had none, or both are zero) there is no noise estimate, and the difference is
// not judged ("difference not judged: no noise estimate"): nothing but a measured difference outside a measured band ever reads as a change. The spread used is the WIDER of the head's and the base's.
//
// An eval verdict is a quality signal reported as measures, NOT a change proof: `countsTowardProof` is false here whatever the check-kind registry says for the `eval` row (the registry is another lane's file).
//
// Words from the runner (measure names, units) reach every printed sentence only through `inertEvidenceText`. In a round that used a hidden eval set they do not reach the evidence at all: the label comes from the base record
// (Rovara's own base round of main), or is "eval measure N" (eval-hidden-set.ts rule 3).
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
  ...EVAL_NOT_RUN_CLASSES, "too_many_not_run", "hidden_set_needs_sealed_round", "hidden_set_unavailable", "no_base_score", "partial_run", "unreadable_score", "no_measures_file", "eval_set_changed", "eval_set_unknown",
] as const;
export type EvalNotRunReason = (typeof EVAL_NOT_RUN_REASONS)[number];

/** Why an eval (or one measure of it) was not run, in fixed words. The class reasons are F1-a's own sentences (the cap one without an amount: `evalNotRunResult` adds the amount when it has one). */
export const EVAL_NOT_RUN_SENTENCES: Readonly<Record<EvalNotRunReason, string>> = {
  rate_limit: NOT_RUN_SENTENCES.rate_limit,
  quota: NOT_RUN_SENTENCES.quota,
  overloaded: NOT_RUN_SENTENCES.overloaded,
  key_refused: NOT_RUN_SENTENCES.key_refused,
  cap: capSentence(),
  too_many_not_run: "not run: too many cases hit a limit",
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
  /** The runner's spread for the head scores, when it gave one. */
  readonly headSpread?: number;
  /** The spread of the base round, when it had one. */
  readonly baseSpread?: number;
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
const clamp = (value: number): number => Math.max(-SCORE_LIMIT, Math.min(SCORE_LIMIT, value));

/** One measure's verdict. Never throws; a number it cannot read (NaN, infinity, out of range, a negative spread) is `not_run`, never a change. */
export function evalVerdictFor(input: EvalVerdictInput): EvalVerdictOutput {
  const { base, head, headSpread, baseSpread } = input;
  if (!readable(base) || !readable(head) || (headSpread !== undefined && !readableSpread(headSpread)) || (baseSpread !== undefined && !readableSpread(baseSpread))) return { verdict: "not_run", reason: "unreadable_score" };
  const spread = Math.max(headSpread ?? 0, baseSpread ?? 0);
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
  /** The measure's position in the runner's file. */
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
  /** The cases behind the score: the runner's count, else the cases that ran. */
  readonly count: number;
}

export interface EvalCheckResult {
  readonly kind: "eval";
  /** An eval verdict is a quality signal, never a change proof. */
  readonly countsTowardProof: false;
  readonly roundKind: EvalRoundKind;
  /** `passed`: the eval ran. `not_run`: it did not, or no measure could be compared. Never `failed`: a difference is a measure, not a failure. */
  readonly outcome: "passed" | "not_run";
  /** Set when the whole eval was not run. */
  readonly notRun?: { readonly reason: EvalNotRunReason; readonly sentence: string };
  readonly casesRun: number;
  readonly casesTotal: number;
  readonly usedHiddenSet: boolean;
  /** The v2 evidence `measure` entries (each passes `EvidenceMeasureSchema`): only measures that have a base. */
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
}

const SUMMARY_PREFIX = "Eval (your runner): ";
const CLASS_ORDER: readonly EvalNotRunClass[] = ["cap", "key_refused", "rate_limit", "quota", "overloaded"];
const round2 = (value: number): string => String(Number(value.toFixed(2)));
const inert = (text: string, max: number): string => inertEvidenceText(typeof text === "string" ? text : "", max);

/** The sentence for a not-run class, with the cap amount when there is one. */
function classSentence(word: EvalNotRunClass, capMicros: number | undefined): string {
  return word === "cap" ? capSentence(capMicros) : NOT_RUN_SENTENCES[word];
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
    kind: "eval", countsTowardProof: false, roundKind: args.roundKind, outcome: "not_run", notRun: { reason: args.reason, sentence },
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
  if (facts.total > 0 && facts.notRun / facts.total > EVAL_NOT_RUN_FRACTION_MAX) {
    const word = dominantClass(facts);
    return evalNotRunResult({ roundKind, reason: "too_many_not_run", sentence: word === undefined ? EVAL_NOT_RUN_SENTENCES.too_many_not_run : classSentence(word, input.capMicros), facts, ...(hidden ? { hiddenSetUsed: true } : {}) });
  }
  const verdicts: EvalMeasureResult[] = [];
  const measures: EvalEvidenceMeasure[] = [];
  input.head.measures.forEach((entry, index) => {
    const match = input.base?.measures.find((candidate) => candidate.name === entry.name && candidate.unit === entry.unit && candidate.direction === entry.direction);
    // A hidden-set round never prints the runner's own name: the base record's (written by Rovara's base round of main) or a number.
    const label = hidden ? (match === undefined ? `eval measure ${String(index + 1)}` : inert(match.name, 40)) : inert(entry.name, 40);
    const unit = inert(hidden ? (match?.unit ?? "") : entry.unit, 10);
    const count = entry.count ?? facts.run;
    const refuse = (reason: EvalNotRunReason, showHead: boolean): void => {
      verdicts.push({ index, label, unit, verdict: "not_run", reason, sentence: EVAL_NOT_RUN_SENTENCES[reason], ...(showHead && readable(entry.value) ? { head: entry.value } : {}), count });
    };
    if (facts.notRun > 0 && entry.count !== facts.run) return refuse("partial_run", false);
    if (match === undefined) return refuse("no_base_score", true);
    const judged = evalVerdictFor({ direction: entry.direction, base: match.value, head: entry.value, ...(entry.spread === undefined ? {} : { headSpread: entry.spread }), ...(match.spread === undefined ? {} : { baseSpread: match.spread }) });
    if (judged.verdict === "not_run") return refuse("unreadable_score", false);
    verdicts.push({ index, label, unit, verdict: judged.verdict, sentence: EVAL_VERDICT_WORDS[judged.verdict], head: entry.value, base: match.value, count });
    const candidate = {
      name: hidden ? match.name : entry.name, unit: match.unit, base: match.value, head: entry.value, direction: entry.direction,
      ...(judged.spread === undefined ? {} : { spread: judged.spread }), ...(judged.band === undefined ? {} : { band: judged.band }),
    };
    const checked = EvidenceMeasureSchema.safeParse(candidate);
    if (checked.success && measures.length < EVIDENCE_MEASURES_MAX) measures.push(checked.data);
  });
  const lines = verdicts.slice(0, SUMMARY_MEASURES_LISTED).map((verdict) => {
    if (verdict.base === undefined || verdict.head === undefined) return `${verdict.label}: ${verdict.sentence}`;
    return `${verdict.label} ${round2(verdict.head)} ${verdict.unit} (main ${round2(verdict.base)} ${verdict.unit}) \u00b7 ${verdict.sentence}`;
  });
  if (verdicts.length > SUMMARY_MEASURES_LISTED) lines.push(`and ${String(verdicts.length - SUMMARY_MEASURES_LISTED)} more measures`);
  const partial = facts.notRun > 0 ? ` (${String(facts.run)} of ${String(facts.total)} run)` : "";
  return {
    kind: "eval", countsTowardProof: false, roundKind, outcome: verdicts.some((verdict) => verdict.verdict !== "not_run") ? "passed" : "not_run",
    casesRun: facts.run, casesTotal: facts.total, usedHiddenSet: hidden, measures, verdicts, summary: `${SUMMARY_PREFIX}${lines.join("; ")}${partial}`,
  };
}
