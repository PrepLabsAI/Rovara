import type { CaseResult, EvalReport } from "./runner.js";

export interface PresentationScore { passed: number; toolAccuracy: number; refusalCases: number; refusalAccuracy: number }

export interface Sc004Result {
  model: string;
  /** Cases both presentations can express; the scores below cover only these. */
  cases: number;
  /** Cases the legacy presentation cannot express, left out of both scores. */
  notApplicable: string[];
  new: PresentationScore;
  legacy: PresentationScore;
  /** SC-004: the new tool accuracy is higher, and the new refusal accuracy is at least 90%. */
  met: boolean;
}

function score(results: readonly CaseResult[]): PresentationScore {
  const refusals = results.filter((result) => result.runs.some((run) => run.refusalOk !== null));
  const refused = refusals.filter((result) => result.runs.every((run) => run.toolOk && run.refusalOk === true)).length;
  return {
    passed: results.filter((result) => result.passed).length,
    toolAccuracy: results.length === 0 ? 0 : results.filter((result) => result.runs.every((run) => run.toolOk)).length / results.length,
    refusalCases: refusals.length,
    refusalAccuracy: refusals.length === 0 ? 1 : refused / refusals.length,
  };
}

/**
 * SC-004 from the two live reports of one model. It compares the presentations only on the cases
 * both can express: a case the legacy presentation reported as not applicable is left out of both
 * scores. Any other difference in the case sets, and any errored or stopped run, is an error.
 */
export function compareSc004(fresh: EvalReport, legacy: EvalReport): Sc004Result {
  if (fresh.presentation !== "new" || legacy.presentation !== "legacy") {
    throw new Error("compareSc004 takes the new presentation first and the legacy presentation second");
  }
  if (fresh.provider !== legacy.provider || fresh.model !== legacy.model || fresh.repeat !== legacy.repeat) {
    throw new Error(`the two reports must be for the same provider, model and repeat (new: ${fresh.provider}/${fresh.model} x${fresh.repeat}; legacy: ${legacy.provider}/${legacy.model} x${legacy.repeat})`);
  }
  for (const report of [fresh, legacy]) {
    if (report.summary.errors > 0 || report.stopped !== undefined) throw new Error(`the ${report.presentation} report has errors or stopped early; SC-004 needs two clean runs`);
  }
  const notApplicable = (legacy.notApplicable ?? []).map((entry) => entry.id);
  const legacyIds = new Set(legacy.cases.map((result) => result.id));
  const freshIds = new Set(fresh.cases.map((result) => result.id));
  const unmatched = [
    ...[...freshIds].filter((id) => !legacyIds.has(id) && !notApplicable.includes(id)),
    ...[...legacyIds].filter((id) => !freshIds.has(id)),
    ...notApplicable.filter((id) => !freshIds.has(id)),
  ];
  if (unmatched.length > 0) throw new Error(`the two reports cover different cases: ${unmatched.join(", ")}`);
  const shared = fresh.cases.filter((result) => legacyIds.has(result.id));
  const newScore = score(shared);
  const legacyScore = score(legacy.cases);
  return {
    model: fresh.model,
    cases: shared.length,
    notApplicable,
    new: newScore,
    legacy: legacyScore,
    met: newScore.refusalCases > 0 && newScore.toolAccuracy > legacyScore.toolAccuracy && newScore.refusalAccuracy >= 0.9,
  };
}
