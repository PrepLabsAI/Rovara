// Which repositories the erasure sweep, the erasure hook and archive visit. NOT the project's current repository list: the WATCH ROWS. Every repository Rovara has ever written to
// (or been switched on for) has a watch row that says who it is (host kind in the place, address, the project's name for it) as of when it was written, and rows are never deleted while the project exists. A repository that has since
// been removed from the project, moved to another host or been given a new id keeps its row, and is still swept for as long as the installation lets Rovara reach it:
//   - its open Rovara pull requests are closed (like archive), and blocks of deleted lessons still on its default branch go out through a removal-only pull request;
//   - one Rovara cannot reach (the app is uninstalled, the repository is gone) is recorded ONCE on its watch row with how many deleted lessons were waiting, shown on the status, and tried again weekly (the erasure hook always tries);
//   - one repository failing never fails the sweep of the others.
// No publish state is read. No model call.
import { sweepDepsOf, sweepErasures, closeAllRovaraPrs, type EraseSweepDeps, type EraseSweepResult } from "./repo-file-erase.js";
import type { RepoFileTarget } from "./repo-file-host.js";
import type { RepoFileRuntime } from "./repo-file-job.js";
import type { PrRow } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

/** A repository that cannot be reached is tried again this often by the nightly sweep (the erasure hook, which means a lesson was just deleted, always tries). */
export const UNREACHABLE_RETRY_MS = 6 * 86_400_000;

/** One place the sweep visits: the repository as the project lists it now, or as its watch row remembers it. */
export interface SweepPlace { place: string; watch?: PrRow; target?: RepoFileTarget; former: boolean; rows: PrRow[] }

/** The places to visit: every place that has a row, the project's current target for it when there is one, else the repository its watch row remembers (when the runtime can reach it). Throws only when the rows cannot be read. */
export async function sweepPlacesOf(runtime: RepoFileRuntime, key: ScopeKey): Promise<SweepPlace[]> {
  const sweepRows = sweepDepsOf(runtime.deps).rows;
  const listed = (await sweepRows.listPrs(key)).rows;
  const places = [...new Set(listed.map((row) => row.place))].sort();
  // A project with no row at all has nothing of Rovara's anywhere: the project's repositories are not even asked for.
  if (places.length === 0) return [];
  let current: RepoFileTarget[] | undefined;
  try { current = await runtime.targets(key.workspaceId, key.project); } catch { current = undefined; }
  const out: SweepPlace[] = [];
  for (const place of places) {
    const rows = listed.filter((row) => row.place === place);
    const watch = rows.find((row) => row.kind === "watch");
    const here = current?.find((candidate) => candidate.place === place);
    if (here !== undefined) { out.push({ place, ...(watch === undefined ? {} : { watch }), target: here, former: false, rows }); continue; }
    let target: RepoFileTarget | undefined;
    if (watch?.repoUrl !== undefined && runtime.reach !== undefined) {
      try { target = await runtime.reach(key.workspaceId, key.project, { place, url: watch.repoUrl, name: watch.repoName ?? place }); } catch { target = undefined; }
    }
    // `former` only when the project's list was read and does not have the place: a list that could not be read says nothing about it.
    out.push({ place, ...(watch === undefined ? {} : { watch }), ...(target === undefined ? {} : { target }), former: current !== undefined, rows });
  }
  return out;
}

export interface SweepProjectCounts { closed: number; failures: number; removalsOpened: number; unreachable: number; skipped: number }

/** Deleted lessons that rows of this place still stand for (an open pull request that adds one, a removal pull request for one): the number the status says Rovara cannot take out. */
async function waitingLessons(deps: EraseSweepDeps, key: ScopeKey, rows: readonly PrRow[]): Promise<number> {
  const ids = [...new Set(rows.filter((row) => (row.kind === "adds" || row.kind === "removal") && row.closedAt === undefined).flatMap((row) => row.ids))];
  if (ids.length === 0) return 0;
  try { return (await deps.store.goneOf(key, ids)).size; } catch { return 0; }
}

/** Records what the sweep found on the repository's watch row, and only when it changed (an unreachable repository is recorded once). Best effort. */
async function remember(deps: EraseSweepDeps, key: ScopeKey, place: SweepPlace, found: { unreachable: boolean; strayBranches: number; unconfirmed: number; marks?: string[] | undefined }): Promise<void> {
  const watch = place.watch;
  if (watch === undefined) return;
  const at = deps.now();
  const { unreachableAt: _a, unreachableLessons: _l, triedAt: _t, strayBranches: _s, unconfirmedCloses: _u, ...rest } = watch;
  void _a; void _l; void _t; void _s; void _u;
  let next: PrRow = { ...rest, ...(found.strayBranches > 0 ? { strayBranches: found.strayBranches } : {}), ...(found.unconfirmed > 0 ? { unconfirmedCloses: found.unconfirmed } : {}) };
  // The marked copies the sweep found in the file (a sweep that did not read the file leaves what the row remembered): released only by a later successful sweep that finds none.
  const { marks: _m, ...withoutMarks } = next;
  void _m;
  const marks = found.marks ?? watch.marks;
  next = { ...withoutMarks, ...(marks === undefined || marks.length === 0 ? {} : { marks }) };
  if (found.unreachable) {
    const lessons = await waitingLessons(deps, key, place.rows);
    next = { ...next, unreachableAt: watch.unreachableAt ?? at, unreachableLessons: lessons, triedAt: at };
    if (watch.unreachableAt === undefined) deps.log?.("lessons_repo_file.repository_unreachable", { lessons });
  }
  const same = watch.unreachableAt === next.unreachableAt && watch.unreachableLessons === next.unreachableLessons && watch.strayBranches === next.strayBranches && watch.unconfirmedCloses === next.unconfirmedCloses && JSON.stringify(watch.marks ?? []) === JSON.stringify(next.marks ?? []) && (!found.unreachable || watch.triedAt === next.triedAt);
  if (!same) await deps.rows.putPr(key, next).catch(() => { deps.log?.("lessons_repo_file.watch_row_not_saved", {}); });
}

/**
 * The project's erasure sweep: every watched repository, each on its own. `hook`: a lesson was just deleted, so an unreachable repository is tried again now instead of waiting for its weekly retry. Throws only when the rows cannot be read.
 */
export async function sweepProject(runtime: RepoFileRuntime, key: ScopeKey, options: { hook?: boolean } = {}): Promise<SweepProjectCounts> {
  const deps = sweepDepsOf(runtime.deps);
  const counts: SweepProjectCounts = { closed: 0, failures: 0, removalsOpened: 0, unreachable: 0, skipped: 0 };
  for (const place of await sweepPlacesOf(runtime, key)) {
    try {
      const retryAt = place.watch?.unreachableAt === undefined || place.watch.triedAt === undefined ? 0 : place.watch.triedAt + UNREACHABLE_RETRY_MS;
      if (options.hook !== true && deps.now() < retryAt) { counts.skipped += 1; continue; }
      const result: EraseSweepResult = place.target === undefined
        ? { closed: 0, removalOpened: false, failures: 1, unreachable: true, strayBranches: 0, unconfirmed: 0 }
        : await sweepErasures(deps, key, place.target, { former: place.former });
      counts.closed += result.closed;
      counts.failures += result.failures;
      if (result.removalOpened) counts.removalsOpened += 1;
      if (result.unreachable) counts.unreachable += 1;
      await remember(deps, key, place, result);
    } catch { counts.failures += 1; deps.log?.("lessons_repo_file.erase_place_failed", {}); }
  }
  return counts;
}

/** A project is archived: every open Rovara pull request of every watched repository is closed, wherever it now is. Best effort, per repository. */
export async function closeProjectPrs(runtime: RepoFileRuntime, key: ScopeKey): Promise<number> {
  const deps = sweepDepsOf(runtime.deps);
  let closed = 0;
  for (const place of await sweepPlacesOf(runtime, key)) {
    if (place.target === undefined) continue;
    try { closed += await closeAllRovaraPrs(deps, key, place.target); } catch { /* the project is going away; nothing more to do */ }
  }
  return closed;
}
