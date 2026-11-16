// Deploy facts from the code host (M7 slice 2, H2a; decision 252b): the neutral `deployment.status` event and the bounded `deploymentStatuses` read, both mapped to the watcher's one `DeployFact`.
//
// Nothing here believes the host beyond "look at this commit in this environment": the watcher resolves the commit itself through the merge-commit index (company + repository + commit), so a deployment of a commit Rovara
// did not merge is ignored. Everything is checked at runtime (an event or an answer is untrusted): a shape that does not check is ignored with fixed words, and nothing echoes the input.
//
// The read is the backstop for a deployment event that was never delivered, and the laptop's only way to learn of a deploy. It is read only and bounded in TOTAL (targets, requests, time), runs only for a
// merge the company's index holds and whose project has the watcher switched on (a project that is off costs no request), and reads the host the task's own project pins for that repository, in the company's scope.
import { CodeHostEventSchema, DeploymentStatusReadSchema, type CodeHost, type DeploymentStatusRead, type HostScope, type OrgId, type PageBudget, type RepositoryRef } from "@agentx/contracts";
import { findMergeCommit } from "../proof/revert/merge-commit-index.js";
import { isRepositoryName } from "./facts.js";
import { guarded, observeDeployment, type DeploymentOutcome } from "./watch.js";
import { afterMergeSettingsOf } from "./settings.js";
import type { AfterMergeDeps, DeployFact } from "./ports.js";

const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/u;

/** `owner/name` (lower case) of a plain GitHub repository address, or undefined (another host, another shape, a trailing part). The merge-commit index is GitHub's, so facts of another host are not matched. */
export function githubRepositoryOfUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = GITHUB_REPOSITORY_URL.exec(url);
  const name = match?.[1]?.toLowerCase();
  return name !== undefined && isRepositoryName(name) ? name : undefined;
}

/** The deploy fact a `deployment.status` event says, or undefined for any other event, a repository that is not a GitHub address, or an event that does not check. */
export function deployFactOfEvent(event: unknown): DeployFact | undefined {
  const parsed = CodeHostEventSchema.safeParse(event);
  if (!parsed.success || parsed.data.type !== "deployment.status") return undefined;
  const repository = githubRepositoryOfUrl(parsed.data.repository.url);
  if (repository === undefined) return undefined;
  return { repository, revision: parsed.data.revision, environment: parsed.data.environment, state: parsed.data.state, source: "code_host" };
}

/** The deploy facts a host's answer to `deploymentStatuses` says for one revision, or undefined when the answer does not check (it is then ignored whole, never partly believed). */
export function deployFactsOfRead(repository: string, revision: string, read: unknown): { facts: DeployFact[]; complete: boolean } | undefined {
  const parsed = DeploymentStatusReadSchema.safeParse(read);
  if (!parsed.success) return undefined;
  return { facts: parsed.data.statuses.map((status) => ({ repository, revision, environment: status.environment, state: status.state, source: "code_host" as const })), complete: parsed.data.complete };
}

/** The code host and repository a task's pinned project names for a repository, in the company's scope. The host binding is the one place a GitHub repository name is tied to a company's project. */
export interface AfterMergeHost { codeHost: CodeHost; repository: RepositoryRef; scope: HostScope }
export interface AfterMergeHosts {
  /** The host for `repositoryFullName` (lower case) as the task's pinned project registers it, or undefined: the task is not this company's, the project does not pin that repository, or its host is not registered here. Never another company's host. */
  forTask(orgId: OrgId, taskId: string, repositoryFullName: string): Promise<AfterMergeHost | undefined>;
}

/** One merge to ask the host about. The caller names the repository and the commit it merged; the company's index decides whether it is ours. */
export interface DeploymentTarget { repository: string; revision: string }

/** What the host knows about the deployments of the targets, as the watcher took them: one entry per target, in order, with fixed words only. */
export type ReconcileOutcome =
  | { kind: "off" }
  | { kind: "unavailable" }
  | { kind: "skipped"; reason: "not_ours" | "no_host" | "unsupported" | "budget" }
  | { kind: "read"; deployments: DeploymentOutcome[]; complete: boolean };

/** The most targets and requests one reconcile pass spends, and its time: one TOTAL bound across every target. A pass that runs out stops and leaves the rest for the next pass. */
export const RECONCILE_TARGETS_MAX = 10;
export const RECONCILE_REQUESTS_MAX = 40;
export const RECONCILE_MS_MAX = 20_000;

export interface ReconcileLimits { targets?: number; requests?: number; ms?: number }

/** A budget over a number of requests and a deadline. `beforeRequest` throws (a fixed-word error) when either is used up. */
function pageBudgetOf(now: () => Date, limits: { requests: number; ms: number }): PageBudget & { spent: () => number } {
  const startedAt = now().getTime();
  let requests = 0;
  return {
    beforeRequest: () => {
      if (requests >= limits.requests || now().getTime() >= startedAt + limits.ms) {
        const exhausted = new Error("the pass used its request allowance");
        exhausted.name = "AfterMergeBudgetExhausted";
        throw exhausted;
      }
      requests += 1;
    },
    spent: () => requests,
  };
}

/**
 * Asks the host about the deployments of merges the company made, and gives each answer to the watcher. For each target (at most `targets`): the merge must be in the company's index, its project must have the watcher on
 * (read live), the host is the task's own project's, and the host must offer `deploymentStatuses`. A read that throws is "unavailable" for that target (a rate limit, a refused read, an App without the permission): it is never
 * read as "no deployments", and the next pass asks again. Returns one outcome per target handled; targets past the bound are not handled.
 */
export async function reconcileDeployments(deps: AfterMergeDeps, orgId: OrgId, hosts: AfterMergeHosts, targets: readonly DeploymentTarget[], limits: ReconcileLimits = {}): Promise<ReconcileOutcome[]> {
  if (deps.settings === undefined) return [{ kind: "off" }];
  const budget = pageBudgetOf(deps.now, { requests: limits.requests ?? RECONCILE_REQUESTS_MAX, ms: limits.ms ?? RECONCILE_MS_MAX });
  const outcomes: ReconcileOutcome[] = [];
  for (const target of targets.slice(0, limits.targets ?? RECONCILE_TARGETS_MAX)) {
    outcomes.push(await reconcileOne(deps, orgId, hosts, target, budget));
  }
  return outcomes;
}

async function reconcileOne(deps: AfterMergeDeps, orgId: OrgId, hosts: AfterMergeHosts, target: DeploymentTarget, budget: PageBudget): Promise<ReconcileOutcome> {
  if (!isRepositoryName(target.repository) || typeof target.revision !== "string") return { kind: "skipped", reason: "not_ours" };
  const repository = target.repository.toLowerCase();
  const revision = target.revision.toLowerCase();
  const found = await guarded(deps, async () => {
    const merge = await findMergeCommit(deps.store, { orgId, repositoryFullName: repository, sha: revision });
    if (merge === undefined) return undefined;
    // The merge's task is this company's (the reader never answers for another company's task), and its project has the watcher on: a project that is off costs no request.
    let task: Awaited<ReturnType<AfterMergeDeps["tasks"]["read"]>>;
    try {
      task = await deps.tasks.read(orgId, merge.taskId);
    } catch {
      deps.log?.("after_merge.task_unreadable", { level: "warn" });
      return "unavailable" as const;
    }
    if (task === undefined) return undefined;
    if (await afterMergeSettingsOf(deps.settings, orgId, task.project) === undefined) return "off" as const;
    return { taskId: merge.taskId };
  });
  if (found === "unavailable") return { kind: "unavailable" };
  if (found === "off") return { kind: "off" };
  if (found === undefined) return { kind: "skipped", reason: "not_ours" };
  let host: AfterMergeHost | undefined;
  try {
    host = await hosts.forTask(orgId, found.taskId, repository);
  } catch {
    deps.log?.("after_merge.host_unavailable", { level: "warn" });
    return { kind: "unavailable" };
  }
  if (host === undefined) return { kind: "skipped", reason: "no_host" };
  if (typeof host.codeHost.deploymentStatuses !== "function") return { kind: "skipped", reason: "unsupported" };
  let read: DeploymentStatusRead;
  try {
    read = await host.codeHost.deploymentStatuses(host.repository, revision, host.scope, budget);
  } catch (error) {
    // Fixed words and the error's class only: its message may carry the host's text.
    deps.log?.("after_merge.deployment_read_failed", { level: "warn", error: error instanceof Error ? error.name : "unknown" });
    return (error instanceof Error && error.name === "AfterMergeBudgetExhausted") ? { kind: "skipped", reason: "budget" } : { kind: "unavailable" };
  }
  const facts = deployFactsOfRead(repository, revision, read);
  if (facts === undefined) {
    deps.log?.("after_merge.deployment_read_invalid", { level: "warn" });
    return { kind: "unavailable" };
  }
  const deployments: DeploymentOutcome[] = [];
  for (const fact of facts.facts) deployments.push(await observeDeployment(deps, orgId, fact));
  return { kind: "read", deployments, complete: facts.complete };
}
