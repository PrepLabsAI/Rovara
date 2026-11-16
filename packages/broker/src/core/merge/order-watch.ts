// MR3b (TE-R3): what the tracking pass does with the merge order. Rovara never merges by itself (owner decision 1) and never takes a merge back; it WATCHES. When a person merges a pull request by hand on the code host
// ahead of the one it depends on, the pass says so once (a `stuck` milestone, which the session's timeline and the chat channels carry, naming every pull request of the task), and a pull request that depends on the
// repository still waiting stays a draft until that repository merges (the same hold the change proof and the scope question use: `held` in `trackOne`). Nothing here runs without dependency facts: a task with no facts,
// facts that cannot be read, a dependency cycle or no pull request merged out of order is tracked exactly as it always was.
import { createHash } from "node:crypto";
import type { CodeMilestone, OrgId, TransactItem, WorkflowSnapshot } from "@agentx/contracts";
import { inertLine } from "../proof/inert-text.js";
import { isHostRateLimit } from "./host-port.js";
import { ciFailureWaitLine, heldDependents, mergeOrderOf, mergeOrderStateLines, perRepositoryCiLines, waitingProviders, MERGE_ORDER_NAME_MAX, MERGE_ORDER_WORDS, type MergeOrder } from "./merge-order.js";
import type { CodeMilestones, MergeTask } from "./seams.js";

type DependencyOrder = Extract<MergeOrder, { kind: "dependencies" }>;
type PullRequestEntry = NonNullable<WorkflowSnapshot["pullRequests"]>[number];

const requiredOf = (workflow: WorkflowSnapshot): PullRequestEntry[] => (workflow.pullRequests ?? []).filter((entry) => entry.required);

/**
 * The order of the task's required pull requests when it comes from dependencies, else undefined: no seam, no facts, a cycle, facts that cannot be read, a seam that throws. A pass never guesses an order, and never
 * fails because the facts are missing (it logs once by name; the press is where an unreadable order is refused).
 */
export async function dependencyOrderOf(
  deps: { repositoryEdges?: ((task: MergeTask) => unknown) | undefined; log?: ((event: string, fields: Record<string, unknown>) => void) | undefined },
  task: MergeTask & { workflow: WorkflowSnapshot },
): Promise<DependencyOrder | undefined> {
  if (deps.repositoryEdges === undefined) return undefined;
  const repositories = requiredOf(task.workflow).map((entry) => entry.repositoryId);
  if (new Set(repositories).size < 2) return undefined;
  try {
    const order = mergeOrderOf(repositories, await deps.repositoryEdges(task));
    return order.kind === "dependencies" ? order : undefined;
  } catch (error) {
    deps.log?.("merge_tracking.order_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

const mergedRepositoriesOf = (workflow: WorkflowSnapshot): string[] => requiredOf(workflow).filter((entry) => entry.state === "MERGED").map((entry) => entry.repositoryId);

/** Whether this pull request is kept as a draft because of the merge order: it depends on a repository that is still waiting, after a pull request was merged ahead of that repository. */
export async function orderHoldsReady(
  deps: Parameters<typeof dependencyOrderOf>[0], task: MergeTask & { workflow: WorkflowSnapshot }, repositoryId: string,
): Promise<boolean> {
  const order = await dependencyOrderOf(deps, task);
  return order !== undefined && heldDependents(order, mergedRepositoriesOf(task.workflow)).includes(repositoryId);
}

/** The state of one provider on the code host right now, read live by the caller (it never comes from the workflow, which lags a pass behind). `unknown`: it could not be read. */
export type ProviderMergeState = "merged" | "not_merged" | "unknown";

/** A stable milestone number for one set of out-of-order pairs: the same pairs are said once (a milestone is written only if absent), new ones are said again. */
const numberOf = (pairs: ReadonlyArray<{ consumer: string; provider: string }>): number =>
  Number.parseInt(createHash("sha256").update(`out_of_order\n${pairs.map((pair) => `${pair.consumer}>${pair.provider}`).join("\n")}`).digest("hex").slice(0, 6), 16) % 1_000_000;

/**
 * The warning for the pull requests this save moves to MERGED: the milestone items (none when every one that merged has its providers merged or there is nothing to compare). A provider the workflow still has open is
 * read live (`providerState`): one that the host says merged is not "out of order" (the pass has not recorded it yet, or both merged in the right order between two passes), one that cannot be read is not guessed
 * about. At most 32 pull requests are named (the milestone's bound). `after` is the workflow this save writes.
 */
export async function outOfOrderMilestoneItems(
  deps: {
    milestones: CodeMilestones;
    repositoryEdges?: ((task: MergeTask) => unknown) | undefined;
    providerState(repositoryId: string): Promise<ProviderMergeState>;
    log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  },
  task: MergeTask & { orgId: OrgId; workflow: WorkflowSnapshot }, before: WorkflowSnapshot, after: WorkflowSnapshot, now: string,
): Promise<TransactItem[]> {
  const beforeMerged = new Set(mergedRepositoriesOf(before));
  const newly = mergedRepositoriesOf(after).filter((repository) => !beforeMerged.has(repository));
  if (newly.length === 0) return [];
  const order = await dependencyOrderOf(deps, { ...task, workflow: after });
  if (order === undefined) return [];
  const afterMerged = new Set(mergedRepositoriesOf(after));
  const pairs: Array<{ consumer: string; provider: string }> = [];
  for (const consumer of newly) {
    for (const provider of order.providersOf[consumer] ?? []) {
      if (afterMerged.has(provider)) continue;
      // A host that says "slow down" goes up to the sweep (it pauses); any other fault is "cannot tell", not a guess.
      const state = await deps.providerState(provider).catch((error: unknown): ProviderMergeState => {
        if (isHostRateLimit(error)) throw error;
        return "unknown";
      });
      if (state === "not_merged") pairs.push({ consumer, provider });
      else if (state === "unknown") deps.log?.("merge_tracking.order_provider_unreadable", { taskId: task.taskId });
    }
  }
  if (pairs.length === 0) return [];
  const first = pairs[0]!;
  const held = heldDependents(order, [...afterMerged]);
  const text = MERGE_ORDER_WORDS.outOfOrderWarning(inertLine(first.consumer, MERGE_ORDER_NAME_MAX), inertLine(first.provider, MERGE_ORDER_NAME_MAX), held.map((repository) => inertLine(repository, MERGE_ORDER_NAME_MAX)), pairs.length - 1);
  const milestone: CodeMilestone = {
    kind: "stuck", orgId: task.orgId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: now, text,
    pullRequests: requiredOf(after).slice(0, 32).map((entry) => ({ repository: entry.repositoryId, number: entry.number, url: entry.url })),
  };
  return deps.milestones.items(milestone, numberOf(pairs), { definitionVersion: after.definitionVersion });
}

/**
 * The lines about the merge order for a task's pull request descriptions, its page and its chat: from the task's repositories (those of its candidate and of its required pull requests, so the first description
 * already knows the order before the other pull requests are open). Nothing for one repository, with no seam, with no facts or when the order is today's repository order. Facts that cannot be read, or a cycle, give the
 * fixed "no safe order" words (a description that says nothing would let a person assume an order that was never checked). Never throws.
 */
export async function mergeOrderLinesOfTask(
  deps: { repositoryEdges?: ((task: MergeTask) => unknown) | undefined; log?: ((event: string, fields: Record<string, unknown>) => void) | undefined },
  task: MergeTask & { workflow: WorkflowSnapshot },
  /** MR4: the repository whose description these lines are for: its own CI words follow the order lines. */
  repositoryId?: string,
): Promise<string[]> {
  if (deps.repositoryEdges === undefined) return [];
  const pullRequests = requiredOf(task.workflow);
  const repositories = [...new Set([...(task.workflow.candidate?.repositories ?? []).map((entry) => entry.repositoryId), ...pullRequests.map((entry) => entry.repositoryId)])];
  if (repositories.length < 2) return [];
  let order: MergeOrder;
  try {
    order = mergeOrderOf(repositories, await deps.repositoryEdges(task));
  } catch (error) {
    deps.log?.("merge_tracking.order_unreadable", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    order = { kind: "no_safe_order", reason: "unreadable", repositories: mergeOrderOf(repositories, undefined).repositories };
  }
  return [...mergeOrderStateLines(order, pullRequests), ...(repositoryId === undefined ? [] : perRepositoryCiLines(order, repositoryId, pullRequests))];
}

/** MR4: the providers of this repository that have not merged yet (from the same facts), for keeping a CI failure out of the fix loop. Empty without facts, with facts that cannot be read, or without a dependency. Never throws. */
export async function providersWaitingFor(
  deps: Parameters<typeof dependencyOrderOf>[0], task: MergeTask & { workflow: WorkflowSnapshot }, repositoryId: string,
): Promise<string[]> {
  const order = await dependencyOrderOf(deps, task);
  // A provider whose pull request was closed without merging is not "about to merge": its consumer's failure is no longer explained by waiting.
  return order === undefined ? [] : waitingProviders(order, repositoryId, requiredOf(task.workflow).filter((entry) => entry.state === "MERGED" || entry.state === "CLOSED").map((entry) => entry.repositoryId));
}

/** MR4: what the task page says for this repository's pull request while its CI is failing and a repository it depends on waits. Nothing otherwise. Never throws. */
export async function ciWaitLinesOfTask(deps: Parameters<typeof dependencyOrderOf>[0], task: MergeTask & { workflow: WorkflowSnapshot }, repositoryId: string): Promise<string[]> {
  const order = await dependencyOrderOf(deps, task);
  return order === undefined ? [] : ciFailureWaitLine(order, repositoryId, requiredOf(task.workflow));
}
