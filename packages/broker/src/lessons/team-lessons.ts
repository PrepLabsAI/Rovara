// Lead 4 L4-LP3W: "Team lessons for this area". The ONE function that decides which approved lessons an agent is told in a code area, shown to a person on the area's wiki page. It reuses the knowledge look-up's own pieces
// (`pullable`, `unitOfLesson` of `knowledge-brief.ts`; the approval rule, the stage rule and the access-checked read of `selectLessons` of `load.ts`) and adds nothing of its own to what may be shown:
//   - only ACTIVE lessons the project's policy still counts as approved (`approvedForUse`: a person approved it, or it is stable and trials are allowed), unexpired, with no stale code citation;
//   - only scoped lessons a person approved or that are stable (`pullable`), and none that needs a person's look (`needsALook`: a retire is proposed, it contradicts or may duplicate another, it was sent back);
//   - only lessons the WHOLE PROJECT may read (`selectLessons` with no viewer and no running task: a restricted place, or a source task not open to the whole project, keeps a lesson out). An agent running a task that
//     is shared with the project is told at least these, so the page never promises more than an agent is told;
//   - read through the one read path (`readVisible`) again as the last step before anything is handed on: it can only remove a lesson.
// The words are `unitOfLesson`'s: the very unit the look-up sends a worker, so a person's row and an agent's line say the same sentence (a golden test holds it). Nothing is written. The text is the team's notes written from
// tasks and repository text: DATA. It carries no field that could grant a tool, a check, an approval or a limit.
import { knowledgeUnitId, type LessonStage, type TeamLessonRow } from "@agentx/contracts";
import { lessonAppliesToArea, needsALook } from "./area-index.js";
import { pullable, unitOfLesson } from "./knowledge-brief.js";
import { selectLessons, type LoadDeps } from "./load.js";
import { modeAllows, resolveLearning } from "./policy.js";
import { readVisible } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { hasStaleCitation } from "./trial.js";
import { wikiPageArea, type WikiPageAreaInput } from "./wiki-area.js";
import type { Lesson } from "./types.js";

/** The stages that may look up by tool: a lesson is in the section when an agent in any of them may be told it. */
const LOOKUP_STAGES: readonly LessonStage[] = ["UNDERSTAND", "PLAN", "IMPLEMENT"];
/** The page lists this many; the rest are counted. */
export const TEAM_LESSONS_PAGE_MAX = 30;
/** The most lessons one read looks at (it bounds the work whatever the project holds). */
const READ_MAX = 150;

export interface TeamLessonsInput {
  key: ScopeKey;
  /** The area (a repository and a folder: `src/billing`, "" for the whole repository), or the wiki page whose area is to be found (`wiki-area.ts`). */
  target: { area: { repo: string; folder: string } } | { page: Omit<WikiPageAreaInput, "lessonScopes"> };
}
/** `area` is absent when the page is about no single area (nothing is read for it beyond the list of scopes). */
export interface TeamLessonsRead { area?: { repo: string; folder: string }; lessons: Lesson[]; more: number }

const orderOf = (a: Lesson, b: Lesson): number => b.counters.helpful - a.counters.helpful || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * The lessons an agent in this area is told, for a person's page. Undefined when anything cannot be read (the caller answers a fixed "try again"); an empty list when learning does not load, the page has no area or nothing fits.
 */
export async function teamLessonsForArea(deps: LoadDeps, input: TeamLessonsInput): Promise<TeamLessonsRead | undefined> {
  const { key } = input;
  try {
    const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
    if (!modeAllows(resolved.mode, "load")) return { lessons: [], more: 0 };
    const now = deps.now();
    const live = (await deps.store.list(key, { statuses: ["active"] })).filter((lesson) => lesson.expiresAt > now && !hasStaleCitation(lesson));
    const area = "area" in input.target ? input.target.area : wikiPageArea({ ...input.target.page, lessonScopes: live.filter((lesson) => pullable(lesson)).map((lesson) => lesson.scope) });
    if (area === undefined) return { lessons: [], more: 0 };
    const active = live.filter((lesson) => lessonAppliesToArea(lesson.scope, area));
    if (active.length === 0) return { area, lessons: [], more: 0 };
    const union = new Map<string, Lesson>();
    for (const stage of LOOKUP_STAGES) {
      const selected = await selectLessons({ ...deps, embedder: undefined }, {
        key, stage, resolved, active, intent: "", repos: [area.repo], files: [], languages: [], reader: {}, where: "wiki",
        budget: { lessons: READ_MAX, bytes: 1_048_576 }, prefilter: async (eligible) => eligible.filter((lesson) => pullable(lesson) && !needsALook(lesson)),
      });
      if (!selected.ok) return undefined;
      for (const lesson of selected.picked) union.set(lesson.id, lesson);
    }
    // The last line before anything is handed on: the one read path once more, for nobody in particular (the whole project). It can only remove a lesson.
    const visible = await readVisible({ access: deps.access, key, viewer: undefined, lessons: [...union.values()], where: "wiki", log: deps.log });
    const lessons = visible.filter((lesson) => lesson.status === "active" && !needsALook(lesson)).sort(orderOf);
    return { area, lessons: lessons.slice(0, TEAM_LESSONS_PAGE_MAX), more: Math.max(0, lessons.length - TEAM_LESSONS_PAGE_MAX) };
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "error" });
    return undefined;
  }
}

/** One lesson as a row: built from `unitOfLesson`, the unit the agent's look-up carries, so both read the same words. */
export function teamLessonRowOf(lesson: Lesson): TeamLessonRow {
  const unit = unitOfLesson(lesson);
  return { id: knowledgeUnitId("lesson", lesson.id), lessonId: lesson.id, version: lesson.version, type: lesson.type, statement: unit.statement, why: unit.why, detail: unit.detail ?? "", scopeLabel: unit.scopeLabel, trust: "team-approved" };
}
