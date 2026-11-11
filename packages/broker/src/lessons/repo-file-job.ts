// The weekly file pass inside the nightly job, so no new schedule and no infrastructure. Each night it looks, per project, at the repositories whose lessons file is switched on;
// a repository is worked on at most once a week (`runRepoFilePass` keeps its own clock), so most nights this is one store query per project and nothing else.
// Bounded in projects and time; a project that fails never stops the others. Makes no model call. Returns counts only.
import { OrgIdSchema } from "@agentx/contracts";
import { rotated } from "./nightly-state.js";
import type { RepoFileTarget } from "./repo-file-host.js";
import { finishClosings, runRepoFilePass, runRetireRead, type RepoFileDeps } from "./repo-file-pass.js";
import { sweepProject } from "./repo-file-sweep.js";

/** What the job and the routes need beyond the pass's own dependencies: how to find a project's repositories (with their code hosts). */
export interface RepoFileRuntime {
  deps: Omit<RepoFileDeps, "holder">;
  /** The project's repositories as targets. Throws when the project definition cannot be read. A repository whose host this install does not know is left out. */
  targets(workspaceId: string, project: string): Promise<RepoFileTarget[]>;
  newHolder?(): string;
  /**
   * A repository the project no longer lists, rebuilt from what its watch row remembers (host kind in the place, address, name): the target to sweep it with, or undefined when this install cannot build one (a host it does
   * not know). It does not say whether the host lets Rovara in: the sweep finds that out.
   */
  reach?(workspaceId: string, project: string, former: { place: string; url: string; name: string }): Promise<RepoFileTarget | undefined>;
}

export const MAX_REPO_FILE_PROJECTS = 200;

const newCounts = () => ({ repoFilePrsOpened: 0, repoFileLeft: 0, repoFileProblems: 0, repoFileFailures: 0, repoFileSkipped: 0, repoFileErasureFailures: 0, repoFileErasuresClosed: 0 });

/**
 * The erasure sweep for every project, on its OWN budget and FIRST in the nightly run, so no other pass can starve it. For every repository of a project that Rovara has written to it reads no publish state (see `repo-file-erase.ts`):
 * whatever fails there cannot reach it, and one repository's failure never touches another's.
 */
export async function lessonsRepoFileSweepJob(runtime: RepoFileRuntime, orgId: string, projects: readonly string[], budgetMs: number, dayNumber: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  const counts = newCounts();
  if (!org.success) return counts;
  const started = runtime.deps.now();
  const capped = [...new Set(projects)].sort().slice(0, MAX_REPO_FILE_PROJECTS);
  for (const project of rotated(capped, capped.length === 0 ? 0 : dayNumber % capped.length)) {
    if (runtime.deps.now() - started > budgetMs) { counts.repoFileSkipped += 1; continue; }
    const key = { workspaceId: org.data, project };
    try {
      const swept = await sweepProject(runtime, key);
      counts.repoFileErasureFailures += swept.failures;
      counts.repoFileErasuresClosed += swept.closed;
    } catch { counts.repoFileFailures += 1; runtime.deps.log?.("lessons_job.repo_file_sweep_failed", {}); }
  }
  return counts;
}

/** The weekly publish pass for every project's switched-on repositories (the sweep is not part of it). */
export async function lessonsRepoFilePublishJob(runtime: RepoFileRuntime, orgId: string, projects: readonly string[], budgetMs: number, dayNumber: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  const counts = newCounts();
  if (!org.success) return counts;
  const started = runtime.deps.now();
  const capped = [...new Set(projects)].sort().slice(0, MAX_REPO_FILE_PROJECTS);
  // A different starting project each day, so a time budget that runs out never cuts off the same projects every night.
  for (const project of rotated(capped, capped.length === 0 ? 0 : dayNumber % capped.length)) {
    if (runtime.deps.now() - started > budgetMs) { counts.repoFileSkipped += 1; continue; }
    const key = { workspaceId: org.data, project };
    try {
      const states = await runtime.deps.state.list(key);
      const work = states.filter((state) => state.enabled || state.closing.length > 0 || state.pending !== undefined);
      if (work.length === 0) continue;
      const targets = await runtime.targets(key.workspaceId, project);
      const deps: RepoFileDeps = { ...runtime.deps, holder: runtime.newHolder?.() ?? `nightly-${String(runtime.deps.now())}` };
      // A different repository first each day, like the projects, so a time budget that runs out never cuts off the same ones.
      const first = dayNumber % work.length;
      for (const state of [...work.slice(first), ...work.slice(0, first)]) {
        if (runtime.deps.now() - started > budgetMs) { counts.repoFileSkipped += 1; continue; }
        const target = targets.find((candidate) => candidate.place === state.place);
        if (target === undefined) {
          // The repository left the project: say so on the row instead of failing silently.
          if (state.enabled) await runtime.deps.state.put(key, { ...state, problem: "repository_gone" }, state.revision).catch(() => undefined);
          counts.repoFileProblems += 1;
          continue;
        }
        if (!state.enabled) { await finishClosings(deps, key, target, (await runtime.deps.state.get(key, state.place)) ?? state); continue; }
        // A confirmed retire is carried out whether or not this repository's weekly pass is due: read-back only, no pull request, no change to the pass's own clock. It comes first, so a pass that is due sees its result.
        if (state.readBackHeld?.verdict === "retire") await runRetireRead(deps, key, target);
        const result = await runRepoFilePass(deps, key, target);
        if (result.status === "opened") counts.repoFilePrsOpened += 1;
        else if (result.status === "left") counts.repoFileLeft += 1;
        else if (result.status === "problem") counts.repoFileProblems += 1;
      }
    } catch {
      counts.repoFileFailures += 1;
      runtime.deps.log?.("lessons_job.repo_file_failed", {});
    }
  }
  return counts;
}

/** Both, sweep first (each on the whole budget it is given: callers that share a night give the sweep a slice of its own). */
export async function lessonsRepoFileJob(runtime: RepoFileRuntime, orgId: string, projects: readonly string[], budgetMs: number, dayNumber: number): Promise<Record<string, number>> {
  const swept = await lessonsRepoFileSweepJob(runtime, orgId, projects, budgetMs, dayNumber);
  const published = await lessonsRepoFilePublishJob(runtime, orgId, projects, budgetMs, dayNumber);
  return Object.fromEntries(Object.keys(swept).map((name) => [name, swept[name]! + published[name]!]));
}
