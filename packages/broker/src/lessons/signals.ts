// What the loader and the weekly list know about a project beyond its lessons (lessons phases 1 and 2): the project's clean-merge rate (the prior's centre), each lesson's windowed evidence, the lessons under question and
// the repeat counts. One read per project, reused for `SIGNALS_TTL_MS`, bounded by `SIGNALS_WAIT_MS` for a caller that is on a step's dispatch path: a load never waits for it past that, and never fails because of it (no answer is
// "no signals": the neutral prior, no evidence and nothing under question, which is exactly what a project with no rows has).
//
// Only this company's rows for this project are read (each partition is keyed by company AND project and every row is checked again). Read only. Ids and numbers only.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import { REVERT_WINDOW_MS } from "./counters.js";
import { readAreaMarks } from "./area-check.js";
import { readEvidenceTotals } from "./evidence.js";
import { readUnderQuestion } from "./revert-question.js";
import { CLEAN_MERGE_MIN_TASKS, CLEAN_MERGE_WINDOW_DAYS, DEFAULT_RANKING, SIGNALS_ROWS_MAX, SIGNALS_TTL_MS, SIGNALS_WAIT_MS, evidenceWindowMs, type RankingSettings } from "./scoring-settings.js";
import type { LessonEvidence } from "./strength.js";
import type { ScopeKey } from "./store.js";
import type { QuestionInfo, WeeklyExtras } from "./weekly-order.js";

const DAY = 86_400_000;
const PAGE = 200;
/** The longest one project's signals read may run before its flight is let go. */
const FLIGHT_LIMIT_MS = 10_000;

export interface ProjectSignals {
  /** Merged tasks of the clean-merge window that were not reverted, over merged tasks; null while fewer than `CLEAN_MERGE_MIN_TASKS` merged. */
  cleanMergeRate: number | null;
  evidence: ReadonlyMap<string, LessonEvidence>;
  repeats: ReadonlyMap<string, { matched: number; back: number }>;
  /** Lessons in use under question, and why: reverted tasks whose files overlapped their area, their area is gone, or it was rewritten. */
  questions: ReadonlyMap<string, QuestionInfo>;
  /** The ids of `questions`, for the loader. */
  underQuestion: ReadonlySet<string>;
  /** Lessons a person was asked to keep after a second quiet window. */
  askedToKeep: ReadonlyMap<string, number>;
  at: number;
  truncated: boolean;
}
export const NO_SIGNALS: Omit<ProjectSignals, "at"> = Object.freeze({ cleanMergeRate: null, evidence: new Map<string, LessonEvidence>(), repeats: new Map<string, { matched: number; back: number }>(), questions: new Map<string, QuestionInfo>(), underQuestion: new Set<string>(), askedToKeep: new Map<string, number>(), truncated: false });

export interface SignalsReader { read(key: ScopeKey): Promise<ProjectSignals | undefined> }

/** The project's clean-merge rate from its merged and reverted task rows (`measure.ts`): counted over the window, null while there are too few merged tasks. */
export async function readCleanMergeRate(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; now: number; windowDays?: number; rowsMax?: number; minTasks?: number }): Promise<number | null> {
  // The partition of the project's merged and reverted task rows (the same key words as `measure.ts` `mergePk`).
  const pk = companyScoped(input.companyId, `LESSON_MERGE#${input.project}`);
  const since = input.now - (input.windowDays ?? CLEAN_MERGE_WINDOW_DAYS) * DAY;
  const merged = new Set<string>();
  const reverted = new Set<string>();
  let read = 0;
  const rowsMax = input.rowsMax ?? SIGNALS_ROWS_MAX;
  for (let cursor: string | undefined; read < rowsMax;) {
    const page = await store.query({ pk, limit: Math.min(PAGE, rowsMax - read), descending: true, ...(cursor === undefined ? {} : { cursor }) });
    read += Math.max(1, page.items.length);
    for (const row of page.items) {
      if (row["pk"] !== pk || row["entityType"] !== "LESSON_MERGE" || row["project"] !== input.project || typeof row["taskId"] !== "string" || typeof row["keepUntil"] !== "number" || row["keepUntil"] <= input.now || typeof row["at"] !== "number") continue;
      if (row["kind"] === "reverted") reverted.add(row["taskId"]);
      // A merge younger than the 14-day revert window is not counted yet (it may still be reverted, and counting it clean would lean the prior upward).
      else if (row["kind"] === "merged" && row["at"] >= since && row["at"] <= input.now - REVERT_WINDOW_MS) merged.add(row["taskId"]);
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  if (merged.size < (input.minTasks ?? CLEAN_MERGE_MIN_TASKS)) return null;
  const clean = [...merged].filter((taskId) => !reverted.has(taskId)).length;
  return clean / merged.size;
}

/** Everything for one project, read once. Throws only for a store fault (the cached reader below swallows it). */
export async function readProjectSignals(store: Pick<DocumentStore, "query">, input: { companyId: OrgId; project: string; now: number; settings?: Pick<RankingSettings, "evidenceWindowDays"> }): Promise<ProjectSignals> {
  const settings = input.settings ?? DEFAULT_RANKING;
  // A read of the question or area rows that stopped at its row cap with more waiting is "truncated" too: a lesson whose mark was not reached must not look clean.
  const cut = { truncated: false };
  const [rate, totals, reverts, marks] = await Promise.all([
    readCleanMergeRate(store, input), readEvidenceTotals(store, { companyId: input.companyId, project: input.project, now: input.now, windowMs: evidenceWindowMs(settings) }),
    readUnderQuestion(store, input.companyId, input.project, input.now, cut), readAreaMarks(store, input.companyId, input.project, input.now, cut),
  ]);
  const questions = new Map<string, QuestionInfo>();
  for (const revert of reverts) questions.set(revert.lessonId, { revertTasks: revert.tasks, areaGone: false, areaRewritten: false });
  for (const [lessonId, kinds] of marks) {
    const known = questions.get(lessonId) ?? { revertTasks: 0, areaGone: false, areaRewritten: false };
    questions.set(lessonId, { ...known, areaGone: kinds.has("area_gone"), areaRewritten: kinds.has("area_rewritten") });
  }
  return { cleanMergeRate: rate, evidence: totals.evidence, repeats: totals.repeats, questions, underQuestion: new Set(questions.keys()), askedToKeep: totals.asked, at: input.now, truncated: totals.truncated || cut.truncated };
}

/**
 * The reader the loader uses: one project's signals reused for `ttlMs`; one read at a time per project (callers share it); a caller waits at most `waitMs` and then gets the last answer (or nothing) while the read goes on and fills
 * the cache. It never throws. The cache is small (one entry per project of this company) and holds numbers and lesson ids only.
 */
export function cachedSignalsReader(store: Pick<DocumentStore, "query">, companyId: OrgId, now: () => number, options: { ttlMs?: number; waitMs?: number; settings?: Pick<RankingSettings, "evidenceWindowDays"> } = {}): SignalsReader {
  const ttl = options.ttlMs ?? SIGNALS_TTL_MS;
  const wait = options.waitMs ?? SIGNALS_WAIT_MS;
  const cache = new Map<string, ProjectSignals>();
  const flights = new Map<string, Promise<ProjectSignals | undefined>>();
  const refresh = (key: ScopeKey): Promise<ProjectSignals | undefined> => {
    const name = key.project;
    const running = flights.get(name);
    if (running !== undefined) return running;
    // The read itself has a limit: a store that never answers does not hold the project's flight for ever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), FLIGHT_LIMIT_MS); timer.unref?.(); });
    const flight = Promise.race([readProjectSignals(store, { companyId, project: key.project, now: now(), ...(options.settings === undefined ? {} : { settings: options.settings }) })
      .then((signals) => { cache.set(name, signals); return signals; }, () => undefined), limit])
      .finally(() => { if (timer !== undefined) clearTimeout(timer); flights.delete(name); });
    flights.set(name, flight);
    return flight;
  };
  return {
    async read(key) {
      if (key.workspaceId !== companyId) return undefined;
      const cached = cache.get(key.project);
      if (cached !== undefined && now() - cached.at < ttl) return cached;
      // A stale answer is served at once while the refresh runs in the background (a load never waits for a refresh it can do without).
      if (cached !== undefined) { void refresh(key); return cached; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fresh = await Promise.race([refresh(key), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), wait); timer.unref?.(); })]);
        return fresh ?? cache.get(key.project);
      } catch { return cache.get(key.project); } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}

/** What the weekly list reads from a project's signals (lessons under question, lessons a person was asked to keep, repeat counts). Never throws; no answer is none. */
export async function weeklyExtrasOf(reader: SignalsReader, key: ScopeKey): Promise<WeeklyExtras | undefined> {
  const signals = await reader.read(key).catch(() => undefined);
  return signals === undefined ? undefined : { underQuestion: signals.questions, askedToKeep: signals.askedToKeep, repeats: signals.repeats };
}

/**
 * A reader that reads the project's signals fresh at every call (no cache): for a DECISION (making a lesson permanent, drafting a skill), where a stale "nothing against it" must not stand. It reads only this company's rows for the
 * project asked about, and a store fault or a read that runs past `FLIGHT_LIMIT_MS` is "no answer" (the caller then treats the lesson as not proven).
 */
export function freshSignalsReader(store: Pick<DocumentStore, "query">, companyId: OrgId, now: () => number, options: { settings?: Pick<RankingSettings, "evidenceWindowDays"> } = {}): SignalsReader {
  return {
    async read(key) {
      if (key.workspaceId !== companyId) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), FLIGHT_LIMIT_MS); timer.unref?.(); });
        return await Promise.race([readProjectSignals(store, { companyId, project: key.project, now: now(), ...(options.settings === undefined ? {} : { settings: options.settings }) }).catch(() => undefined), limit]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}
