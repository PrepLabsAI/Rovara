// Spec 052: statistics over a batch's finished runs.
import type { EvalBatchModelSummary, EvalRunMeasure } from "./eval-batch.js";

/** The Wilson score interval for `successes` of `n` trials; `[0, 1]` when there were no trials. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** Per model (and thinking level): graded runs, resolved, rate over graded runs with its Wilson interval, and every row's charge. */
export function summarize(measures: readonly EvalRunMeasure[]): EvalBatchModelSummary[] {
  const groups = new Map<string, EvalRunMeasure[]>();
  for (const measure of measures) {
    const key = JSON.stringify([measure.provider, measure.modelId, measure.thinkingLevel ?? null, measure.routing?.only ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), measure]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as EvalRunMeasure;
    const graded = group.filter((measure) => measure.outcome === "GRADED");
    const resolved = graded.filter((measure) => measure.resolved).length;
    const totalCostUsd = group.reduce((sum, measure) => sum + measure.chargedUsd, 0);
    const interval = wilsonInterval(resolved, graded.length);
    return {
      provider: first.provider,
      modelId: first.modelId,
      ...(first.thinkingLevel === undefined ? {} : { thinkingLevel: first.thinkingLevel }),
      ...(first.routing === undefined ? {} : { routing: first.routing }),
      runs: graded.length,
      failed: group.filter((measure) => measure.outcome === "FAILED").length,
      cancelled: group.filter((measure) => measure.outcome === "CANCELLED").length,
      retried: group.filter((measure) => measure.outcome === "RETRIED").length,
      resolved,
      rate: graded.length === 0 ? null : resolved / graded.length,
      wilsonLow: graded.length === 0 ? null : interval.low,
      wilsonHigh: graded.length === 0 ? null : interval.high,
      totalCostUsd,
      unpricedRuns: group.filter((measure) => measure.costUsd === null).length,
      costPerSolvedUsd: resolved === 0 ? null : totalCostUsd / resolved,
    };
  });
}
