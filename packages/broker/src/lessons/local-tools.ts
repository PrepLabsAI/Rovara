// Lessons for local coding tools (decisions 46b, 47, 50a). A local coding tool asks Rovara "which team lessons apply to this repository and this change?"
// and gets a short markdown block. Everything here is read live on every call and nothing is kept (no cache), so a lesson that is erased, narrowed or retired is gone on the next call.
//
// Who may ask and what they get (owner decision 46b):
//   - the CALLER is checked by the route (their own sign-in or their own `lessons` script token, on the project's roster now); this module never sees a shared key;
//   - the lessons are those the WHOLE PROJECT may read, never the caller's wider personal view (decision 32: `selectLessons` with no running task and no viewer, so every source task must be open to the whole project
//     with no People denial, and the access records must not restrict the place), because what a local tool reads ends up in commits, pull requests and a model vendor's chat;
//   - only STABLE or PERSON-APPROVED lessons (a lesson still on trial, or one that went live with no person, is left out: a local session has no outcome, so nothing could measure it);
//   - a lesson restricted only to ONE project repository (decision 36) is returned only for that repository, and for no repository at all it is not returned;
//   - a lesson whose text names a person is left out, and so is one whose authors cannot be looked up (a failed names read is never "no names");
//   - the install's lessons switch off (decision 47), the company's "lessons stay in Rovara" switch, a project in learning Off, the Regulated preset, or the project's own local-tools setting off: nothing is returned and the
//     answer says why in a fixed sentence (`LOCAL_OFF_MESSAGES`).
// It makes no model call and no embedder call (ranking is keywords and cited paths), writes no load manifest and does not count a "load" (no outcome will follow).
//
// Lessons that are repo-file eligible live in the merged `.rovara/lessons.md` (decision 50a). A tool that reads that file asks with `skipRepoFile` and gets only the lessons NOT already merged into that repository's file;
// without it the lessons in the file are returned and marked `inRepoFile`, so a tool that reads both can drop the duplicates. A failed read of the file's state leaves the lesson in (a repeat is harmless; a gap is not).

import { LOCAL_LESSONS_NOTES_LINE, LOCAL_LESSONS_UNAVAILABLE_LINE, OrgIdSchema, cleanLessonText, type LearnedLesson, type LessonStage } from "@agentx/contracts";
import { LOAD_MAX_BYTES, LOAD_MAX_LESSONS, hasStaleCitation, selectLessons, type LoadDeps } from "./load.js";
import { learnedLessonsSwitchOn, modeAllows, resolveLearning, resolveLoadBudget, type LearningSettingsReader, type LoadBudget } from "./policy.js";
import { mayNameInRepository, projectRepoScopesOf } from "./project-repo-audience.js";
import { readVisible } from "./read-visible.js";
import { normalizeRemote } from "./repo-remote.js";
import { hasPersonApproval } from "./repo-eligibility.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { namesAPerson } from "./trial.js";
import type { Lesson } from "./types.js";

/** The stages a tool names, and the lesson stage each is. A review stage still needs tier-2 approval (`stageAllows`). */
export const LOCAL_STAGES = { plan: "PLAN", code: "IMPLEMENT", review: "REVIEW" } as const;
export type LocalStage = keyof typeof LOCAL_STAGES;
export const LOCAL_STAGE_DEFAULT: LocalStage = "code";
/** `all`: the whole allowed set for the repository in one block (ranked, within these caps). */
export const LOCAL_ALL_MAX_LESSONS = 300;
export const LOCAL_ALL_MAX_BYTES = 64 * 1024;
const ALL_PAGE = 50;
/** One line of advice and one line of why are each cut at this many characters. */
export const LOCAL_TEXT_MAX = 300;
export const LOCAL_TASK_TEXT_MAX = 2_000;
export const LOCAL_FILES_MAX = 50;

/** Why nothing is returned, in fixed codes. */
export const LOCAL_OFF_REASONS = ["install_switch", "company_stays", "learning_off", "regulated", "project_setting"] as const;
export type LocalOffReason = (typeof LOCAL_OFF_REASONS)[number];
export const LOCAL_OFF_MESSAGES: Readonly<Record<LocalOffReason, string>> = {
  install_switch: "Lessons are switched off for this Rovara installation, so there are no lessons to give.",
  company_stays: "Your company keeps lessons inside Rovara, so local coding tools get none.",
  learning_off: "Lessons are off for this project, so there are no lessons to give.",
  regulated: "This project is on the Regulated preset, so local coding tools get no lessons.",
  project_setting: "Local coding tools are switched off for this project's lessons.",
};
/** What a tool says when Rovara cannot answer (the CLI and the MCP tool print this, and carry on). */
export const LOCAL_UNAVAILABLE_LINE = LOCAL_LESSONS_UNAVAILABLE_LINE;

/** The two settings of decision 46b. `projectOn` is the project's own choice (absent: on, because the default is on under Standard); `companyStays` is the company's "lessons stay in Rovara" switch (absent: off). */
export interface LocalToolsSettings { projectOn?: boolean | undefined; companyStays: boolean }
export interface LocalToolsSettingsReader {
  /** Read now, never cached. Throws when a stored value cannot be read or is not valid (the caller fails closed). */
  read(workspaceId: string, project: string): Promise<LocalToolsSettings>;
}
/** The reader and the two writers (`local-tools-setting.ts` audits each change before it calls them). */
export interface LocalToolsSettingsStore extends LocalToolsSettingsReader {
  /** The company's switch alone (true: lessons stay in Rovara). Throws when it cannot be read or is not valid. */
  readCompany(workspaceId: string): Promise<boolean>;
  setProject(workspaceId: string, project: string, enabled: boolean, at: number): Promise<void>;
  setCompany(workspaceId: string, stays: boolean, at: number): Promise<void>;
}
/** The day's count for one person and project, with no text: calls, lessons returned, and a fixed refusal code. A failure to count never blocks the answer. */
export interface LocalToolsCounter { count(event: { orgId: string; project: string; developerId: string; lessons: number; refusal?: string | undefined }): Promise<void> }

export interface LocalLessonsDeps {
  store: LessonStore; settings: LearningSettingsReader; access: LoadDeps["access"]; localTools: LocalToolsSettingsReader;
  /**
   * The display names of the people a lesson could name: the project's members and the people of the lessons asked about (the repo-file pass's rule), read now. Throws when a name cannot be read or there are too many to look up; absent:
   * the call is "unavailable". A lesson whose text holds any of them (or an @handle or an e-mail address) is left out.
   */
  names?: ((key: ScopeKey, lessons: readonly Lesson[]) => Promise<readonly string[]>) | undefined;
  resolveMember?: LoadDeps["resolveMember"] | undefined;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** The ids of the lessons merged into the repository's `.rovara/lessons.md` (its publish state's `rendered`), or undefined when not known. */
  repoFileIds?: ((key: ScopeKey, place: string) => Promise<ReadonlySet<string> | undefined>) | undefined;
}

export interface LocalLessonsInput {
  orgId: string; project: string;
  /** The git remote the tool read in its checkout. Absent: no repository, so only lessons with no repository scope. */
  remote?: string | undefined;
  /** What the change is, one line from the tool. It only ranks (it is never stored, logged or sent anywhere). */
  task?: string | undefined; files?: readonly string[] | undefined; stage?: LocalStage | undefined;
  all?: boolean | undefined; skipRepoFile?: boolean | undefined;
}
export interface LocalLesson { id: string; advice: string; why?: string | undefined; citation?: string | undefined; inRepoFile?: true | undefined }
export interface LocalLessonsAnswer {
  status: "ok" | "off"; reason?: LocalOffReason | undefined; message: string;
  project: string; repo?: string | undefined; lessons: LocalLesson[]; markdown: string;
  /** False when the time budget ended before every candidate was checked: what was not checked is not offered. */
  complete: boolean;
}
export type LocalLessonsOutcome = { kind: "answer"; answer: LocalLessonsAnswer } | { kind: "unknown_repo" };

/** A read inside the call failed: the route answers 503 and the tool says `LOCAL_UNAVAILABLE_LINE`. Never a partial list presented as complete. */
export class LocalLessonsUnavailable extends Error { constructor(readonly code: string) { super(`local lessons unavailable: ${code}`); this.name = "LocalLessonsUnavailable"; } }

/** The stable lessons and the person-approved ones (decision 46b). A lesson on trial, or live with no person behind it, is not given to a local tool. */
export const stableOrPersonApproved = (lesson: Pick<Lesson, "trial" | "approvals">): boolean => lesson.trial?.state !== "trial" && (lesson.trial?.state === "stable" || hasPersonApproval(lesson));

/**
 * Text that leaves Rovara is held to the repo file's soundness (`repo-eligibility.ts`): a lesson sent back to a person, one proposed for retirement, one with a thumbs-down and a tier-2 lesson that is not a review check
 * (a review check approved by two people is what the review stage is for) stay in Rovara.
 */
export const soundForLeaving = (lesson: Pick<Lesson, "tier" | "type" | "reviewRequired" | "retireProposedAt" | "counters">): boolean =>
  lesson.reviewRequired !== true && lesson.retireProposedAt === undefined && lesson.counters.harmful === 0 && (lesson.tier < 2 || lesson.type === "review_check");

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\brovara:task[/:]\S+|\b(?:www\.)\S+/giu;
const TASK_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
/** One line of lesson text for a tool: hygiene as everywhere, no link and no task id, whitespace folded, cut at `LOCAL_TEXT_MAX`. */
export function oneLine(text: string, max = LOCAL_TEXT_MAX): string {
  const folded = cleanLessonText(text, 4 * max).replace(URL_LIKE, "[link removed]").replace(TASK_ID, "[id removed]").replace(/\s+/gu, " ").trim();
  const points = [...folded];
  return points.length <= max ? folded : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}
const oneLinePath = (path: string): string => path.replace(/[^\w./@+-]/gu, "_").slice(0, 200);

function localLesson(lesson: Lesson, learned: LearnedLesson, inRepoFile: boolean): LocalLesson {
  const cite = learned.citations[0];
  const why = oneLine(lesson.description);
  return {
    id: lesson.id, advice: oneLine(lesson.title),
    ...(why === "" ? {} : { why }),
    ...(cite === undefined ? {} : { citation: `${oneLinePath(cite.path)}:${String(cite.startLine)}` }),
    ...(inRepoFile ? { inRepoFile: true as const } : {}),
  };
}

/** The markdown a tool gets (design section 1): a one-line header comment, the lessons, nothing else. LF only; no link, no task id, no person. */
export function renderLocalLessons(input: { project: string; repo?: string | undefined; lessons: readonly LocalLesson[]; at: number; complete: boolean; note?: string | undefined }): string {
  const header = (text: string): string => `<!-- ${text.replace(/-->|--!>|[\r\n]/gu, " ")} -->`;
  const where = `project "${oneLine(input.project, 100)}"${input.repo === undefined ? "" : `, repo ${oneLine(input.repo, 200)}`}`;
  const when = new Date(input.at).toISOString().slice(0, 16).replace("T", " ");
  if (input.note !== undefined) return `${header(`Rovara lessons for ${where}. Checked ${when} UTC.`)}\n${oneLine(input.note, 400)}\n`;
  if (input.lessons.length === 0) return `${header(`Rovara lessons for ${where}. No lessons fit this change. Checked ${when} UTC.`)}\n`;
  // Each lesson is one quoted line (data from the team, not a command), after the fixed notes line.
  const lines = input.lessons.map((lesson) => `> - [${lesson.id}] ${lesson.advice}${lesson.why === undefined ? "" : ` Why: ${lesson.why}`}${lesson.citation === undefined ? "" : ` See ${lesson.citation}`}${lesson.inRepoFile === true ? " (also in .rovara/lessons.md)" : ""}`);
  return [
    header(`Rovara lessons for ${where}. ${String(input.lessons.length)} ${input.lessons.length === 1 ? "lesson fits" : "lessons fit"} this change. Checked ${when} UTC.${input.complete ? "" : " Some lessons could not be checked in time."}`),
    "## Team lessons (from Rovara; follow them unless the task says otherwise)",
    LOCAL_LESSONS_NOTES_LINE,
    ...lines, "",
  ].join("\n");
}

const refuse = (input: LocalLessonsInput, deps: LocalLessonsDeps, reason: LocalOffReason): LocalLessonsOutcome => ({
  kind: "answer",
  answer: { status: "off", reason, message: LOCAL_OFF_MESSAGES[reason], project: input.project, lessons: [], markdown: renderLocalLessons({ project: input.project, lessons: [], at: deps.now(), complete: true, note: LOCAL_OFF_MESSAGES[reason] }), complete: true },
});

/**
 * The lessons for a local tool, or why there are none. Throws `LocalLessonsUnavailable` when a read fails (the project's settings, the store, the project's repositories); returns `unknown_repo` when the remote is not one of the
 * project's repositories. The caller (the route) has already checked the person and the project's roster. Never writes, never calls a model.
 */
export async function lessonsForLocalTool(deps: LocalLessonsDeps, input: LocalLessonsInput): Promise<LocalLessonsOutcome> {
  const key: ScopeKey = { workspaceId: input.orgId, project: input.project };
  // The repository is proved FIRST (it reads only the project's own definition): an address that is not one of this project's repositories is "no such repository" whatever is switched off, so a client that asks every project
  // meets another project's "off" never, and only the project that holds the repository can say "off".
  // Which repository: the remote is proved against the project's registered repositories; one that is not theirs is "no such repository", with nothing else said.
  let repo: { name: string; place?: string | undefined } | undefined;
  if (input.remote !== undefined) {
    const remote = normalizeRemote(input.remote);
    if (remote === undefined) return { kind: "unknown_repo" };
    const port = projectRepoScopesOf(deps.access.taskVisibility);
    const org = OrgIdSchema.safeParse(key.workspaceId);
    if (port?.byRemote === undefined || !org.success) throw new LocalLessonsUnavailable("repositories");
    try { repo = await port.byRemote(org.data, key.project, remote); } catch { throw new LocalLessonsUnavailable("repositories"); }
    if (repo === undefined) return { kind: "unknown_repo" };
  }

  // Decision 47: the install's lessons switch is off, so no lesson and no setting is read at all.
  if (!learnedLessonsSwitchOn()) return refuse(input, deps, "install_switch");
  let local: Awaited<ReturnType<LocalToolsSettingsReader["read"]>>;
  try { local = await deps.localTools.read(key.workspaceId, key.project); } catch { throw new LocalLessonsUnavailable("settings"); }
  if (local.companyStays) return refuse(input, deps, "company_stays");
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return refuse(input, deps, "learning_off");
  if (resolved.preset === "regulated") return refuse(input, deps, "regulated");
  if (local.projectOn === false) return refuse(input, deps, "project_setting");

  let active: Lesson[];
  try {
    const now = deps.now();
    active = (await deps.store.list(key, { statuses: ["active"] })).filter((lesson) => lesson.expiresAt > now && !hasStaleCitation(lesson));
  } catch { throw new LocalLessonsUnavailable("store"); }

  // What is merged into the repository's own file now (decision 50a), so a tool that reads the file is not given the same lesson twice.
  let inFile: ReadonlySet<string> | undefined;
  if (repo?.place !== undefined && deps.repoFileIds !== undefined) {
    try { inFile = await deps.repoFileIds(key, repo.place); } catch { inFile = undefined; }
  }
  const place = repo?.place;
  let namesUnknown = false;
  const prefilter = async (eligible: readonly Lesson[]): Promise<Lesson[]> => {
    const fits = eligible.filter((lesson) => stableOrPersonApproved(lesson) && soundForLeaving(lesson) && mayNameInRepository(lesson, place) && !(input.skipRepoFile === true && inFile?.has(lesson.id) === true));
    if (fits.length === 0) return [];
    // The names are read only when some lesson could go out. A roster that cannot be read, or one too large to look up, withholds EVERYTHING (never "no names").
    let names: readonly string[];
    try {
      if (deps.names === undefined) throw new Error("no names reader");
      names = await deps.names(key, fits);
    } catch { namesUnknown = true; return []; }
    return fits.filter((lesson) => !namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), names));
  };

  const all = input.all === true;
  const budget: LoadBudget = all ? { lessons: LOCAL_ALL_MAX_LESSONS, bytes: LOCAL_ALL_MAX_BYTES } : resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES });
  const stage: LessonStage = LOCAL_STAGES[input.stage ?? LOCAL_STAGE_DEFAULT];
  // No embedder and no vectors are given: the ranking is keywords and cited paths, so the task text never leaves this process and the call costs nothing.
  const select: LoadDeps = {
    store: deps.store, settings: deps.settings, access: deps.access, now: deps.now, audit: { emit: async () => undefined }, vectors: { get: async () => new Map(), put: async () => undefined, remove: async () => undefined },
    ...(deps.resolveMember === undefined ? {} : { resolveMember: deps.resolveMember }), ...(deps.log === undefined ? {} : { log: deps.log }),
  };
  const files = (input.files ?? []).slice(0, LOCAL_FILES_MAX);
  const selected = await selectLessons(select, {
    key, stage, resolved, active, intent: (input.task ?? "").slice(0, LOCAL_TASK_TEXT_MAX), repos: repo === undefined ? [] : [repo.name], files, languages: [],
    reader: {}, where: "local_tools", budget, prefilter, ...(all ? { pageSize: ALL_PAGE } : {}),
  });
  if (namesUnknown) throw new LocalLessonsUnavailable("names");
  if (!selected.ok) throw new LocalLessonsUnavailable(selected.skipped);
  // The last line before anything leaves Rovara: what was picked goes through the one read path again, as for nobody in particular, with the same reader (so no task is read twice). It can only remove a lesson.
  let allowed: ReadonlySet<string>;
  try { allowed = new Set((await readVisible({ access: deps.access, key, viewer: undefined, live: selected.live, lessons: selected.picked, where: "local_tools", log: deps.log })).map((lesson) => lesson.id)); } catch { throw new LocalLessonsUnavailable("access"); }
  const lessons = selected.picked.flatMap((lesson, index) => (allowed.has(lesson.id) ? [localLesson(lesson, selected.chosen[index]!, inFile?.has(lesson.id) === true)] : []));
  const markdown = renderLocalLessons({ project: input.project, ...(repo === undefined ? {} : { repo: normalizeRemote(input.remote!)! }), lessons, at: deps.now(), complete: selected.complete });
  return { kind: "answer", answer: { status: "ok", message: "", project: input.project, ...(repo === undefined ? {} : { repo: normalizeRemote(input.remote!)! }), lessons, markdown, complete: selected.complete } };
}
