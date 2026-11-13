// TE-F3-b: the statistics behind the DECISIONS 170 gate. Pure, no randomness, no clock. Normal approximation throughout (the sums are over many questions); every choice is stated here so a reviewer can check it.
//
//   - PAIRED: the same questions are scored on the old code and the new code, so the question's difficulty cancels. For question q the difference is d_q = mean(new runs) - mean(old runs). The effect is the mean of d_q over the questions.
//   - NOISE: from REPEATED OLD-CODE RUNS only. Question q's run-to-run variance s2_q comes from the old code's runs (n-1 denominator). The standard error of the effect is
//       SE = sqrt( sum_q s2_q x (1/oldRuns + 1/newRuns) ) / n.
//     The spread BETWEEN questions never enters it (that is what pairing removes).
//   - BAND: +/- k x SE with k = 2.5 (`EVAL_GATE_BAND_K`; DECISIONS 171 said 2, tightened after the review's no-change simulations), from repeated OLD-code runs only. A question whose old runs all agreed (measured variance exactly 0) is not proven noise-free: when the rest of the set did vary it is given `EVAL_GATE_VARIANCE_FLOOR`. A change is "beyond the band" only when it is strictly outside it.
//   - STEADY: when the old code scored exactly the same on every run (zero spread) and ran at least 3 times, there is no band: the effect is judged against the agreed minimum drop (a drop of at least that is worse). With fewer runs there is no noise estimate.
//   - DETECTABLE: the smallest drop the eval could see with 80% power is (k + 0.84) x SE (`EVAL_GATE_Z_POWER`). If that is more than the agreed minimum drop, the eval cannot detect the agreed drop.
//   - CATEGORIES: each ordinary category gets a one-sided test for a drop (tail `EVAL_HOLM_ALPHA` = 0.01), and the Holm-Bonferroni step-down correction decides which of them are clear drops. Strict (safety and refusal)
//     categories are not corrected: any drop beyond their own uncorrected band is clear. A category whose old runs never varied has no noise estimate: it gets p = 1 (it can never alone be a clear drop), because a zero standard error would make any wobble of the new code look infinitely significant.
import type { EvalQuestionResult } from "./measures-file.js";

/** Twelve significant digits: the same edge in two float spellings is one edge. */
export const norm = (value: number): number => Number(value.toPrecision(12));

/** The standard normal CDF (Marsaglia's series, about 1e-15 accurate). */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? Number.NaN : x > 0 ? 1 : 0;
  if (x < -38) return 0;
  if (x > 38) return 1;
  let sum = x;
  let term = x;
  const square = x * x;
  for (let index = 1; index < 2_000; index += 2) {
    const previous = sum;
    term *= square / (index + 2);
    sum += term;
    if (sum === previous) break;
  }
  return Math.min(1, Math.max(0, 0.5 + sum * Math.exp(-0.5 * square - 0.9189385332046727)));
}

/**
 * The Holm-Bonferroni step-down test. `pValues` in any order; `alpha` is the per-test level before correction. Sorted ascending, the i-th smallest (1-based, of m) is rejected when p <= alpha / (m - i + 1); the first one that is not
 * stops the walk. Returns one boolean per input, in the input's order. A p-value that is not a number in [0, 1] is never rejected.
 */
export function holmRejections(pValues: readonly number[], alpha: number): boolean[] {
  const order = pValues.map((p, index) => ({ p, index })).filter((entry) => Number.isFinite(entry.p) && entry.p >= 0 && entry.p <= 1).sort((left, right) => left.p - right.p || left.index - right.index);
  const rejected = pValues.map(() => false);
  const m = order.length;
  for (let rank = 0; rank < m; rank += 1) {
    const entry = order[rank] as { p: number; index: number };
    if (norm(entry.p) > norm(alpha / (m - rank))) break;
    rejected[entry.index] = true;
  }
  return rejected;
}

/** One question's runs on the old code and on the new code. */
export interface PairedQuestion {
  readonly id: string;
  readonly category: string;
  readonly baseRuns: readonly number[];
  readonly headRuns: readonly number[];
}
export interface PairedEffect {
  /** Questions behind the effect. */
  readonly n: number;
  /** Mean of the per-question differences (new minus old). */
  readonly effect: number;
  /** The standard error of the effect, from the old code's run-to-run variance. */
  readonly se: number;
  readonly baseMean: number;
  readonly headMean: number;
}
/** The mean, to 12 significant digits (0.1 three times is 0.1, not 0.10000000000000002). */
const mean = (values: readonly number[]): number => norm(values.reduce((sum, value) => sum + value, 0) / values.length);
/** Sample variance (n - 1), computed on values shifted by the first one, so equal runs have variance exactly 0. Needs at least two values. */
const sampleVariance = (values: readonly number[]): number => {
  const shift = values[0] as number;
  const shifted = values.map((value) => value - shift);
  const centre = shifted.reduce((sum, value) => sum + value, 0) / shifted.length;
  return shifted.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (values.length - 1);
};

/** The paired effect of a set of questions, or undefined when there are none or a question has fewer than two old runs (no noise estimate) or no new run. */
export function pairedEffect(questions: readonly PairedQuestion[], varianceFloor = 0): PairedEffect | undefined {
  if (questions.length === 0) return undefined;
  let diffSum = 0;
  let varianceSum = 0;
  let baseSum = 0;
  let headSum = 0;
  for (const question of questions) {
    if (question.baseRuns.length < 2 || question.headRuns.length < 1) return undefined;
    const baseMean = mean(question.baseRuns);
    const headMean = mean(question.headRuns);
    diffSum += headMean - baseMean;
    baseSum += baseMean;
    headSum += headMean;
    varianceSum += (sampleVariance(question.baseRuns) || varianceFloor) * (1 / question.baseRuns.length + 1 / question.headRuns.length);
  }
  const n = questions.length;
  return { n, effect: diffSum / n, se: Math.sqrt(varianceSum) / n, baseMean: baseSum / n, headMean: headSum / n };
}

/** Groups question results into one paired record per question id (base side and head side), in the order the ids first appear. A question missing on either side is left out and counted. */
export function pairQuestionRuns(base: readonly EvalQuestionResult[], head: readonly EvalQuestionResult[]): { paired: Array<{ id: string; category: string; baseRuns: number[]; headRuns: number[]; baseIndexes: number[]; headIndexes: number[] }>; unpaired: string[] } {
  const side = (rows: readonly EvalQuestionResult[]): Map<string, { category: string; rows: EvalQuestionResult[] }> => {
    const out = new Map<string, { category: string; rows: EvalQuestionResult[] }>();
    for (const row of rows) {
      const held = out.get(row.id);
      if (held === undefined) out.set(row.id, { category: row.category, rows: [row] });
      else held.rows.push(row);
    }
    return out;
  };
  const baseSide = side(base);
  const headSide = side(head);
  const paired: Array<{ id: string; category: string; baseRuns: number[]; headRuns: number[]; baseIndexes: number[]; headIndexes: number[] }> = [];
  const unpaired: string[] = [];
  for (const [id, held] of baseSide) {
    const other = headSide.get(id);
    if (other === undefined || other.category !== held.category) { unpaired.push(id); continue; }
    const baseRows = [...held.rows].sort((left, right) => left.run - right.run);
    const headRows = [...other.rows].sort((left, right) => left.run - right.run);
    paired.push({ id, category: held.category, baseRuns: baseRows.map((row) => row.score), headRuns: headRows.map((row) => row.score), baseIndexes: baseRows.map((row) => row.run), headIndexes: headRows.map((row) => row.run) });
  }
  for (const id of headSide.keys()) if (!baseSide.has(id)) unpaired.push(id);
  return { paired, unpaired };
}
