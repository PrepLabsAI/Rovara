// Lessons phase 2 (research Q2, "anchoring to code, so lessons go stale when code changes"): the two nightly checks for a lesson that has path scope but no cited lines. NO model call, nothing stored but a small mark.
//   area gone       no file of the lesson's repositories matches any of its path patterns any more: the lesson goes "under question" (it keeps loading, ranked lower, and is first in the weekly review).
//   area rewritten  more than `AREA_REWRITTEN_SHARE` of the lines of the files in its area changed since a person approved it: the weekly review asks a person to confirm it is still true; it ranks lower until then.
// A check that cannot be answered (a repository that cannot be listed, a change count that is not known) marks NOTHING: unknown is never "gone". The marks are rows of the project's `LESSON_QUESTION` partition (the one the revert
// watch writes: `revert-question.ts`), under their own sort-key prefix `A#`, ids and fixed words only (no path, no file name, no person). They are rewritten each night while they hold and lapse on their own `AREA_CHECK_KEEP_DAYS`
// days after they stop holding. No lesson, counter, status or expiry is changed.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import { globToRegExp } from "./guards.js";
import { AREA_CHECK_KEEP_DAYS, AREA_CHECK_LESSONS_MAX, AREA_REWRITTEN_SHARE } from "./scoring-settings.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

const DAY = 86_400_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const ID = /^[A-Za-z0-9_-]{4,64}$/u;
/** How long an area mark is read for (the nightly check rewrites it while it holds). */
export const AREA_CHECK_KEEP_MS = AREA_CHECK_KEEP_DAYS * DAY;
export type AreaMarkKind = "area_gone" | "area_rewritten";
const KINDS: ReadonlySet<string> = new Set<AreaMarkKind>(["area_gone", "area_rewritten"]);

/** Same partition as the revert watch's rows (`revert-question.ts` `questionPk`): imported by name there would be a cycle of intent, so the key is built from the same words. */
const questionPk = (companyId: string, project: string): string => companyScoped(companyId, `LESSON_QUESTION#${project}`);

export interface AreaCheckPorts {
  /** The project's repositories a lesson with no `scope.repos` may be about. Undefined: not known (the lesson is not checked). */
  repositories(key: ScopeKey): Promise<readonly string[] | undefined>;
  /** Every file path of one repository on its default branch (no leading `./`), or undefined when it can not be listed whole. */
  files(key: ScopeKey, repository: string): Promise<readonly string[] | undefined>;
  /** For the files of `repository` that match any of `globs`: the lines changed since `since` and the lines they hold now. Undefined (or absent port): not known. */
  changed?(key: ScopeKey, input: { repository: string; globs: readonly string[]; since: number }): Promise<{ changedLines: number; totalLines: number } | undefined>;
}

export interface AreaCheckDeps {
  lessons: Pick<LessonStore, "listPage">;
  docs: Pick<DocumentStore, "put"> & { ttlAttribute?: string | undefined };
  companyId: OrgId;
  now: () => number;
  ports: AreaCheckPorts;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

const normal = (path: string): string => path.replace(/^(?:\.\/|\/)+/u, "");
/** When a person last approved the lesson (the research's "since the lesson was approved"); the lesson's creation when nobody did. */
export const approvedAtOf = (lesson: Pick<Lesson, "approvals" | "createdAt">): number => lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").reduce((latest, a) => Math.max(latest, a.at), lesson.createdAt);

/** Pure: no file of the area matches any pattern. An empty file list is "gone" only when the caller knows the listing was whole (it passes the list it got). */
export const areaIsGone = (globs: readonly string[], files: readonly string[]): boolean => { const patterns = globs.map(globToRegExp); return !files.some((file) => patterns.some((p) => p.test(normal(file)))); };
/** Pure: more than `AREA_REWRITTEN_SHARE` of the area's lines changed. Zero or unknown lines is never "rewritten". */
export const areaWasRewritten = (change: { changedLines: number; totalLines: number } | undefined, share: number = AREA_REWRITTEN_SHARE): boolean =>
  change !== undefined && Number.isFinite(change.changedLines) && Number.isFinite(change.totalLines) && change.totalLines > 0 && change.changedLines >= 0 && change.changedLines / change.totalLines > share;

/** One nightly pass over one project's lessons in use. Bounded by `AREA_CHECK_LESSONS_MAX` lessons and the caller's `stop`. Returns the lessons marked tonight. Throws only for a store fault (the caller treats it as information). */
export async function runAreaChecks(deps: AreaCheckDeps, key: ScopeKey, options: { stop?: () => boolean } = {}): Promise<{ checked: number; gone: string[]; rewritten: string[] }> {
  const result = { checked: 0, gone: [] as string[], rewritten: [] as string[] };
  if (key.workspaceId !== deps.companyId || !NAME.test(key.project)) return result;
  const projectRepos = await deps.ports.repositories(key).catch(() => undefined);
  const listed = new Map<string, readonly string[] | undefined>();
  const filesOf = async (repository: string): Promise<readonly string[] | undefined> => {
    if (!listed.has(repository)) listed.set(repository, await deps.ports.files(key, repository).catch(() => undefined));
    return listed.get(repository);
  };
  const at = deps.now();
  const mark = async (lessonId: string, kind: AreaMarkKind): Promise<void> => {
    await deps.docs.put({
      item: {
        pk: questionPk(deps.companyId, key.project), sk: `A#${lessonId}#${kind}`, entityType: "LESSON_QUESTION", kind, project: key.project, lessonId, at, keepUntil: at + AREA_CHECK_KEEP_MS,
        ...(deps.docs.ttlAttribute === undefined ? {} : { [deps.docs.ttlAttribute]: Math.floor(at / 1000) + AREA_CHECK_KEEP_DAYS * 86_400 }),
      },
    });
  };
  for (let after: string | undefined; ;) {
    const page = await deps.lessons.listPage(key, { statuses: ["active"], limit: 100, ...(after === undefined ? {} : { after }) });
    for (const lesson of page.lessons) {
      if (result.checked >= AREA_CHECK_LESSONS_MAX || options.stop?.() === true) return result;
      const globs = lesson.scope.paths ?? [];
      // A lesson with no code area has nothing to be gone; one with cited lines is anchored by the citation check instead.
      if (lesson.status !== "active" || globs.length === 0 || !ID.test(lesson.id)) continue;
      const repositories = lesson.scope.repos !== undefined && lesson.scope.repos.length > 0 ? lesson.scope.repos : projectRepos;
      if (repositories === undefined || repositories.length === 0) continue;
      result.checked += 1;
      const lists = await Promise.all(repositories.map(filesOf));
      // One repository that could not be listed whole makes the answer unknown: nothing is marked.
      if (lists.some((list) => list === undefined)) continue;
      if (lists.every((list) => areaIsGone(globs, list!))) { await mark(lesson.id, "area_gone"); result.gone.push(lesson.id); continue; }
      if (deps.ports.changed === undefined) continue;
      const since = approvedAtOf(lesson);
      let changedLines = 0, totalLines = 0, known = true;
      for (const repository of repositories) {
        const change = await deps.ports.changed(key, { repository, globs, since }).catch(() => undefined);
        if (change === undefined) { known = false; break; }
        changedLines += change.changedLines; totalLines += change.totalLines;
      }
      if (known && areaWasRewritten({ changedLines, totalLines })) { await mark(lesson.id, "area_rewritten"); result.rewritten.push(lesson.id); }
    }
    after = page.next;
    if (after === undefined) break;
  }
  deps.log?.("learning.area_check", { checked: result.checked, gone: result.gone.length, rewritten: result.rewritten.length });
  return result;
}

/** The area marks that hold now, by lesson. Reads this company's partition for this project and checks every row again; rows past their `keepUntil`, or of another shape, are left out. */
export async function readAreaMarks(docs: Pick<DocumentStore, "query">, companyId: OrgId, project: string, now: number, report?: { truncated: boolean }): Promise<Map<string, Set<AreaMarkKind>>> {
  const out = new Map<string, Set<AreaMarkKind>>();
  if (!NAME.test(project)) return out;
  const pk = questionPk(companyId, project);
  let read = 0;
  for (let cursor: string | undefined; read < 2_000;) {
    const page = await docs.query({ pk, sk: { op: "beginsWith", prefix: "A#" }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    read += Math.max(1, page.items.length);
    for (const row of page.items) {
      if (row["pk"] !== pk || row["entityType"] !== "LESSON_QUESTION" || row["project"] !== project || typeof row["lessonId"] !== "string" || !ID.test(row["lessonId"]) || typeof row["kind"] !== "string" || !KINDS.has(row["kind"])
        || typeof row["keepUntil"] !== "number" || row["keepUntil"] <= now) continue;
      const set = out.get(row["lessonId"]) ?? new Set<AreaMarkKind>();
      set.add(row["kind"] as AreaMarkKind);
      out.set(row["lessonId"], set);
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
    if (read >= 2_000 && report !== undefined) report.truncated = true;
  }
  return out;
}
