// Wiki W0 (DEC 254zh, 254zi): the free file map and forecast. Reads each repository of a project through the code host at ONE fixed commit (the head of the default branch when the map is made), counts and groups the files,
// ranks the areas by recent commits, suggests the "Tell Rovara what matters" chips and estimates pages. NO model call, nothing stored, no dollar figure.
//
// Honesty (held by tests): a map that is not whole says "partial: <reason>" and is never complete; secret-shaped files are counted and never listed; every read is bounded (entries, folder reads, commit-count requests, time); a
// cause is never echoed (fixed words only).
import { hostRateLimitRetryAt, WIKI_MAP_ACTIVITY_DAYS, WIKI_MAP_LIMITS, type CodeHost, type HostScope, type TreeEntry, type WikiFileMap, type WikiMapArea, type WikiMapChip, type WikiMapRepo } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { areaKindOf, areaOf, classifyPath, isTestFolderName, languageOf, secretDirectory, skippedDirectoryClass } from "./skip-rules.js";

/** What the map needs of a code host: only reads that list or count, never a file's content. */
export type FileMapHost = Pick<CodeHost, "baseBranchHead" | "repositoryTree" | "directoryEntries" | "commitActivity">;

export interface FileMapRepository { name: string; url: string; defaultBranch: string; host: FileMapHost }
export interface FileMapDeps { scope: HostScope; now: () => number; log?: ((entry: Record<string, unknown>) => void) | undefined }

export const WIKI_MAP_REPO_UNAVAILABLE = "Rovara could not read this repository's files just now.";
export const WIKI_MAP_NO_LISTING = "This repository's code host cannot list files for the file map yet.";
export const WIKI_MAP_OUT_OF_TIME = "Rovara ran out of time before reaching this repository. Try again.";
/** The whole map is made within this many milliseconds; a repository not reached by then is "unavailable" with the sentence above. */
export const WIKI_MAP_DEADLINE_MS = 25_000;
const READ_TIMEOUT_MS = 8_000;
const ACTIVITY_CONCURRENCY = 4;
const MIN_FILES_FOR_MODULE_PAGE = 3;
const FIXED_PAGES = 4; // the start page and three fixed project pages (overview, glossary, how to run and test)

interface Tally { files: number; languages: Map<string, number>; areas: Map<string, number>; skipped: { generated: number; vendored: number; lockfiles: number; assets: number; secret: number }; testFolders: Set<string>; skippedFolders: Set<string> }

/** Counts the entries of one tree. Only directories and files that are NOT secret-shaped can reach a listed path. */
function tally(entries: readonly TreeEntry[]): Tally {
  const out: Tally = { files: 0, languages: new Map(), areas: new Map(), skipped: { generated: 0, vendored: 0, lockfiles: 0, assets: 0, secret: 0 }, testFolders: new Set(), skippedFolders: new Set() };
  for (const entry of entries) {
    if (entry.kind === "dir") {
      if (secretDirectory(entry.path)) continue;
      const segments = entry.path.split("/");
      const name = segments[segments.length - 1]!;
      if (skippedDirectoryClass(name) !== undefined && !segments.slice(0, -1).some((s) => skippedDirectoryClass(s) !== undefined)) out.skippedFolders.add(entry.path);
      else if (isTestFolderName(name) && classifyPath(`${entry.path}/x`) === undefined) out.testFolders.add(entry.path);
      continue;
    }
    if (entry.kind !== "file") continue;
    const why = classifyPath(entry.path);
    if (why === "secret") { out.skipped.secret += 1; continue; }
    if (why === "vendored") { out.skipped.vendored += 1; continue; }
    if (why === "generated") { out.skipped.generated += 1; continue; }
    if (why === "lockfile") { out.skipped.lockfiles += 1; continue; }
    if (why === "asset") { out.skipped.assets += 1; continue; }
    out.files += 1;
    const language = languageOf(entry.path);
    if (language !== undefined) out.languages.set(language, (out.languages.get(language) ?? 0) + 1);
    const area = areaOf(entry.path);
    out.areas.set(area, (out.areas.get(area) ?? 0) + 1);
  }
  return out;
}

/** The shortest test folders first, nested ones folded into their parent, at most 10. */
function testFoldersOf(folders: ReadonlySet<string>): string[] {
  const sorted = [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const kept: string[] = [];
  for (const folder of sorted) if (!kept.some((parent) => folder.startsWith(`${parent}/`))) kept.push(folder);
  return kept.slice(0, 10);
}

interface Walked { entries: TreeEntry[]; unread: number; cut: number; budgetUsed: number; failed: boolean }

/** The fallback when the code host cut its whole-tree list: a bounded folder-by-folder walk. It never enters a vendored, generated or secret-shaped folder (those are counted by name, not read). */
async function walkFolders(host: FileMapHost, repo: FileMapRepository, commit: string, deps: FileMapDeps, until: number): Promise<Walked> {
  const out: Walked = { entries: [], unread: 0, cut: 0, budgetUsed: 0, failed: false };
  let queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
  while (queue.length > 0) {
    const next: Array<{ path: string; depth: number }> = [];
    for (const [index, folder] of queue.entries()) {
      if (out.budgetUsed >= WIKI_MAP_LIMITS.directoryWalkRequests || deps.now() > until || out.entries.length > WIKI_MAP_LIMITS.treeEntries) { out.unread += queue.length - index + next.length; return out; }
      if (folder.depth >= WIKI_MAP_LIMITS.directoryWalkDepth) { out.unread += 1; continue; }
      out.budgetUsed += 1;
      let listed;
      try { listed = await host.directoryEntries!({ url: repo.url }, folder.path, commit, deps.scope, { timeoutMs: READ_TIMEOUT_MS }); } catch { out.failed = true; out.unread += 1; continue; }
      if (!listed.complete) out.cut += 1;
      for (const child of listed.entries) {
        const path = folder.path === "" ? child.name : `${folder.path}/${child.name}`;
        out.entries.push({ path, kind: child.kind });
        const skippable = child.kind === "dir" && (skippedDirectoryClass(child.name) !== undefined || secretDirectory(path));
        if (child.kind === "dir" && !skippable) next.push({ path, depth: folder.depth + 1 });
        // A skipped folder is counted by its name, not read: its files are unknown and are not in `files`.
      }
    }
    queue = next;
  }
  return out;
}

interface ActivityResult { status: "ok" | "partial" | "unavailable"; reason?: string }

/** Commit counts for the source areas, one call each, within a request budget and the time. Mutates the areas it measured. */
async function measureActivity(host: FileMapHost, repo: FileMapRepository, commit: string, areas: WikiMapArea[], deps: FileMapDeps, until: number, budget: number): Promise<ActivityResult> {
  if (host.commitActivity === undefined) return { status: "unavailable", reason: "This code host cannot count commits yet." };
  const since = new Date(deps.now() - WIKI_MAP_ACTIVITY_DAYS * 86_400_000).toISOString();
  const targets = areas.filter((area) => area.kind === "source" && area.path !== ".");
  let spent = 0, measured = 0, failed = 0, slowDown = false, stopped: "budget" | "time" | undefined;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length && !slowDown) {
      if (spent >= budget) { stopped ??= "budget"; return; }
      if (deps.now() > until) { stopped ??= "time"; return; }
      const area = targets[cursor++]!;
      spent += 1;
      try {
        const read = await host.commitActivity!({ url: repo.url }, commit, deps.scope, { since, path: area.path, cap: 100, timeoutMs: READ_TIMEOUT_MS });
        if (read.count === 0) spent += 1;
        area.commits = read.count;
        if (read.capped) area.commitsCapped = true;
        if (read.latestAt !== undefined) area.lastChangeAt = read.latestAt;
        measured += 1;
      } catch (error) {
        if (hostRateLimitRetryAt(error) !== undefined) slowDown = true; else failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, Math.max(1, targets.length)) }, worker));
  if (targets.length === 0 || measured === targets.length) return { status: "ok" };
  if (measured === 0 && stopped === undefined) return { status: "unavailable", reason: slowDown ? "The code host asked Rovara to slow down, so commit counts are missing." : "The code host did not answer the commit counts." };
  const why = slowDown ? "the code host asked Rovara to slow down" : stopped === "time" ? "out of time" : stopped === "budget" ? "the commit-count limit was reached" : "the code host did not answer for some folders";
  return { status: "partial", reason: `${why}; measured ${String(measured)} of ${String(targets.length)} folders` };
}

/** Ranks the measured areas (1 = busiest): most commits, then most files. */
function rank(areas: WikiMapArea[]): void {
  const measured = areas.filter((area) => area.commits !== undefined).sort((a, b) => b.commits! - a.commits! || b.files - a.files || a.path.localeCompare(b.path));
  for (const [index, area] of measured.entries()) area.rank = index + 1;
}

/** The map of one repository. Never throws: a repository that cannot be read is `unavailable` in fixed words. */
export async function mapRepository(repo: FileMapRepository, deps: FileMapDeps, until: number, activityBudget: number): Promise<WikiMapRepo> {
  const base: WikiMapRepo = {
    name: repo.name, url: repo.url, status: "unavailable", files: 0, skipped: { generated: 0, vendored: 0, lockfiles: 0, assets: 0, secret: 0 },
    languages: [], areas: [], testFolders: [], skippedFolders: [], activity: { status: "unavailable", days: WIKI_MAP_ACTIVITY_DAYS }, pages: { repository: 1, modules: 0, modulesCapped: false },
  };
  const host = repo.host;
  if (deps.now() > until) return { ...base, unavailable: WIKI_MAP_OUT_OF_TIME };
  if (host.repositoryTree === undefined) return { ...base, unavailable: WIKI_MAP_NO_LISTING };
  let commit: string;
  let read;
  try {
    commit = await host.baseBranchHead({ url: repo.url }, repo.defaultBranch, deps.scope);
    if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("not a commit");
    read = await host.repositoryTree({ url: repo.url }, commit, deps.scope, { timeoutMs: READ_TIMEOUT_MS });
  } catch (error) {
    deps.log?.({ event: "wiki_map.repository_unreadable", reason: error instanceof Error ? error.name : "unknown" });
    return { ...base, unavailable: unavailableFor(error) };
  }
  let entries = read.entries;
  const reasons: string[] = [];
  if (!read.complete) {
    if (host.directoryEntries === undefined) {
      reasons.push("the code host cut its file list and cannot list folders, so this is only part of the repository");
    } else {
      const walked = await walkFolders(host, repo, commit, deps, until);
      entries = walked.entries;
      if (walked.unread > 0 || walked.cut > 0 || walked.failed) {
        const bits = [walked.budgetUsed >= WIKI_MAP_LIMITS.directoryWalkRequests ? `stopped after ${String(WIKI_MAP_LIMITS.directoryWalkRequests)} folder reads` : undefined, walked.unread > 0 ? `${String(walked.unread)} folders not read` : undefined, walked.cut > 0 ? `${String(walked.cut)} very large folders cut short by the code host` : undefined].filter((bit) => bit !== undefined);
        reasons.push(`the code host cut its file list, so Rovara walked the folders${bits.length === 0 ? "" : `: ${bits.join(", ")}`}`);
      }
    }
  }
  if (entries.length > WIKI_MAP_LIMITS.treeEntries) { entries = entries.slice(0, WIKI_MAP_LIMITS.treeEntries); reasons.push(`the repository has more than ${String(WIKI_MAP_LIMITS.treeEntries)} entries`); }
  const counted = tally(entries);
  const total = [...counted.languages.values()].reduce((a, b) => a + b, 0);
  const sortedLanguages = [...counted.languages].sort(([an, a], [bn, b]) => b - a || an.localeCompare(bn));
  const top = sortedLanguages.slice(0, 8);
  const rest = sortedLanguages.slice(8).reduce((sum, [, n]) => sum + n, 0);
  const languages = [...top, ...(rest > 0 ? [["Other", rest] as [string, number]] : [])].map(([language, files]) => ({ language, files, percent: Math.round((files / total) * 1000) / 10 }));
  const allAreas = [...counted.areas].map(([path, files]) => ({ path, files, kind: areaKindOf(path) })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
  const areas: WikiMapArea[] = allAreas.slice(0, WIKI_MAP_LIMITS.areasPerRepository);
  const moduleAreas = allAreas.filter((area) => area.kind === "source" && area.path !== "." && area.files >= MIN_FILES_FOR_MODULE_PAGE).length;
  const activity = await measureActivity(host, repo, commit, areas, deps, until, activityBudget);
  rank(areas);
  const partial = reasons.length === 0 ? undefined : `partial: ${reasons.join("; ")}`;
  return {
    name: repo.name, url: repo.url, status: partial === undefined ? "ok" : "partial", ...(partial === undefined ? {} : { partial }), branch: repo.defaultBranch, commit,
    files: counted.files, skipped: counted.skipped, languages, areas, testFolders: testFoldersOf(counted.testFolders), skippedFolders: [...counted.skippedFolders].sort().slice(0, 20),
    activity: { status: activity.status, ...(activity.reason === undefined ? {} : { reason: activity.reason }), days: WIKI_MAP_ACTIVITY_DAYS },
    pages: { repository: 1, modules: Math.min(moduleAreas, WIKI_MAP_LIMITS.modulePagesPerRepository), modulesCapped: moduleAreas > WIKI_MAP_LIMITS.modulePagesPerRepository },
  };
}

// A cause is never echoed: a rate limit says so, anything else is the one fixed sentence.
function unavailableFor(error: unknown): string {
  return hostRateLimitRetryAt(error) !== undefined ? "The code host asked Rovara to slow down. Try again in a few minutes." : WIKI_MAP_REPO_UNAVAILABLE;
}

const chipId = (kind: string, repo: string, path: string): string => `${kind}-${createHash("sha256").update(`${repo}\n${path}`).digest("hex").slice(0, 16)}`;

/** The chips under "Tell Rovara what matters": the busiest areas ("write these first?"), big areas nobody touched in the window ("skip?"), and generated or vendored folders ("skip?", on by default). */
export function chipsOf(repositories: readonly WikiMapRepo[]): WikiMapChip[] {
  const chips: WikiMapChip[] = [];
  for (const repo of repositories) {
    if (repo.status === "unavailable") continue;
    const busiest = repo.areas.filter((area) => area.kind === "source" && area.rank !== undefined && (area.commits ?? 0) > 0).sort((a, b) => a.rank! - b.rank!).slice(0, 3);
    for (const area of busiest) chips.push({ id: chipId("write_first", repo.name, area.path), kind: "write_first", repo: repo.name, path: area.path, label: `Write these first? ${repo.name}/${area.path}`, defaultOn: false });
    const old = repo.areas.filter((area) => area.kind === "source" && area.path !== "." && area.commits === 0 && area.lastChangeAt !== undefined).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)).slice(0, 3);
    for (const area of old) chips.push({ id: chipId("skip_old", repo.name, area.path), kind: "skip_old", repo: repo.name, path: area.path, label: `Skip? ${repo.name}/${area.path} (no changes in ${String(WIKI_MAP_ACTIVITY_DAYS)} days)`, defaultOn: false });
    for (const folder of repo.skippedFolders.slice(0, 5)) chips.push({ id: chipId("skip_generated", repo.name, folder), kind: "skip_generated", repo: repo.name, path: folder, label: `Skip? ${repo.name}/${folder} (generated or vendored)`, defaultOn: true });
  }
  return chips;
}

/** Pages a build would write: a start page, one per repository, the module pages, one for how the repositories connect (two or more), and three fixed project pages. Capped at the project limit. */
export function forecastOf(repositories: readonly WikiMapRepo[]): WikiFileMap["forecast"] {
  const read = repositories.filter((repo) => repo.status !== "unavailable");
  const modules = read.reduce((sum, repo) => sum + repo.pages.modules, 0);
  const raw = 1 + read.length + modules + (read.length > 1 ? 1 : 0) + (FIXED_PAGES - 1);
  return { repositories: read.length, files: read.reduce((sum, repo) => sum + repo.files, 0), pages: Math.min(raw, WIKI_MAP_LIMITS.pagesPerProject), pagesCapped: raw > WIKI_MAP_LIMITS.pagesPerProject, price: "not_priced_yet" };
}

/** The file map of a whole project. At most `WIKI_MAP_LIMITS.repositories` repositories are read; the commit-count budget is shared out evenly. Never throws for a repository's own failure. */
export async function computeWikiFileMap(input: { project: string; repositories: readonly FileMapRepository[] }, deps: FileMapDeps): Promise<WikiFileMap> {
  const started = deps.now();
  const until = started + WIKI_MAP_DEADLINE_MS;
  const picked = input.repositories.slice(0, WIKI_MAP_LIMITS.repositories);
  const share = Math.max(1, Math.floor(WIKI_MAP_LIMITS.activityRequests / Math.max(1, picked.length)));
  const repositories: WikiMapRepo[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < picked.length) { const index = next++; repositories[index] = await mapRepository(picked[index]!, deps, until, share); }
  };
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, picked.length)) }, worker));
  const omitted = Math.max(0, input.repositories.length - picked.length);
  return {
    version: 1, project: input.project, computedAt: new Date(deps.now()).toISOString(), repositories,
    complete: omitted === 0 && repositories.every((repo) => repo.status === "ok"), repositoriesOmitted: omitted,
    chips: chipsOf(repositories), forecast: forecastOf(repositories),
    limits: { activityDays: WIKI_MAP_ACTIVITY_DAYS, modulePagesPerRepository: WIKI_MAP_LIMITS.modulePagesPerRepository, pagesPerProject: WIKI_MAP_LIMITS.pagesPerProject, areasPerRepository: WIKI_MAP_LIMITS.areasPerRepository },
  };
}
