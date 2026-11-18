// Lessons phases 1 and 2 (lessons architecture research, sections 3 Q1/Q3/Q4/Q5 and 8): EVERY number that decides which lessons load, how a lesson's evidence is weighed, how the weekly list is ordered and when a lesson fades
// lives here, as a named constant with its reason. They are the research's STARTING values. Phase 0 (`measure.ts`) records the numbers that replace them (the fit of loaded and left-out lessons, the clean-merge rate), so
// tuning later changes this file only, never a rule. A caller (a test, the replay harness) may hand the loader a `RankingSettings` with some of them changed (`resolveRanking`); a value that is not a usable number is ignored
// (the default stands), so a bad setting can never turn a guard off by accident.
//
// Nothing here calls a model or reads a store: it is numbers and their words.

const DAY = 86_400_000;

// ---- Phase 1: what loads ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The fit floor, on an ABSOLUTE number. Phase 0 (#960) found the loader's fused `fit` is a RANK score (1 is first in every list the query has, whatever the text), so a floor on it would pass the best of a bad lot. The two
 * absolute measures phase 0 records are used instead: `words` (the share of the shorter text's words the task and the lesson have in common, 0 to 1) and `cos` (the embedder's cosine, where the install has an embedder).
 * A lesson whose scope names a file the task touches always passes (its path matched: that is fit by construction); every other lesson must pass one of the two floors, or it is not loaded, so a step gets fewer than 5
 * when few fit.
 */
export const FIT_FLOOR_WORDS = 0.35;
/** The embedder's cosine a lesson needs, where there is an embedder. The small open embedder gives high cosines to unrelated text (the similarity gate uses 0.72 for "close in meaning"), so this is a different number from the words floor. */
export const FIT_FLOOR_COSINE = 0.72;

/** Weights of the step ranking (they are today's; the Wilson term is replaced by the Beta strength, the weights stay). Fit, strength, recency. */
export const RANK_WEIGHTS = { fit: 0.6, strength: 0.3, recency: 0.1 } as const;
/** Recency decays with this half-life-like constant (days): `exp(-age / RECENCY_DAYS)`. */
export const RECENCY_DAYS = 90;

/**
 * The strength of a lesson is `(prior_for + for) / (prior_for + prior_against + for + against)`, a Beta score. The prior is worth `PRIOR_WEIGHT_USES` uses and is centred on the project's own clean-merge rate, so a new lesson
 * starts as "average for this project", not as "failed" (the Wilson bound it replaces is 0 for a lesson never loaded). Only evidence of the last `EVIDENCE_WINDOW_DAYS` counts.
 */
export const PRIOR_WEIGHT_USES = 4;
export const EVIDENCE_WINDOW_DAYS = 180;
/** The prior's centre while the project has no merged task of its own in the clean-merge window: neutral, so no lesson is favoured before there is a number. */
export const PRIOR_RATE_FALLBACK = 0.5;
/** The prior's centre is kept inside this range, so one all-clean (or all-reverted) month can not make the prior itself decide a lesson's strength. */
export const PRIOR_RATE_RANGE = { min: 0.1, max: 0.9 } as const;
/** Merged tasks of this many days make the clean-merge rate; fewer than `CLEAN_MERGE_MIN_TASKS` of them and the fallback stands. */
export const CLEAN_MERGE_WINDOW_DAYS = 30;
export const CLEAN_MERGE_MIN_TASKS = 5;
/** How long a project's signals (its clean-merge rate, its lessons' evidence totals, its lessons under question) are reused by the loader before they are read again. A load never waits for them past `SIGNALS_WAIT_MS`: it uses the last answer or the defaults. */
export const SIGNALS_TTL_MS = 5 * 60_000;
export const SIGNALS_WAIT_MS = 600;
/** Most evidence rows one signals read looks at (newest first); a project with more is read from its newest rows (`truncated`). */
export const SIGNALS_ROWS_MAX = 4_000;

/** A lesson under question (a revert overlapped its area, its area is gone or rewritten) still loads, ranked lower by this much of its score, until a person settles it. */
export const UNDER_QUESTION_RANK_PENALTY = 0.25;

/**
 * The newcomer place: one of the step's places is kept for the best-fitting lesson with fewer than `NEWCOMER_MAX_USES` uses, when one passes the fit floor. No randomness (a person must be able to see why a lesson loaded,
 * and a replay must give the same loads). With a budget below `NEWCOMER_MIN_BUDGET` there is no reserved place (a step of one lesson keeps its best one).
 */
export const NEWCOMER_SLOTS = 1;
export const NEWCOMER_MAX_USES = 3;
export const NEWCOMER_MIN_BUDGET = 2;

// ---- Phase 1: the weekly list --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** New suggestions a week, and the need-a-look cards shown first (not counted in the 5). */
export const WEEKLY_PICKS = 5;
export const WEEKLY_NEED_LOOK_MAX = 3;
/** At most this many of the week's picks may come from one code area, and from one source. */
export const WEEKLY_MAX_PER_AREA = 2;
export const WEEKLY_MAX_PER_SOURCE = 2;
/** A source whose suggestions were kept less than this share of the time in the last `SOURCE_WINDOW_DAYS`, with at least `NOISY_MIN_DECIDED` decided, ranks one band lower. */
export const NOISY_KEPT_RATE = 0.3;
export const NOISY_MIN_DECIDED = 10;
export const SOURCE_WINDOW_DAYS = 30;
/** "Would have applied to N tasks in the last 30 days" looks at tasks of this many days. */
export const WOULD_HAVE_APPLIED_DAYS = 30;
/** A suggestion that waits at most this long (hours) before it lapses counts as "about to lapse" when less than this many hours are left. */
export const ABOUT_TO_LAPSE_HOURS = 48;

// ---- Phase 2: honest evidence --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** How long an evidence row (a "for", an "against", one task's repeat result) is read for and kept: the window plus a month of margin. */
export const EVIDENCE_KEEP_DAYS = EVIDENCE_WINDOW_DAYS + 30;
/**
 * Fade by chances, not calendar. A lesson that comes due when NO task was given it in the quiet window (no chance to help) and whose anchors still hold is renewed `FADE_QUIET_RENEWALS` time without asking; the next
 * quiet window puts it in the weekly review ("Not used in N months. Keep?") and it stays in use meanwhile. A lesson that had chances and never helped fades as it does today.
 */
export const FADE_QUIET_RENEWALS = 1;
/** A lesson a person was asked to keep stays in use this long (days) while the question waits in the weekly list; if nobody answers it fades as it would have. */
export const FADE_ASK_GRACE_DAYS = 30;
/** How long a fade row (renewals used, asked-at) is kept: longer than any expiry window a project may choose (365 days) plus the renewal. */
export const FADE_KEEP_DAYS = 800;

/** The nightly area checks (no model): "area rewritten" when more than this share of the lines of the files in a lesson's area changed since it was approved. */
export const AREA_REWRITTEN_SHARE = 0.5;
/** An area-check mark is rewritten each night while it holds, so it lapses on its own this many days after it stops holding. */
export const AREA_CHECK_KEEP_DAYS = 14;
/** Lessons and files one nightly area check looks at (bounds). */
export const AREA_CHECK_LESSONS_MAX = 200;

export interface RankingSettings {
  fitFloorWords: number; fitFloorCosine: number;
  weights: { fit: number; strength: number; recency: number };
  priorWeightUses: number; evidenceWindowDays: number; priorRateFallback: number;
  underQuestionPenalty: number;
  newcomerSlots: number; newcomerMaxUses: number; newcomerMinBudget: number;
}

export const DEFAULT_RANKING: RankingSettings = Object.freeze({
  fitFloorWords: FIT_FLOOR_WORDS, fitFloorCosine: FIT_FLOOR_COSINE, weights: RANK_WEIGHTS,
  priorWeightUses: PRIOR_WEIGHT_USES, evidenceWindowDays: EVIDENCE_WINDOW_DAYS, priorRateFallback: PRIOR_RATE_FALLBACK,
  underQuestionPenalty: UNDER_QUESTION_RANK_PENALTY,
  newcomerSlots: NEWCOMER_SLOTS, newcomerMaxUses: NEWCOMER_MAX_USES, newcomerMinBudget: NEWCOMER_MIN_BUDGET,
});

const unit = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback);
const positive = (value: unknown, fallback: number, max: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : fallback);
const whole = (value: unknown, fallback: number, max: number): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback);

/** The settings in force: the defaults with the usable parts of `override` on top. A value out of range or not a number is ignored. */
export function resolveRanking(override?: Partial<Omit<RankingSettings, "weights">> & { weights?: Partial<RankingSettings["weights"]> }): RankingSettings {
  if (override === undefined) return DEFAULT_RANKING;
  return {
    fitFloorWords: unit(override.fitFloorWords, DEFAULT_RANKING.fitFloorWords), fitFloorCosine: unit(override.fitFloorCosine, DEFAULT_RANKING.fitFloorCosine),
    weights: { fit: unit(override.weights?.fit, RANK_WEIGHTS.fit), strength: unit(override.weights?.strength, RANK_WEIGHTS.strength), recency: unit(override.weights?.recency, RANK_WEIGHTS.recency) },
    priorWeightUses: positive(override.priorWeightUses, PRIOR_WEIGHT_USES, 1_000), evidenceWindowDays: positive(override.evidenceWindowDays, EVIDENCE_WINDOW_DAYS, 3_650), priorRateFallback: unit(override.priorRateFallback, PRIOR_RATE_FALLBACK),
    underQuestionPenalty: unit(override.underQuestionPenalty, UNDER_QUESTION_RANK_PENALTY),
    newcomerSlots: whole(override.newcomerSlots, NEWCOMER_SLOTS, 5), newcomerMaxUses: whole(override.newcomerMaxUses, NEWCOMER_MAX_USES, 1_000), newcomerMinBudget: whole(override.newcomerMinBudget, NEWCOMER_MIN_BUDGET, 12),
  };
}

export const evidenceWindowMs = (settings: Pick<RankingSettings, "evidenceWindowDays"> = DEFAULT_RANKING): number => settings.evidenceWindowDays * DAY;
