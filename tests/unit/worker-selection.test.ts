// Proof and test environment E5: affected-test selection (coverage map, import graph, declared, full), every fallback to the full suite, the safe command line, and the per-project round budget.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type TestEnvironmentBody } from "@agentx/contracts";
import { BUILTIN_FULL_SUITE_ON, SELECTION_MAP_MAX_AGE_HOURS, buildImportGraph, checkRoundBudgetMs, checkTimeLimitMs, commandWithSelection, globRegExp, selectTests, type CoverageMap, type SelectionInput } from "../../packages/worker/src/verification/selection.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const INVENTORY = Array.from({ length: 50 }, (_, index) => `tests/test_m${String(index)}.py::test_a`);
const map = (over: Partial<CoverageMap> = {}): CoverageMap => ({ builtAt: hoursAgo(14), files: { "src/match.py": ["tests/test_m1.py::test_a", "tests/test_m2.py::test_a"], "src/rank.py": ["tests/test_m3.py::test_a"] }, ...over });
const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  config: { method: "coverage_map", alwaysRun: [], fullSuiteOn: ["poetry.lock", "conftest.py", ".github/**"] },
  check: { id: "unit", selectArgs: ["{tests}"] },
  changes: [{ path: "src/match.py", status: "modified" }],
  inventory: INVENTORY, coverageMap: map(), lastNightlyFailures: [], now: NOW, ...over,
});

describe("test-support files and thin maps (review I9, M11)", () => {
  const reason = (over: Partial<SelectionInput>) => {
    const result = selectTests(input(over));
    return result.mode === "full" ? result.selection.fallbackReason : result.mode;
  };
  it("a test file renamed to a path in the inventory is the same tests moved: not a reason to run everything; a deleted file (a test or a helper) is, because nothing says which", () => {
    expect(selectTests(input({ changes: [{ path: "src/match.py", status: "modified" }, { path: "tests/test_m9.py", oldPath: "tests/test_old_name.py", status: "renamed" }] })).mode).toBe("selected");
    expect(reason({ changes: [{ path: "src/match.py", status: "modified" }, { path: "tests/test_gone.py", status: "deleted" }] })).toBe("unknown_file");
    expect(reason({ changes: [{ path: "tests/support/test_helpers.py", status: "deleted" }] })).toBe("unknown_file");
    expect(reason({ changes: [{ path: "tests/support/helpers2.py", oldPath: "tests/support/helpers.py", status: "renamed" }] })).toBe("unknown_file");
  });
  it("sources changed and nothing selected: the full suite, never 'selected' with no tests", () => {
    expect(reason({ coverageMap: map({ files: { "src/match.py": [] } }) })).toBe("unknown_file");
  });
  it("a map whose ids are mostly not in the inventory does not describe this code", () => {
    const stale = map({ files: { "src/match.py": ["old/test_a.py::t1", "old/test_b.py::t2", "tests/test_m1.py::test_a"] } });
    expect(reason({ coverageMap: stale })).toBe("map_stale");
    const mostlyThere = map({ files: { "src/match.py": ["old/test_a.py::t1", "tests/test_m1.py::test_a", "tests/test_m2.py::test_a"] } });
    expect(selectTests(input({ coverageMap: mostlyThere }))).toMatchObject({ mode: "selected", tests: ["tests/test_m1.py::test_a", "tests/test_m2.py::test_a"] });
  });
  it("an approved empty fullSuiteOn cannot turn the floor off: lockfiles, project files, conftest and CI always run everything", () => {
    for (const path of ["poetry.lock", "pyproject.toml", "package.json", "requirements-dev.txt", "tests/unit/conftest.py", "conftest.py", ".github/workflows/ci.yml", "Makefile"]) {
      expect(reason({ config: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, changes: [{ path, status: "modified" }] }), path).toBe("full_suite_on_path");
    }
    expect(BUILTIN_FULL_SUITE_ON).toContain("pyproject.toml");
  });
});

describe("falls back to the full suite, and says why", () => {
  const reason = (over: Partial<SelectionInput>) => {
    const result = selectTests(input(over));
    if (result.mode !== "full") throw new Error(`expected full, got ${result.mode}`);
    expect(result.selection).toMatchObject({ method: "full", selected: 50, total: 50 });
    return result.selection.fallbackReason;
  };
  it("a missing, stale or unreadable map", () => {
    expect(reason({ coverageMap: undefined })).toBe("map_missing");
    expect(reason({ coverageMap: map({ builtAt: hoursAgo(SELECTION_MAP_MAX_AGE_HOURS + 1) }) })).toBe("map_stale");
    expect(reason({ coverageMap: map({ builtAt: "yesterday-ish" }) })).toBe("map_stale");
    expect(selectTests(input({ coverageMap: map({ builtAt: hoursAgo(SELECTION_MAP_MAX_AGE_HOURS) }) })).mode).toBe("selected");
  });
  it("the declared and full methods", () => {
    expect(selectTests(input({ config: { method: "full", alwaysRun: [], fullSuiteOn: [] } }))).toEqual({ mode: "full", selection: { method: "full", selected: 50, total: 50 } });
    expect(reason({ config: { method: "declared", alwaysRun: [], fullSuiteOn: [], declared: [{ glob: "src/rank.py", tests: ["tests/test_m3.py"] }] } })).toBe("unknown_file");
  });
  it("a check on the always-run list is never selected down and carries no selection", () => {
    expect(selectTests(input({ config: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: [] } }))).toEqual({ mode: "always_full" });
  });
});

describe("import graph and declared selection", () => {
  const files = [
    { path: "src/match.py", text: "import json\nfrom .util import helper\n" },
    { path: "src/util.py", text: "X = 1\n" },
    { path: "src/service/__init__.py", text: "" },
    { path: "src/service/api.py", text: "from src.match import score\nfrom . import util2\n" },
    { path: "src/service/util2.py", text: "" },
    { path: "tests/test_m1.py", text: "from src.service.api import handler\n" },
    { path: "tests/test_m2.py", text: "import src.util\n" },
    { path: "tests/test_m3.py", text: "import unrelated_third_party\n" },
  ];
  const graph = buildImportGraph(files);
  it("builds Python edges: relative, absolute under a source root, packages, and submodules", () => {
    expect([...(graph.get("src/match.py") ?? [])]).toEqual(["src/util.py"]);
    expect([...(graph.get("src/service/api.py") ?? [])].sort()).toEqual(["src/match.py", "src/service/util2.py"]);
    expect([...(graph.get("tests/test_m2.py") ?? [])]).toEqual(["src/util.py"]);
    expect([...(graph.get("tests/test_m3.py") ?? [])]).toEqual([]);
  });
  it("copes with cycles and refuses a file the graph does not know", () => {
    const cyclic = buildImportGraph([{ path: "a.py", text: "import b\n" }, { path: "b.py", text: "import a\n" }, { path: "test_a.py", text: "import a\n" }]);
    expect(selectTests(input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, importGraph: cyclic, coverageMap: undefined, inventory: ["test_a.py::t", ...INVENTORY], changes: [{ path: "b.py", status: "modified" }] }))).toMatchObject({ mode: "selected", tests: ["test_a.py::t"] });
    const unknown = selectTests(input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, importGraph: graph, coverageMap: undefined, changes: [{ path: "src/ghost.py", status: "added" }] }));
    expect(unknown).toMatchObject({ mode: "full", selection: { fallbackReason: "unknown_file" } });
    expect(selectTests(input({ config: { method: "import_graph", alwaysRun: [], fullSuiteOn: [] }, importGraph: undefined, coverageMap: undefined }))).toMatchObject({ mode: "full", selection: { fallbackReason: "map_missing" } });
  });
  it("declared selection maps changed globs to test globs", () => {
    const result = selectTests(input({ config: { method: "declared", alwaysRun: [], fullSuiteOn: [], declared: [{ glob: "src/match.py", tests: ["tests/test_m1.py", "tests/test_m2.py"] }] }, coverageMap: undefined }));
    expect(result).toMatchObject({ mode: "selected", tests: ["tests/test_m1.py::test_a", "tests/test_m2.py::test_a"], selection: { method: "declared", selected: 2 } });
  });
});

describe("the command line", () => {
  const command = { cwd: "service", executable: "pytest", args: ["-q"], timeoutSeconds: 600 };
  it("adds the tests as separate arguments in the approved place and leaves the customer's command alone", () => {
    expect(commandWithSelection(command, ["--", "{tests}"], ["a.py::t", "b.py::t"])).toEqual({ ...command, args: ["-q", "--", "a.py::t", "b.py::t"] });
    expect(command.args).toEqual(["-q"]);
  });
  it("returns the command unchanged for a bad template or a test id that is an option or holds whitespace", () => {
    expect(commandWithSelection(command, ["{tests}", "{tests}"], ["a"])).toBe(command);
    expect(commandWithSelection(command, ["-k"], ["a"])).toBe(command);
    expect(commandWithSelection(command, ["{tests}"], ["--rootdir=/"])).toBe(command);
    expect(commandWithSelection(command, ["{tests}"], ["a b"])).toBe(command);
  });
  it("matches globs the way a maintainer writes them", () => {
    expect(globRegExp("**/conftest.py").test("a/b/conftest.py")).toBe(true);
    expect(globRegExp("**/conftest.py").test("conftest.py")).toBe(true);
    expect(globRegExp(".github/**").test(".github/workflows/ci.yml")).toBe(true);
    expect(globRegExp("src/*.py").test("src/a/b.py")).toBe(false);
    expect(globRegExp("src/{a,b}.py").test("src/b.py")).toBe(true);
    expect(globRegExp("a+b.py").test("a+b.py")).toBe(true);
    expect(globRegExp("a.py").test("aXpy")).toBe(false);
  });
});

const env = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "svc", setupCommands: [], checks: [
    { id: "unit", label: "Unit", command: { cwd: "service", executable: "pytest", args: ["-q"], timeoutSeconds: 600 }, kind: "test", selectArgs: ["{tests}"] },
    { id: "lint", label: "Lint", command: { cwd: "service", executable: "ruff", args: ["check"], timeoutSeconds: 120 }, kind: "lint" },
    { id: "smoke", label: "Smoke", command: { cwd: "service", executable: "pytest", args: ["smoke"], timeoutSeconds: 120 }, kind: "test" },
  ] }],
  roundBudgetMin: 45,
  selection: { method: "coverage_map", alwaysRun: ["smoke"], fullSuiteOn: ["poetry.lock"] },
  nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});

describe("the per-project round budget", () => {
  it("is the environment's, held to 30 to 120 minutes, and the default without one", () => {
    expect(checkRoundBudgetMs(env())).toBe(45 * 60_000);
    expect(checkRoundBudgetMs(undefined)).toBe(30 * 60_000);
    for (const minutes of [0, 29, 121, 45.5, Number.NaN, -5]) expect(checkRoundBudgetMs({ roundBudgetMin: minutes })).toBe(30 * 60_000);
    expect(checkRoundBudgetMs({ roundBudgetMin: 120 })).toBe(120 * 60_000);
  });
  it("a check's time is its own limit cut to what the round has left", () => {
    expect(checkTimeLimitMs(600, 3_600_000)).toBe(600_000);
    expect(checkTimeLimitMs(600, 90_000)).toBe(90_000);
    expect(checkTimeLimitMs(600, -5)).toBe(0);
  });
});
