// TE-MR2b: test selection across repositories (the pure planner). Safety first: a skipped test that should have run is a FAIL, so every unknown is the whole check, and an edge is never dropped because the candidate no longer shows it.
import { describe, expect, it } from "vitest";
import { type ProjectCommand, type RepositoryCoverageMap } from "@agentx/contracts";
import { planRepositorySelections, type RepositorySelectionInput } from "../../packages/worker/src/verification/multi-repo-selection.js";
import type { ChangedPath } from "../../packages/worker/src/verification/selection.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const FRESH = "2026-11-02T08:00:00.000Z";
const command = (cwd: string): ProjectCommand => ({ cwd, executable: "pytest", args: ["-q"], timeoutSeconds: 600 });
const config = { method: "coverage_map" as const, alwaysRun: ["lint"], fullSuiteOn: ["poetry.lock"] };
const tests = (repositoryId: string, count: number, prefix = "t") => Array.from({ length: count }, (_, i) => ({ repositoryId, id: `tests/test_${prefix}${String(i)}.py::test_x` }));
const entry = (repositoryId: string, path: string, list: Array<{ repositoryId: string; id: string }>) => ({ repositoryId, path, tests: list });
const modified = (path: string): ChangedPath => ({ path, status: "modified" });
const checks = [
  { id: "svc-unit", kind: "test" as const, repositoryId: "service", command: command("service"), selectArgs: ["{tests}"] },
  { id: "lib-unit", kind: "test" as const, repositoryId: "lib", command: command("lib"), selectArgs: ["{tests}"] },
  { id: "lint", kind: "lint" as const, repositoryId: "service", command: { ...command("service"), executable: "ruff" }, selectArgs: undefined },
];
// service has 12 tests, lib has 12 tests. lib's source is touched by 2 of service's tests and 1 of lib's.
const map = (over: RepositoryCoverageMap["entries"] = []): RepositoryCoverageMap => ({
  builtAt: FRESH,
  entries: [
    entry("lib", "src/lib.py", [{ repositoryId: "service", id: "tests/test_s0.py::test_x" }, { repositoryId: "service", id: "tests/test_s1.py::test_x" }, { repositoryId: "lib", id: "tests/test_l0.py::test_x" }]),
    entry("lib", "src/other.py", [{ repositoryId: "lib", id: "tests/test_l1.py::test_x" }]),
    entry("service", "src/svc.py", tests("service", 12, "s").slice(2, 3)),
    entry("service", "src/rest.py", tests("service", 12, "s").slice(3)),
    entry("lib", "src/rest.py", tests("lib", 12, "l").slice(2)),
    ...over,
  ],
});
const edge = (consumer: string, provider: string, source: "base" | "candidate" | "both" = "both") => ({ consumer, provider, language: "node" as const, source });
const base = (over: Partial<RepositorySelectionInput> = {}): RepositorySelectionInput => ({
  config, checks, changes: new Map([["lib", [modified("src/lib.py")]]]), map: map(), facts: { edges: [edge("service", "lib")], notes: [], complete: true, unknown: [] },
  repositories: ["service", "lib"], now: NOW, ...over,
});
const planned = (over: Partial<RepositorySelectionInput> = {}) => planRepositorySelections(base(over));

describe("cross-repository selection", () => {
  it("a change in a provider selects the consumer's tests that touch it, and only that repository's tests, in that repository's check", () => {
    const result = planned();
    const service = result.get("svc-unit")!;
    expect(service.command.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
    expect(service.selection).toMatchObject({ method: "coverage_map", selected: 2 });
    // lib's own check runs lib's test only: the same change, the provider's own tests.
    expect(result.get("lib-unit")!.command.args).toEqual(["-q", "tests/test_l0.py::test_x"]);
    // A check that is not a test check, and one in alwaysRun, is left alone.
    expect(result.get("lint")!.command).toEqual(checks[2]!.command);
    expect(result.get("lint")!.selection).toBeUndefined();
  });

  it("two repositories may hold the same test id: each check gets its own repository's tests only", () => {
    const same = { id: "tests/test_same.py::test_x" };
    const withSame = planRepositorySelections(base({ map: { builtAt: FRESH, entries: [entry("lib", "src/lib.py", [{ repositoryId: "service", ...same }, { repositoryId: "lib", ...same }]), ...map().entries.slice(1)] } }));
    expect(withSame.get("svc-unit")!.command.args).toEqual(["-q", same.id]);
    expect(withSame.get("lib-unit")!.command.args).toEqual(["-q", same.id]);
    expect(withSame.get("svc-unit")!.selection).toMatchObject({ selected: 1 });
  });

  it("a repository that does not depend on the changed one ignores the change, so its own change selects its own tests", () => {
    const result = planned({ checks: [checks[1]!], changes: new Map([["service", [modified("src/svc.py")]], ["lib", [modified("src/other.py")]]]) });
    // lib does not depend on service: service's change is ignored for lib's check; lib's own change selects test_l1.
    expect(result.get("lib-unit")!.command.args).toEqual(["-q", "tests/test_l1.py::test_x"]);
  });

  it("transitive providers count: app -> service -> lib, and a change in lib selects the app's tests", () => {
    const appTest = { repositoryId: "app", id: "tests/test_app.py::test_x" };
    const m = { builtAt: FRESH, entries: [entry("lib", "src/lib.py", [appTest]), ...tests("app", 12, "a").map((t, i) => entry("app", `src/a${String(i)}.py`, [t]))] };
    const result = planRepositorySelections(base({ map: m, repositories: ["app", "service", "lib"], checks: [{ id: "app-unit", kind: "test", repositoryId: "app", command: command("app"), selectArgs: ["{tests}"] }], facts: { edges: [edge("app", "service"), edge("service", "lib")], notes: [], complete: true, unknown: [] } }));
    expect(result.get("app-unit")!.command.args).toEqual(["-q", appTest.id]);
  });

  it("an edge the candidate removed still counts (base only), and one the candidate added counts (candidate only)", () => {
    for (const source of ["base", "candidate", "both"] as const) {
      const result = planned({ facts: { edges: [edge("service", "lib", source)], notes: [], complete: true, unknown: [] } });
      expect(result.get("svc-unit")!.command.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
    }
  });

  it("the map's own evidence counts as a dependency: a repository the manifests do not show as a provider still relates when a test of this repository touches its file", () => {
    const result = planned({ facts: { edges: [], notes: [], complete: true, unknown: [] } });
    expect(result.get("svc-unit")!.command.args).toEqual(["-q", "tests/test_s0.py::test_x", "tests/test_s1.py::test_x"]);
  });

  it("a provider's changed file that the map holds but no test of this repository touches runs the whole check", () => {
    const m = map([entry("lib", "src/uncovered.py", [{ repositoryId: "lib", id: "tests/test_l0.py::test_x" }])]);
    const result = planned({ map: m, changes: new Map([["lib", [modified("src/uncovered.py")]], ["service", [modified("src/svc.py")]]]) });
    const one = result.get("svc-unit")!;
    expect(one.command).toEqual(checks[0]!.command);
    expect(one.selection).toMatchObject({ method: "full", fallbackReason: "unknown_file" });
  });

  it("a cycle terminates and relates both ways", () => {
    const result = planned({ facts: { edges: [edge("service", "lib"), edge("lib", "service")], notes: [], complete: true, unknown: [] }, changes: new Map([["lib", [modified("src/lib.py")]], ["service", [modified("src/svc.py")]]]) });
    expect(result.get("svc-unit")!.command.args).toContain("tests/test_s0.py::test_x");
    expect(result.get("svc-unit")!.command.args).toContain("tests/test_s2.py::test_x");
  });
});

describe("cross-repository selection fails closed", () => {
  const unchanged = (result: ReturnType<typeof planned>, id: string, reason: string) => {
    const one = result.get(id)!;
    expect(one.command).toEqual(checks.find((c) => c.id === id)!.command);
    expect(one.selection).toMatchObject({ method: "full", fallbackReason: reason });
  };
  it("unfinished facts (ambiguous, unreadable, over a limit, aborted) run every test check whole", () => {
    const result = planned({ facts: { edges: [], notes: ["ambiguous"], complete: false, unknown: [] } });
    unchanged(result, "svc-unit", "unknown_file"); unchanged(result, "lib-unit", "unknown_file");
  });
  it("a repository whose dependencies are not fully known is never skipped as unrelated, whichever side it is on", () => {
    // The map shows no test of service touching lib: only the manifests could relate them.
    const isolated = map().entries.map((value) => (value.repositoryId === "lib" && value.path === "src/lib.py" ? { ...value, tests: value.tests.filter((test) => test.repositoryId === "lib") } : value));
    for (const unknown of [["service"], ["lib"], ["service", "lib"]]) {
      const result = planned({ map: { builtAt: FRESH, entries: isolated }, facts: { edges: [], notes: [], complete: true, unknown } });
      // service (no edge to lib) and lib: lib changed, no edge. An unknown side means the change may reach it: the whole check.
      unchanged(result, "svc-unit", "unknown_file");
    }
    // Known on both sides with no edge: the change is ignored for the consumer-less repository (no change of its own: nothing selected, the caller runs it whole).
    const known = planned({ map: { builtAt: FRESH, entries: isolated }, facts: { edges: [], notes: [], complete: true, unknown: [] } });
    expect(known.get("svc-unit")!.selection).toMatchObject({ selected: 0 });
  });
  it("a path that is not in the map, a stale map and a path that changes what every test means run the whole check", () => {
    unchanged(planned({ changes: new Map([["lib", [modified("src/brand_new.py")]]]) }), "svc-unit", "unknown_file");
    expect(planned({ map: { ...map(), builtAt: "2026-10-01T00:00:00.000Z" } }).get("svc-unit")!.selection).toMatchObject({ method: "full", fallbackReason: "map_stale" });
    unchanged(planned({ changes: new Map([["lib", [modified("poetry.lock")]]]) }), "svc-unit", "full_suite_on_path");
    unchanged(planned({ changes: new Map([["lib", [modified("src/lib.py"), modified("package.json")]]]) }), "svc-unit", "full_suite_on_path");
    unchanged(planned({ changes: new Map([["lib", [modified("src/lib.py")]], ["service", [modified(".github/workflows/ci.yml")]]]) }), "svc-unit", "full_suite_on_path");
  });
  it("a changed file with a path that could be mistaken for another repository's key runs the whole check", () => {
    unchanged(planned({ changes: new Map([["service", [modified("\u0001lib\u0001src/lib.py")]]]) }), "svc-unit", "unknown_file");
    unchanged(planned({ changes: new Map([["lib", [{ path: "src/new.py", oldPath: "\u0001x", status: "renamed" }]]]) }), "svc-unit", "unknown_file");
  });
  it("a check of a repository the task does not hold, or a method that is not repository-aware, runs whole", () => {
    unchanged(planned({ repositories: ["lib"] }), "svc-unit", "unknown_file");
    unchanged(planned({ config: { ...config, method: "import_graph" } }), "svc-unit", "map_missing");
    unchanged(planned({ config: { ...config, method: "declared", declared: [{ glob: "src/*", tests: ["tests/*"] }] } }), "svc-unit", "map_missing");
  });
  it("hostile paths and repository ids do not throw or reach another repository's entries", () => {
    for (const path of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const result = planned({ changes: new Map([["lib", [modified(path)]]]) });
      unchanged(result, "svc-unit", "unknown_file");
    }
    const hostile = planned({ checks: [{ ...checks[0]!, repositoryId: "__proto__" }], repositories: ["__proto__", "lib"], facts: { edges: [edge("__proto__", "lib")], notes: [], complete: true, unknown: [] } });
    expect(hostile.get("svc-unit")!.selection).toMatchObject({ method: "full" });
  });
  it("an over-selected or empty selection is the engine's own rule, not a new one", () => {
    const wide = { builtAt: FRESH, entries: [entry("lib", "src/lib.py", tests("service", 12, "s")), entry("service", "src/rest.py", tests("service", 12, "s"))] };
    unchanged(planned({ map: wide }), "svc-unit", "over_selected");
  });
  it("is bounded on a large input: 20,000 map entries, 32 repositories, 64 edges", () => {
    const ids = Array.from({ length: 32 }, (_, i) => `r${String(i)}`);
    const many = { builtAt: FRESH, entries: Array.from({ length: 20_000 }, (_, i) => entry(ids[i % 32]!, `src/f${String(i)}.py`, [{ repositoryId: ids[(i + 1) % 32]!, id: `tests/test_${String(i)}.py::t` }])) };
    const started = Date.now();
    const result = planRepositorySelections(base({ map: many, repositories: ids, checks: ids.map((id) => ({ id: `c-${id}`, kind: "test" as const, repositoryId: id, command: command(id), selectArgs: ["{tests}"] })),
      facts: { edges: ids.slice(1).map((id, i) => edge(id, ids[i]!)), notes: [], complete: true, unknown: [] }, changes: new Map([["r0", [modified("src/f0.py")]]]) }));
    expect(result.size).toBe(32);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
