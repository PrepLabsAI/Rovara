// MR3 (TE-R3; owner O56, O65, DEC 209): the order a task's pull requests merge in when it changes several repositories, and the state of a task that merged only part of them.
//
// A provider merges before its consumers (a library before the app that uses it). The facts are TE-MR2's repository edges (`EvidenceRaw.repositoryEdges.edges`: `{ consumer, provider }`), read
// through the optional `MergeDependencies.repositoryEdges` seam. Only edges between two repositories of the task's own pull requests count; an edge to any other repository says nothing about the
// order of these merges and is dropped. Ties keep the merge core's repository order, so a task with no edges among its repositories merges exactly as it always did.
//
// Facts that cannot be read as a whole (a wrong shape, too many edges, a self-edge) and a dependency cycle both give "no safe order": the press refuses until a person confirms the override
// (DEC 209: only a person overrides the order). Never a guessed order. Rovara never merges by itself (owner decision 1): this module only orders and words the merges a person presses.
// Absence of an edge in the candidate is never used to skip or narrow tests (TE-MR2's rule); this module reads the edges only for ordering.

import { inertLine } from "../proof/inert-text.js";

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

/**
 * MR3b: the repositories whose pull requests Rovara keeps as drafts. Only once a consumer merged ahead of a repository it depends on (`outOfOrder`): then every repository that has not merged and depends on
 * one of those providers waits at draft until the provider merges, so it is not merged ahead of it too. Nothing is held while the merges follow the order, or when the order is not from dependencies.
 */
export function heldDependents(order: MergeOrder, mergedRepositories: readonly string[]): string[] {
  const state = partialMergeState(order, mergedRepositories);
  if (order.kind !== "dependencies" || state.kind !== "partial" || state.outOfOrder.length === 0) return [];
  const behind = new Set(state.outOfOrder.map((pair) => pair.provider));
  return state.waiting.filter((repository) => (order.providersOf[repository] ?? []).some((provider) => behind.has(provider)));
}

/** A repository's name in a line shown to people (a pull request description, the task page, a chat): one inert line, at most this long, so the line stays bounded whatever the names are. */
export const MERGE_ORDER_NAME_MAX = 40;
const nameOf = (id: string): string => inertLine(id, MERGE_ORDER_NAME_MAX);

export const MERGE_ORDER_WORDS = {
  noSafeOrder: {
    cycle: "These repositories depend on each other both ways, so Rovara can't pick a safe merge order. Merge them yourself on the code host, or confirm merging them in the order listed.",
    unreadable: "Rovara couldn't read which of these repositories depend on each other, so it can't pick a safe merge order. Merge them yourself on the code host, or confirm merging them in the order listed.",
  },
  held: (held: readonly string[], merged: readonly string[]): string =>
    `Rovara stopped there, so these were not merged: ${list(held)}. Press Merge again to finish in order, or ask for a revert of ${list(merged)}.`,
  outOfOrder: (consumer: string, provider: string): string => `${consumer} merged before ${provider}, which it depends on.`,
  /** MR3b: what the task and its chat are told once when a pull request was merged ahead of the one it depends on (by hand, on the code host). `held` are the drafts Rovara keeps; `more` the other pairs. */
  /** MR4 (TE-R4): what a consumer's pull request says about its own CI. `named` is the providers' names, already joined (`namedProviders`). */
  ciAlone: (named: string, plural: boolean): string => `Tested together in Rovara; your CI tests each repository alone and may fail until ${named} ${plural ? "merge" : "merges"}.`,
  /** MR4: what the task page says while that CI is failing: said as it is, with no promise about a re-run (Rovara cannot re-run a person's CI yet). */
  ciFailureWaits: (named: string, plural = false): string => `Its own CI is failing, and may until ${named} ${plural ? "merge" : "merges"}: it tests this repository alone. Rovara is not trying to fix that failure before then.`,
  /** Which pull requests Rovara keeps as drafts, and until what: at most three are named. */
  keptAsDraft: (held: readonly string[], provider: string): string => {
    const shown = held.slice(0, 3);
    return `Rovara keeps ${list(shown)}${held.length > shown.length ? ` and ${String(held.length - shown.length)} more` : ""} as a draft until ${provider} merges.`;
  },
  outOfOrderWarning: (consumer: string, provider: string, held: readonly string[], more: number): string => {
    const holding = held.length === 0 ? "" : ` ${MERGE_ORDER_WORDS.keptAsDraft(held, provider)}`;
    return `${consumer} merged before ${provider}, which it depends on.${holding} Merge ${provider} next, or ask for a revert of ${consumer}.${more > 0 ? ` ${String(more)} more merged out of order.` : ""}`;
  },
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
  const named = order.repositories.map((repository) => (numbers.has(repository) ? `${nameOf(repository)} #${String(numbers.get(repository))}` : nameOf(repository)));
  return [`Merge order: ${named.map((name, index) => (index === 0 ? `${name} first` : `then ${name}`)).join(", ")}.`];
}

/**
 * MR3b: the lines the task page, the pull request description and the chat show about the order: the order itself (nothing when it is today's repository order), and, when a pull request was merged ahead of the one it
 * depends on, what happened and which drafts Rovara keeps. `pullRequests` are the task's required pull requests (`state: "MERGED"` for the merged ones). Fixed words; every name is one inert line.
 */
export function mergeOrderStateLines(order: MergeOrder, pullRequests: ReadonlyArray<{ repositoryId: string; number: number; state?: string | undefined }>): string[] {
  const lines = mergeOrderLines(order, pullRequests);
  if (order.kind !== "dependencies") return lines;
  const merged = pullRequests.filter((pr) => pr.state === "MERGED").map((pr) => pr.repositoryId);
  const state = partialMergeState(order, merged);
  if (state.kind !== "partial" || state.outOfOrder.length === 0) return lines;
  const held = heldDependents(order, merged);
  const [first, ...rest] = state.outOfOrder;
  return [...lines, MERGE_ORDER_WORDS.outOfOrderWarning(nameOf(first!.consumer), nameOf(first!.provider), held.map(nameOf), rest.length)];
}

// ---- MR4 (TE-R4): each repository's own CI tests that repository alone

/** The repositories a repository depends on that have not merged yet, in repository order. Only for an order from dependencies: no other order says what a pull request is waiting for. */
export function waitingProviders(order: MergeOrder, repositoryId: string, mergedRepositories: readonly string[]): string[] {
  if (order.kind !== "dependencies") return [];
  const merged = new Set(mergedRepositories);
  return (order.providersOf[repositoryId] ?? []).filter((provider) => !merged.has(provider));
}

/** The providers named with their pull request numbers where known: at most three, then a count. */
function namedProviders(waiting: readonly string[], pullRequests: ReadonlyArray<{ repositoryId: string; number: number }>): { text: string; plural: boolean } {
  const numbers = new Map(pullRequests.map((pr) => [pr.repositoryId, pr.number]));
  const names = waiting.map((repository) => (numbers.has(repository) ? `${nameOf(repository)} #${String(numbers.get(repository))}` : nameOf(repository)));
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const text = rest > 0 ? `${shown.join(", ")} and ${String(rest)} more` : shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`;
  return { text, plural: names.length > 1 };
}

const mergedOf = (pullRequests: ReadonlyArray<{ repositoryId: string; state?: string | undefined }>): string[] => pullRequests.filter((pr) => pr.state === "MERGED" || pr.state === "CLOSED").map((pr) => pr.repositoryId);

/** The sentence a consumer's pull request carries about its own CI while a repository it depends on waits (nothing otherwise: a provider, an independent repository, no dependency facts). */
export function perRepositoryCiLines(order: MergeOrder, repositoryId: string, pullRequests: ReadonlyArray<{ repositoryId: string; number: number; state?: string | undefined }>): string[] {
  const waiting = waitingProviders(order, repositoryId, mergedOf(pullRequests));
  if (waiting.length === 0) return [];
  const named = namedProviders(waiting, pullRequests);
  return [MERGE_ORDER_WORDS.ciAlone(named.text, named.plural)];
}

/** The sentence the task page adds for a consumer whose CI is failing while a repository it depends on waits. */
export function ciFailureWaitLine(order: MergeOrder, repositoryId: string, pullRequests: ReadonlyArray<{ repositoryId: string; number: number; state?: string | undefined }>): string[] {
  const waiting = waitingProviders(order, repositoryId, mergedOf(pullRequests));
  if (waiting.length === 0) return [];
  const named = namedProviders(waiting, pullRequests);
  return [MERGE_ORDER_WORDS.ciFailureWaits(named.text, named.plural)];
}
