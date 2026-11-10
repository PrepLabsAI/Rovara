// The status of a project's lessons files and the maintainer's switches, as plain functions the route layer (`routes.ts`) and the CLI's API calls use. Fixed words only.
//   status:  every repository of the project with its row (switched on or not, the open pull request, unmerged count, removals waiting, held lessons, pointer, problem, notices) and the repositories not yet switched on.
//   actions: on / off (the open pull request is closed and its branch deleted; the merged file stays), resume (after the team deleted the file), pointer_add ("add it back"), pointer_decline ("don't ask again").
// Switching on or off is audited BEFORE it changes. Nothing here calls a host except `off` (closing Rovara's own pull request); the first pull request is opened by the next nightly pass, within a day.
import { resolveLearning, modeAllows, requireAudit, type ResolvedLearning } from "./policy.js";
import type { LessonsRepoFileBody, LessonsRepoFileRow, LessonsRepoFileStatus } from "@agentx/contracts";
import type { RepoFileRuntime } from "./repo-file-job.js";
import { closeProjectPrs, sweepProject } from "./repo-file-sweep.js";
import { watchRowOf, type RepoFileTarget } from "./repo-file-host.js";
import { switchRepoFileOff } from "./repo-file-pass.js";
import { rowOf } from "./repo-file-pr.js";
import { newRepoFileState } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

export type RepoFileActionResult = { ok: true; row: LessonsRepoFileRow } | { ok: false; code: "not_found" | "host_cannot_write" | "audit_unavailable" | "conflict" | "unreadable" };

/** Why a switched-on repository does nothing yet: the install's lessons switch is off, else the project's mode does not let lessons load. Absent when lessons are on. */
const waitingOf = (resolved: ResolvedLearning): { waitingFor: "install" | "project" } | Record<string, never> =>
  resolved.switchedOff ? { waitingFor: "install" } : !modeAllows(resolved.mode, "load") ? { waitingFor: "project" } : {};
const withWaiting = (row: LessonsRepoFileRow, resolved: ResolvedLearning): LessonsRepoFileRow => row.enabled ? { ...row, ...waitingOf(resolved) } : row;

const canWrite = (target: RepoFileTarget): boolean => target.host.commitFiles !== undefined && target.host.deleteBranch !== undefined && target.host.pathKind !== undefined && target.host.changeRequestForBranch !== undefined;

export async function repoFileStatus(runtime: RepoFileRuntime, key: ScopeKey): Promise<LessonsRepoFileStatus> {
  const resolved = await resolveLearning(runtime.deps.settings, key.workspaceId, key.project);
  const states = await runtime.deps.state.list(key);
  const targets = await runtime.targets(key.workspaceId, key.project);
  const listed = await (runtime.deps.rows ?? runtime.deps.state).listPrs(key).then((l) => l.rows, () => []);
  // Removal pull requests the erasure sweep opened and nobody has merged: shown on the repository's row, switched on or not.
  const removals = listed.filter((r) => r.kind === "removal" && r.closedAt === undefined && !r.number.startsWith("~"));
  const shownStates = states.filter((state) => state.enabled || state.open !== undefined || state.fileDeleted);
  const shownPlaces = new Set(shownStates.map((state) => state.place));
  // A repository that is switched off (or never had a state) but has a removal pull request waiting still gets its row.
  const waitingOnly = [...new Set(removals.map((r) => r.place))].filter((place) => !shownPlaces.has(place)).map((place) => {
    const name = targets.find((candidate) => candidate.place === place)?.name ?? listed.find((r) => r.place === place && r.kind === "watch")?.repoName ?? place;
    return { ...newRepoFileState(place, name), enabled: false };
  });
  const rows = [...shownStates, ...waitingOnly].map((state) => {
    const row = rowOf(state);
    const waiting = removals.filter((r) => r.place === state.place).length;
    const target = targets.find((candidate) => candidate.place === state.place);
    const shown = waiting === 0 ? withWaiting(row, resolved) : { ...withWaiting(row, resolved), erasurePrs: waiting, notices: [...row.notices, `${String(waiting)} ${waiting === 1 ? "pull request that removes" : "pull requests that remove"} deleted lessons ${waiting === 1 ? "is" : "are"} waiting for your team`] };
    return target === undefined ? { ...shown, problem: "repository_gone" as const, notices: [...shown.notices, "This repository is no longer part of the project"] } : shown;
  });
  const watches = listed.filter((r) => r.kind === "watch");
  const unreachable = watches.filter((w) => w.unreachableAt !== undefined).map((w) => ({ repo: w.repoName ?? w.place, lessons: w.unreachableLessons ?? 0 }));
  // Closes that were held back: the sweep's count (watch row) and the pass's (state), by repository.
  const held = new Map<string, number>();
  for (const w of watches) if ((w.unconfirmedCloses ?? 0) > 0) held.set(w.repoName ?? w.place, (held.get(w.repoName ?? w.place) ?? 0) + (w.unconfirmedCloses ?? 0));
  for (const state of states) if ((state.closesHeld ?? 0) > 0) held.set(state.name, (held.get(state.name) ?? 0) + (state.closesHeld ?? 0));
  const stray = watches.filter((w) => (w.strayBranches ?? 0) > 0).map((w) => ({ repo: w.repoName ?? w.place, branches: w.strayBranches ?? 0 }));
  return {
    lessonsOff: !modeAllows(resolved.mode, "load"),
    canEnable: targets.some(canWrite),
    repos: rows,
    ...(unreachable.length === 0 ? {} : { unreachable }),
    ...(stray.length === 0 ? {} : { strayBranches: stray }),
    ...(held.size === 0 ? {} : { closesHeld: [...held].map(([repo, count]) => ({ repo, count })) }),
    available: targets.filter((target) => !shownPlaces.has(target.place) && canWrite(target)).map((target) => target.name),
  };
}

/** One switch or answer for one repository, by the project's name for it. */
export async function repoFileAction(runtime: RepoFileRuntime, key: ScopeKey, body: LessonsRepoFileBody): Promise<RepoFileActionResult> {
  let target: RepoFileTarget | undefined;
  let everyTarget: RepoFileTarget[];
  try { everyTarget = await runtime.targets(key.workspaceId, key.project); target = everyTarget.find((candidate) => candidate.name === body.repo); } catch { return { ok: false, code: "unreadable" }; }
  if (target === undefined) return { ok: false, code: "not_found" };
  const deps = { ...runtime.deps, holder: runtime.newHolder?.() ?? "route" };
  const existing = await deps.state.get(key, target.place);
  const state = existing ?? newRepoFileState(target.place, target.name);
  const save = async (next: typeof state) => deps.state.put(key, next, existing?.revision ?? 0);
  try {
    if (body.action === "on") {
      if (!canWrite(target)) return { ok: false, code: "host_cannot_write" };
      const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
      if (state.enabled) return { ok: true, row: withWaiting(rowOf(state), resolved) };
      // WRITE AHEAD: when the feature is switched on, the erasure sweep is told about EVERY repository of the project (a watch row each, never deleted while the project exists) before anything else happens. If that cannot be written, nothing changes.
      try { for (const each of everyTarget) await (deps.rows ?? deps.state).putPr(key, watchRowOf(each, deps.now())); } catch { return { ok: false, code: "unreadable" }; }
      if (!await requireAudit(deps.audit, { action: "lesson.repo_file_switched", workspaceId: key.workspaceId, project: key.project, facts: { enabled: true } })) return { ok: false, code: "audit_unavailable" };
      const saved = await save({ ...state, name: target.name, enabled: true, ...(body.pointers === undefined ? {} : { pointers: body.pointers }) });
      return saved === undefined ? { ok: false, code: "conflict" } : { ok: true, row: withWaiting(rowOf(saved), resolved) };
    }
    if (existing === undefined) return { ok: false, code: "not_found" };
    if (body.action === "off") {
      if (!existing.enabled && existing.open === undefined && existing.closing.length === 0) return { ok: true, row: rowOf(existing) };
      if (!await requireAudit(deps.audit, { action: "lesson.repo_file_switched", workspaceId: key.workspaceId, project: key.project, facts: { enabled: false } })) return { ok: false, code: "audit_unavailable" };
      return { ok: true, row: rowOf(await switchRepoFileOff(deps, key, target, existing)) };
    }
    // Resume: the team deleted the file and wants Rovara to start again; the next pass proposes it afresh. Pointer answers.
    const next = body.action === "resume" ? { ...existing, fileDeleted: false, fileSeen: false, held: [] } : body.action === "pointer_add"
      ? { ...existing, pointerProposed: false, pointerDeclined: false, pointerMissing: false } : { ...existing, pointerDeclined: true, pointerMissing: false };
    const saved = await save(next);
    return saved === undefined ? { ok: false, code: "conflict" } : { ok: true, row: rowOf(saved) };
  } catch { return { ok: false, code: "conflict" }; }
}

/**
 * A lesson was deleted or erased (`repo-file-hook.ts`, called once its deletion finished, so the lesson store's tombstone for it exists): every WATCHED repository of the project runs the erasure sweep at once, including one the project
 * no longer lists (it is rebuilt from its watch row). The sweep reads no publish state (see `repo-file-erase.ts`), so nothing about a repository's state can stop it, and one repository failing never touches another. What cannot be done
 * now is done by the nightly job, which sweeps first of all.
 */
export async function closeOpenPullRequestFor(runtime: RepoFileRuntime, key: ScopeKey, _lessonId: string): Promise<void> {
  void _lessonId;
  await sweepProject(runtime, key, { hook: true });
}

/** A repository was taken out of the project (or the project's list changed): the sweep runs now, so the open Rovara pull requests of a repository that left are closed at once, like archive. Best effort. */
export async function repositoriesChanged(runtime: RepoFileRuntime, key: ScopeKey): Promise<void> {
  await sweepProject(runtime, key, { hook: true });
}

/** A project is archived: every open Rovara pull request of its watched repositories is closed before the project's rows go (nothing is left in the customer's repository that Rovara could still take down). Best effort, per repository. */
export async function closeProjectRovaraPrs(runtime: RepoFileRuntime, key: ScopeKey): Promise<number> {
  return closeProjectPrs(runtime, key);
}
