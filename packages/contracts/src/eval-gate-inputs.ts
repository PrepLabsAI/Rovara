// TE-F3-b (DECISIONS 170): what the gate is told BEFORE it looks at a score, and the rules each of those facts must meet. Pure: no clock (times are exact UTC text, compared as text), no randomness, no file, no network.
//   - the PLAN (minimum detectable drop, runs, seed, alpha, power, correction) is fixed and hashed before the task; the hash Rovara stored then must equal the plan's hash now, and the plan's time must be before the task's start;
//   - the GOAL for "Improved on eval" is taken from the task request and hashed before any code is written;
//   - the JUDGE (model, version, scoring prompt) is pinned before the task, and is from a different model family than the product and coding models, or was spot-checked against human labels. The pin has the SAME SHAPE as TE-F10's
//     `SideBySideJudgePin` (`pr/te-f10-side-by-side` @ 602d929cc, `side-by-side-judge-pin.ts`); F10 is not in this lane's base, so it is mirrored here and a DEFERRED row says to unify them;
//   - EDITS: whether the change edited eval questions, scoring or thresholds, from Rovara's own diff of the eval files (never from the runner);
//   - COVERAGE: which changed prompt or code items the eval exercised, from Rovara's own measurement;
//   - the BASELINE's age, model version and seed.
import { canonicalJson } from "./canonical-json.js";
import { EVAL_BASE_CACHE_TTL_DAYS } from "./eval-base-cache.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** Exact UTC text to the second: two such strings compare in time order as plain text. */
export const EVAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/u;
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const FAMILY = /^[a-z][a-z0-9_-]{0,39}$/u;
const SEED = /^[A-Za-z0-9._:-]{1,64}$/u;
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,39}$/u;

export const EVAL_GATE_ALPHA_DEFAULT = 0.05;
export const EVAL_GATE_POWER_DEFAULT = 0.8;
/** The old code must run at least twice for there to be run-to-run noise at all; once is "can't judge yet" (DECISIONS 171). */
export const EVAL_GATE_BASE_RUNS_MIN = 2;
/** A steady eval (the old code scored exactly the same every run, zero spread) is judged against the agreed minimum drop only when the old code ran at least this many times (DECISIONS 171). */
export const EVAL_STEADY_MIN_RUNS = 3;
export const EVAL_GATE_RUNS_MAX = 50;
/** A category whose name says safety or refusal is strict whatever the plan lists; the plan can add names, never remove one. */
export const EVAL_STRICT_CATEGORY_PATTERN = /safety|safe|refus|harm|toxic|jailbreak|injection|privacy|\bpii\b|polic|abuse|security|unsafe|guardrail/iu;

// ---- The plan ----
export interface EvalGatePlan {
  readonly version: 1;
  /** The smallest drop the eval must be able to detect, in score units (scores are 0 to 1). */
  readonly minDetectableDrop: number;
  /** Runs of the OLD code (the noise comes from these) and of the new code, fixed in advance. */
  readonly baseRuns: number;
  readonly headRuns: number;
  readonly seed: string;
  /** Two-sided level of the band (0.05 gives the 95% band). */
  readonly alpha: number;
  /** The chance the eval sees a drop of `minDetectableDrop` when it is there. */
  readonly power: number;
  readonly correction: "holm";
  /** Extra strict categories (safety, refusal); the name pattern adds more. */
  readonly strictCategories: readonly string[];
  /** When the plan was fixed, UTC. It must be BEFORE the task started. */
  readonly registeredAt: string;
}
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isUtc = (value: unknown): value is string => typeof value === "string" && EVAL_UTC.test(value);

/** The plan's SHA-256: the hash Rovara stores when it fixes the plan, and checks again when the gate runs. */
export function evalGatePlanHash(plan: EvalGatePlan): string {
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-gate-plan/v1\n${canonicalJson(plan)}`));
}
const planShapeOk = (plan: Partial<EvalGatePlan> | undefined): plan is EvalGatePlan =>
  plan !== undefined && plan.version === 1 && isNumber(plan.minDetectableDrop) && plan.minDetectableDrop > 0 && plan.minDetectableDrop <= 0.5
  && Number.isSafeInteger(plan.baseRuns) && (plan.baseRuns as number) >= 1 && (plan.baseRuns as number) <= EVAL_GATE_RUNS_MAX
  && Number.isSafeInteger(plan.headRuns) && (plan.headRuns as number) >= 1 && (plan.headRuns as number) <= EVAL_GATE_RUNS_MAX
  && typeof plan.seed === "string" && SEED.test(plan.seed) && isNumber(plan.alpha) && plan.alpha >= 0.001 && plan.alpha <= 0.1 && isNumber(plan.power) && plan.power >= 0.7 && plan.power <= 0.99
  && plan.correction === "holm" && Array.isArray(plan.strictCategories) && plan.strictCategories.length <= 50 && plan.strictCategories.every((name) => typeof name === "string" && CATEGORY.test(name)) && isUtc(plan.registeredAt);

/** Whether the plan was fixed in advance and can detect anything at all. Fixed text answers; nothing about the plan's values is echoed. */
export function checkEvalGatePlan(args: { readonly plan: EvalGatePlan | undefined; readonly recordedHash: string | undefined; readonly taskStartedAt: string }): { readonly ok: true } | { readonly ok: false; readonly detail: "plan_not_fixed" | "cannot_detect_drop" } {
  const { plan } = args;
  if (!planShapeOk(plan) || !isUtc(args.taskStartedAt)) return { ok: false, detail: "plan_not_fixed" };
  if (typeof args.recordedHash !== "string" || !SHA256.test(args.recordedHash) || args.recordedHash !== evalGatePlanHash(plan)) return { ok: false, detail: "plan_not_fixed" };
  if (!(plan.registeredAt < args.taskStartedAt)) return { ok: false, detail: "plan_not_fixed" };
  if (plan.baseRuns < EVAL_GATE_BASE_RUNS_MIN) return { ok: false, detail: "cannot_detect_drop" };
  return { ok: true };
}

// ---- The goal (Improved on eval) ----
export type EvalGoalMetric = { readonly kind: "overall" } | { readonly kind: "category"; readonly category: string };
export interface EvalGoal {
  readonly version: 1;
  /** The target metric, taken from the task request: the overall score, or one category's. */
  readonly metric: EvalGoalMetric;
  /** When the goal was written down, UTC. It must be BEFORE the first code was written. */
  readonly registeredAt: string;
}
export function evalGoalHash(goal: EvalGoal): string {
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-goal/v1\n${canonicalJson(goal)}`));
}
/** Whether a goal was named, unchanged, before any code was written. */
export function checkEvalGoal(args: { readonly goal: EvalGoal | undefined; readonly recordedHash: string | undefined; readonly firstCodeAt: string }): boolean {
  const goal = args.goal as Partial<EvalGoal> | undefined;
  if (goal === undefined || goal.version !== 1 || !isUtc(goal.registeredAt) || !isUtc(args.firstCodeAt)) return false;
  const metric = goal.metric as Partial<{ kind: string; category: string }> | undefined;
  if (metric === undefined || (metric.kind !== "overall" && !(metric.kind === "category" && typeof metric.category === "string" && CATEGORY.test(metric.category)))) return false;
  if (typeof args.recordedHash !== "string" || !SHA256.test(args.recordedHash) || args.recordedHash !== evalGoalHash(goal as EvalGoal)) return false;
  return goal.registeredAt < args.firstCodeAt;
}

// ---- The judge ----
/** The same shape as TE-F10's `SideBySideJudgePin`. */
export interface EvalJudgePin {
  readonly model: string;
  readonly version: string;
  readonly family: string;
  readonly scoringPromptSha256: string;
  readonly pinnedAt: string;
}
export interface EvalHumanCheck {
  readonly labelSetId: string;
  readonly agreement: number;
  readonly sampleSize: number;
  readonly checkedAt: string;
}
export const EVAL_SPOT_CHECK_MIN_AGREEMENT = 0.8;
export const EVAL_SPOT_CHECK_MIN_SAMPLES = 20;
/** `none`: the eval is scored by code, not by a model (its scoring predates the task like the questions). */
export type EvalJudgeInput =
  | { readonly kind: "none" }
  | {
    readonly kind: "model";
    readonly pin: EvalJudgePin;
    /** The SHA-256 of the scoring prompt the eval's own files hold at the base commit: the pin must name exactly it. */
    readonly expectedScoringPromptSha256: string;
    readonly productModelFamily: string;
    readonly codingModelFamily?: string | undefined;
    readonly humanCheck?: EvalHumanCheck | undefined;
  };
const familyOf = (value: unknown): string | undefined => (typeof value === "string" && FAMILY.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined);

/** Whether the judge may be used: pinned before the task, the scoring prompt the eval holds, and from another family (or spot-checked). */
export function checkEvalJudge(judge: EvalJudgeInput | undefined, taskStartedAt: string): boolean {
  if (judge === undefined) return false;
  if (judge.kind === "none") return true;
  if (judge.kind !== "model") return false;
  const pin = judge.pin as Partial<EvalJudgePin> | undefined;
  const judgeFamily = familyOf(pin?.family);
  if (
    pin === undefined || typeof pin.model !== "string" || !NAME.test(pin.model) || typeof pin.version !== "string" || !NAME.test(pin.version) || judgeFamily === undefined
    || typeof pin.scoringPromptSha256 !== "string" || !SHA256.test(pin.scoringPromptSha256) || pin.scoringPromptSha256 !== judge.expectedScoringPromptSha256 || !isUtc(pin.pinnedAt) || !isUtc(taskStartedAt)
  ) return false;
  if (!(pin.pinnedAt < taskStartedAt)) return false;
  const productFamily = familyOf(judge.productModelFamily);
  const codingFamily = judge.codingModelFamily === undefined ? undefined : familyOf(judge.codingModelFamily);
  if (productFamily !== undefined && productFamily !== judgeFamily && (judge.codingModelFamily === undefined || (codingFamily !== undefined && codingFamily !== judgeFamily))) return true;
  const check = judge.humanCheck;
  return check !== undefined && typeof check.labelSetId === "string" && NAME.test(check.labelSetId) && isUtc(check.checkedAt) && check.checkedAt < taskStartedAt
    && isNumber(check.agreement) && check.agreement >= EVAL_SPOT_CHECK_MIN_AGREEMENT && check.agreement <= 1 && Number.isSafeInteger(check.sampleSize) && check.sampleSize >= EVAL_SPOT_CHECK_MIN_SAMPLES;
}

// ---- Edits, coverage, baseline ----
/** What the change did to the eval's own files, from Rovara's diff. `unknown` fails closed. */
export type EvalEdits =
  | { readonly status: "known"; readonly editedQuestionIds: readonly string[]; readonly scoringEdited: boolean; readonly thresholdsEdited: boolean }
  | { readonly status: "unknown" };
/** The fewest questions that must exercise a changed item for it to count as evaluated. */
export const EVAL_COVERAGE_MIN_QUESTIONS = 3;
/** The changed prompt or code items (counted, never printed) and how many untouched questions exercised each; from Rovara's own measurement, never the runner's word. */
export interface EvalCoverage {
  readonly changedItems: readonly string[];
  readonly exercised: ReadonlyArray<{ readonly item: string; readonly questions: number }>;
}
export function evalCoverageCount(coverage: EvalCoverage | undefined): { readonly changed: number; readonly evaluated: number } {
  if (coverage === undefined || !Array.isArray(coverage.changedItems) || !Array.isArray(coverage.exercised)) return { changed: 0, evaluated: 0 };
  const changed = new Set(coverage.changedItems.filter((item): item is string => typeof item === "string" && item !== ""));
  let evaluated = 0;
  for (const item of changed) {
    const best = coverage.exercised.reduce((most, row) => (row.item === item && Number.isSafeInteger(row.questions) && row.questions > most ? row.questions : most), 0);
    if (best >= EVAL_COVERAGE_MIN_QUESTIONS) evaluated += 1;
  }
  return { changed: changed.size, evaluated };
}

export interface EvalBaselineFacts {
  /** The EXACT model version the cached (or fresh) base scores were measured with, and the one the new code is run with now. */
  readonly modelVersionAtBase: string;
  readonly modelVersionNow: string;
  /** The day the base scores were measured and today, `YYYY-MM-DD`. */
  readonly recordedOn: string;
  readonly today: string;
  /** The longest a baseline is used (default and ceiling: 30 days). */
  readonly maxAgeDays?: number;
}
const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
/** Whether a baseline may be used: the exact same model version, not older than the maximum age, and not from the future. */
export function checkEvalBaseline(facts: EvalBaselineFacts | undefined): boolean {
  if (facts === undefined || typeof facts.modelVersionAtBase !== "string" || facts.modelVersionAtBase === "" || facts.modelVersionAtBase !== facts.modelVersionNow) return false;
  if (typeof facts.recordedOn !== "string" || !DAY.test(facts.recordedOn) || typeof facts.today !== "string" || !DAY.test(facts.today)) return false;
  const requested = facts.maxAgeDays;
  const maxAge = Number.isSafeInteger(requested) && (requested as number) >= 1 ? Math.min(EVAL_BASE_CACHE_TTL_DAYS, requested as number) : EVAL_BASE_CACHE_TTL_DAYS;
  const age = dayNumber(facts.today) - dayNumber(facts.recordedOn);
  return Number.isFinite(age) && age >= 0 && age <= maxAge;
}

/** Whether a name is a strict (safety or refusal) category under the plan. */
export function isStrictCategory(name: string, plan: Pick<EvalGatePlan, "strictCategories">): boolean {
  return EVAL_STRICT_CATEGORY_PATTERN.test(name) || plan.strictCategories.some((listed) => listed.toLowerCase() === name.toLowerCase());
}
