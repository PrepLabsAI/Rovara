// Lessons tuning report (lane L4-WK): the phase 0 numbers (`measure.ts`) turned into SUGGESTED starting values for the settings that phases 1 and 2 introduce (`scoring-settings.ts` of lane L4-LP12), so the values can
// be set from the pilot's own data without a rebuild. READ ONLY and counts only: nothing here writes a row, changes a setting or loads a lesson differently. An operator or admin reads the suggestion and applies a value
// in the ranking settings themselves; the next load uses it. Until there is enough data the report says so ("not enough data yet (N of M loads)") and suggests nothing.
//
// What it reads: the same two row families phase 0 writes, of ONE project of ONE company (`LESSON_FIT#<project>` per-load rows, `LESSON_MERGE#<project>` merged and reverted task rows), through the same keys,
// the same freshness rule (`keepUntil`, the window) and bounds (one total row limit, one deadline). Ids and numbers only: the answer carries no lesson id, task id, title, path, person or text.
//
// The suggestions, each with the number of rows it rests on (`evidence.have` of `evidence.needed`):
//   fitFloorWords    the share of words a loaded lesson must have in common with the task: the 20th percentile of the words overlap of the loaded lessons that matched on words at all, so the floor would have cut the
//                    weakest fifth of what loads now; kept inside 0.20 to 0.50.
//   fitFloorCosine   the same for the embedder's cosine, where the install has an embedder; kept inside 0.50 to 0.90.
//   priorWeightUses  how many uses the Beta prior is worth: the median number of loads a lesson got in the window (one window of use then roughly balances the prior), kept inside 2 to 12; needs the project's
//                    clean-merge rate too (at least `TUNING_MIN_MERGED` merged tasks), the prior's centre.
//   stepLessonCap    the lessons a step loads: raised by one (to at most 8; a budget already at or above 8 is kept) only when the cap bound in at least a quarter of the loads made with the current budget (the step
//                    was full and a lesson that passes the CURRENT floors was left out).
//   weeklyPicks      the weekly cap on new suggestions: no value is suggested, because no measured row records how many of a week's suggestions people decide. It is listed so the report names every setting.
// The clean-merge rows also give the evidence block: how the loads of tasks that merged clean compare with those of tasks that were reverted (shown only with at least `OUTCOME_MIN_TASKS` tasks each side; it is
// information, not an input to any suggestion).
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { MEASURE_DEADLINE_MS, MEASURE_ROWS_MAX, MEASURE_WINDOW_DAYS, MEASURE_WINDOW_DAYS_MAX, fitPk, mergePk, samplesFrom, type FitSample } from "./measure.js";

const DAY = 86_400_000;
/** Loads the report needs before it suggests anything. */
export const TUNING_MIN_LOADS = 20;
/** Loaded lessons that matched on words (or on meaning, for the cosine) a floor suggestion rests on. */
export const TUNING_MIN_SAMPLES = 30;
/** Distinct lessons the prior suggestion rests on, and the merged tasks that give the prior its centre (the same rule as the loader's: fewer and the neutral fallback stands). */
export const TUNING_MIN_LESSONS = 10;
export const TUNING_MIN_MERGED = 5;
/** Tasks each side an outcome comparison needs before it is shown. */
export const OUTCOME_MIN_TASKS = 3;
/** The share of loads in which the step cap bound that asks for one more place. */
export const CAP_BOUND_SHARE = 0.25;
export const STEP_CAP_CEILING = 8;
const FLOOR_PERCENTILE = 0.2;
const WORDS_RANGE = { min: 0.2, max: 0.5 } as const;
const COSINE_RANGE = { min: 0.5, max: 0.9 } as const;
const PRIOR_RANGE = { min: 2, max: 12 } as const;

/**
 * The values in force today, by the names of lane L4-LP12's settings (`RankingSettings`: fitFloorWords, fitFloorCosine, priorWeightUses; `WEEKLY_PICKS`; the step budget is the project's own load budget).
 * These are the research's starting values. A caller that has the live ones (the settings module once it is merged, or an operator's override) passes them and the report compares against those.
 */
export interface TuningCurrent { fitFloorWords: number; fitFloorCosine: number; priorWeightUses: number; stepLessonCap: number; weeklyPicks: number }
export const TUNING_STARTING_VALUES: Readonly<TuningCurrent> = Object.freeze({ fitFloorWords: 0.35, fitFloorCosine: 0.72, priorWeightUses: 4, stepLessonCap: 5, weeklyPicks: 5 });

export type TuningSetting = keyof TuningCurrent;
export interface TuningSuggestion {
  setting: TuningSetting;
  /** `suggested`: a different value is suggested; `keep`: the data says the current value stands; `not_enough_data`: nothing is suggested yet; `no_data_source`: nothing measured can inform it. */
  status: "suggested" | "keep" | "not_enough_data" | "no_data_source";
  current: number;
  suggested: number | null;
  evidence: { have: number; needed: number; unit: string };
  message: string;
}
export interface TuningReport {
  project: string;
  windowDays: number;
  /** Whether there are enough loads for the report to suggest anything. */
  ready: boolean;
  message: string;
  evidence: {
    loads: number; loadedLessons: number; lessonsLoaded: number; mergedTasks: number; revertedTasks: number; cleanMergeRate: number | null;
    /** Mean words overlap of the lessons loaded in tasks that merged clean, and in tasks that were reverted; null with fewer than `OUTCOME_MIN_TASKS` tasks on that side. */
    meanWordsCleanTasks: number | null; meanWordsRevertedTasks: number | null;
    truncated: boolean; unreadable: number;
  };
  suggestions: TuningSuggestion[];
  /** Always the same fixed words: the report changes nothing. */
  note: string;
}

export const TUNING_NOTE = "These are suggestions only. Nothing changes until an operator or admin applies a value in the lessons ranking settings.";

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const usable = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const roundTo = (value: number, step: number): number => Math.round(Math.round(value / step) * step * 1e6) / 1e6;
/** Nearest-rank percentile of a list (0 to 1); undefined for an empty list. */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1)];
}
const mean3 = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 1000) / 1000);

interface LoadRow { taskId: string; budget: number; loaded: FitSample[]; leftOut: FitSample[] }

/**
 * The report for one project of one company. Bounded like the measure read (one total row limit across both families, one deadline); a cut input sets `truncated` and the report is for what was read. A project
 * with no rows gets the "not enough data" report.
 */
export async function readTuningReport(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; now: number; windowDays?: number; current?: Partial<TuningCurrent>; limits?: { rowsTotal?: number; deadlineMs?: number } }): Promise<TuningReport> {
  const windowDays = Math.min(MEASURE_WINDOW_DAYS_MAX, Math.max(1, Math.floor(input.windowDays ?? MEASURE_WINDOW_DAYS)));
  const since = input.now - windowDays * DAY;
  const rowsTotal = input.limits?.rowsTotal ?? MEASURE_ROWS_MAX;
  const deadlineAt = Date.now() + (input.limits?.deadlineMs ?? MEASURE_DEADLINE_MS);
  const current: TuningCurrent = {
    fitFloorWords: usable(input.current?.fitFloorWords, TUNING_STARTING_VALUES.fitFloorWords), fitFloorCosine: usable(input.current?.fitFloorCosine, TUNING_STARTING_VALUES.fitFloorCosine),
    priorWeightUses: usable(input.current?.priorWeightUses, TUNING_STARTING_VALUES.priorWeightUses), stepLessonCap: usable(input.current?.stepLessonCap, TUNING_STARTING_VALUES.stepLessonCap),
    weeklyPicks: usable(input.current?.weeklyPicks, TUNING_STARTING_VALUES.weeklyPicks),
  };
  let read = 0;
  let truncated = false;
  let unreadable = 0;

  type Page = Awaited<ReturnType<typeof store.query>>;
  type Paging = { descending: true; limit: number; cursor?: string };
  async function rowsOf(pk: string, ask: (paging: Paging) => Promise<Page>, fresh: (row: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let pages = 0; pages <= Math.ceil(rowsTotal / 200) + 1; pages += 1) {
      const take = Math.min(200, rowsTotal - read);
      if (take <= 0 || Date.now() >= deadlineAt) { truncated = true; return out; }
      read += take;
      let page: Page | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        page = await Promise.race([ask({ descending: true, limit: take, ...(cursor === undefined ? {} : { cursor }) }), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - Date.now())); timer.unref?.(); })]);
      } catch { page = undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
      if (page === undefined) { truncated = true; return out; }
      read -= take - Math.min(take, page.items.length);
      for (const row of page.items.slice(0, take)) {
        if (row.pk !== pk) continue;
        if (fresh(row)) out.push(row);
      }
      cursor = page.cursor;
      if (cursor === undefined) return out;
    }
    truncated = true;
    return out;
  }
  const live = (row: Record<string, unknown>): boolean => { const expires = numberOf(row["keepUntil"]); return expires !== undefined && expires > input.now; };

  const fitRows = await rowsOf(fitPk(input.companyId, input.project), (paging) => store.query({ pk: fitPk(input.companyId, input.project), ...paging }), (row) => {
    if (row["entityType"] !== "LESSON_FIT" || row["project"] !== input.project) { unreadable += 1; return false; }
    const at = numberOf(row["at"]);
    return live(row) && at !== undefined && at >= since;
  });
  const loads: LoadRow[] = [];
  for (const row of fitRows) {
    const loaded = samplesFrom(row["loaded"]);
    const leftOut = samplesFrom(row["leftOut"]);
    const budget = numberOf(row["budgetLessons"]);
    const taskId = row["taskId"];
    if (loaded === undefined || leftOut === undefined || budget === undefined || typeof taskId !== "string" || taskId === "") { unreadable += 1; continue; }
    loads.push({ taskId, budget, loaded, leftOut });
  }
  const mergeRows = await rowsOf(mergePk(input.companyId, input.project), (paging) => store.query({ pk: mergePk(input.companyId, input.project), ...paging }), (row) => {
    if (row["entityType"] !== "LESSON_MERGE" || row["project"] !== input.project || (row["kind"] !== "merged" && row["kind"] !== "reverted") || typeof row["taskId"] !== "string") { unreadable += 1; return false; }
    return live(row) && numberOf(row["at"]) !== undefined;
  });
  const reverted = new Set(mergeRows.filter((row) => row["kind"] === "reverted").map((row) => row["taskId"] as string));
  const merged = new Set(mergeRows.filter((row) => row["kind"] === "merged" && (row["at"] as number) >= since).map((row) => row["taskId"] as string));
  const revertedOfMerged = [...merged].filter((taskId) => reverted.has(taskId)).length;
  const cleanRate = merged.size === 0 ? null : Math.round(((merged.size - revertedOfMerged) / merged.size) * 1000) / 1000;

  // The loaded lessons' numbers.
  const loadedAll = loads.flatMap((one) => one.loaded);
  const words = loadedAll.filter((sample) => sample.words > 0).map((sample) => sample.words);
  const cosines = loadedAll.flatMap((sample) => (sample.cos === null ? [] : [sample.cos]));
  const perLesson = new Map<string, number>();
  for (const sample of loadedAll) perLesson.set(sample.id, (perLesson.get(sample.id) ?? 0) + 1);

  // How the loads of clean-merged and reverted tasks compare (information only).
  const wordsOf = (taskIds: ReadonlySet<string>): { tasks: number; mean: number | null } => {
    const mine = loads.filter((one) => taskIds.has(one.taskId));
    return { tasks: new Set(mine.map((one) => one.taskId)).size, mean: mean3(mine.flatMap((one) => one.loaded.filter((sample) => sample.words > 0).map((sample) => sample.words))) };
  };
  const clean = wordsOf(new Set([...merged].filter((taskId) => !reverted.has(taskId))));
  const bad = wordsOf(new Set([...merged].filter((taskId) => reverted.has(taskId))));

  const ready = loads.length >= TUNING_MIN_LOADS;
  const notEnough = (setting: TuningSetting, have: number, needed: number, unit: string): TuningSuggestion => ({
    setting, status: "not_enough_data", current: current[setting], suggested: null, evidence: { have, needed, unit }, message: `not enough data yet (${String(have)} of ${String(needed)} ${unit})`,
  });
  const decide = (setting: TuningSetting, now: number, suggested: number, evidence: TuningSuggestion["evidence"], why: string): TuningSuggestion => {
    const same = Math.abs(suggested - now) < 1e-9;
    return { setting, status: same ? "keep" : "suggested", current: now, suggested, evidence, message: same ? `keep ${String(now)}: ${why}` : `suggest ${String(suggested)} (now ${String(now)}): ${why}` };
  };

  const suggestions: TuningSuggestion[] = [];
  if (!ready) {
    for (const setting of ["fitFloorWords", "fitFloorCosine", "priorWeightUses", "stepLessonCap"] as const) suggestions.push(notEnough(setting, loads.length, TUNING_MIN_LOADS, "loads"));
  } else {
    // The floors.
    const wordsP = percentile(words, FLOOR_PERCENTILE);
    suggestions.push(words.length < TUNING_MIN_SAMPLES || wordsP === undefined
      ? notEnough("fitFloorWords", words.length, TUNING_MIN_SAMPLES, "loaded lessons that matched on words")
      : decide("fitFloorWords", current.fitFloorWords, roundTo(clamp(wordsP, WORDS_RANGE.min, WORDS_RANGE.max), 0.05), { have: words.length, needed: TUNING_MIN_SAMPLES, unit: "loaded lessons that matched on words" }, "it would have cut the weakest fifth of the lessons that loaded"));
    const cosineP = percentile(cosines, FLOOR_PERCENTILE);
    suggestions.push(cosines.length < TUNING_MIN_SAMPLES || cosineP === undefined
      ? notEnough("fitFloorCosine", cosines.length, TUNING_MIN_SAMPLES, "loaded lessons with a meaning score")
      : decide("fitFloorCosine", current.fitFloorCosine, roundTo(clamp(cosineP, COSINE_RANGE.min, COSINE_RANGE.max), 0.01), { have: cosines.length, needed: TUNING_MIN_SAMPLES, unit: "loaded lessons with a meaning score" }, "it would have cut the weakest fifth of the lessons that loaded"));
    // The prior.
    const typical = percentile([...perLesson.values()], 0.5);
    suggestions.push(perLesson.size < TUNING_MIN_LESSONS || typical === undefined
      ? notEnough("priorWeightUses", perLesson.size, TUNING_MIN_LESSONS, "lessons loaded")
      : merged.size < TUNING_MIN_MERGED
        ? notEnough("priorWeightUses", merged.size, TUNING_MIN_MERGED, "merged tasks")
        : decide("priorWeightUses", current.priorWeightUses, clamp(Math.round(typical), PRIOR_RANGE.min, PRIOR_RANGE.max), { have: perLesson.size, needed: TUNING_MIN_LESSONS, unit: "lessons loaded" }, "a lesson typically gets about this many loads in the window, so one window of use balances the prior"));
    // The step cap. "Now" is the caller's value when it gives one, else the budget the loads were actually given (the most common one). Only loads made under that budget count toward "the cap bound", measured
    // against the floors in force. The suggestion only ever raises it (by one, to at most STEP_CAP_CEILING); a budget already at or above the ceiling is kept.
    const budgets = new Map<number, number>();
    for (const one of loads) budgets.set(one.budget, (budgets.get(one.budget) ?? 0) + 1);
    const usual = [...budgets.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? current.stepLessonCap;
    const now = input.current?.stepLessonCap !== undefined && usable(input.current.stepLessonCap, -1) >= 0 ? input.current.stepLessonCap : usual;
    const underNow = loads.filter((one) => one.budget === now);
    const passes = (sample: FitSample): boolean => sample.words >= current.fitFloorWords || (sample.cos !== null && sample.cos >= current.fitFloorCosine);
    const capBound = underNow.filter((one) => one.budget > 0 && one.loaded.length >= one.budget && one.leftOut.some(passes)).length;
    const binds = underNow.length > 0 && capBound / underNow.length >= CAP_BOUND_SHARE;
    suggestions.push(decide("stepLessonCap", now, binds && now < STEP_CAP_CEILING ? now + 1 : now, { have: loads.length, needed: TUNING_MIN_LOADS, unit: "loads" },
      `the step was full with a fitting lesson left out in ${binds ? "" : "only "}${String(capBound)} of ${String(underNow.length)} loads made with ${String(now)} places`));
  }
  suggestions.push({
    setting: "weeklyPicks", status: "no_data_source", current: current.weeklyPicks, suggested: null, evidence: { have: 0, needed: 0, unit: "decided weekly suggestions" },
    message: `no value suggested: no measured row records how many of a week's suggestions people decide, so keep ${String(current.weeklyPicks)}`,
  });

  return {
    project: input.project, windowDays, ready,
    message: ready ? `${String(loads.length)} loads in the last ${String(windowDays)} days.` : `not enough data yet (${String(loads.length)} of ${String(TUNING_MIN_LOADS)} loads)`,
    evidence: {
      loads: loads.length, loadedLessons: loadedAll.length, lessonsLoaded: perLesson.size, mergedTasks: merged.size, revertedTasks: revertedOfMerged, cleanMergeRate: cleanRate,
      meanWordsCleanTasks: clean.tasks >= OUTCOME_MIN_TASKS ? clean.mean : null, meanWordsRevertedTasks: bad.tasks >= OUTCOME_MIN_TASKS ? bad.mean : null, truncated, unreadable,
    },
    suggestions, note: TUNING_NOTE,
  };
}
