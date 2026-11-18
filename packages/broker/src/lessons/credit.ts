// Lessons phase 2 (lessons architecture research Q3, decisions 9 to 11): who is owed the credit of one clean merge. Pure.
//
// Today every lesson that reached a merged task's prompt gets the same "helpful" mark (presence): if 85% of tasks merge clean, every loaded lesson looks 85% helpful and the mark says little. Now one clean merge is ONE credit,
// shared (1/k) among the k lessons that earned it:
//   - the agent REPORTED using the lesson (the step's own `knowledgeUseReport`: the agent's claim, used only to decide how one credit is SHARED: it can never add credit), AND
//   - the change touched the lesson's code area (overlap). A lesson the agent did not report and whose area was untouched gets nothing; a lesson reported as used in an area the change did not touch gets nothing either.
// With no use report for the task at all (a worker that does not report yet) the report cannot be asked: the credit is shared among the loaded lessons whose area the change touched. When the changed files are NOT KNOWN either
// (the merge's file list was not read), overlap can be neither shown nor ruled out, so no lesson is excluded for it: they share the credit as before this lane, but 1/k of it each, never a whole mark each. (This is the one place
// "unknown" works in a lesson's favour: leaving every lesson with no credit would let a good lesson fade for want of a file list. Blame never takes this road: a revert with unknown files marks nothing, `revert-question.ts`.)
// A revert, or a clean merge with no eligible lesson, credits nobody. Nothing here is ever a mark AGAINST a lesson.
import { globToRegExp } from "./guards.js";
import type { Lesson } from "./types.js";

/** One unit of a worker's use report as the broker keeps it (the L4-AK2 `KnowledgeUseReport` shape, kept structural so this file needs nothing of that branch). `id` is the stored id or the shown id (`L-<id>`). */
export interface UseReportUnit { id: string; kind?: string | undefined; used?: boolean | undefined; areaTouched: boolean }
export interface UseReport { reported: boolean; units: readonly UseReportUnit[] }

const normal = (path: string): string => path.replace(/^(?:\.\/|\/)+/u, "");

/** The stored lesson id of a reported unit, or undefined for a unit that is not a lesson (a rule, fact or skill is not scored this way). */
export function lessonIdOfUnit(unit: Pick<UseReportUnit, "id" | "kind">): string | undefined {
  if (unit.kind !== undefined && unit.kind !== "lesson") return undefined;
  if (unit.kind === undefined && /^[RFS]-/u.test(unit.id)) return undefined;
  return unit.id.replace(/^L-/u, "");
}

/**
 * Whether the change may have touched the lesson's code area. Unknown files (`undefined`): not ruled out. Known files: a lesson with no path scope is about the whole project, so any change touches it; a scoped lesson needs a changed
 * file in its area. A known empty list (nothing changed) touches nothing.
 */
export function lessonAreaOverlap(lesson: Pick<Lesson, "scope">, touched: readonly string[] | undefined): boolean {
  if (touched === undefined) return true;
  const globs = lesson.scope.paths ?? [];
  if (touched.length === 0) return false;
  if (globs.length === 0) return true;
  const patterns = globs.map(globToRegExp);
  return touched.some((file) => patterns.some((p) => p.test(normal(file))));
}

/**
 * The share of one clean merge each lesson is owed, `1/k` for each of the k eligible lessons. `loaded` are the lessons that reached the task's prompt (a lesson that never did earns nothing whatever a report says).
 * `reports` are the task's Build and Fix use reports; absent or empty means no report was made.
 */
export function lessonCreditShares(input: { lessons: ReadonlyMap<string, Pick<Lesson, "scope">>; loaded: ReadonlySet<string>; reports: readonly UseReport[] | undefined; touched: readonly string[] | undefined }): Map<string, number> {
  const eligible = new Set<string>();
  const reports = input.reports ?? [];
  if (reports.length > 0) {
    for (const report of reports) {
      for (const unit of report.units) {
        const id = lessonIdOfUnit(unit);
        if (id === undefined || !input.loaded.has(id) || !input.lessons.has(id)) continue;
        // The agent said it used it (when it reported), and the change touched the area (the worker's own check of the step; the broker's check of the changed files, when it has them, must agree).
        const claimed = report.reported ? unit.used === true && unit.areaTouched : unit.areaTouched;
        if (claimed && (input.touched === undefined || lessonAreaOverlap(input.lessons.get(id)!, input.touched))) eligible.add(id);
      }
    }
  } else {
    for (const id of input.loaded) {
      const lesson = input.lessons.get(id);
      if (lesson !== undefined && lessonAreaOverlap(lesson, input.touched)) eligible.add(id);
    }
  }
  const share = eligible.size === 0 ? 0 : 1 / eligible.size;
  return new Map([...eligible].sort().map((id) => [id, share] as const));
}
