// A lesson restricted ONLY because its evidence came from a repository that belongs to the lesson's project (PR review comments, human fix-up commits and the like in a
// private project repository) counts as visible to the whole project for lessons. Everything that keeps a lesson's audience correct (the live audience of every source task) then applies as for any project-wide lesson.
//
// The shape this recognises is exactly what capture writes for a code-host row (the code host capture's `audienceOf`): a restricted audience whose ACL has NO principals and NO groups, and whose scope is one
// or more `<source>:repo/<repository id>` places joined by `+` (two sources intersect to their scopes joined, `narrowestAudience`). It is treated as project-wide only while EVERY one of those places is the place of a
// repository the project has NOW, read live from the project definition (`ProjectRepoScopesPort`). Anything else stays restricted and unloaded: a Slack channel, a tracker, a repository that is another project's or
// is no longer the project's, an explicit list, a scope joined with any other place, a scope cut at its length limit (it ends with the place `CUT_SCOPE_PLACE`, which no record matches, and a scope of the limit's length is never believed). A definition that cannot be read means no lesson is converted (fail closed).
//
// This narrows what the conversion allows: the lesson LOADS into any project task, but it is NAMED in a pull request's "Lessons used" list and PUBLISHED only in the repository it is restricted to (`mayNameInRepository`);
// a project rule is read in every repository, so such a lesson is not promoted (`promote.ts`). A repository whose place the Team record has closed (deleted, transferred out or excluded) is not the project's any more here,
// though its pinned id may still be in the project definition (a hosted install's `ProjectRepoScopesPort`).
//
// This is for lessons ONLY. The Team record's own access check (the access check) is unchanged: it still answers "restricted" for these rows, and `viewedForLessons` merely stops asking it
// about places that are the project's own repositories. Callers keep the lesson they passed in; only the checks look at the converted copy.
import type { OrgId } from "@agentx/contracts";
import { ACL_SCOPE_MAX, type Lesson } from "./types.js";

/** The places (`<source>:repo/<id>`) of the repositories a project has now. Throws when the project definition cannot be read. */
export interface ProjectRepoScopesPort {
  read(orgId: OrgId, project: string): Promise<ReadonlySet<string>>;
  /**
   * The place (`github:repo/<id>`) of the repository a pull request is in. `name` is the repository's name in the project revision the task STARTED on (`startingRevision`); that revision gives the GitHub
   * repository id, which is what is compared with the project's repositories now, so a rename or a later revision cannot make the name mean another repository. Undefined (unknown) when there is no starting
   * revision, either side has no pinned id, or the repository is not one of the project's now. Throws when the project definition cannot be read. Absent: no pull request can name a repository-only lesson.
   */
  placeOf?(orgId: OrgId, project: string, name: string, startingRevision?: number): Promise<string | undefined>;
  /**
   * Lessons for local coding tools (decision 46b): the project repository whose REGISTERED address is `remote` (already normalised by `normalizeRemote`), by the project's latest revision, read now. `name` is its name in the
   * project (what a lesson's scope names); `place` is its `<host>:repo/<id>`, absent when the host cannot say the repository's id (so a lesson restricted to a repository is then never returned for it). Undefined when no
   * repository of the project has that address. Throws when the project definition cannot be read. Absent: a local tool's repository cannot be proved, so nothing is returned.
   */
  byRemote?(orgId: OrgId, project: string, remote: string): Promise<{ name: string; place?: string } | undefined>;
}

/** The port rides on the task-visibility port the access check carries (as the lesson audiences do), so the shared access port and the Team record's port types stay exactly as they were. */
export interface WithProjectRepoScopes { projectRepoScopes: ProjectRepoScopesPort }

export function withProjectRepoScopes<T extends object>(port: T, scopes: ProjectRepoScopesPort): T & WithProjectRepoScopes {
  return Object.assign(Object.create(Object.getPrototypeOf(port) as object | null), port, { projectRepoScopes: scopes }) as T & WithProjectRepoScopes;
}

export function projectRepoScopesOf(port: object | undefined): ProjectRepoScopesPort | undefined {
  const found = (port as Partial<WithProjectRepoScopes> | undefined)?.projectRepoScopes;
  return found !== undefined && typeof found.read === "function" ? found : undefined;
}

export const REPO_PLACE = /^[a-z][a-z0-9:._-]*:repo\/[^+\s]+$/;

/** The repository places of a lesson whose restriction is exactly "readers of these repositories" (see the top of this file); `undefined` for any other lesson. Pure. */
export function repoOnlyScopes(lesson: { provenance: { audience: Lesson["provenance"]["audience"] } }): string[] | undefined {
  const audience = lesson.provenance.audience;
  if (audience.kind !== "restricted") return undefined;
  const acl = audience.acl;
  if (acl.principals !== undefined || acl.groups !== undefined) return undefined;
  // A scope at the length limit may have been cut (`narrowestAudience` ends a cut one with a place nobody matches, but a lesson stored before that, or one cut elsewhere, has none): the places after the cut are unknown, so
  // this is not "exactly these repositories" and the lesson stays restricted (fails closed, review).
  if (acl.scope.length >= ACL_SCOPE_MAX) return undefined;
  const places = acl.scope.split("+");
  return places.length > 0 && places.every((place) => REPO_PLACE.test(place)) ? places : undefined;
}

/** Whether the project's repositories could change how this lesson is judged: its restriction is exactly repository readers, or it is project-wide and names a repository place among its sources. Pure. */
export function mentionsRepoPlace(lesson: Pick<Lesson, "provenance">): boolean {
  if (repoOnlyScopes(lesson) !== undefined) return true;
  return lesson.provenance.audience.kind === "project" && (lesson.provenance.sourceScopes ?? []).some((scope) => REPO_PLACE.test(scope));
}

/**
 * A lesson restricted ONLY to repository A loads into any project task, but it is NAMED in a pull request's "Lessons used" list and PUBLISHED into AGENTS.md
 * (and similar files) only in repository A itself. In the project's other repositories the pull request only counts it. `targetPlace` is the place (`github:repo/<id>`) of the repository the text goes into;
 * undefined (not known) is "not A". Every other lesson (project-wide, or restricted for another reason, which never gets here) is not limited by this rule. The restriction is read from the lesson's OWN audience,
 * whether or not it has been converted by `viewedForLessons`. Pure.
 */
export function mayNameInRepository(lesson: Pick<Lesson, "provenance">, targetPlace: string | undefined): boolean {
  const places = repoOnlyScopes(lesson);
  if (places === undefined) return true;
  return targetPlace !== undefined && places.every((place) => place === targetPlace);
}

/**
 * The lesson as the lesson read paths judge it: when its restriction is exactly the readers of repositories that are ALL the project's own now (`projectRepos`), it is project-wide and those places are no
 * longer places the access records are asked about. A project-wide lesson that names a project repository among its sources (a repository that has gone private since) stops being asked about that place too.
 * `projectRepos` undefined (not asked, or unreadable) leaves the lesson as it is, restricted. Returns the same object when nothing changes.
 */
export function viewedForLessons<T extends Pick<Lesson, "provenance">>(lesson: T, projectRepos: ReadonlySet<string> | undefined): T {
  if (projectRepos === undefined) return lesson;
  const places = repoOnlyScopes(lesson);
  const restrictedToProjectRepos = places !== undefined && places.every((place) => projectRepos.has(place));
  if (places !== undefined && !restrictedToProjectRepos) return lesson;
  if (places === undefined && lesson.provenance.audience.kind !== "project") return lesson;
  const sourceScopes = (lesson.provenance.sourceScopes ?? []).filter((scope) => !projectRepos.has(scope));
  if (!restrictedToProjectRepos && sourceScopes.length === (lesson.provenance.sourceScopes ?? []).length) return lesson;
  return { ...lesson, provenance: { ...lesson.provenance, audience: { kind: "project" as const }, sourceScopes } };
}
