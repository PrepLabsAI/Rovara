// The fit floor (lessons architecture research Q1, phase 1). Pure. A lesson is loaded for a step only when the task's own words or files fit it on an ABSOLUTE measure: a scope path the task touched, or the share of
// shared words (`words`), or the embedder's cosine (`cos`, where the install has an embedder). The fused rank score is never used here (it is relative: the best of a bad lot scores 1).
import { DEFAULT_RANKING, type RankingSettings } from "./scoring-settings.js";

export interface AbsoluteFit {
  /** The share of the shorter text's words the task and the lesson have in common, 0 to 1 (0 when the lesson was in none of the query's lists). */
  words: number;
  /** The embedder's cosine, when there was one and the lesson entered its list. */
  cos: number | undefined;
  /** A scope path of the lesson matched a file the task touches. */
  byPath: boolean;
}

/** Whether a lesson fits well enough to load: its path matched, or its words or its cosine passes the floor. Non-finite numbers never pass. */
export function passesFitFloor(fit: AbsoluteFit, settings: Pick<RankingSettings, "fitFloorWords" | "fitFloorCosine"> = DEFAULT_RANKING): boolean {
  if (fit.byPath) return true;
  if (Number.isFinite(fit.words) && fit.words >= settings.fitFloorWords) return true;
  return fit.cos !== undefined && Number.isFinite(fit.cos) && fit.cos >= settings.fitFloorCosine;
}

/** One number to order by among lessons that fit (the newcomer place picks "the best-fitting"): a path match first, then the larger of the words share and the cosine scaled to the cosine floor. */
export function fitOrder(fit: AbsoluteFit, settings: Pick<RankingSettings, "fitFloorWords" | "fitFloorCosine"> = DEFAULT_RANKING): number {
  const words = Number.isFinite(fit.words) ? fit.words : 0;
  const cosine = fit.cos !== undefined && Number.isFinite(fit.cos) && settings.fitFloorCosine > 0 ? (fit.cos / settings.fitFloorCosine) * settings.fitFloorWords : 0;
  return (fit.byPath ? 10 : 0) + Math.max(words, cosine);
}
