// The measurement that gates the file pass (design "Measure first"). A READ-ONLY count, per project and repository, of active lessons that are eligible for
// that repository's file and that are not, and the top reasons for "not" (fixed codes only), plus what share of recent reflections had every input readable by the readers of one repository.
//
// Counts only: the report holds no lesson text, no lesson id, no person, no source key. It is built from lessons the caller already read (the operator script `scripts/lessons-repo-eligibility-report.ts` scans the lesson heads; the
// tests hand it fakes), so nothing here touches a store, the network or a model. Pure.
//
// How a lesson is counted. The repositories a lesson is judged against are the ones it names: its `repoOnly` place, the repository places among its source scopes, and the repository its audience is restricted to. A lesson
// that names none is counted in the bucket `(none)`. Each lesson is counted once per repository it names, and a lesson with several reasons is counted under each reason (so reasons add up to more than "not eligible").
// The roster of display names is not read, so a lesson whose text names a person only by display name counts as eligible; an @handle or an e-mail address is still caught (`rosterChecked: false` says so).
import { REPO_PLACE, repoOnlyScopes } from "./project-repo-audience.js";
import { isRepoPlace, repoFileBlockers, type RepoEligibilityLesson } from "./repo-eligibility.js";
import type { LessonProvenance, RepoBlockCode } from "./types.js";

/** What the report reads of a lesson: the eligibility rule's fields plus when it was made, the places it named and the reflection that made it. The measurement script reads only these (a projection), never a whole item. */
export type ReportLesson = RepoEligibilityLesson & { createdAt: number; provenance: Pick<LessonProvenance, "sourceScopes" | "reflectorRun"> };

export const NO_REPO_BUCKET = "(none)";
export type ReportReason = `file:${string}` | `input:${RepoBlockCode}`;

export interface ReasonCount { reason: string; count: number }
export interface RepoLine {
  repo: string;
  /** Active lessons judged against this repository. */
  active: number;
  eligible: number;
  notEligible: number;
  /** Counts per reason, most common first. */
  topReasons: ReasonCount[];
}
export interface ProjectLine {
  workspace: string;
  project: string;
  /** Active lessons of the project, each once. */
  active: number;
  /** Active lessons eligible for at least one repository they name, each once. */
  eligibleForAny: number;
  /** The most common reasons across the project's lessons. */
  topReasons: ReasonCount[];
  repos: RepoLine[];
  /** Reflections (distinct reflector runs) whose first lesson was made since `sinceMs`, whatever became of the lesson. Reflections that made no lesson are not here (the broker's `learning.reflect_repo_visible` metric counts those). */
  recentReflections: number;
  /** Of those, how many had every input readable by the readers of one repository. */
  recentRepoVisible: number;
}
export interface RepoEligibilityReport {
  rosterChecked: false;
  sinceMs: number;
  lessonsRead: number;
  active: number;
  eligibleForAny: number;
  recentReflections: number;
  recentRepoVisible: number;
  /** Of the active lessons, the most common reasons across all projects. */
  topReasons: ReasonCount[];
  projects: ProjectLine[];
  notes: string[];
}

const NOTES = [
  "Counts only: no lesson text, no lesson id, no person.",
  "A lesson is counted once per repository it names; a lesson with several reasons is counted under each, so reasons add up to more than the number of lessons that are not eligible.",
  "Reasons beginning `input:` say what kept the lesson's INPUTS from being repository-only (set at reflection); `file:` reasons are the other rules (stage, approval, audience, naming, soundness).",
  "`predates_field` means the lesson was learned before the repository-only mark existed: it can never be eligible. Reflections are counted from the lessons they made, so a reflection that made no lesson, or whose lessons were merged into older ones, is not in the share (the broker's `learning.reflect_repo_visible` metric counts every reflection).",
  "Display names of people are not checked (the roster is not read); @handles and e-mail addresses are.",
];

/** The repositories a lesson names: its repoOnly place, the repository places among its source scopes, and the repository its audience is restricted to. */
export function reposNamedBy(lesson: ReportLesson): string[] {
  const places = new Set<string>();
  if (lesson.provenance.repoOnly !== undefined) places.add(lesson.provenance.repoOnly.place);
  for (const scope of lesson.provenance.sourceScopes ?? []) if (REPO_PLACE.test(scope)) places.add(scope);
  for (const place of repoOnlyScopes(lesson) ?? []) places.add(place);
  return [...places].filter(isRepoPlace).sort();
}

const top = (counts: Map<string, number>, limit: number): ReasonCount[] =>
  [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)).slice(0, limit);

const bump = (counts: Map<string, number>, reason: string): void => { counts.set(reason, (counts.get(reason) ?? 0) + 1); };

/** Why a lesson's inputs were not repository-only, from the fixed codes it carries; a lesson with none recorded predates the field. */
function inputReasons(lesson: ReportLesson): string[] {
  if (lesson.provenance.repoOnly !== undefined) return [];
  const codes = lesson.provenance.repoBlockCodes;
  return (codes === undefined || codes.length === 0 ? ["predates_field"] : codes).map((code) => `input:${code}`);
}

export interface ReportInput {
  workspaceId: string;
  project: string;
  lesson: ReportLesson;
}
export interface ReportOptions {
  /** Reflections count from lessons made at or after this time (ms). */
  sinceMs: number;
  /** The display names the lessons could name, if the caller has them; empty is "not checked". */
  names?: readonly string[];
  /** The most reasons listed per repository, project and in all. Default 5. */
  topReasons?: number;
}

/** Builds the report from lessons already read. Pure: no store, no network, no model. */
export function repoEligibilityReport(rows: Iterable<ReportInput>, options: ReportOptions): RepoEligibilityReport {
  const limit = options.topReasons ?? 5;
  const names = options.names ?? [];
  interface Acc { active: number; eligibleAny: number; reasons: Map<string, number>; repos: Map<string, { active: number; eligible: number; reasons: Map<string, number> }>; runs: Map<string, boolean> }
  const projects = new Map<string, Acc & { workspace: string; project: string }>();
  const all = new Map<string, number>();
  let lessonsRead = 0;
  let active = 0;
  let eligibleAny = 0;
  for (const { workspaceId, project, lesson } of rows) {
    lessonsRead += 1;
    const id = `${workspaceId}\u0001${project}`;
    let acc = projects.get(id);
    if (acc === undefined) { acc = { workspace: workspaceId, project, active: 0, eligibleAny: 0, reasons: new Map(), repos: new Map(), runs: new Map() }; projects.set(id, acc); }
    // Reflections: one per reflector run, judged by the first lesson seen for it (every draft of a run carries the same answer; a merge may later lower a lesson, so a run counts as visible only if no lesson of it says otherwise).
    if (lesson.createdAt >= options.sinceMs) {
      const run = lesson.provenance.reflectorRun;
      const visibleHere = lesson.provenance.repoOnly !== undefined;
      acc.runs.set(run, (acc.runs.get(run) ?? true) && visibleHere);
    }
    if (lesson.status !== "active") continue;
    active += 1;
    acc.active += 1;
    const repos = reposNamedBy(lesson);
    let eligibleHere = false;
    for (const repo of repos.length === 0 ? [NO_REPO_BUCKET] : repos) {
      const line = acc.repos.get(repo) ?? { active: 0, eligible: 0, reasons: new Map<string, number>() };
      acc.repos.set(repo, line);
      line.active += 1;
      const blockers = repo === NO_REPO_BUCKET ? ["file:no_repo_named" as const] : repoFileBlockers(lesson, repo, names).map((blocker) => `file:${blocker}` as const);
      const reasons = [...blockers, ...inputReasons(lesson)];
      if (reasons.length === 0) { line.eligible += 1; eligibleHere = true; } else for (const reason of reasons) { bump(line.reasons, reason); bump(acc.reasons, reason); bump(all, reason); }
    }
    if (eligibleHere) { acc.eligibleAny += 1; eligibleAny += 1; }
  }
  const lines: ProjectLine[] = [...projects.values()].sort((a, b) => (`${a.workspace}\u0001${a.project}` < `${b.workspace}\u0001${b.project}` ? -1 : 1)).map((acc) => ({
    workspace: acc.workspace, project: acc.project, active: acc.active, eligibleForAny: acc.eligibleAny, topReasons: top(acc.reasons, limit),
    repos: [...acc.repos].sort(([a], [b]) => (a < b ? -1 : 1)).map(([repo, line]) => ({ repo, active: line.active, eligible: line.eligible, notEligible: line.active - line.eligible, topReasons: top(line.reasons, limit) })),
    recentReflections: acc.runs.size, recentRepoVisible: [...acc.runs.values()].filter(Boolean).length,
  }));
  return {
    rosterChecked: false, sinceMs: options.sinceMs, lessonsRead, active, eligibleForAny: eligibleAny,
    recentReflections: lines.reduce((sum, line) => sum + line.recentReflections, 0), recentRepoVisible: lines.reduce((sum, line) => sum + line.recentRepoVisible, 0),
    topReasons: top(all, limit), projects: lines, notes: NOTES,
  };
}
