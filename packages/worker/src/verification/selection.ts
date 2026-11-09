// Proof and test environment E5 (design proof-test-env, section 4.5): run the tests a change can affect, not the whole suite, and say plainly what was not run. Pure: the worker hands in the diff it computed
// itself (never the agent's claim), the test inventory, the nightly coverage map and the import graph; nothing here reads a file or runs a command.
//
// Methods, best first: `coverage_map` (the nightly run records which tests touch which files), `import_graph` (a test is affected when it imports, transitively, a changed module), `declared` (the maintainer's
// globs), `full`. Always added to a selection: tests in new or changed test files, and the tests that failed in the last nightly.
//
// FAIL CLOSED to the full suite (and the reason is recorded, in the evidence's fixed words) when:
//   - the check has no approved `selectArgs` template (Rovara never rewrites the customer's command);
//   - a changed path matches `fullSuiteOn` (lockfiles, conftest, build and CI config), counting a rename's old path;
//   - the method's input is missing (`map_missing`) or the map is older than 7 days (`map_stale`);
//   - a changed non-test file is unknown to the method (`unknown_file`);
//   - more than 40% of the tests would be selected, or the selected ids cannot be passed safely (`over_selected`).
// A check listed in `alwaysRun` is never selected down; it runs in full and carries no selection.
import { posix } from "node:path";
import type { z } from "zod";
import {
  isRerunnableTestId,
  type EvidenceSelectionSchema,
  TEST_ENV_SELECT_PLACEHOLDER,
  TEST_ENV_ROUND_BUDGET_MIN,
  type ProjectCommand,
  type TestEnvironmentBody,
} from "@agentx/contracts";

type EvidenceSelection = z.infer<typeof EvidenceSelectionSchema>;

export const SELECTION_MAP_MAX_AGE_HOURS = 7 * 24;
export const SELECTION_OVER_FRACTION = 0.4;
/** The most test ids passed on one command line, and their most bytes together: a longer list runs the whole suite instead. */
export const SELECTION_ARGS_MAX_TESTS = 2_000;
export const SELECTION_ARGS_MAX_BYTES = 64 * 1_024;

export type SelectionFallback = NonNullable<EvidenceSelection["fallbackReason"]>;

export interface ChangedPath { path: string; status: "added" | "modified" | "deleted" | "renamed"; oldPath?: string }
/** The nightly run's map: which tests touched each source file. Test ids are inventory ids (`tests/test_match.py::test_no_region`, or a file path). */
export interface CoverageMap { builtAt: string; files: Readonly<Record<string, readonly string[]>> }
/** A file's direct imports, as repository paths. Built by `buildImportGraph`. */
export type ImportGraph = ReadonlyMap<string, ReadonlySet<string>>;

export interface SelectionInput {
  config: Pick<TestEnvironmentBody["selection"], "method" | "declared" | "alwaysRun" | "fullSuiteOn">;
  check: { id: string; selectArgs?: readonly string[] | undefined };
  changes: readonly ChangedPath[];
  /** Every test of the check, by id. */
  inventory: readonly string[];
  coverageMap?: CoverageMap | undefined;
  importGraph?: ImportGraph | undefined;
  /** Tests that failed in the last nightly: they always run. */
  lastNightlyFailures?: readonly string[] | undefined;
  now: Date;
}

export type SelectionResult =
  | { mode: "always_full" }
  | { mode: "full"; selection: EvidenceSelection }
  | { mode: "selected"; tests: string[]; selection: EvidenceSelection };

/** A test id's file: the part before `::`. */
export const testFileOf = (id: string): string => id.split("::", 1)[0] ?? id;

/** A glob as the environment writes them (the one implementation is in the contracts, shared with the saved environment key). */
import { globRegExp } from "@agentx/contracts";
export { globRegExp };

/**
 * What always runs the whole suite, whatever the approved environment lists (a floor an empty `fullSuiteOn` cannot remove): a test configuration or helper at the root of any test tree, dependency lockfiles and
 * manifests, project and build configuration, and CI.
 */
export const BUILTIN_FULL_SUITE_ON: readonly string[] = [
  "conftest.py", "**/conftest.py", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "poetry.lock", "uv.lock", "Pipfile.lock", "requirements*.txt", "**/requirements*.txt",
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".github/**", ".gitlab-ci.yml", "Makefile",
];

const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => globRegExp(glob).test(path));
/** `conftest.py` in the glob list means any directory's, as a maintainer writes it; a glob with a slash is a path from the root. */
const globMatches = (path: string, glob: string): boolean => globRegExp(glob).test(path) || (!glob.includes("/") && globRegExp(glob).test(posix.basename(path)));

const pathsOf = (changes: readonly ChangedPath[]): string[] => [...new Set(changes.flatMap((change) => (change.oldPath === undefined ? [change.path] : [change.path, change.oldPath])))];

const full = (selection: EvidenceSelection): SelectionResult => ({ mode: "full", selection });
const fellBack = (input: SelectionInput, reason: SelectionFallback, mapAgeHours?: number): SelectionResult =>
  full({ method: "full", selected: input.inventory.length, total: input.inventory.length, fallbackReason: reason, ...(mapAgeHours === undefined ? {} : { mapAgeHours }) });

/** Whole hours since the map was built (rounded down), or undefined when the date cannot be read: an unreadable date is a stale map. */
function mapAge(map: CoverageMap, now: Date): number | undefined {
  const built = Date.parse(map.builtAt);
  if (!Number.isFinite(built)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - built) / 3_600_000));
}

/** Tests that could depend on a changed file through imports: every inventory test whose file reaches a changed file, transitively. */
function reachingTests(graph: ImportGraph, changed: ReadonlySet<string>, inventory: readonly string[]): Set<string> {
  const cache = new Map<string, boolean>();
  const reaches = (start: string): boolean => {
    const known = cache.get(start);
    if (known !== undefined) return known;
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const file = queue[head] as string;
      if (changed.has(file)) { cache.set(start, true); return true; }
      for (const next of graph.get(file) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    cache.set(start, false);
    return false;
  };
  return new Set(inventory.filter((id) => reaches(testFileOf(id))));
}

export function selectTests(input: SelectionInput): SelectionResult {
  const { config, check } = input;
  if (config.alwaysRun.includes(check.id)) return { mode: "always_full" };
  if (config.method === "full") return full({ method: "full", selected: input.inventory.length, total: input.inventory.length });
  if (check.selectArgs === undefined || check.selectArgs.length === 0) return fellBack(input, "no_template");
  const paths = pathsOf(input.changes);
  if (paths.some((path) => [...BUILTIN_FULL_SUITE_ON, ...config.fullSuiteOn].some((glob) => globMatches(path, glob)))) return fellBack(input, "full_suite_on_path");

  const inventory = new Set(input.inventory);
  // A test FILE is one that defines tests of this check. Every other changed file is a SOURCE, even when it looks test-related (a helper or factory under tests/, `test_helpers.py`, `*_test.json`, `*.spec.json`, a
  // fixture, another check's tests, a deleted test file): it can change what many tests do, and pytest or jest never list a file that defines no test. A source the method does not know widens the selection to the
  // full suite. The one exception is a test file renamed to a path that IS in the inventory: the same tests moved, and the old path has nothing left.
  const inventoryFiles = new Set(input.inventory.map(testFileOf));
  const movedAway = new Set(input.changes.filter((change) => change.status === "renamed" && change.oldPath !== undefined && inventoryFiles.has(change.path)).map((change) => change.oldPath as string));
  const changedSources = paths.filter((path) => !inventoryFiles.has(path) && !movedAway.has(path));
  const selected = new Set<string>();
  let mapAgeHours: number | undefined;

  if (config.method === "coverage_map") {
    const map = input.coverageMap;
    if (map === undefined) return fellBack(input, "map_missing");
    mapAgeHours = mapAge(map, input.now);
    if (mapAgeHours === undefined || mapAgeHours > SELECTION_MAP_MAX_AGE_HOURS) return fellBack(input, "map_stale", mapAgeHours);
    for (const path of changedSources) {
      const touching = map.files[path];
      // Known to the map, or to the import graph when there is one; neither means a file the nightly never saw.
      if (touching === undefined && !(input.importGraph?.has(path) ?? false)) return fellBack(input, "unknown_file", mapAgeHours);
      for (const id of touching ?? []) selected.add(id);
    }
    if (input.importGraph !== undefined) for (const id of reachingTests(input.importGraph, new Set(changedSources), input.inventory)) selected.add(id);
  } else if (config.method === "import_graph") {
    const graph = input.importGraph;
    if (graph === undefined) return fellBack(input, "map_missing");
    if (changedSources.some((path) => !graph.has(path) && !graphMentions(graph, path))) return fellBack(input, "unknown_file");
    for (const id of reachingTests(graph, new Set(changedSources), input.inventory)) selected.add(id);
  } else {
    const declared = config.declared ?? [];
    for (const path of changedSources) {
      const rules = declared.filter((rule) => globMatches(path, rule.glob));
      if (rules.length === 0) return fellBack(input, "unknown_file");
      for (const rule of rules) for (const id of input.inventory) if (matchesAny(testFileOf(id), rule.tests)) selected.add(id);
    }
  }

  const fromMethod = new Set(selected);
  // Always added: tests in new or changed test files, and the ones that failed in the last nightly.
  const changedTestFiles = new Set(input.changes.filter((change) => change.status !== "deleted").map((change) => change.path).filter((path) => inventoryFiles.has(path)));
  for (const id of input.inventory) if (changedTestFiles.has(testFileOf(id))) selected.add(id);
  for (const id of input.lastNightlyFailures ?? []) selected.add(id);

  const known = [...selected].filter((id) => inventory.has(id));
  // Map or declared ids that are not in the inventory (a renamed test, a map from another layout) are not trusted: most of them missing means the map does not describe this code.
  if (fromMethod.size > 0 && [...fromMethod].filter((id) => inventory.has(id)).length * 2 < fromMethod.size) return fellBack(input, "map_stale", mapAgeHours);
  const tests = known.sort();
  // Sources changed and nothing selected: no test is known to cover the change, which is not the same as nothing being affected.
  if (changedSources.length > 0 && tests.length === 0) return fellBack(input, "unknown_file", mapAgeHours);
  if (!tests.every(safeTestId) || tests.length > SELECTION_ARGS_MAX_TESTS || tests.reduce((sum, id) => sum + Buffer.byteLength(id) + 1, 0) > SELECTION_ARGS_MAX_BYTES || tests.length > SELECTION_OVER_FRACTION * input.inventory.length) {
    return fellBack(input, "over_selected", mapAgeHours);
  }
  return { mode: "selected", tests, selection: { method: config.method, selected: tests.length, total: input.inventory.length, ...(mapAgeHours === undefined ? {} : { mapAgeHours }) } };
}

/** A path some other file imports counts as known even if it imports nothing itself (it has no outgoing edges). */
function graphMentions(graph: ImportGraph, path: string): boolean {
  for (const targets of graph.values()) if (targets.has(path)) return true;
  return false;
}

/**
 * A test id passed in the `{tests}` place of a selected run: rerunnable (the shared rule, contracts `test-id.ts`) AND with no space. The `{tests}` slot cannot say how a runner wants a name with spaces (vitest and jest take
 * files, not full names), so a selection that would need one falls back to the full suite, as it always has; the nightly's rerun builds those commands itself (`rerunCommandsOf`).
 */
const safeTestId = (id: string): boolean => isRerunnableTestId(id) && !id.includes(" ");

/**
 * The check's command with the selected tests in the approved `{tests}` place, as separate arguments: no shell, so no quoting to get wrong. Without the placeholder exactly once the command is returned
 * unchanged (the contract refuses such a template, so this is only a guard). The customer's own executable and arguments are not touched.
 */
export function commandWithSelection(command: ProjectCommand, selectArgs: readonly string[], tests: readonly string[], acceptable: (id: string) => boolean = safeTestId): ProjectCommand {
  if (selectArgs.filter((arg) => arg === TEST_ENV_SELECT_PLACEHOLDER).length !== 1 || !tests.every(acceptable)) return command;
  return { ...command, args: [...command.args, ...selectArgs.flatMap((arg) => (arg === TEST_ENV_SELECT_PLACEHOLDER ? [...tests] : [arg]))] };
}

// ---- the import graph

const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+([^\n#]+)|import[ \t]+([A-Za-z_][\w.,\t ]*))/gmu;
const JS_IMPORT = /(?:\bfrom[ \t]*|\bimport[ \t]*\(?[ \t]*|\brequire\([ \t]*)["'](\.{1,2}\/[^"'\n]*)["']/gu;
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * A file's imports as repository paths, for the languages the pilot uses. Python: `import a.b`, `from a.b import c`, relative forms (`from . import x`, `from ..pkg import y`), resolved against the files
 * given (a module or a package `__init__.py`). TypeScript and JavaScript: relative specifiers only, with the usual extensions and `index` files. Anything that resolves to no file given is dropped (a third-party
 * package has no edge). Static only: dynamic imports it cannot read are not edges, which is why a method failing to know a file falls back to the full suite and the nightly runs everything.
 */
export function buildImportGraph(files: ReadonlyArray<{ path: string; text: string }>): ImportGraph {
  const known = new Set(files.map((file) => file.path));
  const graph = new Map<string, Set<string>>();
  const resolvePython = (from: string, dots: string, module: string): string | undefined => {
    let base = dots.length === 0 ? "" : posix.dirname(from);
    for (let level = 1; level < dots.length; level += 1) base = posix.dirname(base);
    const relative = module.replace(/\./gu, "/");
    const candidates = dots.length === 0 ? sourceRoots(known, relative) : [posix.join(base, relative)];
    for (const candidate of candidates) {
      for (const option of [`${candidate}.py`, posix.join(candidate, "__init__.py")]) if (known.has(option)) return option;
    }
    return undefined;
  };
  for (const file of files) {
    const edges = new Set<string>();
    if (file.path.endsWith(".py")) {
      for (const match of file.text.matchAll(PY_IMPORT)) {
        const [, dots, module, names, plain] = match;
        if (plain !== undefined) {
          for (const name of plain.split(",")) {
            const target = resolvePython(file.path, "", (name.trim().split(/\s+/u)[0] ?? ""));
            if (target !== undefined) edges.add(target);
          }
        } else {
          const base = module ?? "";
          const target = base === "" ? undefined : resolvePython(file.path, dots ?? "", base);
          if (target !== undefined) edges.add(target);
          // `from pkg import submodule` may name a module file.
          for (const name of (names ?? "").replace(/[()]/gu, "").split(",")) {
            const clean = name.trim().split(/\s+/u)[0] ?? "";
            if (/^[A-Za-z_]\w*$/u.test(clean)) {
              const sub = resolvePython(file.path, dots ?? "", base === "" ? clean : `${base}.${clean}`);
              if (sub !== undefined) edges.add(sub);
            }
          }
        }
      }
    } else if (JS_EXTENSIONS.some((extension) => file.path.endsWith(extension))) {
      for (const match of file.text.matchAll(JS_IMPORT)) {
        const spec = posix.join(posix.dirname(file.path), match[1] ?? "");
        const stripped = spec.replace(/\.(?:js|mjs|cjs|jsx)$/u, "");
        const options = [spec, ...JS_EXTENSIONS.map((extension) => `${stripped}${extension}`), ...JS_EXTENSIONS.map((extension) => posix.join(spec, `index${extension}`))];
        const target = options.find((option) => known.has(option));
        if (target !== undefined) edges.add(target);
      }
    }
    edges.delete(file.path);
    graph.set(file.path, edges);
  }
  return graph;
}

/** Where an absolute Python module can live: the repository root, or a `src` directory, or any directory a file of that module path is found under. */
function sourceRoots(known: ReadonlySet<string>, relative: string): string[] {
  const roots = new Set<string>([relative, posix.join("src", relative)]);
  for (const path of known) {
    const at = path.indexOf(`/${relative}.py`);
    const pkg = path.indexOf(`/${relative}/__init__.py`);
    if (at > 0) roots.add(path.slice(0, at + 1 + relative.length));
    if (pkg > 0) roots.add(path.slice(0, pkg + 1 + relative.length));
  }
  return [...roots];
}

// ---- the round budget and the per-check time limit

/** The check round's budget in milliseconds from an approved environment: its `roundBudgetMin`, held to the contract's 30 to 120 minutes. No environment, or a value outside the range, is the default 30 minutes. */
export function checkRoundBudgetMs(env: Pick<TestEnvironmentBody, "roundBudgetMin"> | undefined): number {
  const minutes = env?.roundBudgetMin;
  return typeof minutes === "number" && Number.isInteger(minutes) && minutes >= TEST_ENV_ROUND_BUDGET_MIN.min && minutes <= TEST_ENV_ROUND_BUDGET_MIN.max ? minutes * 60_000 : TEST_ENV_ROUND_BUDGET_MIN.default * 60_000;
}

/** One check's time: its own limit, cut to what the round has left. (The round loop in `checks.ts` applies the same rule; this is the figure the estimate and the worker's time limit use.) */
export function checkTimeLimitMs(commandTimeoutSeconds: number, roundRemainingMs: number): number {
  return Math.max(0, Math.min(Math.floor(commandTimeoutSeconds) * 1_000, roundRemainingMs));
}

// ---- one environment, every check

export interface CheckSelectionPlan {
  /** The command to run: the customer's own, with the selected tests added in the approved place when the check was selected down. */
  command: ProjectCommand;
  /** Absent for a check that always runs in full or is not a test check. */
  selection?: EvidenceSelection;
}

/**
 * For each test check of the environment: the command to run and the selection to show. A non-test check is never selected down. The caller supplies the inventory and the nightly inputs per check; a check with
 * no inventory entry runs in full with `map_missing` (nothing is known about its tests).
 */
export function planSelections(
  env: Pick<TestEnvironmentBody, "selection" | "repos">,
  inputs: { changes: readonly ChangedPath[]; now: Date; inventoryOf(checkId: string): readonly string[] | undefined; coverageMap?: CoverageMap | undefined; importGraph?: ImportGraph | undefined; lastNightlyFailures?: readonly string[] | undefined },
): Map<string, CheckSelectionPlan> {
  const plans = new Map<string, CheckSelectionPlan>();
  for (const repo of env.repos) {
    for (const check of repo.checks) {
      if (check.kind !== "test" || env.selection.alwaysRun.includes(check.id)) { plans.set(check.id, { command: check.command }); continue; }
      const inventory = inputs.inventoryOf(check.id);
      if (inventory === undefined) {
        plans.set(check.id, { command: check.command, selection: { method: "full", selected: 0, total: 0, fallbackReason: "map_missing" } });
        continue;
      }
      const result = selectTests({ config: env.selection, check, changes: inputs.changes, inventory, coverageMap: inputs.coverageMap, importGraph: inputs.importGraph, lastNightlyFailures: inputs.lastNightlyFailures, now: inputs.now });
      if (result.mode === "always_full") plans.set(check.id, { command: check.command });
      else if (result.mode === "full") plans.set(check.id, { command: check.command, selection: result.selection });
      else plans.set(check.id, { command: commandWithSelection(check.command, check.selectArgs ?? [], result.tests), selection: result.selection });
    }
  }
  return plans;
}
