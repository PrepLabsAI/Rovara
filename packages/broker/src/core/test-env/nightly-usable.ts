// Which nightly baseline may be trusted as "what already fails". Only the last nightly that is RECENT (finished within 7 days) and ran on the SAME branch the tasks
// are based on (the project's default branch; a project whose repositories do not agree has none). A stale baseline, one from another branch, one that did not fit (truncated) or one that cannot be read is not
// used at all: its failures excuse nothing and no mark is offered from it. The same rule serves any later removal of a mark a maintainer set.
import { PROJECT_REVISION_SK_PREFIX, projectPk, queryAll, type NightlyBaseline, type OrgId } from "@agentx/contracts";
import type { StoreOnly, TestEnvDeps } from "./deps.js";
import { failingSetIsWhole, readNightlyBaseline } from "./nightly.js";

/** A baseline older than this is not used. */
export const NIGHTLY_BASELINE_MAX_AGE_MS = 7 * 86_400_000;
/** A clock skew allowance: a baseline that claims to have finished later than this ahead of now is not believed. */
const FUTURE_SKEW_MS = 3_600_000;

/** The branch the project's tasks are based on: the default branch every repository of its latest revision names. Undefined when it cannot be read or the repositories disagree. */
export async function projectBaseBranch(deps: StoreOnly, orgId: OrgId, project: string): Promise<string | undefined> {
  try {
    const page = await deps.store.query({ pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: PROJECT_REVISION_SK_PREFIX }, descending: true, limit: 1 });
    const definition = page.items[0]?.["definition"] as { repositories?: Array<{ defaultBranch?: unknown }> } | undefined;
    const branches = (definition?.repositories ?? []).map((repository) => repository.defaultBranch);
    const first = branches[0];
    return typeof first === "string" && first !== "" && branches.every((branch) => branch === first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/** TE-MR2b: the repository names of the project's latest revision (the ids a task's repositories carry), each once; undefined when they cannot be read or are none. */
export async function projectRepositoryNames(deps: StoreOnly, orgId: OrgId, project: string): Promise<string[] | undefined> {
  try {
    const page = await deps.store.query({ pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: PROJECT_REVISION_SK_PREFIX }, descending: true, limit: 1 });
    const definition = page.items[0]?.["definition"] as { repositories?: Array<{ name?: unknown }> } | undefined;
    const names = (definition?.repositories ?? []).map((repository) => repository.name);
    return names.length > 0 && names.every((name): name is string => typeof name === "string" && name !== "") && new Set(names).size === names.length ? names : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The branches the task's open pull requests target (distinct), read from its merge-tracking rows. Empty when it has no open pull request yet (it is then based on the project's default branch) or the rows cannot be read.
 */
export async function taskBaseBranches(deps: StoreOnly, taskId: string): Promise<string[]> {
  try {
    const rows = await queryAll(deps.store, { pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "MERGE_TRACKING#" } });
    return [...new Set(rows.filter((item) => item["state"] === "open" && typeof item["baseBranch"] === "string" && item["baseBranch"] !== "").map((item) => item["baseBranch"] as string))];
  } catch {
    return [];
  }
}

/**
 * TE-C1: the branch a task's baseline is looked up on, by the same rule as `nightlyBaselineUsable`: the one branch its open pull requests target when they all agree, else (no open pull request, or the rows cannot be read)
 * the project's default branch. Undefined when its pull requests target different branches, or the default cannot be read: such a task gets no candidates and no words.
 */
export async function taskBaselineBranch(deps: StoreOnly, orgId: OrgId, project: string, taskId: string): Promise<string | undefined> {
  const own = await taskBaseBranches(deps, taskId);
  if (own.length > 1) return undefined;
  return own[0] ?? projectBaseBranch(deps, orgId, project);
}

/** Reads a project's default-branch head from its code host: for a project, a function from a branch to its head now (undefined when it cannot be read). */
export type NightlyHeadReader = (orgId: OrgId, project: string) => (branch: string) => Promise<string | undefined>;

/** The options a caller gives `usableNightlyFailing` for a task: the branches of its open pull requests and, where the host can be asked, the branch's head now. */
export async function nightlyOptionsFor(deps: StoreOnly, task: { taskId: string; orgId: OrgId; project: string }, reader: NightlyHeadReader | undefined): Promise<UsableNightlyOptions> {
  return { taskBranches: await taskBaseBranches(deps, task.taskId), currentHead: reader?.(task.orgId, task.project) };
}

export interface UsableNightlyOptions {
  /** The branches the task itself is based on (`taskBaseBranches`). When given and not empty, the nightly's branch must be each of them: a task on another branch gets no excuse from a nightly of this one. Otherwise the project's default branch is used. */
  taskBranches?: readonly string[] | undefined;
  /** The branch's head commit now, or undefined when it cannot be read. With it, a baseline older than 7 days is still used when it was run on exactly this head (a quiet repository has had nothing to change since). */
  currentHead?: ((branch: string) => Promise<string | undefined>) | undefined;
}

/**
 * Whether `baseline` may be trusted as "what the project's tests do now": whole (its failing set fits), not from the future, on the task's base branch, and either recent (7 days) or run on exactly the branch's
 * head now. The one rule behind both the excuse for a failing test and the automatic removal of a mark .
 */
export async function nightlyBaselineUsable(deps: TestEnvDeps, orgId: OrgId, project: string, baseline: NightlyBaseline, options: UsableNightlyOptions = {}): Promise<boolean> {
  if (!failingSetIsWhole(baseline)) return false;
  const finished = Date.parse(baseline.finishedAt), now = deps.now();
  if (!Number.isFinite(finished) || finished > now + FUTURE_SKEW_MS) return false;
  const own = options.taskBranches ?? [];
  if (own.length > 0) {
    if (!own.every((branch) => branch === baseline.branch)) return false;
  } else {
    const base = await projectBaseBranch(deps, orgId, project);
    if (base === undefined || baseline.branch !== base) return false;
  }
  if (finished < now - NIGHTLY_BASELINE_MAX_AGE_MS) {
    // Older than a week: still what already fails if the branch has not moved since it ran.
    const head = options.currentHead === undefined ? undefined : await options.currentHead(baseline.branch).catch(() => undefined);
    if (head === undefined || head !== baseline.headSha) return false;
  }
  return true;
}

/** The last nightly baseline when it is usable (`nightlyBaselineUsable`), else undefined. */
export async function usableNightlyBaseline(deps: TestEnvDeps, orgId: OrgId, project: string, options: UsableNightlyOptions = {}): Promise<NightlyBaseline | undefined> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  return baseline !== undefined && await nightlyBaselineUsable(deps, orgId, project, baseline, options) ? baseline : undefined;
}

/** The failing tests of the last nightly when it is usable (recent or on the branch's unchanged head, the task's base branch, whole), else undefined. */
export async function usableNightlyFailing(deps: TestEnvDeps, orgId: OrgId, project: string, options: UsableNightlyOptions = {}): Promise<string[] | undefined> {
  const baseline = await usableNightlyBaseline(deps, orgId, project, options);
  return baseline === undefined ? undefined : [...baseline.failed];
}
