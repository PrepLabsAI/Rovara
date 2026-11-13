// TE-F3-b: the statistics behind the DECISIONS 170 gate. Pure, no randomness, no clock. Normal approximation throughout (the sums are over many questions); every choice is stated here so a reviewer can check it.
//
//   - PAIRED: the same questions are scored on the old code and the new code, so the question's difficulty cancels. For question q the difference is d_q = mean(new runs) - mean(old runs). The effect is the mean of d_q over the questions.
//   - NOISE: from REPEATED OLD-CODE RUNS only. Question q's run-to-run variance s2_q comes from the old code's runs (n-1 denominator). The standard error of the effect is
//       SE = sqrt( sum_q s2_q x (1/oldRuns + 1/newRuns) ) / n.
//     The spread BETWEEN questions never enters it (that is what pairing removes).
//   - BAND: +/- k x SE with k = 2 (DECISIONS 171: "2x the run-to-run spread, from repeated OLD-code runs only"). A change is "beyond the band" only when it is strictly outside it.
//   - STEADY: when the old code scored exactly the same on every run (zero spread) and ran at least 3 times, there is no band: the effect is judged against the agreed minimum drop (a drop of at least that is worse). With fewer runs there is no noise estimate.
//   - DETECTABLE: the smallest drop the eval could see with the planned power is (k + z(power)) x SE. If that is more than the agreed minimum drop, the eval cannot detect the agreed drop.
//   - CATEGORIES: each ordinary category gets a one-sided test for a drop (tail alpha/2), and the Holm-Bonferroni step-down correction decides which of them are clear drops. Strict (safety and refusal)
//     categories are not corrected: any drop beyond their own uncorrected band is clear.
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
  return Math.min(1, Math.max(0, 0.5 + sum * Math.exp(-0.5 * square - 0.918938533204672741780329736406)));
}

const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00] as const;
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01] as const;
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00] as const;
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00] as const;

/** The standard normal quantile (Acklam's rational approximation plus one Halley step). NaN outside (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  const error = normalCdf(x) - p;
  const u = error * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
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
export function pairedEffect(questions: readonly PairedQuestion[]): PairedEffect | undefined {
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
    varianceSum += sampleVariance(question.baseRuns) * (1 / question.baseRuns.length + 1 / question.headRuns.length);
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
