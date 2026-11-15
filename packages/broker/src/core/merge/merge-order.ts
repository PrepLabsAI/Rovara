// MR3 (TE-R3; owner O56, O65, DEC 209): the order a task's pull requests merge in when it changes several repositories, and the state of a task that merged only part of them.
//
// A provider merges before its consumers (a library before the app that uses it). The facts are TE-MR2's repository edges (`EvidenceRaw.repositoryEdges.edges`: `{ consumer, provider }`), read
// through the optional `MergeDependencies.repositoryEdges` seam. Only edges between two repositories of the task's own pull requests count; an edge to any other repository says nothing about the
// order of these merges and is dropped. Ties keep the merge core's repository order, so a task with no edges among its repositories merges exactly as it always did.
//
// Facts that cannot be read as a whole (a wrong shape, too many edges, a self-edge) and a dependency cycle both give "no safe order": the press refuses until a person confirms the override
// (DEC 209: only a person overrides the order). Never a guessed order. Rovara never merges by itself (owner decision 1): this module only orders and words the merges a person presses.
// Absence of an edge in the candidate is never used to skip or narrow tests (TE-MR2's rule); this module reads the edges only for ordering.

/** At most this many edges are read (TE-MR2 records at most 64). More is unreadable, not cut short. */
export const MERGE_ORDER_EDGES_MAX = 64;
/** At most this many repositories are ordered in one task (the stuck milestone lists at most 32 pull requests). */
export const MERGE_ORDER_REPOSITORIES_MAX = 32;
const REPOSITORY_ID_MAX = 200;

export type MergeOrder =
  /** No edge among the task's repositories (or no facts): the repository order the merge core always used. */
  | { kind: "repository"; repositories: string[] }
  /** Providers first. `providersOf` lists, for each consumer, the task repositories it depends on. */
  | { kind: "dependencies"; repositories: string[]; providersOf: Record<string, string[]> }
  /** A person must confirm the override; `repositories` is the repository order the override merges in. */
  | { kind: "no_safe_order"; reason: "cycle" | "unreadable"; repositories: string[] };

const repositoryOrder = (ids: readonly string[]): string[] => [...new Set(ids)].sort((left, right) => left.localeCompare(right));

const readableId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= REPOSITORY_ID_MAX;

/** The edges as `[consumer, provider]` pairs, or undefined when any part of the input cannot be read (the whole input is refused, never a partial read). */
function readEdges(facts: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(facts) || facts.length > MERGE_ORDER_EDGES_MAX) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const fact of facts as unknown[]) {
    if (typeof fact !== "object" || fact === null || Array.isArray(fact)) return undefined;
    const { consumer, provider } = fact as { consumer?: unknown; provider?: unknown };
    if (!readableId(consumer) || !readableId(provider) || consumer === provider) return undefined;
    pairs.push([consumer, provider]);
  }
  return pairs;
}

/**
 * The merge order of the task's repositories from the dependency facts. `facts` undefined: no facts (today's order). Runtime-checked: anything but an array of `{ consumer, provider }` objects with
 * short, distinct, non-empty ids (other fields are ignored) is "unreadable".
 */
export function mergeOrderOf(repositoryIds: readonly string[], facts: unknown): MergeOrder {
  const repositories = repositoryOrder(repositoryIds);
  if (repositories.length > MERGE_ORDER_REPOSITORIES_MAX) return { kind: "no_safe_order", reason: "unreadable", repositories };
  if (facts === undefined) return { kind: "repository", repositories };
  const pairs = readEdges(facts);
  if (pairs === undefined) return { kind: "no_safe_order", reason: "unreadable", repositories };
  const inTask = new Set(repositories);
  const providers = new Map<string, Set<string>>();
  for (const [consumer, provider] of pairs) {
    if (!inTask.has(consumer) || !inTask.has(provider)) continue;
    const set = providers.get(consumer) ?? new Set<string>();
    set.add(provider);
    providers.set(consumer, set);
  }
  if (providers.size === 0) return { kind: "repository", repositories };
  // Kahn's order: at each step the repositories whose providers have all merged, the first in repository order going next.
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < repositories.length) {
    const next = repositories.find((repository) => !placed.has(repository) && [...(providers.get(repository) ?? [])].every((provider) => placed.has(provider)));
    if (next === undefined) return { kind: "no_safe_order", reason: "cycle", repositories };
    ordered.push(next);
    placed.add(next);
  }
  const providersOf: Record<string, string[]> = {};
  for (const repository of repositories) {
    const set = providers.get(repository);
    if (set !== undefined) providersOf[repository] = repositoryOrder([...set]);
  }
  return { kind: "dependencies", repositories: ordered, providersOf };
}

export type PartialMergeState =
  | { kind: "none" }
  | { kind: "complete" }
  | {
    kind: "partial";
    merged: string[];
    /** Not merged yet, in merge order. */
    waiting: string[];
    /** The one to merge next. */
    next: string;
    /** A consumer merged while a repository it depends on is not (merged by hand on the code host): the case to warn about. */
    outOfOrder: Array<{ consumer: string; provider: string }>;
    /** What a person can do: finish the merges in order, or be offered a revert of what merged (an offer only, owner decision O13). */
    actions: readonly ["finish_in_order", "offer_revert"];
  };

/** Where a task stands when some of its pull requests merged: from the order and the repositories that merged. */
export function partialMergeState(order: MergeOrder, mergedRepositories: readonly string[]): PartialMergeState {
  const merged = new Set(mergedRepositories);
  const done = order.repositories.filter((repository) => merged.has(repository));
  const waiting = order.repositories.filter((repository) => !merged.has(repository));
  if (done.length === 0) return { kind: "none" };
  if (waiting.length === 0) return { kind: "complete" };
  const outOfOrder: Array<{ consumer: string; provider: string }> = [];
  if (order.kind === "dependencies") {
    for (const consumer of done) for (const provider of order.providersOf[consumer] ?? []) if (!merged.has(provider)) outOfOrder.push({ consumer, provider });
  }
  return { kind: "partial", merged: done, waiting, next: waiting[0]!, outOfOrder, actions: ["finish_in_order", "offer_revert"] };
}

const list = (ids: readonly string[]): string => ids.join(", ");

export const MERGE_ORDER_WORDS = {
  noSafeOrder: {
    cycle: "These repositories depend on each other both ways, so Rovara can't pick a safe merge order. Merge them yourself on the code host, or confirm merging them in the order listed.",
    unreadable: "Rovara couldn't read which of these repositories depend on each other, so it can't pick a safe merge order. Merge them yourself on the code host, or confirm merging them in the order listed.",
  },
  held: (held: readonly string[], merged: readonly string[]): string =>
    `Rovara stopped there, so these were not merged: ${list(held)}. Press Merge again to finish in order, or ask for a revert of ${list(merged)}.`,
  outOfOrder: (consumer: string, provider: string): string => `${consumer} merged before ${provider}, which it depends on.`,
} as const;

/** The sentence a half merge adds when the order came from dependencies: what was held back (the failed one and everything after it, in merge order) and the two next steps. `merged` is in the order it merged. */
export function heldAfterHalfMerge(order: MergeOrder, failed: string, merged: readonly string[]): string {
  const done = new Set(merged);
  const from = order.repositories.indexOf(failed);
  const held = order.repositories.slice(from < 0 ? 0 : from).filter((repository) => !done.has(repository));
  return MERGE_ORDER_WORDS.held(held, merged);
}

/** The order line for the PR and the task page: nothing when the order is today's repository order. */
export function mergeOrderLines(order: MergeOrder, pullRequests: ReadonlyArray<{ repositoryId: string; number: number }>): string[] {
  if (order.kind === "repository") return [];
  if (order.kind === "no_safe_order") return [MERGE_ORDER_WORDS.noSafeOrder[order.reason]];
  const numbers = new Map(pullRequests.map((pr) => [pr.repositoryId, pr.number]));
  const named = order.repositories.map((repository) => (numbers.has(repository) ? `${repository} #${String(numbers.get(repository))}` : repository));
  return [`Merge order: ${named.map((name, index) => (index === 0 ? `${name} first` : `then ${name}`)).join(", ")}.`];
}
