// Lead 4 L4-LP3W (lessons phase 3): the area index. It answers "what does Rovara know about src/billing/?" with no model call and no store read: it is a PURE function of the lessons it is given, built from each lesson's own
// scope (the repositories and path globs a person or the reflector wrote), as a tree  project > repository > folder > file  that is the customer's own code layout. Nothing here reads a store, a person or a
// task: the callers (`view.ts` for the Learned page, `team-lessons.ts` for the wiki page) hand it lessons that already went through `readVisible`.
//
// Two ways to ask, kept apart on purpose:
//   - ANCHORED (`lessonsAnchoredIn`, the tree and the Learned page): where a lesson lives. `src/billing/**` is anchored at `src/billing/`. Browsing by this answers "what did we teach about this folder".
//   - APPLIES (`lessonAppliesToArea`, the wiki page and the agent's look-up): where an agent will be told it. `src/**` applies to `src/billing/` too. It is the same rule the worker's `knowledge_for` uses
//     (`worker/src/knowledge-context.ts` `unitMatchesPath`); a test holds the two equal.
// A lesson with no repository and no path is "whole project": it has no area, so it is counted apart and never on an area's page.
// Every label that leaves this file is a plain path token (the stored scope is free text written from tasks and repository text), anything else falls back to the repository or the whole project.
import { globToRegExp } from "./guards.js";
import { STRICT_TOKEN } from "./render.js";
import type { Lesson, LessonScope } from "./types.js";

/** Bounds of the tree: a project with huge scopes still answers a small, fixed-size tree (`partial` says it was cut). */
export const AREA_LIMITS = { depth: 6, childrenPerNode: 40, filesPerFolder: 20, nodes: 400, repos: 30 } as const;

/** One place a lesson is anchored at. `folder` is "" for the whole repository, else `a/b` (no leading or trailing slash). `repo` is undefined when the lesson names paths but no repository. */
export interface AreaPlace { repo: string | undefined; folder: string; file?: string | undefined }

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.@-]{1,100}$/u;
const WILDCARD = /[*?[{]/u;
/** A repository name as the index shows it: a plain token with no wildcard. */
const repoToken = (repo: string): string | undefined => (STRICT_TOKEN.test(repo) && !repo.includes("*") && !repo.includes("/") ? repo : undefined);

/** The folder and file a path glob is anchored at: the literal part before the first wildcard. `undefined` when no plain path is left (a bare wildcard, a segment that is not a plain token). */
function anchorOf(glob: string): { folder: string; file?: string } | undefined {
  const bare = glob.replace(/^\.?\//u, "");
  const cut = bare.search(WILDCARD);
  const literal = cut < 0 ? bare : bare.slice(0, cut);
  const parts = literal.split("/");
  // A literal that ends in a slash is a folder; otherwise its last segment is the file (no wildcard) or a half-written name (a wildcard follows) that is dropped.
  let file: string | undefined;
  if (literal.endsWith("/")) parts.pop();
  else { const last = parts.pop(); if (cut < 0) file = last; }
  if (parts.length === 0 && file === undefined) return undefined;
  if (!parts.every((part) => SEGMENT.test(part)) || (file !== undefined && !SEGMENT.test(file))) return undefined;
  return { folder: parts.join("/"), ...(file === undefined ? {} : { file }) };
}

/** Every place a lesson's scope is anchored at (empty: the whole project, or nothing usable to show). */
export function areaPlacesOf(scope: Pick<LessonScope, "repos" | "paths">): AreaPlace[] {
  const repos = [...new Set((scope.repos ?? []).flatMap((repo) => { const token = repoToken(repo); return token === undefined ? [] : [token]; }))];
  const anchors = (scope.paths ?? []).flatMap((glob) => { const anchor = anchorOf(glob); return anchor === undefined ? [] : [anchor]; });
  if (repos.length === 0 && anchors.length === 0) return [];
  const places = new Map<string, AreaPlace>();
  const add = (place: AreaPlace): void => { places.set(`${place.repo ?? ""}\u0000${place.folder}\u0000${place.file ?? ""}`, place); };
  if (anchors.length === 0) for (const repo of repos) add({ repo, folder: "" });
  else for (const repo of repos.length > 0 ? repos : [undefined]) for (const anchor of anchors) add({ repo, folder: anchor.folder, ...(anchor.file === undefined ? {} : { file: anchor.file }) });
  return [...places.values()];
}

/** `src/billing` -> `src/billing/`, "" -> "" (the whole repository). */
export const folderLabel = (folder: string): string => (folder === "" ? "" : `${folder}/`);

export interface AreaFile { name: string; lessons: number }
export interface AreaNode {
  /** The last segment (`billing`). */
  name: string;
  /** The folder with a trailing slash (`src/billing/`). */
  path: string;
  /** Lessons anchored at this folder or anywhere below it, each counted once. */
  lessons: number;
  children: AreaNode[];
  /** Folders left out of `children` by the per-node cap. */
  moreChildren?: number;
  files: AreaFile[];
  moreFiles?: number;
}
export interface AreaRepo { repo: string | null; lessons: number; children: AreaNode[]; moreChildren?: number; files: AreaFile[]; moreFiles?: number }
export interface AreaIndex {
  /** Lessons with no repository and no path: they have no area. */
  wholeProject: number;
  /** Lessons counted, each once. */
  total: number;
  repos: AreaRepo[];
  /** The tree was cut by a bound (nodes, depth, repositories). Counts above are still true for what is shown. */
  partial?: true;
}

interface Mutable { name: string; path: string; ids: Set<string>; children: Map<string, Mutable>; files: Map<string, Set<string>> }
const fresh = (name: string, path: string): Mutable => ({ name, path, ids: new Set(), children: new Map(), files: new Map() });

/** The index of the given lessons. Counts what it is given: the caller decides which lessons (approved, visible) and says so. Pure. */
export function buildAreaIndex(lessons: readonly Pick<Lesson, "id" | "scope">[]): AreaIndex {
  const roots = new Map<string, Mutable>();
  let wholeProject = 0;
  let partial = false;
  let nodes = 0;
  const counted = new Set<string>();
  for (const lesson of lessons) {
    if (counted.has(lesson.id)) continue;
    counted.add(lesson.id);
    const places = areaPlacesOf(lesson.scope);
    if (places.length === 0) { wholeProject += 1; continue; }
    for (const place of places) {
      const key = place.repo ?? "\u0000";
      let root = roots.get(key);
      if (root === undefined) {
        if (roots.size >= AREA_LIMITS.repos) { partial = true; continue; }
        root = fresh(place.repo ?? "", "");
        roots.set(key, root);
      }
      root.ids.add(lesson.id);
      let node = root;
      const segments = place.folder === "" ? [] : place.folder.split("/");
      let walked = 0;
      for (const segment of segments) {
        if (walked >= AREA_LIMITS.depth) { partial = true; break; }
        let child = node.children.get(segment);
        if (child === undefined) {
          if (nodes >= AREA_LIMITS.nodes) { partial = true; break; }
          nodes += 1;
          child = fresh(segment, `${node.path}${segment}/`);
          node.children.set(segment, child);
        }
        child.ids.add(lesson.id);
        node = child;
        walked += 1;
      }
      if (place.file !== undefined && walked === segments.length) {
        const found = node.files.get(place.file) ?? new Set<string>();
        found.add(lesson.id);
        node.files.set(place.file, found);
      }
    }
  }
  const byCount = <T extends { lessons: number }>(a: T & { name?: string }, b: T & { name?: string }): number => b.lessons - a.lessons || (a.name ?? "").localeCompare(b.name ?? "");
  const finish = (node: Mutable): AreaNode => {
    const children = [...node.children.values()].map(finish).sort(byCount);
    const files = [...node.files.entries()].map(([name, ids]) => ({ name, lessons: ids.size })).sort(byCount);
    if (children.length > AREA_LIMITS.childrenPerNode || files.length > AREA_LIMITS.filesPerFolder) partial = true;
    return {
      name: node.name, path: node.path, lessons: node.ids.size, children: children.slice(0, AREA_LIMITS.childrenPerNode), ...(children.length > AREA_LIMITS.childrenPerNode ? { moreChildren: children.length - AREA_LIMITS.childrenPerNode } : {}),
      files: files.slice(0, AREA_LIMITS.filesPerFolder), ...(files.length > AREA_LIMITS.filesPerFolder ? { moreFiles: files.length - AREA_LIMITS.filesPerFolder } : {}),
    };
  };
  const repos = [...roots.entries()].map(([key, root]): AreaRepo => {
    const top = finish(root);
    return { repo: key === "\u0000" ? null : key, lessons: top.lessons, children: top.children, ...(top.moreChildren === undefined ? {} : { moreChildren: top.moreChildren }), files: top.files, ...(top.moreFiles === undefined ? {} : { moreFiles: top.moreFiles }) };
  }).sort((a, b) => b.lessons - a.lessons || (a.repo ?? "").localeCompare(b.repo ?? ""));
  return { wholeProject, total: counted.size, repos, ...(partial ? { partial: true as const } : {}) };
}

/** A selection of one node of the tree: the whole project (lessons with no area), or a repository (null: lessons that name paths but no repository) and a folder inside it ("" = the repository). */
export type AreaSelection = { whole: true } | { whole?: undefined; repo: string | null; folder: string };

const under = (folder: string, within: string): boolean => within === "" || folder === within || folder.startsWith(`${within}/`);

/** The lessons anchored at the selection or below it (the Learned page's "pick an area"). Pure; keeps the order it was given. */
export function lessonsAnchoredIn<T extends Pick<Lesson, "scope">>(lessons: readonly T[], selection: AreaSelection): T[] {
  return lessons.filter((lesson) => {
    const places = areaPlacesOf(lesson.scope);
    if (selection.whole === true) return places.length === 0;
    return places.some((place) => (place.repo ?? null) === selection.repo && under(place.folder, selection.folder));
  });
}

/** The tree path of a requested folder (`src/billing/`, `src/billing`, `` ), or undefined when it is not a plain folder (a bad request, never a guess). */
export function folderOfRequest(raw: string): string | undefined {
  const trimmed = raw.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (trimmed === "") return "";
  const segments = trimmed.split("/");
  return segments.length <= AREA_LIMITS.depth + 1 && segments.every((part) => SEGMENT.test(part)) ? segments.join("/") : undefined;
}

/** The static folder of a pattern: the literal part before the first wildcard, without a half-written last name (the worker's `staticPrefix`). */
const staticPrefix = (pattern: string): string => {
  const cut = pattern.search(WILDCARD);
  return (cut < 0 ? pattern : pattern.slice(0, cut)).replace(/^\.?\//u, "");
};

/**
 * Whether a lesson applies to an area (a folder of one repository): the rule the agent's look-up uses for a folder path (`knowledge_for("src/billing/")`), so a person's page and an agent's answer name the same
 * lessons. A lesson scoped to other repositories never applies; one scoped by repository alone applies to every folder of it; one with path globs applies when a glob matches something in the folder or reaches into it
 * (a broader `src/**` applies to `src/billing/`). A lesson with no scope has no area and applies to none (it competes for the push only).
 */
export function lessonAppliesToArea(scope: Pick<LessonScope, "repos" | "paths">, area: { repo: string | undefined; folder: string }): boolean {
  const repos = scope.repos ?? [];
  const paths = scope.paths ?? [];
  if (repos.length > 0 && area.repo !== undefined && !repos.includes(area.repo)) return false;
  if (paths.length === 0) return repos.length > 0;
  const folder = area.folder.replace(/\/+$/u, "");
  if (folder === "") return true;
  return paths.some((pattern) => {
    const bare = pattern.replace(/^\.?\//u, "");
    if (globToRegExp(bare).test(`${folder}/probe`) || globToRegExp(bare).test(folder)) return true;
    const prefix = staticPrefix(pattern);
    return prefix === "" || `${prefix}/`.startsWith(`${folder}/`) || `${folder}/`.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  });
}

/**
 * Whether a lesson "needs a person's look" and so is flagged: harmful marks asked for it to be retired, it contradicts another lesson, it may duplicate one, or it was sent back to a person. A flagged lesson stays out of
 * everything an agent is told from the team's lessons (the push, the look-up and the wiki section) until a person settles it. Pure; no store.
 */
export const needsALook = (lesson: Pick<Lesson, "retireProposedAt" | "contradictsWith" | "possibleDuplicateOf" | "reviewRequired">): boolean =>
  lesson.retireProposedAt !== undefined || lesson.contradictsWith !== undefined || lesson.possibleDuplicateOf !== undefined || lesson.reviewRequired === true;
