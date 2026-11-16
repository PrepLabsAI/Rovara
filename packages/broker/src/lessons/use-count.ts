// "Used in N tasks" (lessons holistic review, fix 3): how many distinct tasks a lesson was given to, counted from the LESSON_USE rows the loader writes (`host-glue.ts` `learnedFor`: one row per
// lesson and task, sort key = the task id, kept `LESSON_USE_KEEP_SECONDS`). Read-only; counts only (no task id or title leaves this module).
//
//   - Every key is under the company's own partition (`companyScoped`), for one project: rows of another company or project are never read.
//   - A row past its keep time (the store may not have swept it yet), or one that is not shaped like a use row, is not counted.
//   - One TOTAL limit per call: at most `USED_IN_ROWS_TOTAL` rows (reserved before each query, so parallel counts never pass it) and `USED_IN_DEADLINE_MS` (each query is raced against the time left)
//     across all the lessons asked about. Each lesson counts at most `USED_IN_MAX` tasks (`more`: there were more).
//   - Never a guess: a lesson whose rows could not all be read (the store failed, the total limit or the deadline was reached) gets NO count, and the answer says it is incomplete.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";

/** How long a use row is kept (the loader writes it with this TTL). */
export const LESSON_USE_KEEP_SECONDS = 180 * 86_400;
/** The most tasks one lesson's count says; past it the count is this with `more`. */
export const USED_IN_MAX = 500;
/** The most use rows one call reads, across every lesson it counts. */
export const USED_IN_ROWS_TOTAL = 20_000;
/** How long one call may spend counting. */
export const USED_IN_DEADLINE_MS = 3_000;
/** Lessons counted at once. */
const PARALLEL = 5;
const PAGE = 200;

/** The partition of one lesson's use rows (one row per task that was given the lesson). */
export const lessonUsePk = (companyId: OrgId, project: string, lessonId: string): string => companyScoped(companyId, `LESSON_USE#${project}#${lessonId}`);

export interface LessonUseCount { tasks: number; more?: true }
export interface LessonUseCounts {
  /** The lessons that were counted in full. A lesson asked about and missing here could not be counted. */
  counts: Map<string, LessonUseCount>;
  /** Some lesson asked about has no count. */
  incomplete: boolean;
}

/** The tasks each lesson was given to, for one project of one company. */
export async function countLessonUses(store: Pick<DocumentStore, "query" | "ttlAttribute">, input: {
  companyId: OrgId; project: string; lessonIds: readonly string[]; now: number;
  /** Tests: the limits. */
  limits?: { rowsTotal?: number; deadlineMs?: number; perLesson?: number };
}): Promise<LessonUseCounts> {
  const rowsTotal = input.limits?.rowsTotal ?? USED_IN_ROWS_TOTAL;
  const perLesson = input.limits?.perLesson ?? USED_IN_MAX;
  const deadlineAt = Date.now() + (input.limits?.deadlineMs ?? USED_IN_DEADLINE_MS);
  const oldest = input.now - LESSON_USE_KEEP_SECONDS * 1000;
  const nowSeconds = Math.floor(input.now / 1000);
  const ttl = store.ttlAttribute;
  const counts = new Map<string, LessonUseCount>();
  const ids = [...new Set(input.lessonIds)];
  let read = 0;
  let incomplete = false;

  const live = (row: Record<string, unknown>): boolean => {
    if (typeof row["taskId"] !== "string" || row["taskId"] !== row["sk"] || row["entityType"] !== "LESSON_USE") return false;
    if (typeof row["at"] !== "number" || row["at"] < oldest) return false;
    const expires = ttl === undefined ? undefined : row[ttl];
    return typeof expires !== "number" || expires > nowSeconds;
  };

  /** A query raced against the time left: undefined when the deadline came first (a late answer is ignored). */
  async function queryInTime(request: Parameters<DocumentStore["query"]>[0]): Promise<Awaited<ReturnType<DocumentStore["query"]>> | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        store.query(request),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - Date.now())); timer.unref?.(); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function countOne(lessonId: string): Promise<void> {
    const pk = lessonUsePk(input.companyId, input.project, lessonId);
    const tasks = new Set<string>();
    let cursor: string | undefined;
    // A store that keeps answering empty pages with a cursor is stopped here as well as by the deadline.
    const pagesMax = Math.ceil(rowsTotal / PAGE) + 1;
    try {
      for (let pages = 0; ; pages += 1) {
        if (pages >= pagesMax || Date.now() >= deadlineAt) { incomplete = true; return; }
        // The rows are reserved BEFORE the query, so lessons counted at the same time never pass the total between them; what a page did not use is given back.
        const take = Math.min(PAGE, rowsTotal - read);
        if (take <= 0) { incomplete = true; return; }
        read += take;
        const page = await queryInTime({ pk: companyScoped(input.companyId, `LESSON_USE#${input.project}#${lessonId}`), limit: take, ...(cursor === undefined ? {} : { cursor }) });
        if (page === undefined) { incomplete = true; return; }
        read -= take - Math.min(take, page.items.length);
        for (const row of page.items.slice(0, take)) if (row.pk === pk && live(row)) tasks.add(row["taskId"] as string);
        if (tasks.size > perLesson) { counts.set(lessonId, { tasks: perLesson, more: true }); return; }
        cursor = page.cursor;
        if (cursor === undefined) break;
      }
    } catch { incomplete = true; return; }
    counts.set(lessonId, { tasks: tasks.size });
  }

  for (let at = 0; at < ids.length; at += PARALLEL) await Promise.all(ids.slice(at, at + PARALLEL).map(countOne));
  return { counts, incomplete: incomplete || counts.size < ids.length };
}
