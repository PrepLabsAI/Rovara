// Lessons phase 0 (lessons architecture research, section 6): MEASURE ONLY. No behaviour changes: what loads, how it is ranked and what is credited are exactly what they were. This module records
// numbers about each load so the owner can see whether the cap (5 lessons a step) or a missing fit floor is the real limit, and what the project's normal clean-merge rate is (the prior for a later score).
//
// What is recorded, and nothing else (ids and numbers only; there is NO field that can hold a title, a lesson's words, a task's words, a path, a file name, a person or a model's text):
//   - per load (a row of `LESSON_FIT#<project>`): the fit and rank score of each lesson that was loaded and of the next `MEASURE_LEFT_OUT` left out (lesson ids), how many loaded lessons fit below `MEASURE_FIT_FLOOR`,
//     the step's budget, how many lessons were eligible for the step and how many the project has in use;
//   - per merged task (a row of `LESSON_MERGE#<project>`): the task id and the time, written when the task's merge reaches the lessons' milestone hook; and per reverted task the task id and the time. The clean-merge
//     rate is counted from these (merged tasks of the window that were not reverted, over merged tasks of the window).
// Every row is under the company's own partition AND the project (`companyScoped`), written only for the company this sink was built for, and read back only through the same keys. A row carries its own
// `keepUntil` (checked by the reader, so no row is read past it whether or not the store has swept it) and, where the store names a time-to-live attribute, that attribute too (the store's own, never a name written here).
// Erase: a person's id is never in a row, so a person erase has nothing to remove; a project or company purge removes the partitions as it does every other project-keyed row.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";

const DAY = 86_400_000;
/** The fit below which a loaded lesson is counted as a weak fit. The research's starting value; phase 0 exists to replace it with a measured one. */
export const MEASURE_FIT_FLOOR = 0.35;
/** The lessons left out that are recorded after the loaded ones. */
export const MEASURE_LEFT_OUT = 5;
/** The most loaded lessons one row records (the loader's own ceiling). */
const LOADED_MAX = 12;
/** How long a measurement row is read for (the reader's own clock) and kept by the store. */
export const MEASURE_KEEP_MS = 60 * DAY;
/** The window the summary counts, in days. */
export const MEASURE_WINDOW_DAYS = 30;
export const MEASURE_WINDOW_DAYS_MAX = 60;
/** One TOTAL limit per read: rows read across the load rows and the merge rows, and the time. */
export const MEASURE_ROWS_MAX = 4_000;
export const MEASURE_DEADLINE_MS = 3_000;
/** The longest a write waits: a slow store never holds a step's dispatch for a measurement. */
export const MEASURE_WRITE_MS = 400;
const PAGE = 200;
const STAGES: ReadonlySet<string> = new Set(["UNDERSTAND", "PLAN", "IMPLEMENT", "PLAN_CRITIQUE", "REVIEW"]);
const ID = /^[A-Za-z0-9_-]{4,64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** The partition of a project's per-load rows. */
export const fitPk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_FIT#${project}`);
/** The partition of a project's merged and reverted task rows. */
export const mergePk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_MERGE#${project}`);
/** Times are written as 16 digits, so the sort key orders by time. */
const timeSk = (at: number): string => String(Math.max(0, Math.floor(at))).padStart(16, "0");

export type FitSample = {
  id: string;
  /** The fused fit to the task, 0 to 1 (three places). It is a RANK score (1 is first in every list the query has; 0 is in none), so it is also kept beside two absolute numbers below. */
  fit: number;
  /** The rank score the loader sorted by (three places). */
  score: number;
  /** The share of the shorter text's words the task and the lesson have in common, 0 to 1 (absolute; 0 when the lesson was in no list). */
  words: number;
  /** The embedder's cosine of the task and the lesson, when there was one and the lesson was close enough to enter its list; else null. */
  cos: number | null;
};
export interface LoadMeasure {
  workspaceId: string; project: string; taskId: string; stage: string; round: number; at: number;
  /** The step's budget in lessons. */
  budgetLessons: number;
  /** The project's active lessons (the lessons in use) when the step loaded. */
  activeCount: number;
  /** The lessons that fit the stage and scope (what the ranking chose from). */
  eligibleCount: number;
  loaded: readonly FitSample[];
  leftOut: readonly FitSample[];
}

/** What writes the measurement rows. Every method never throws and never waits past `MEASURE_WRITE_MS`. */
export interface MeasureSink {
  load(measure: LoadMeasure): Promise<void>;
  merged(input: { workspaceId: string; project: string; taskId: string; at: number }): Promise<void>;
  reverted(input: { workspaceId: string; project: string; taskId: string; at: number }): Promise<void>;
}

const round3 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const sampleOf = (sample: FitSample): FitSample | undefined => (ID.test(sample.id) && Number.isFinite(sample.fit) && Number.isFinite(sample.score) && Number.isFinite(sample.words)
  ? { id: sample.id, fit: round3(sample.fit), score: round3(sample.score), words: round3(sample.words), cos: sample.cos === null || !Number.isFinite(sample.cos) ? null : round3(sample.cos) } : undefined);
const samplesOf = (samples: readonly FitSample[], max: number): FitSample[] => samples.slice(0, max).flatMap((sample) => { const one = sampleOf(sample); return one === undefined ? [] : [one]; });
const count = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0);

/** How many of the loaded lessons fit below the floor (the number the summary and the row both carry). */
export const belowFloorOf = (loaded: readonly Pick<FitSample, "fit">[]): number => loaded.filter((sample) => sample.fit < MEASURE_FIT_FLOOR).length;

/** The document-store sink of one company. A call for another company, a project or id that is not shaped as one, or a stage that is not one writes nothing. */
export function documentMeasureSink(store: Pick<DocumentStore, "put" | "ttlAttribute">, companyId: OrgId, now: () => number): MeasureSink {
  const ttl = (seconds: number): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(now() / 1000) + seconds });
  const within = async (write: () => Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([write(), new Promise<void>((resolve) => { timer = setTimeout(resolve, MEASURE_WRITE_MS); timer.unref?.(); })]);
    } catch { /* a measurement is information only: it never fails a load */ } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const mine = (input: { workspaceId: string; project: string; taskId: string }): boolean => input.workspaceId === companyId && NAME.test(input.project) && ID.test(input.taskId.replace(/-/gu, "_"));
  const keep = MEASURE_KEEP_MS / 1000;
  return {
    async load(measure) {
      if (!mine(measure) || !STAGES.has(measure.stage)) return;
      const loaded = samplesOf(measure.loaded, LOADED_MAX);
      const leftOut = samplesOf(measure.leftOut, MEASURE_LEFT_OUT);
      const at = measure.at;
      await within(() => store.put({
        item: {
          pk: fitPk(companyId, measure.project), sk: `L#${timeSk(at)}#${measure.taskId}#${measure.stage}#${String(count(measure.round, 10_000))}`, entityType: "LESSON_FIT", project: measure.project,
          taskId: measure.taskId, stage: measure.stage, round: count(measure.round, 10_000), at, keepUntil: at + MEASURE_KEEP_MS, floor: MEASURE_FIT_FLOOR,
          budgetLessons: count(measure.budgetLessons, 100), activeCount: count(measure.activeCount, 100_000), eligibleCount: count(measure.eligibleCount, 100_000),
          loaded, leftOut, belowFloor: belowFloorOf(loaded), ...ttl(keep),
        },
      }));
    },
    async merged(input) {
      if (!mine(input)) return;
      await within(() => store.put({
        item: { pk: mergePk(companyId, input.project), sk: `M#${input.taskId}`, entityType: "LESSON_MERGE", kind: "merged", project: input.project, taskId: input.taskId, at: input.at, keepUntil: input.at + MEASURE_KEEP_MS, ...ttl(keep) },
        // The first delivery of a merge decides its time: a repeat of the milestone changes nothing.
        condition: { op: "notExists", path: ["pk"] },
      }));
    },
    async reverted(input) {
      if (!mine(input)) return;
      await within(() => store.put({
        item: { pk: mergePk(companyId, input.project), sk: `R#${input.taskId}`, entityType: "LESSON_MERGE", kind: "reverted", project: input.project, taskId: input.taskId, at: input.at, keepUntil: input.at + MEASURE_KEEP_MS, ...ttl(keep) },
        condition: { op: "notExists", path: ["pk"] },
      }));
    },
  };
}

export interface LessonMeasure {
  project: string;
  windowDays: number;
  /** The fit floor the counts use. */
  floor: number;
  loads: number;
  /** Lessons the project had in use at its latest load in the window; null when it had no load. */
  lessonsInUse: number | null;
  loadedLessons: number;
  /** Loaded lessons that fit below the floor, and the loads that loaded at least one of them. */
  loadedBelowFloor: number;
  loadsWithBelowFloor: number;
  /** Loaded lessons that were in none of the query's lists (fit 0): they were loaded only because there is no minimum. */
  loadedNoMatch: number;
  /** Mean of the absolute word overlap of the loaded lessons, and of the lessons left out. */
  meanWordsLoaded: number | null;
  meanWordsLeftOut: number | null;
  /** Loads that filled the budget while a lesson at or above the floor was left out: the cap was the limit. */
  loadsCapBound: number;
  /** Lessons left out that fit at or above the floor. */
  leftOutAtOrAboveFloor: number;
  meanFitLoaded: number | null;
  meanFitLeftOut: number | null;
  cleanMerge: { merged: number; reverted: number; clean: number; rate: number | null };
  /** Some input was cut by the total limit or the deadline: the answer is for what was read. */
  truncated: boolean;
  /** Rows that were not shaped as a row of this module (they are left out, never guessed from). */
  unreadable: number;
}

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
function samplesFrom(value: unknown): FitSample[] | undefined {
  if (!Array.isArray(value) || value.length > LOADED_MAX) return undefined;
  const out: FitSample[] = [];
  for (const entry of value as unknown[]) {
    const row = entry as { id?: unknown; fit?: unknown; score?: unknown; words?: unknown; cos?: unknown } | null;
    const fit = numberOf(row?.fit);
    const score = numberOf(row?.score);
    const words = numberOf(row?.words);
    const cos = row?.cos === null ? null : numberOf(row?.cos);
    if (row === null || typeof row !== "object" || typeof row.id !== "string" || !ID.test(row.id) || fit === undefined || score === undefined || words === undefined || cos === undefined || fit < 0 || fit > 1 || words < 0 || words > 1) return undefined;
    out.push({ id: row.id, fit, score, words, cos });
  }
  return out;
}

/**
 * The numbers phase 0 shows a maintainer, for one project of one company: counted from that project's rows only (the partitions are keyed by company AND project, and a row is checked against both again). Read only,
 * bounded by one total row limit and a deadline, and counts only. A project with no rows answers zeros and `null` where a mean or a rate has nothing to rest on.
 */
export async function readLessonMeasure(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; now: number; windowDays?: number; limits?: { rowsTotal?: number; deadlineMs?: number } }): Promise<LessonMeasure> {
  const windowDays = Math.min(MEASURE_WINDOW_DAYS_MAX, Math.max(1, Math.floor(input.windowDays ?? MEASURE_WINDOW_DAYS)));
  const since = input.now - windowDays * DAY;
  const rowsTotal = input.limits?.rowsTotal ?? MEASURE_ROWS_MAX;
  const deadlineAt = Date.now() + (input.limits?.deadlineMs ?? MEASURE_DEADLINE_MS);
  let read = 0;
  let truncated = false;
  let unreadable = 0;

  type Page = Awaited<ReturnType<typeof store.query>>;
  type Paging = { descending: true; limit: number; cursor?: string };
  async function rowsOf(pk: string, ask: (paging: Paging) => Promise<Page>, fresh: (row: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let pages = 0; pages <= Math.ceil(rowsTotal / PAGE) + 1; pages += 1) {
      const take = Math.min(PAGE, rowsTotal - read);
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
  let loads = 0; let loadedLessons = 0; let loadedBelow = 0; let loadsWithBelow = 0; let capBound = 0; let leftOutAbove = 0; let latestAt = -1; let lessonsInUse: number | null = null;
  let fitLoaded = 0; let fitLeft = 0; let leftCount = 0; let noMatch = 0; let wordsLoaded = 0; let wordsLeft = 0;
  for (const row of fitRows) {
    const loaded = samplesFrom(row["loaded"]);
    const leftOut = samplesFrom(row["leftOut"]);
    const budget = numberOf(row["budgetLessons"]);
    const active = numberOf(row["activeCount"]);
    const at = numberOf(row["at"]);
    if (loaded === undefined || leftOut === undefined || budget === undefined || active === undefined || at === undefined) { unreadable += 1; continue; }
    loads += 1;
    loadedLessons += loaded.length;
    const below = belowFloorOf(loaded);
    loadedBelow += below;
    if (below > 0) loadsWithBelow += 1;
    const above = leftOut.filter((sample) => sample.fit >= MEASURE_FIT_FLOOR).length;
    leftOutAbove += above;
    if (loaded.length >= budget && budget > 0 && above > 0) capBound += 1;
    for (const sample of loaded) { fitLoaded += sample.fit; wordsLoaded += sample.words; if (sample.fit === 0) noMatch += 1; }
    for (const sample of leftOut) { fitLeft += sample.fit; wordsLeft += sample.words; leftCount += 1; }
    if (at > latestAt) { latestAt = at; lessonsInUse = active; }
  }

  const mergeRows = await rowsOf(mergePk(input.companyId, input.project), (paging) => store.query({ pk: mergePk(input.companyId, input.project), ...paging }), (row) => {
    if (row["entityType"] !== "LESSON_MERGE" || row["project"] !== input.project || (row["kind"] !== "merged" && row["kind"] !== "reverted") || typeof row["taskId"] !== "string") { unreadable += 1; return false; }
    return live(row) && numberOf(row["at"]) !== undefined;
  });
  const reverted = new Set(mergeRows.filter((row) => row["kind"] === "reverted").map((row) => row["taskId"] as string));
  const merged = new Set(mergeRows.filter((row) => row["kind"] === "merged" && (row["at"] as number) >= since).map((row) => row["taskId"] as string));
  const revertedOfMerged = [...merged].filter((taskId) => reverted.has(taskId)).length;
  const clean = merged.size - revertedOfMerged;
  return {
    project: input.project, windowDays, floor: MEASURE_FIT_FLOOR, loads, lessonsInUse, loadedLessons, loadedBelowFloor: loadedBelow, loadsWithBelowFloor: loadsWithBelow, loadedNoMatch: noMatch, meanWordsLoaded: loadedLessons === 0 ? null : Math.round((wordsLoaded / loadedLessons) * 1000) / 1000, meanWordsLeftOut: leftCount === 0 ? null : Math.round((wordsLeft / leftCount) * 1000) / 1000, loadsCapBound: capBound,
    leftOutAtOrAboveFloor: leftOutAbove, meanFitLoaded: loadedLessons === 0 ? null : Math.round((fitLoaded / loadedLessons) * 1000) / 1000, meanFitLeftOut: leftCount === 0 ? null : Math.round((fitLeft / leftCount) * 1000) / 1000,
    cleanMerge: { merged: merged.size, reverted: revertedOfMerged, clean, rate: merged.size === 0 ? null : Math.round((clean / merged.size) * 1000) / 1000 },
    truncated, unreadable,
  };
}
