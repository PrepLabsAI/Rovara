// "Lessons used", what a task's pull request description says about the lessons the task loaded. The description is read by everyone who can see the repository, so:
//  - a repository that is PUBLIC, or whose visibility is UNKNOWN, gets only the number of lessons and one link to the task page (the titles are behind sign-in);
//  - a repository known to be PRIVATE also lists the lessons, each with a "not helpful" link, except tier-2 and review-check lessons and any that name a person (or whose authors cannot be named);
//  - a lesson learned from a restricted place is never counted or named; only lessons that reached the agent's prompt count (and may still be given to the task); at most LESSONS_USED_MAX are listed;
//  - a lesson is NAMED only when every task it was learned from is open to the whole project with no People denial, checked live; otherwise it is only counted;
//  - a lesson restricted only to ONE project repository A is counted in every pull request of the project but NAMED only in a pull request of repository A itself; the pull request's repository
//    comes in `input.repo`, and a repository that is not known is "not A".
// The reader is plugged in at handler start where lessons are on (`setLessonsUsedReader`), the way Home's lessons card is; without it, or with learning off for the project, the description has no section.
import { OrgIdSchema } from "@agentx/contracts";
import type { AccessCheckPort } from "./access-port.js";
import { createLessonLiveReader } from "./live-visibility.js";
import { readVisible } from "./read-visible.js";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { namesAPerson } from "./trial.js";
import { mayNameInRepository, projectRepoScopesOf, repoOnlyScopes } from "./project-repo-audience.js";
import type { Lesson } from "./types.js";
import type { AttributionReader } from "./people.js";

export const LESSONS_USED_MAX = 30;
/** Whether the people who can read the repository are limited to the company's own: a public or unknown repository is read by everyone. */
export type RepositoryVisibility = "private" | "public" | "unknown";
/** What the host said about each of a project's repositories (`undefined`: it could not say): private only when it said so for EVERY one; public when it said any is not; otherwise unknown. */
export function visibilityOfRepositories(answers: ReadonlyArray<{ private?: boolean | undefined } | undefined>): RepositoryVisibility {
  if (answers.length === 0) return "unknown";
  if (answers.some((a) => a?.private === false)) return "public";
  return answers.every((a) => a?.private === true) ? "private" : "unknown";
}
export interface LessonUsed { id: string; title: string; /** The link that opens the task page ready to mark the lesson not helpful. Empty where the install has no page a pull request can link to. */ notHelpfulUrl: string }
/**
 * What the description says: how many lessons the task used and ONE link to the task page (titles are behind sign-in), and, only for a repository known to be private, the lessons themselves.
 * `items` is empty for a public repository and for one whose visibility is unknown.
 */
export interface LessonsUsedSummary { count: number; taskUrl: string; items: readonly LessonUsed[] }
export interface LessonsUsedInput {
  orgId: string; project: string; taskId: string; /** The task page's address (https); the link is this page with the lesson named. */ pageUrl: string | undefined;
  /** The project repository (its name in the project definition) the pull request is in. Absent: unknown, so a lesson restricted to one repository is only counted. */
  repo?: string | undefined;
  /** The project revision the task started on: `repo` is a name in THAT revision, and its GitHub repository id is what is compared. Absent: the repository is unknown. */
  startingRevision?: number | undefined;
}
export type LessonsUsedReader = (input: LessonsUsedInput) => Promise<LessonsUsedSummary | undefined>;

let reader: LessonsUsedReader | undefined;
export function setLessonsUsedReader(next: LessonsUsedReader | undefined): void { reader = next; }
/** The lessons the task used, or none: never throws (a description never waits on, or fails because of, lessons). */
export async function lessonsUsedForTask(input: LessonsUsedInput): Promise<LessonsUsedSummary | undefined> {
  const read = reader;
  if (read === undefined || input.pageUrl === undefined) return undefined;
  try { return await read(input); } catch { return undefined; }
}

/** The description's section for a summary (the shape `PullRequestBodyContext.lessonsUsed` takes). */
export const lessonsUsedSection = (summary: LessonsUsedSummary | undefined): { count: number; taskUrl: string; entries: ReadonlyArray<{ title: string; notHelpfulUrl: string; number?: number }> } | undefined =>
  summary === undefined || summary.count <= 0 ? undefined : { count: summary.count, taskUrl: summary.taskUrl, entries: summary.items.map((l, index) => ({ title: l.title, notHelpfulUrl: l.notHelpfulUrl, ...(l.notHelpfulUrl === "" ? { number: index + 1 } : {}) })) };

const REACHED = new Set(["valid", "moved", "none"]);
/** The task page's address as an https link with nothing else on it (no query, no fragment), or undefined. */
export function plainTaskUrl(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:") return undefined;
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return undefined; }
}
/** The link: the task page with `notHelpful=<lesson id>`; the page asks before it marks anything. */
export function notHelpfulUrl(pageUrl: string, lessonId: string): string | undefined {
  const base = plainTaskUrl(pageUrl);
  if (base === undefined) return undefined;
  const url = new URL(base);
  url.searchParams.set("notHelpful", lessonId);
  return url.href;
}

export interface LessonsUsedReaderDeps {
  store: LessonStore; settings: LearningSettingsReader; access: AccessCheckPort;
  /** Whether the project's repositories are private. Absent or failing: unknown, so only the count and the link are written. */
  visibility?: (orgId: string, project: string) => Promise<RepositoryVisibility>;
  /** Display names of the people a lesson could name (its authors and editors), so a title that names one is not listed. A lesson whose people cannot be named is not listed either. */
  names?: AttributionReader;
  /**
   * The install has no page a pull request can link to (a laptop's pages are on loopback): the description counts the lessons and, for a repository known to be private, names them with the number a comment command
   * takes (`/rovara lesson <number> wrong`), with no link. Without it a reader that has no https page address gives no section.
   */
  commands?: boolean;
}

export function lessonsUsedReaderOver(deps: LessonsUsedReaderDeps): LessonsUsedReader {
  return async (input) => {
    if (input.pageUrl === undefined && deps.commands !== true) return undefined;
    const taskUrl = input.pageUrl === undefined ? "" : plainTaskUrl(input.pageUrl);
    if (taskUrl === undefined) return undefined;
    const key: ScopeKey = { workspaceId: input.orgId, project: input.project };
    if (!modeAllows((await resolveLearning(deps.settings, key.workspaceId, key.project)).mode, "load")) return undefined;
    const visibility: RepositoryVisibility = await Promise.resolve().then(() => (deps.visibility === undefined ? "unknown" as const : deps.visibility(input.orgId, input.project))).catch(() => "unknown" as const);
    const seen = new Set<string>();
    const used: Lesson[] = [];
    // Two readers for the whole description that share their reads (each source task is read once, not once per reader). COUNT (`live`): the lessons the task used that it may still be given: the audience of the task itself lies within every source task's
    //, checked live. NAME (`wide`): a pull request is readable by anyone with access to the repository, so a lesson is named only while EVERY task it was learned from is open to the whole project with no
    // People denial, checked live ("nobody in particular"); the repository must also be known private (below). Anything else is counted and linked, not named.
    const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "pull_request", running: { taskId: input.taskId } });
    const wide = live.withoutRunningTask(); // shares what `live` has read: each source task is read once for the whole description
    for (const manifest of await deps.store.manifests(key, input.taskId)) {
      for (const entry of manifest.lessons) {
        if (seen.has(entry.id) || !REACHED.has(entry.citation)) continue;
        seen.add(entry.id);
        const lesson = await deps.store.get(key, entry.id);
        // Read as "nobody in particular" for restricted places: a lesson from a restricted place, or one whose place the access records restrict now, is not counted in a description the repository's readers see.
        if (lesson === undefined || (await readVisible({ access: deps.access, key, viewer: undefined, live, lessons: [lesson], where: "pull_request" })).length !== 1) continue;
        used.push(lesson);
      }
    }
    if (used.length === 0) return undefined;
    const items: LessonUsed[] = [];
    // Titles only where every reader of the repository is the company's own, and only the harmless ones: no tier-2 or review-check lesson, no title that names a person.
    if (visibility === "private") {
      // The place of the pull request's repository, read live from the project definition; a repository the project does not pin, or one that cannot be read, is "unknown".
      const target = used.some((lesson) => repoOnlyScopes(lesson) !== undefined) ? await targetPlaceOf(deps.access.taskVisibility, input) : undefined;
      for (const lesson of used) {
        if (items.length >= LESSONS_USED_MAX) break;
        if (lesson.tier >= 2 || lesson.type === "review_check" || !mayNameInRepository(lesson, target) || !(await namesNobody(deps.names, input.orgId, lesson))) continue;
        // Named only when every source task is open to the whole project (no People denial), read now.
        if ((await wide.keep(undefined, [lesson])).length !== 1) continue;
        const url = input.pageUrl === undefined ? "" : notHelpfulUrl(input.pageUrl, lesson.id);
        if (url !== undefined) items.push({ id: lesson.id, title: lesson.title, notHelpfulUrl: url });
      }
    }
    return { count: used.length, taskUrl, items };
  };
}

/** The place of the pull request's repository, or undefined (no repository given, not a pinned GitHub repository of the project, no port, or a read that fails). */
async function targetPlaceOf(port: object | undefined, input: LessonsUsedInput): Promise<string | undefined> {
  const repos = projectRepoScopesOf(port);
  if (repos?.placeOf === undefined || input.repo === undefined) return undefined;
  const org = OrgIdSchema.safeParse(input.orgId);
  if (!org.success) return undefined;
  try { return await repos.placeOf(org.data, input.project, input.repo, input.startingRevision); } catch { return undefined; }
}

/** True when neither the lesson's text nor its title names a person: an @handle, an e-mail address, or the display name of anyone who wrote it. Unknown (no reader, or it fails) is false. */
async function namesNobody(names: AttributionReader | undefined, orgId: string, lesson: Lesson): Promise<boolean> {
  if (names === undefined) return false;
  try {
    const display: string[] = [];
    for (const id of new Set([...lesson.provenance.authors, ...(lesson.provenance.editors ?? [])])) {
      const name = await names.memberName(orgId, id);
      if (name !== undefined) display.push(name);
    }
    return !namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), display);
  } catch { return false; }
}
