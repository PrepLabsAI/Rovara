// TE-MR2b: test selection across repositories. A change in repository A selects the affected tests in A and in every repository that depends on A (transitively), by the repository-qualified coverage map. Pure: the worker hands in
// the changes it computed itself per repository, the map, and the dependency facts it derived from the repositories' own manifests; nothing here reads a file or runs a command.
//
// The rule is the single-repository one (selection.ts `selectTests`, which runs underneath every check), with the repository kept apart:
//   - a check selects only its own repository's tests (`check.repositoryId`); the same test id in two repositories is two tests;
//   - the check sees its repository's changes as they are, and a provider's changes under a key no path of its own can take (`providerKey`); a path the map does not hold is "unknown", which runs the whole check;
//   - a changed repository that the check's repository does NOT depend on is ignored only when both are fully known. A repository whose dependencies are not fully known (Maven, Gradle, no manifest) may depend on anything,
//     so the check runs whole. Unfinished facts (ambiguous names, an unreadable manifest, a limit, an abort) run every test check whole;
//   - the edges are the union of the base and the candidate manifests (multi-repo-edges.ts). A dependency the candidate removed or added still relates the repositories: ABSENCE FROM THE CANDIDATE NEVER SKIPS A TEST.
// Two-repository changes keep running in full until this is proven live: `MULTI_REPO_SELECTION_LIVE` is off, and the caller (test-env-plan.ts) reaches this only when it is on AND the plan carries the map.
import type { ProjectCommand, RepositoryCoverageMap, TestEnvironmentBody } from "@agentx/contracts";
import { commandWithSelection, pathRunsFullSuite, selectTests, type ChangedPath, type CheckSelectionPlan, type CoverageMap } from "./selection.js";

/**
 * Whether a change in two repositories may be selected down. OFF: such a task runs every test check in full, as before this lane. It is switched on only after a live proof (a worker run with the map on two real
 * repositories); the planner itself is exercised through its `live` argument in tests.
 */
export const MULTI_REPO_SELECTION_LIVE: boolean = false;

/** The dependency facts selection needs (`RepositoryFacts` of multi-repo-edges.ts, only the parts it reads). */
export interface SelectionFacts { edges: ReadonlyArray<{ consumer: string; provider: string }>; complete: boolean; unknown: readonly string[]; notes?: readonly string[] | undefined }
export interface RepositorySelectionCheck { id: string; kind: string; repositoryId: string; command: ProjectCommand; selectArgs?: readonly string[] | undefined }
export interface RepositorySelectionInput {
  config: Pick<TestEnvironmentBody["selection"], "method" | "declared" | "alwaysRun" | "fullSuiteOn">;
  checks: readonly RepositorySelectionCheck[];
  /** The changes the worker computed itself, by repository. A repository with no change is absent or empty. */
  changes: ReadonlyMap<string, readonly ChangedPath[]>;
  map: RepositoryCoverageMap;
  facts: SelectionFacts;
  /** The repositories the task holds. */
  repositories: readonly string[];
  now: Date;
  lastNightlyFailures?: readonly string[] | undefined;
}

type Fallback = NonNullable<NonNullable<CheckSelectionPlan["selection"]>["fallbackReason"]>;
const whole = (check: RepositorySelectionCheck, reason: Fallback): CheckSelectionPlan => ({ command: check.command, selection: { method: "full", selected: 0, total: 0, fallbackReason: reason } });
/** A provider's path as the check sees it. Repository ids hold no control character (REPOSITORY_ID_PATTERN) and a path holding \u0001 is refused before this is used, so no path of the check's own repository can equal it. */
const providerKey = (repositoryId: string, path: string): string => `\u0001${repositoryId}\u0001${path}`;
const hasMarker = (change: ChangedPath): boolean => change.path.includes("\u0001") || (change.oldPath?.includes("\u0001") ?? false);

/** Every repository `repositoryId` depends on, directly or through others, by the union edges. Terminates on a cycle. */
function providersOf(repositoryId: string, edges: SelectionFacts["edges"]): Set<string> {
  const byConsumer = new Map<string, string[]>();
  for (const edge of edges) byConsumer.set(edge.consumer, [...(byConsumer.get(edge.consumer) ?? []), edge.provider]);
  const found = new Set<string>();
  const queue = [repositoryId];
  for (let head = 0; head < queue.length; head += 1) {
    for (const provider of byConsumer.get(queue[head] as string) ?? []) if (!found.has(provider)) { found.add(provider); queue.push(provider); }
  }
  found.delete(repositoryId);
  return found;
}

/** Ids the check's repository owns, once each. */
function inventoryOf(map: RepositoryCoverageMap, repositoryId: string): string[] {
  const ids = new Set<string>();
  for (const entry of map.entries) for (const test of entry.tests) if (test.repositoryId === repositoryId) ids.add(test.id);
  return [...ids];
}

/** For each test check: the command to run (the customer's own, with the selected tests only in the approved place) and what to say. Never throws on a hostile path or repository id (own-key maps, no property lookups on input). */
export function planRepositorySelections(input: RepositorySelectionInput): Map<string, CheckSelectionPlan> {
  const plans = new Map<string, CheckSelectionPlan>();
  const prepared = new Set(input.repositories);
  const unknown = new Set(input.facts.unknown);
  const changed = [...input.changes].filter(([, changes]) => changes.length > 0);
  // The map's own evidence of a dependency: a file of repository P touched by a test of repository R makes P a provider of R's checks whatever the manifests say (a sub-package, an alias, a submodule are invisible to them).
  const touchedBy = new Map<string, Set<string>>();
  for (const entry of input.map.entries) for (const test of entry.tests) {
    const files = touchedBy.get(test.repositoryId) ?? new Set<string>();
    files.add(entry.repositoryId);
    touchedBy.set(test.repositoryId, files);
  }
  for (const check of input.checks) {
    if (check.kind !== "test" || input.config.alwaysRun.includes(check.id)) { plans.set(check.id, { command: check.command }); continue; }
    plans.set(check.id, selectCheck(check));
  }
  return plans;

  function selectCheck(check: RepositorySelectionCheck): CheckSelectionPlan {
    const { config } = input;
    // Declared globs and the import graph are one repository's; with two they cannot be told apart. Only the map is repository-aware.
    if (config.method !== "coverage_map" && config.method !== "full") return whole(check, "map_missing");
    if (!prepared.has(check.repositoryId) || !input.facts.complete) return whole(check, "unknown_file");
    if (check.selectArgs === undefined || check.selectArgs.length === 0) return whole(check, "no_template");
    const providers = providersOf(check.repositoryId, input.facts.edges);
    for (const touched of touchedBy.get(check.repositoryId) ?? []) if (touched !== check.repositoryId) providers.add(touched);
    const own: ChangedPath[] = [];
    const seen: ChangedPath[] = [];
    for (const [repositoryId, changes] of changed) {
      if (changes.some(hasMarker)) return whole(check, "unknown_file");
      if (repositoryId === check.repositoryId) { own.push(...changes); continue; }
      if (providers.has(repositoryId)) {
        // A provider's change that changes what every test means is the whole check, judged on the provider's own path.
        if (changes.some((change) => pathRunsFullSuite(change.path, config) || (change.oldPath !== undefined && pathRunsFullSuite(change.oldPath, config)))) return whole(check, "full_suite_on_path");
        seen.push(...changes.map((change) => ({ ...change, path: providerKey(repositoryId, change.path), ...(change.oldPath === undefined ? {} : { oldPath: providerKey(repositoryId, change.oldPath) }) })));
        continue;
      }
      // Not a provider of this repository. Skipped ONLY when both are fully known; otherwise it may well be one.
      if (unknown.has(check.repositoryId) || unknown.has(repositoryId)) return whole(check, "unknown_file");
    }
    const files: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const entry of input.map.entries) {
      const key = entry.repositoryId === check.repositoryId ? entry.path : providerKey(entry.repositoryId, entry.path);
      files[key] = entry.tests.filter((test) => test.repositoryId === check.repositoryId).map((test) => test.id);
    }
    // A provider's changed file that the map holds but that no test of this repository touches is not "nothing depends on it": the map may simply not record coverage of the provider's files from this repository's runs
    // (a provider installed from a registry reads as exactly that). The whole check, until a producer is proven to measure it.
    for (const change of seen) for (const path of change.oldPath === undefined ? [change.path] : [change.path, change.oldPath]) if (files[path]?.length === 0) return whole(check, "unknown_file");
    const map: CoverageMap = { builtAt: input.map.builtAt, files };
    const result = selectTests({ config, check: { id: check.id, selectArgs: check.selectArgs }, changes: [...own, ...seen], inventory: inventoryOf(input.map, check.repositoryId), coverageMap: map, lastNightlyFailures: input.lastNightlyFailures, now: input.now });
    if (result.mode === "always_full") return { command: check.command };
    if (result.mode === "full") return { command: check.command, selection: result.selection };
    return { command: commandWithSelection(check.command, check.selectArgs, result.tests), selection: result.selection };
  }
}
