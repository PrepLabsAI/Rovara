// The strength of a lesson (lessons architecture research Q3, phase 1): a Beta score with a prior worth `priorWeightUses` uses centred on the project's own clean-merge rate, over the evidence of the last
// `evidenceWindowDays`. It replaces the Wilson lower bound (which is 0 for a lesson never loaded, so a new lesson looked like a failed one). Pure: the evidence is handed in, nothing is read here.
import { DEFAULT_RANKING, PRIOR_RATE_RANGE, type RankingSettings } from "./scoring-settings.js";

/** The weighed evidence for and against one lesson inside the window (a "for" is a share of one clean merge: 1/k; an "against" is a person's direct mark or a correction that came back with the lesson loaded). */
export interface LessonEvidence { forW: number; againstW: number }
export const NO_EVIDENCE: LessonEvidence = Object.freeze({ forW: 0, againstW: 0 });

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The project's clean-merge rate as the prior's centre: kept inside `PRIOR_RATE_RANGE`; a missing or unusable rate is the fallback. */
export function priorRateOf(rate: number | undefined | null, settings: Pick<RankingSettings, "priorRateFallback"> = DEFAULT_RANKING): number {
  const centre = rate === undefined || rate === null || !Number.isFinite(rate) ? settings.priorRateFallback : rate;
  return clamp(centre, PRIOR_RATE_RANGE.min, PRIOR_RATE_RANGE.max);
}

/** `(prior_for + for) / (prior_for + prior_against + for + against)`, 0 to 1. Negative or non-finite evidence counts as none. */
export function betaStrength(evidence: LessonEvidence, rate: number | undefined | null, settings: Pick<RankingSettings, "priorRateFallback" | "priorWeightUses"> = DEFAULT_RANKING): number {
  const centre = priorRateOf(rate, settings);
  const priorFor = centre * settings.priorWeightUses;
  const priorAgainst = (1 - centre) * settings.priorWeightUses;
  const forW = Number.isFinite(evidence.forW) && evidence.forW > 0 ? evidence.forW : 0;
  const againstW = Number.isFinite(evidence.againstW) && evidence.againstW > 0 ? evidence.againstW : 0;
  const total = priorFor + priorAgainst + forW + againstW;
  return total <= 0 ? centre : (priorFor + forW) / total;
}

/**
 * The evidence of a lesson when the project has no evidence rows for it yet (a lesson that lived before the rows existed): its own counters. A counter has no time of its own, so a "helpful" count stands whole unless the lesson's
 * last helpful time is known and outside the window (then it is old evidence and drops out); a "harmful" count stands whole (it is the retire rule's count and is never dropped by a clock). Once ANY evidence row exists for the lesson the
 * rows alone decide (never both: a mark made after the rows began is counted by its row and by the counter, so the counter is not added again).
 */
export function legacyEvidence(lesson: { counters: { helpful: number; harmful: number }; lastHelpfulAt?: number | undefined }, now: number, windowMs: number): LessonEvidence {
  const helpfulInWindow = lesson.lastHelpfulAt === undefined || now - lesson.lastHelpfulAt <= windowMs;
  return { forW: helpfulInWindow ? lesson.counters.helpful : 0, againstW: lesson.counters.harmful };
}
