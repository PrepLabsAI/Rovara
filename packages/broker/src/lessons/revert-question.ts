// Lane L4-LM1b (revert detection): "under question". A revert is evidence about a task, never blame against a lesson (lessons architecture research Q3/Q5, learning review decision 6). All it may do to a lesson is raise a flag for a
// person: the lesson stays exactly as it is (no counter, no status, no score, no expiry, no retire), and the flag is a separate EVIDENCE row that the weekly review reads. One revert alone never retires a lesson.
//
// A lesson is put under question only when ALL of these hold:
//   - the task loaded the lesson (it reached the prompt of a live step: `reachedLessonIds` of the task's manifests, snapshot loads left out);
//   - the lesson is in use now (active);
//   - the lesson has a code area (`scope.paths`, at least one path pattern) AND a file the revert touched is in it. A lesson with no code area (a repository-wide lesson) is NOT flagged: it has no area for the revert to overlap, and
//     flagging every repository-wide lesson on every revert would blame good lessons for unrelated reverts. A revert whose files could not be read whole (`files` undefined) flags nothing, since no overlap can be shown.
//
// The row (`LESSON_QUESTION#<project>`, one per lesson, task and reverting commit, written only when absent) holds ids and numbers: the lesson id, the task id, the reverting commit, the time, `keepUntil`. It holds no path, no file name, no
// words and no person, so a person erase has nothing to remove; the company purge removes the ORG partition; rows expire (`keepUntil` checked by the reader, and the store's own time-to-live attribute where it names one).
import { createHash } from "node:crypto";
import { companyScoped, when, type DocumentStore, type OrgId } from "@agentx/contracts";
import { reachedLessonIds } from "./counters.js";
import { globToRegExp } from "./guards.js";
import type { LessonStore } from "./store.js";

const DAY = 86_400_000;
/** How long an evidence row is read for and kept. */
export const QUESTION_KEEP_MS = 90 * DAY;
/** One TOTAL limit per call: files compared, lessons looked at, rows read. */
export const QUESTION_FILES_MAX = 3_000;
export const QUESTION_LESSONS_MAX = 60;
export const QUESTION_ROWS_MAX = 2_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const ID = /^[A-Za-z0-9_-]{4,64}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;

/** The partition of a project's "under question" evidence rows. */
export const questionPk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_QUESTION#${project}`);

export interface RevertQuestionDeps {
  /** The lessons' own store (the manifests of a task and the lessons themselves). Read only here. */
  lessons: Pick<LessonStore, "get" | "manifests">;
  docs: Pick<DocumentStore, "put" | "query"> & { ttlAttribute?: string | undefined };
  companyId: OrgId;
  now: () => number;
}

/** A file path the way a revert lists it, without a leading `./` or `/`. */
const normal = (path: string): string => path.replace(/^(?:\.\/|\/)+/u, "");

/**
 * Puts the lessons `taskId` loaded under question where the revert's files overlap the lesson's code area. Returns the ids marked now (an overlap already on record is not marked again). Throws only for a store fault
 * (the caller treats the whole thing as information).
 */
export async function markLessonsUnderQuestion(deps: RevertQuestionDeps, input: { project: string; taskId: string; via: string; files: readonly string[] | undefined }): Promise<{ marked: string[] }> {
  if (!NAME.test(input.project) || !ID.test(input.taskId.replace(/-/gu, "_")) || input.files === undefined || input.files.length === 0 || input.files.length > QUESTION_FILES_MAX) return { marked: [] };
  const via = COMMIT.test(input.via.toLowerCase()) ? input.via.toLowerCase() : `x${createHash("sha256").update(input.via).digest("hex").slice(0, 39)}`;
  const key = { workspaceId: deps.companyId, project: input.project };
  const files = input.files.map(normal);
  const loaded = [...reachedLessonIds((await deps.lessons.manifests(key, input.taskId)).filter((manifest) => manifest.memory === "live"))].slice(0, QUESTION_LESSONS_MAX);
  const marked: string[] = [];
  const at = deps.now();
  for (const lessonId of loaded) {
    const lesson = await deps.lessons.get(key, lessonId);
    // Only a lesson in use can be put under question; a retired, expired or pending one is not shown to agents.
    if (lesson === undefined || lesson.status !== "active") continue;
    const area = (lesson.scope.paths ?? []).map(globToRegExp);
    if (area.length === 0 || !files.some((file) => area.some((pattern) => pattern.test(file)))) continue;
    const written = await deps.docs.put({
      item: {
        pk: questionPk(deps.companyId, input.project), sk: `Q#${lessonId}#${input.taskId}#${via}`, entityType: "LESSON_QUESTION", kind: "revert_overlap", project: input.project, lessonId, taskId: input.taskId, via, at, keepUntil: at + QUESTION_KEEP_MS,
        ...(deps.docs.ttlAttribute === undefined ? {} : { [deps.docs.ttlAttribute]: Math.floor(at / 1000) + QUESTION_KEEP_MS / 1000 }),
      },
      condition: when.absent(),
    });
    if (written.applied) marked.push(lessonId);
  }
  return { marked };
}

export interface UnderQuestion { lessonId: string; /** Distinct tasks whose revert overlapped the lesson's area. */ tasks: number; lastAt: number }

/**
 * The lessons of a project that are under question now: one entry per lesson, with the number of distinct reverted tasks behind it. Reads only this company's partition for this project and checks every row again
 * (its type, project and company key); rows past their `keepUntil` are not counted. The weekly review reads this; nothing in Code changes a lesson because of it.
 */
export async function readUnderQuestion(docs: Pick<DocumentStore, "query">, companyId: OrgId, project: string, nowMs: number, report?: { truncated: boolean }): Promise<UnderQuestion[]> {
  if (!NAME.test(project)) return [];
  const pk = questionPk(companyId, project);
  // One TOTAL bound on rows read: a project with more evidence than that is read from its first rows only (the review shows the lessons with the most recent evidence it reached; nothing is changed by it).
  const rows: Array<Record<string, unknown>> = [];
  for (let cursor: string | undefined; rows.length < QUESTION_ROWS_MAX;) {
    const page = await docs.query({ pk, sk: { op: "beginsWith", prefix: "Q#" }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) break;
    if (rows.length >= QUESTION_ROWS_MAX && report !== undefined) report.truncated = true;
  }
  const byLesson = new Map<string, { tasks: Set<string>; lastAt: number }>();
  for (const row of rows.slice(0, QUESTION_ROWS_MAX)) {
    if (row["pk"] !== pk || row["entityType"] !== "LESSON_QUESTION" || row["project"] !== project || typeof row["lessonId"] !== "string" || typeof row["taskId"] !== "string" || typeof row["at"] !== "number" || typeof row["keepUntil"] !== "number" || row["keepUntil"] <= nowMs) continue;
    const entry = byLesson.get(row["lessonId"]) ?? { tasks: new Set<string>(), lastAt: 0 };
    entry.tasks.add(row["taskId"]);
    entry.lastAt = Math.max(entry.lastAt, row["at"]);
    byLesson.set(row["lessonId"], entry);
  }
  return [...byLesson].map(([lessonId, entry]) => ({ lessonId, tasks: entry.tasks.size, lastAt: entry.lastAt })).sort((a, b) => b.lastAt - a.lastAt || a.lessonId.localeCompare(b.lessonId));
}
