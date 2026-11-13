// TE-F3-b test world: a deterministic eval with known noise, built so every number in a test can be worked out by hand.
//   - 4 categories of 10 questions: billing, search, tone and one strict category (safety-refusals); question means spread over 0.3 to 0.7;
//   - old-code runs (5) follow the pattern [+1, -1, +1, -1, 0] x noise (sample variance noise^2); new-code runs (3) follow [+1, -1, 0] x noise;
//   - with noise 0.05 and 40 questions the overall SE is 0.05 x sqrt((1/5 + 1/3) / 40) = 0.005774, so the band (2 x SE) is +/-0.011547 and the smallest detectable drop is 0.016397 ((2 + 0.84) x SE); a 10-question category has SE 0.011547.
import { evalGatePlanHash, evalGoalHash, type EvalGatePlan, type EvalGoal } from "../../packages/contracts/src/eval-gate-inputs.js";
import type { EvalGateInput, EvalGateSetData } from "../../packages/contracts/src/eval-gate.js";
import type { EvalQuestionResult } from "../../packages/contracts/src/measures-file.js";
import { evalFactsAllRun } from "../../packages/contracts/src/eval-pacing.js";

export const TASK_STARTED = "2026-11-13T10:00:00Z";
export const FIRST_CODE = "2026-11-13T10:05:00Z";
export const BEFORE_TASK = "2026-11-12T10:00:00Z";
export const CATEGORIES = ["billing", "search", "tone", "safety-refusals"] as const;
export const SEED = "seed-1";
export const PLAN: EvalGatePlan = { version: 1, minDetectableDrop: 0.05, baseRuns: 5, headRuns: 3, seed: SEED, strictCategories: [], registeredAt: BEFORE_TASK };
export const GOAL: EvalGoal = { version: 1, metric: { kind: "overall" }, registeredAt: "2026-11-13T10:02:00Z" };

const BASE_PATTERN = [1, -1, 1, -1, 0];
const HEAD_PATTERN = [1, -1, 0];
export interface SetOptions {
  readonly categories?: readonly string[];
  readonly perCategory?: number;
  readonly noise?: number;
  /** The change in a question's mean score, by category and index within it. */
  readonly delta?: (category: string, index: number) => number;
  readonly headNoise?: number;
  readonly prefix?: string;
  readonly committedAt?: string;
  readonly independent?: readonly string[];
  readonly baseRuns?: number;
  readonly headRuns?: number;
  readonly seed?: string;
  readonly baseSeed?: string;
}
const clamp = (value: number): number => Math.min(1, Math.max(0, Number(value.toFixed(9))));
export function questionSet(options: SetOptions = {}): EvalGateSetData {
  const categories = options.categories ?? CATEGORIES;
  const perCategory = options.perCategory ?? 10;
  const noise = options.noise ?? 0.05;
  const headNoise = options.headNoise ?? noise;
  const baseRuns = options.baseRuns ?? 5;
  const headRuns = options.headRuns ?? 3;
  const base: EvalQuestionResult[] = [];
  const head: EvalQuestionResult[] = [];
  categories.forEach((category, c) => {
    for (let index = 0; index < perCategory; index += 1) {
      const id = `${options.prefix ?? "q"}-${String(c)}-${String(index)}`;
      const mean = 0.5 + ((index % 5) - 2) * 0.1;
      const moved = mean + (options.delta?.(category, index) ?? 0);
      for (let run = 0; run < baseRuns; run += 1) base.push({ id, category, run, score: clamp(mean + noise * (BASE_PATTERN[run % 5] as number)) });
      for (let run = 0; run < headRuns; run += 1) head.push({ id, category, run, score: clamp(moved + headNoise * (HEAD_PATTERN[run % 3] as number)) });
    }
  });
  return { base, head, baseSeed: options.baseSeed ?? options.seed ?? SEED, headSeed: options.seed ?? SEED, setCommittedAt: options.committedAt ?? BEFORE_TASK, ...(options.independent === undefined ? {} : { independentQuestionIds: options.independent }) };
}

export function gateInput(over: Partial<EvalGateInput> & { visibleOptions?: SetOptions; holdoutOptions?: SetOptions } = {}): EvalGateInput {
  const { visibleOptions, holdoutOptions, ...rest } = over;
  return {
    plan: PLAN, recordedPlanHash: evalGatePlanHash(PLAN), times: { taskStartedAt: TASK_STARTED, firstCodeAt: FIRST_CODE },
    judge: { kind: "none" },
    visible: questionSet(visibleOptions), holdout: questionSet({ prefix: "h", ...holdoutOptions }),
    edits: { status: "known", editedQuestionIds: [], scoringEdited: false, thresholdsEdited: false },
    coverage: { changedItems: ["prompt:system", "code:parse"], exercised: [{ item: "prompt:system", questions: 12 }, { item: "code:parse", questions: 1 }] },
    baseline: { modelVersionAtBase: "gemini-small-2026-10-01", modelVersionNow: "gemini-small-2026-10-01", recordedOn: "2026-11-10", today: "2026-11-13" },
    facts: evalFactsAllRun(320),
    ...rest,
  };
}
export const withGoal = (goal: EvalGoal = GOAL): Pick<EvalGateInput, "goal"> => ({ goal: { goal, recordedHash: evalGoalHash(goal) } });
