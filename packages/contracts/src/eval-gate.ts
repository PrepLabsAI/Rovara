// TE-F3-b (DECISIONS 170 parts A and B): the gate that decides whether an eval may be called "No regression measured (eval)" or "Improved on eval". Pure: no clock, no randomness, no call. It NEVER says "Proven".
//
// It takes the questions' per-run scores on the OLD code (Rovara's own repeated base runs) and on the NEW code, for the visible set and the holdout set, and the facts the rule asks for (plan, goal, judge, edits, coverage, baseline). The
// first failing rule gives "not qualified" with a fixed reason; a clear DROP always wins over the other reasons (a drop is never hidden behind "cannot detect"). The statistics are in eval-gate-stats.ts and are paired, with noise from
// the OLD runs only.
//
// What is printed: `summary` is the public text (PR, task page). It holds fixed words and numbers only: the visible set's effect size and noise range, and WORDS for the holdout ("within the noise band", "clearly better"), never a
// holdout score, count, category name or question id. `ownerDetail` carries every number, including the holdout's, and every run; it is for the owner's page and is never given to the coding agent. The agent's own feedback is
// `evalGateAgentFeedback`: pass, fail or not run, and nothing else (eval-holdout.ts has the per-task limit and the rotation).
import { EVAL_MIN_QUESTIONS } from "./eval-check.js";
import { EVAL_NOT_RUN_FRACTION_MAX, type EvalRoundFacts } from "./eval-pacing.js";
import { inertEvidenceText } from "./evidence-inert.js";
import {
  EVAL_GATE_BAND_K, EVAL_GATE_VARIANCE_FLOOR, EVAL_GATE_Z_POWER, EVAL_HOLM_ALPHA, EVAL_STEADY_MIN_RUNS, EVAL_STEADY_OVERALL_FLIPS, EVAL_STEADY_STRICT_FLIPS, EVAL_UTC, checkEvalBaseline, checkEvalGatePlan, checkEvalGoal, checkEvalJudge, evalCoverageCount, isStrictCategory,
  type EvalBaselineFacts, type EvalCoverage, type EvalEdits, type EvalGatePlan, type EvalGoal, type EvalJudgeInput,
} from "./eval-gate-inputs.js";
import { EVAL_NOT_QUALIFIED_REASON_WORDS, evalProofLabel, type ChangeProofLabel, type EvalNotQualifiedReason } from "./eval-gate-labels.js";
import { holmRejections, norm, normalCdf, pairQuestionRuns, pairedEffect, type PairedEffect } from "./eval-gate-stats.js";
import type { EvalQuestionResult } from "./measures-file.js";

/** Why a result is not qualified, finer than A3's reasons (each maps to one of A3's). */
export const EVAL_GATE_DETAILS = [
  "plan_not_fixed", "cannot_detect_drop", "judge_not_pinned", "replies_not_independent", "questions_edited_by_change", "edits_unknown", "baseline_too_old", "no_holdout", "holdout_checks_used_up", "runs_incomplete",
  "too_few_questions", "cap_hit", "provider_outage", "regression_found", "no_coverage_evidence", "inputs_unreadable", "base_round_unattested", "hidden_round_timed_out", "runner_kill_missing",
] as const;
export type EvalGateDetail = (typeof EVAL_GATE_DETAILS)[number];

/** The fixed words of each detail, and the A3 reason code it maps to. A3 has no word for a drop, a missing holdout or an unfixed plan, so those map to `not_gated` and the detail words say the truth. */
export const EVAL_GATE_DETAIL_ROWS: Readonly<Record<EvalGateDetail, { readonly reason: EvalNotQualifiedReason; readonly words: string }>> = {
  plan_not_fixed: { reason: "not_gated", words: "the agreed drop, runs and seed were not fixed before the task" },
  cannot_detect_drop: { reason: "cannot_detect_drop", words: EVAL_NOT_QUALIFIED_REASON_WORDS.cannot_detect_drop },
  judge_not_pinned: { reason: "judge_not_pinned", words: EVAL_NOT_QUALIFIED_REASON_WORDS.judge_not_pinned },
  replies_not_independent: { reason: "replies_not_independent", words: EVAL_NOT_QUALIFIED_REASON_WORDS.replies_not_independent },
  questions_edited_by_change: { reason: "questions_edited_by_change", words: EVAL_NOT_QUALIFIED_REASON_WORDS.questions_edited_by_change },
  edits_unknown: { reason: "questions_edited_by_change", words: "it is not known whether the change edited the eval questions, scoring or thresholds" },
  baseline_too_old: { reason: "baseline_too_old", words: EVAL_NOT_QUALIFIED_REASON_WORDS.baseline_too_old },
  no_holdout: { reason: "not_gated", words: "no holdout set was scored" },
  holdout_checks_used_up: { reason: "not_gated", words: "the holdout checks for this task are used up" },
  runs_incomplete: { reason: "not_gated", words: "some runs or questions are missing or do not match the plan" },
  too_few_questions: { reason: "too_few_questions", words: EVAL_NOT_QUALIFIED_REASON_WORDS.too_few_questions },
  cap_hit: { reason: "cap_hit", words: EVAL_NOT_QUALIFIED_REASON_WORDS.cap_hit },
  provider_outage: { reason: "provider_outage", words: EVAL_NOT_QUALIFIED_REASON_WORDS.provider_outage },
  regression_found: { reason: "not_gated", words: "the eval shows a drop beyond the noise band" },
  no_coverage_evidence: { reason: "no_coverage_evidence", words: EVAL_NOT_QUALIFIED_REASON_WORDS.no_coverage_evidence },
  inputs_unreadable: { reason: "not_gated", words: "the gate could not read its inputs" },
  runner_kill_missing: { reason: "not_gated", words: "the hidden round has no way to stop its runner" },
  hidden_round_timed_out: { reason: "not_gated", words: "the hidden round did not finish in its time slot" },
  base_round_unattested: { reason: "baseline_too_old", words: "the old-code round was not confirmed to run alone on a clean checkout" },
};

export interface EvalGateSetData {
  /** Every question result of every run on the OLD code (Rovara's own base round), and on the NEW code. */
  readonly base: readonly EvalQuestionResult[];
  readonly head: readonly EvalQuestionResult[];
  /** The seed each side was run with. */
  readonly baseSeed: string | undefined;
  readonly headSeed: string | undefined;
  /** When the questions AND their scoring were committed, UTC. Questions from before the task start are usable; others only if the independent agent wrote them. */
  readonly setCommittedAt: string;
  readonly independentQuestionIds?: readonly string[];
  /** The holdout rotation: only these questions are scored this check. */
  readonly selectedQuestionIds?: readonly string[];
}

export interface EvalGateMeasuresOnly {
  readonly tokens?: { readonly base: number; readonly head: number };
  readonly latencyMs?: { readonly base: number; readonly head: number };
}

export interface EvalGateInput {
  readonly plan: EvalGatePlan | undefined;
  /** The plan's hash as Rovara stored it when the plan was fixed. */
  readonly recordedPlanHash: string | undefined;
  /** Rovara's own record of when the task started and when the first code was written, UTC. */
  readonly times: { readonly taskStartedAt: string; readonly firstCodeAt: string };
  readonly goal?: { readonly goal: EvalGoal | undefined; readonly recordedHash: string | undefined } | undefined;
  readonly judge: EvalJudgeInput | undefined;
  readonly visible: EvalGateSetData;
  readonly holdout?: EvalGateSetData | undefined;
  readonly edits: EvalEdits | undefined;
  readonly coverage: EvalCoverage | undefined;
  readonly baseline: EvalBaselineFacts | undefined;
  /** The facts of the VISIBLE rounds behind this gate (base and head), added up. Up to 20% of the cases may have not run, and the questions that did not run are left out. */
  readonly facts: EvalRoundFacts;
  /** The facts of the HIDDEN (holdout) rounds, base and head, added up. No tolerance: a case that did not run (a cap, an outage, a refused call) makes the whole holdout "not run". Run counts of a hidden round are a channel (a runner can refuse calls on purpose), so nothing of them is ever shown while the task runs. */
  readonly holdoutFacts?: EvalRoundFacts | undefined;
  /** The holdout check limit for this task was already used up. */
  readonly holdoutChecks?: "ok" | "used_up" | undefined;
  /** Token cost and latency: shown, never counted. */
  readonly measuresOnly?: EvalGateMeasuresOnly | undefined;
}

export interface EvalGateRunReport { readonly side: "base" | "head"; readonly index: number; readonly mean: number; readonly questions: number }
export interface EvalGateCategoryReport { readonly category: string; readonly strict: boolean; readonly questions: number; readonly effect: number; readonly clearDrop: boolean }
export interface EvalGateSetReport {
  readonly set: "visible" | "holdout";
  /** Untouched, complete, paired questions behind the numbers. */
  readonly questions: number;
  readonly excluded: { readonly edited: number; readonly notIndependent: number; readonly notSelected: number; readonly added: number; readonly incomplete: number };
  readonly baseMean: number;
  readonly headMean: number;
  /** New minus old, in score units. */
  readonly effect: number;
  readonly se: number;
  /** The noise band around "no change": +/- z x SE. */
  readonly noiseRange: { readonly low: number; readonly high: number };
  /** The smallest drop this eval could see with the planned power. */
  readonly smallestDetectableDrop: number;
  readonly detectable: boolean;
  /** The old code scored exactly the same every run (zero spread): the set is judged against the agreed minimum drop, not a noise band (DECISIONS 171). */
  readonly steady: boolean;
  readonly dropBeyondBand: boolean;
  readonly beyondBandUp: boolean;
  readonly categories: readonly EvalGateCategoryReport[];
  /** Every run: its mean score over the questions. */
  readonly runs: readonly EvalGateRunReport[];
  readonly clearDrop: boolean;
}

export interface EvalGateResult {
  readonly kind: "eval_gate";
  readonly label: ChangeProofLabel;
  readonly qualified: boolean;
  /** A clear drop was found (it blocks the label). */
  readonly regression: boolean;
  readonly reason?: EvalNotQualifiedReason;
  readonly detail?: EvalGateDetail;
  /** A3's words for the label. */
  readonly words: string;
  /** Why "Improved on eval" was not given when "No regression measured (eval)" was. */
  readonly improvedNotClaimed?: "goal_must_be_overall" | "goal_not_named_in_time" | "not_beyond_band_on_holdout";
  readonly coverage: { readonly changed: number; readonly evaluated: number };
  readonly visible?: EvalGateSetReport;
  readonly holdout?: EvalGateSetReport;
  /** The public text: fixed words and numbers; no holdout score, count, category or question id. */
  readonly summary: string;
  /** The visible set's numbers and every visible run, for the owner's page. Never for the coding agent. */
  readonly ownerDetail: readonly string[];
  /** The holdout's numbers, counts, categories and runs. Shown only AFTER the task ends (`evalGatePublicView`): while it runs they are a channel. */
  readonly holdoutOwnerDetail: readonly string[];
}

/** Float residue: two numbers closer than this are equal (0.5 - 0.45 is 0.04999999999999999). */
const EPS = 1e-12;
const SUMMARY_PREFIX = "Eval (gated): ";
const inert = (text: string): string => inertEvidenceText(typeof text === "string" ? text : "", 40);
const sign = (value: number): string => `${value < 0 ? "-" : "+"}${Math.abs(Number(value.toFixed(3)))}`;
const two = (value: number): string => String(Number(value.toFixed(3)));
const isUtc = (value: unknown): value is string => typeof value === "string" && EVAL_UTC.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function notQualified(detail: EvalGateDetail, coverage: { changed: number; evaluated: number }, extra: { regression?: boolean; visible?: EvalGateSetReport; holdout?: EvalGateSetReport; improvedNotClaimed?: EvalGateResult["improvedNotClaimed"]; measuresOnly?: string; owner?: string[] } = {}): EvalGateResult {
  const row = EVAL_GATE_DETAIL_ROWS[detail];
  const label = evalProofLabel({ outcome: "not_qualified", reason: row.reason });
  const numbers = extra.visible === undefined ? "" : ` Visible set: effect ${sign(extra.visible.effect)}, noise range ±${two(extra.visible.noiseRange.high)}.`;
  return {
    kind: "eval_gate", label: label.label, qualified: false, regression: extra.regression === true, reason: row.reason, detail, words: label.words, coverage,
    ...(extra.visible === undefined ? {} : { visible: extra.visible }), ...(extra.holdout === undefined ? {} : { holdout: extra.holdout }),
    summary: `${SUMMARY_PREFIX}not qualified: ${row.words}.${numbers}${extra.measuresOnly === undefined ? "" : ` ${extra.measuresOnly}`}`,
    ownerDetail: [...(extra.owner ?? []), ...ownerLines(extra.visible)], holdoutOwnerDetail: ownerLines(extra.holdout),
  };
}

/** A gate result for a check that stopped before any number could be judged (the holdout was not available in this round, or its checks are used up). */
export function evalGateStopped(detail: EvalGateDetail): EvalGateResult {
  return notQualified(detail, { changed: 0, evaluated: 0 });
}

function ownerLines(report: EvalGateSetReport | undefined): string[] {
  if (report === undefined) return [];
  const out: string[] = [];
  out.push(`${report.set}: ${String(report.questions)} untouched questions; effect ${sign(report.effect)} (old ${two(report.baseMean)}, new ${two(report.headMean)}); ${report.steady ? "steady old-code score, judged against the agreed minimum drop; " : ""}noise range ${sign(report.noiseRange.low)} to ${sign(report.noiseRange.high)}; smallest detectable drop ${two(report.smallestDetectableDrop)}${report.detectable ? "" : " (too big)"}`);
  out.push(`${report.set}: left out: ${String(report.excluded.edited)} edited, ${String(report.excluded.notIndependent)} not independent, ${String(report.excluded.notSelected)} not selected, ${String(report.excluded.added)} added, ${String(report.excluded.incomplete)} incomplete`);
  for (const category of report.categories) out.push(`${report.set} category ${inert(category.category)}${category.strict ? " (strict)" : ""}: ${String(category.questions)} questions, effect ${sign(category.effect)}${category.clearDrop ? ", CLEAR DROP" : ""}`);
  for (const run of report.runs) out.push(`${report.set} ${run.side} run ${String(run.index)}: mean ${two(run.mean)} over ${String(run.questions)} questions`);
  return out;
}

type SetOutcome = { readonly ok: true; readonly report: EvalGateSetReport } | { readonly ok: false; readonly detail: EvalGateDetail };

/** One set's numbers, or the detail that stops the gate. */
function analyseSet(set: "visible" | "holdout", data: EvalGateSetData, args: { plan: EvalGatePlan; edits: Extract<EvalEdits, { status: "known" }>; taskStartedAt: string; minQuestions: number; /** How many model calls the facts say did not run in this set's rounds: the most the missing runs may add up to. */ notRunCases: number }): SetOutcome {
  const { plan } = args;
  if (!Array.isArray(data.base) || !Array.isArray(data.head) || !isUtc(data.setCommittedAt)) return { ok: false, detail: "inputs_unreadable" };
  const readableRow = (row: EvalQuestionResult): boolean => typeof row === "object" && row !== null && typeof row.id === "string" && typeof row.category === "string" && finite(row.score) && row.score >= 0 && row.score <= 1 && Number.isSafeInteger(row.run) && row.run >= 0;
  if (!data.base.every(readableRow) || !data.head.every(readableRow)) return { ok: false, detail: "inputs_unreadable" };
  if (data.headSeed !== plan.seed) return { ok: false, detail: "plan_not_fixed" };
  if (data.baseSeed !== plan.seed) return { ok: false, detail: "baseline_too_old" };
  const edited = new Set(args.edits.editedQuestionIds);
  const independent = new Set(data.independentQuestionIds ?? []);
  const selected = data.selectedQuestionIds === undefined ? undefined : new Set(data.selectedQuestionIds);
  const predates = data.setCommittedAt < args.taskStartedAt;
  const excluded = { edited: 0, notIndependent: 0, notSelected: 0, added: 0, incomplete: 0 };
  // The runs a left-out question is missing. A question may be left out only if the facts show at least that many calls did not run (a missing run with no not-run call behind it is a fault, and a question with EXTRA runs is never tolerated).
  let missingRuns = 0;
  const keep = (row: EvalQuestionResult): boolean => selected === undefined || selected.has(row.id);
  const allBase: readonly EvalQuestionResult[] = data.base;
  const allHead: readonly EvalQuestionResult[] = data.head;
  const baseRows = allBase.filter(keep);
  const headRows = allHead.filter(keep);
  excluded.notSelected = new Set([...allBase, ...allHead].filter((row) => !keep(row)).map((row) => row.id)).size;
  const { paired, unpaired } = pairQuestionRuns(baseRows, headRows);
  const baseIds = new Set(baseRows.map((row) => row.id));
  for (const id of unpaired) {
    if (!baseIds.has(id)) excluded.added += 1;
    else if (edited.has(id)) excluded.edited += 1;
    else { excluded.incomplete += 1; missingRuns += plan.headRuns; }
  }
  const usable = [];
  let editedCount = 0;
  for (const question of paired) {
    if (edited.has(question.id)) { editedCount += 1; continue; }
    if (!predates && !independent.has(question.id)) { excluded.notIndependent += 1; continue; }
    const wantBase = Array.from({ length: plan.baseRuns }, (_x, index) => index);
    const wantHead = Array.from({ length: plan.headRuns }, (_x, index) => index);
    if (question.baseIndexes.join() !== wantBase.join() || question.headIndexes.join() !== wantHead.join()) {
      excluded.incomplete += 1;
      const lacking = (want: readonly number[], have: readonly number[]): number => (new Set(have).size === have.length && have.every((index) => want.includes(index)) ? want.filter((index) => !have.includes(index)).length : Number.POSITIVE_INFINITY);
      missingRuns += lacking(wantBase, question.baseIndexes) + lacking(wantHead, question.headIndexes);
      continue;
    }
    usable.push(question);
  }
  excluded.edited += editedCount;
  // Questions that did not run (a provider limit, said by the facts) are left out when they are at most the not-run share (DECISIONS 171: 20%); missing data the facts do not explain is a fault.
  if (excluded.incomplete > 0 && (missingRuns > args.notRunCases || excluded.incomplete / (usable.length + excluded.incomplete) > EVAL_NOT_RUN_FRACTION_MAX)) return { ok: false, detail: "runs_incomplete" };
  if (usable.length < args.minQuestions) {
    if (excluded.notIndependent > 0 && usable.length + excluded.notIndependent >= args.minQuestions) return { ok: false, detail: "replies_not_independent" };
    return { ok: false, detail: excluded.edited > 0 && usable.length + excluded.edited >= args.minQuestions ? "questions_edited_by_change" : "too_few_questions" };
  }
  // The band is EVAL_GATE_BAND_K x the standard error of the effect, from the old code's repeated runs only. A set that did vary gets a variance floor per question; a set that never varied is steady.
  const zBand = EVAL_GATE_BAND_K;
  const delta = plan.minDetectableDrop;
  const raw = pairedEffect(usable);
  if (raw === undefined) return { ok: false, detail: "inputs_unreadable" };
  const overall = raw.se === 0 ? raw : (pairedEffect(usable, EVAL_GATE_VARIANCE_FLOOR) ?? raw);
  // A steady eval: the old code's runs never varied, over the WHOLE set. It is judged against the agreed minimum drop (a drop of at least that is worse). With fewer than 3 old runs there is still no way to say "no regression"
  // (not detectable), but a big drop is a drop all the same, so it is measured and reported ahead of "cannot detect".
  const steady = overall.se === 0;
  // The steady floor: never less than EVAL_STEADY_OVERALL_FLIPS failed question-runs' worth.
  const steadyDrop = Math.max(delta, EVAL_STEADY_OVERALL_FLIPS / (overall.n * plan.headRuns));
  const band = steady ? steadyDrop : zBand * overall.se;
  const mde = steady ? 0 : (zBand + EVAL_GATE_Z_POWER) * overall.se;
  const effect = Math.abs(overall.effect) < 1e-12 ? 0 : overall.effect;
  const detectable = steady ? plan.baseRuns >= EVAL_STEADY_MIN_RUNS : norm(mde) <= norm(delta);

  const byCategory = new Map<string, typeof usable>();
  for (const question of usable) byCategory.set(question.category, [...(byCategory.get(question.category) ?? []), question]);
  const ordinary: Array<{ category: string; effect: PairedEffect }> = [];
  const categories: EvalGateCategoryReport[] = [];
  let strictDrop = false;
  for (const [category, group] of byCategory) {
    const rawCat = pairedEffect(group);
    if (rawCat === undefined) return { ok: false, detail: "inputs_unreadable" };
    const found = rawCat.se === 0 ? rawCat : (pairedEffect(group, EVAL_GATE_VARIANCE_FLOOR) ?? rawCat);
    if (isStrictCategory(category, plan)) {
      // Strict: no correction; any drop beyond the category's own band is clear. A strict category whose old runs never varied is judged against the agreed minimum drop.
      const drop = found.se === 0 ? found.effect + Math.max(delta, EVAL_STEADY_STRICT_FLIPS / (found.n * plan.headRuns)) <= EPS : norm(found.effect + zBand * found.se) < -EPS && Math.abs(found.effect) >= 1e-12;
      strictDrop ||= drop;
      categories.push({ category, strict: true, questions: found.n, effect: found.effect, clearDrop: drop });
    } else ordinary.push({ category, effect: found });
  }
  // Ordinary categories: one-sided test for a drop, Holm-Bonferroni across the categories. A category with no noise estimate (its old runs never varied) gets p = 1: it can never alone be a clear drop.
  const pValues = ordinary.map(({ effect: found }) => (found.se > 0 ? normalCdf(found.effect / found.se) : 1));
  const rejected = holmRejections(pValues, EVAL_HOLM_ALPHA);
  ordinary.forEach(({ category, effect: found }, index) => categories.push({ category, strict: false, questions: found.n, effect: found.effect, clearDrop: rejected[index] === true }));
  const runs: EvalGateRunReport[] = [];
  for (const side of ["base", "head"] as const) {
    const count = side === "base" ? plan.baseRuns : plan.headRuns;
    for (let index = 0; index < count; index += 1) {
      const scores = usable.map((question) => (side === "base" ? question.baseRuns : question.headRuns)[index] as number);
      runs.push({ side, index, mean: scores.reduce((sum, value) => sum + value, 0) / scores.length, questions: scores.length });
    }
  }
  const dropBeyondBand = steady ? effect + steadyDrop <= EPS : norm(effect + band) < -EPS;
  const clearDrop = dropBeyondBand || strictDrop || categories.some((category) => !category.strict && category.clearDrop);
  const report: EvalGateSetReport = {
    set, questions: usable.length, excluded, baseMean: overall.baseMean, headMean: overall.headMean, effect, se: overall.se,
    noiseRange: { low: norm(-band), high: norm(band) }, smallestDetectableDrop: mde, detectable, steady, dropBeyondBand, beyondBandUp: steady ? effect - steadyDrop >= -EPS : norm(effect - band) > EPS, categories, runs, clearDrop,
  };
  return { ok: true, report };
}

function measuresOnlyWords(measures: EvalGateMeasuresOnly | undefined): string | undefined {
  if (measures === undefined) return undefined;
  const parts: string[] = [];
  if (measures.tokens !== undefined && finite(measures.tokens.base) && finite(measures.tokens.head)) parts.push(`tokens ${two(measures.tokens.head)} (main ${two(measures.tokens.base)})`);
  if (measures.latencyMs !== undefined && finite(measures.latencyMs.base) && finite(measures.latencyMs.head)) parts.push(`latency ${two(measures.latencyMs.head)} ms (main ${two(measures.latencyMs.base)} ms)`);
  return parts.length === 0 ? undefined : `Measures only, not proof: ${parts.join("; ")}.`;
}

/**
 * The gate. In order: the rounds' facts (a cap hit or any case not run is "not qualified", never a pass); the plan fixed in advance; the judge pin; the edit facts; the baseline; a holdout set within the check limit; then the numbers
 * (independence, edits, runs, noise, detectability, drops). A clear drop is reported ahead of "cannot detect". Coverage is last. "Improved on eval" needs a goal named before any code and a holdout effect strictly beyond the band.
 */
export function evalGate(input: EvalGateInput): EvalGateResult {
  const coverage = evalCoverageCount(input.coverage);
  const measuresOnly = measuresOnlyWords(input.measuresOnly);
  const stop = (detail: EvalGateDetail, extra: Parameters<typeof notQualified>[2] = {}): EvalGateResult => notQualified(detail, coverage, { ...extra, ...(measuresOnly === undefined ? {} : { measuresOnly }) });
  try {
    const { facts } = input;
    if (facts === undefined || !finite(facts.total) || !finite(facts.notRun)) return stop("inputs_unreadable");
    if (facts.overrunStop || (facts.byClass.cap ?? 0) > 0) return stop("cap_hit");
    // More than 20% of the cases not run: the whole eval is not run (DECISIONS 171). Fewer are left out, and the data must show which (`runs_incomplete` otherwise).
    if (facts.total > 0 && facts.notRun / facts.total > EVAL_NOT_RUN_FRACTION_MAX) return stop("provider_outage");
    const hf = input.holdoutFacts;
    if (hf !== undefined) {
      if (!finite(hf.total) || !finite(hf.notRun)) return stop("inputs_unreadable");
      if (hf.overrunStop || (hf.byClass.cap ?? 0) > 0) return stop("cap_hit");
      // A hidden round has no tolerance: one case that did not run makes the whole holdout not run (no per-case, per-measure or per-count signal).
      if (hf.notRun > 0) return stop("provider_outage");
    }
    const times = input.times as Partial<EvalGateInput["times"]> | undefined;
    if (times === undefined || !isUtc(times.taskStartedAt) || !isUtc(times.firstCodeAt) || times.firstCodeAt < times.taskStartedAt) return stop("plan_not_fixed");
    const planOk = checkEvalGatePlan({ plan: input.plan, recordedHash: input.recordedPlanHash, taskStartedAt: times.taskStartedAt });
    if (!planOk.ok) return stop(planOk.detail);
    const plan = input.plan as EvalGatePlan;
    if (!checkEvalJudge(input.judge, times.taskStartedAt)) return stop("judge_not_pinned");
    const edits = input.edits;
    if (edits === undefined || edits.status !== "known") return stop("edits_unknown");
    if (edits.scoringEdited || edits.thresholdsEdited) return stop("questions_edited_by_change");
    if (!Array.isArray(edits.editedQuestionIds)) return stop("inputs_unreadable");
    if (!checkEvalBaseline(input.baseline)) return stop("baseline_too_old");
    if (input.holdout === undefined) return stop("no_holdout");
    if (input.holdoutChecks === "used_up") return stop("holdout_checks_used_up");

    const settings = { plan, edits, taskStartedAt: times.taskStartedAt, minQuestions: EVAL_MIN_QUESTIONS, notRunCases: facts.notRun };
    const visible = analyseSet("visible", input.visible, settings);
    if (!visible.ok) return stop(visible.detail);
    const holdout = analyseSet("holdout", input.holdout, { ...settings, notRunCases: 0 });
    if (!holdout.ok) return stop(holdout.detail, { visible: visible.report });
    const reports = { visible: visible.report, holdout: holdout.report };
    if (visible.report.clearDrop || holdout.report.clearDrop) return stop("regression_found", { ...reports, regression: true });
    if (!visible.report.detectable || !holdout.report.detectable) return stop("cannot_detect_drop", reports);
    if (coverage.evaluated < 1) return stop("no_coverage_evidence", reports);

    // Qualified: "No regression measured (eval)", or "Improved on eval" when the goal was named in time and the holdout is clearly better on it.
    let improvedNotClaimed: EvalGateResult["improvedNotClaimed"];
    let improved = false;
    if (input.goal !== undefined) {
      const kind = (input.goal.goal as { metric?: { kind?: unknown } } | undefined)?.metric?.kind;
      if (kind !== undefined && kind !== "overall") improvedNotClaimed = "goal_must_be_overall";
      else if (!checkEvalGoal({ goal: input.goal.goal, recordedHash: input.goal.recordedHash, firstCodeAt: times.firstCodeAt })) improvedNotClaimed = "goal_not_named_in_time";
      else {
        improved = holdout.report.beyondBandUp;
        if (!improved) improvedNotClaimed = "not_beyond_band_on_holdout";
      }
    }
    const outcome = improved ? "improved_eval" : "no_regression_eval";
    const label = evalProofLabel({ outcome });
    const area = `on the evaluated areas (${String(coverage.evaluated)} of ${String(coverage.changed)} changed items exercised; ${String(visible.report.questions)} untouched visible questions, ${String(plan.baseRuns)} old-code and ${String(plan.headRuns)} new-code runs)`;
    const visibleNumbers = visible.report.steady
      ? `Visible set: effect ${sign(visible.report.effect)}; the old code scored the same on every run, so it is judged against the agreed minimum drop of ${two(plan.minDetectableDrop)}.`
      : `Visible set: effect ${sign(visible.report.effect)}, noise range ±${two(visible.report.noiseRange.high)} (smallest detectable drop ${two(visible.report.smallestDetectableDrop)}).`;
    const leftOut = visible.report.excluded.incomplete > 0 ? " Some questions could not be run and were left out." : "";
    const holdoutWords = improved ? "Holdout: clearly better, beyond the noise band." : "Holdout: within the noise band.";
    const runsWords = `Visible runs: old ${visible.report.runs.filter((run) => run.side === "base").map((run) => two(run.mean)).join(" ")}; new ${visible.report.runs.filter((run) => run.side === "head").map((run) => two(run.mean)).join(" ")}.`;
    const points = String(Number((plan.minDetectableDrop * 100).toFixed(1)));
    const sizeWords = `No drop of ${points} points or more measured.`;
    return {
      kind: "eval_gate", label: label.label, qualified: true, regression: false, words: label.words, coverage, ...(improvedNotClaimed === undefined ? {} : { improvedNotClaimed }), visible: visible.report, holdout: holdout.report,
      summary: `${SUMMARY_PREFIX}${label.words} ${area}. ${sizeWords} ${visibleNumbers} ${holdoutWords} ${runsWords}${leftOut}${measuresOnly === undefined ? "" : ` ${measuresOnly}`}`,
      ownerDetail: ownerLines(visible.report), holdoutOwnerDetail: ownerLines(holdout.report),
    };
  } catch {
    return stop("inputs_unreadable");
  }
}

/**
 * What may be shown while the task runs, and after. The holdout's report, counts and detail are left out until the task has ended (`taskEnded`); the coding agent never gets this view at all (it gets `evalGateAgentFeedback`).
 */
export function evalGatePublicView(result: EvalGateResult, options: { readonly taskEnded: boolean }): Omit<EvalGateResult, "holdout" | "holdoutOwnerDetail"> & Partial<Pick<EvalGateResult, "holdout" | "holdoutOwnerDetail">> {
  const { holdout, holdoutOwnerDetail, ...rest } = result;
  return options.taskEnded === true ? { ...rest, ...(holdout === undefined ? {} : { holdout }), holdoutOwnerDetail } : rest;
}

/** What the coding agent is told about the gated eval: pass, fail or not run. No score, no count, no reason, no category, and never which set failed. */
export type EvalGateAgentFeedback = { readonly result: "pass" | "fail" | "not_run" };
export function evalGateAgentFeedback(result: Pick<EvalGateResult, "qualified" | "regression">): EvalGateAgentFeedback {
  if (result.regression === true) return { result: "fail" };
  return { result: result.qualified === true ? "pass" : "not_run" };
}
